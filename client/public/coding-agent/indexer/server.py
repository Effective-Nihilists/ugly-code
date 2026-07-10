#!/usr/bin/env python3
"""
Codebase index HTTP server — singleton-per-machine daemon.

Lightweight Flask server that exposes indexing and semantic search
over localhost. Multi-tenant: every endpoint takes a `project_dir`,
and per-project state lives in a dict keyed by that path. One
daemon serves all node processes on the box.

Endpoints:
    POST /index   — full index of a directory (body.project_dir)
    POST /search  — semantic search           (body.project_dir)
    POST /update  — incremental re-index      (body.project_dir)
    POST /reconcile — sync overlay to worktree on disk (body.project_dir + worktree_root)
    POST /status  — index health for a project (body.project_dir)
    GET  /ping    — liveness probe (no project_dir)
    GET  /projects — list project_dirs we have state for
    POST /shutdown — graceful shutdown

Usage:
    python server.py --port 0  (auto-assign port, print to stdout)
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import threading
from pathlib import Path

from flask import Flask, request, jsonify

from chunker import chunk_file, chunk_directory
import embedder
from embedder import init as init_embedder, embed_documents, embed_query, embed_dim
from store import VectorStore
from overlay import OverlayStore, merged_search

app = Flask(__name__)

# ---------------------------------------------------------------------
# Multi-tenant state. Each project_dir gets its own VectorStore + status
# dict + lock. Locks serialize /index for a single project (so two
# concurrent kickoffs don't clobber); different projects index in
# parallel. A registry-level lock guards the dicts themselves.
# ---------------------------------------------------------------------

_stores: dict[str, VectorStore] = {}
_states: dict[str, dict] = {}
_project_locks: dict[str, threading.Lock] = {}
_registry_lock = threading.Lock()

# Per-worktree overlay cache, keyed on worktree_root. Independent of
# project_dir — a worktree is a session-scoped overlay that may be
# associated with a different project_dir's base store.
_overlays: dict[str, OverlayStore] = {}
_overlay_lock = threading.Lock()


def _new_state() -> dict:
    return {
        "status": "idle",
        "phase": None,
        "indexed_at": None,
        "project_dir": None,
        "total_chunks": 0,
        "total_files": 0,
        "indexed_chunks": 0,
        "indexed_files": 0,
        "error": None,
        # Private (leading underscore) — stripped by _public_state(). Monotonic
        # clocks so rates survive a wall-clock adjustment mid-index.
        "_t_start": None,      # whole run, drives elapsed_seconds
        "_embed_start": None,  # embedding phase only, drives the rates
        # Warm-resume baselines: chunks/files already on disk are credited to
        # indexed_* instantly. Rates must measure only chunks we actually embed,
        # or a mostly-warm index reports an absurd chunks/sec and an ETA of ~0.
        "_base_chunks": 0,
        "_base_files": 0,
    }


def _public_state(state: dict) -> dict:
    """Project `state` onto the wire shape, computing throughput + ETA here so
    there is exactly one monotonic clock and the client never has to difference
    successive polls. Private `_`-prefixed keys never ship."""
    pub = {k: v for k, v in state.items() if not k.startswith("_")}

    t_start = state.get("_t_start")
    if t_start is not None:
        pub["elapsed_seconds"] = round(time.monotonic() - t_start, 3)

    embed_start = state.get("_embed_start")
    if embed_start is not None:
        work_elapsed = time.monotonic() - embed_start
        if work_elapsed > 0:
            new_chunks = state["indexed_chunks"] - state["_base_chunks"]
            new_files = state["indexed_files"] - state["_base_files"]
            if new_chunks > 0:
                cps = new_chunks / work_elapsed
                pub["chunks_per_sec"] = round(cps, 3)
                remaining = state["total_chunks"] - state["indexed_chunks"]
                if remaining > 0:
                    pub["eta_seconds"] = round(remaining / cps, 1)
                elif state["status"] == "ready":
                    pub["eta_seconds"] = 0.0
            if new_files > 0:
                pub["files_per_sec"] = round(new_files / work_elapsed, 3)

    return pub


def _get_state(project_dir: str) -> dict:
    """Return the state dict for a project, creating if missing."""
    with _registry_lock:
        s = _states.get(project_dir)
        if s is None:
            s = _new_state()
            s["project_dir"] = project_dir
            _states[project_dir] = s
        return s


def _get_project_lock(project_dir: str) -> threading.Lock:
    with _registry_lock:
        lk = _project_locks.get(project_dir)
        if lk is None:
            lk = threading.Lock()
            _project_locks[project_dir] = lk
        return lk


def _get_store(project_dir: str) -> VectorStore | None:
    with _registry_lock:
        return _stores.get(project_dir)


def _set_store(project_dir: str, store: VectorStore) -> None:
    with _registry_lock:
        _stores[project_dir] = store


def _get_overlay(worktree_root: str) -> OverlayStore:
    """Return a memoized OverlayStore for this worktree."""
    with _overlay_lock:
        store = _overlays.get(worktree_root)
        if store is None:
            store = OverlayStore(worktree_root, embed_dim=embed_dim())
            _overlays[worktree_root] = store
        return store


# Target chunks per embed+commit batch. Big enough to amortize the
# ONNX per-batch overhead (and give the embedder room to length-sort),
# small enough that a crash loses at most this much work and the
# progress bar updates at a user-visible cadence.
_COMMIT_BATCH_CHUNKS = 128


def _index_directory(project_dir: str) -> dict:
    """Full index of a directory. Blocks until complete.

    Per-project lock serializes concurrent /index calls for the same
    project. Different project_dirs index in parallel.
    """
    state = _get_state(project_dir)
    proj_lock = _get_project_lock(project_dir)

    with proj_lock:
        # Use a transient "scanning" status while we figure out whether the
        # on-disk DB is already warm.
        state["status"] = "scanning"
        state["phase"] = "scanning"
        state["project_dir"] = project_dir
        state["error"] = None
        state["indexed_chunks"] = 0
        state["total_chunks"] = 0
        state["total_files"] = 0
        state["indexed_files"] = 0
        state["_t_start"] = time.monotonic()
        state["_embed_start"] = None
        state["_base_chunks"] = 0
        state["_base_files"] = 0

        try:
            store = VectorStore(project_dir, embed_dim=embed_dim())
            _set_store(project_dir, store)

            # Model-version stamp: if the embedder changed since this index was
            # built, its vectors live in a different space — drop everything and
            # re-embed rather than mix spaces (garbage similarity otherwise).
            stamped = store.get_meta("embed_model")
            if stamped is not None and stamped != embedder.MODEL_REPO:
                print(f"[indexer] embed model changed {stamped} -> "
                      f"{embedder.MODEL_REPO}; clearing index", file=sys.stderr)
                store.clear_all()
            store.set_meta("embed_model", embedder.MODEL_REPO)

            t0 = time.time()
            state["phase"] = "chunking"
            chunks = chunk_directory(project_dir)

            if not chunks:
                for gone in list(store.get_all_file_hashes().keys()):
                    store.delete_file(gone)
                state["status"] = "ready"
                state["phase"] = None
                state["indexed_at"] = time.time()
                state["total_chunks"] = 0
                state["total_files"] = 0
                state["indexed_chunks"] = 0
                state["indexed_files"] = 0
                return {"chunks": 0, "files": 0, "time_s": time.time() - t0}

            by_file: dict[str, list] = {}
            for chunk in chunks:
                by_file.setdefault(chunk.file_path, []).append(chunk)

            stored_hashes = store.get_all_file_hashes()
            stale_files = set(stored_hashes.keys()) - set(by_file.keys())
            for gone in stale_files:
                store.delete_file(gone)

            files_to_index: list[tuple[str, list]] = []
            already_indexed_chunks = 0
            for file_path, file_chunks in by_file.items():
                current = {c.content_hash for c in file_chunks}
                stored = stored_hashes.get(file_path, set())
                if current == stored and current:
                    already_indexed_chunks += len(file_chunks)
                else:
                    files_to_index.append((file_path, file_chunks))

            total_chunks_all = len(chunks)
            already_indexed_files = len(by_file) - len(files_to_index)
            state["total_chunks"] = total_chunks_all
            state["total_files"] = len(by_file)
            state["indexed_chunks"] = already_indexed_chunks
            state["indexed_files"] = already_indexed_files
            # Baselines for the rate window: everything above came off disk for
            # free and must not be counted as embedding throughput.
            state["_base_chunks"] = already_indexed_chunks
            state["_base_files"] = already_indexed_files

            print(
                f"[indexer] resume scan {project_dir}: "
                f"{already_indexed_chunks}/{total_chunks_all} chunks reused, "
                f"{len(files_to_index)}/{len(by_file)} files need (re-)embedding",
                file=sys.stderr,
                flush=True,
            )

            if not files_to_index:
                state["status"] = "ready"
                state["phase"] = None
                state["indexed_at"] = time.time()
                print(
                    f"[indexer] warm resume — nothing to embed for {project_dir} "
                    f"({total_chunks_all} chunks, {len(by_file)} files, "
                    f"{round(time.time() - t0, 2)}s)",
                    file=sys.stderr,
                    flush=True,
                )
                return {
                    "chunks": total_chunks_all,
                    "files": len(by_file),
                    "time_s": round(time.time() - t0, 2),
                }

            init_embedder()
            state["status"] = "indexing"
            state["phase"] = "embedding"
            # Start the rate window AFTER init_embedder() — model load (a cold
            # ONNX + tokenizer init) is not embedding throughput, and folding it
            # in makes the first ETA read minutes too pessimistic.
            state["_embed_start"] = time.monotonic()

            committed_chunks = already_indexed_chunks
            committed_files = already_indexed_files
            batch_files: list[tuple[str, list]] = []
            batch_chunk_count = 0

            def flush() -> None:
                nonlocal committed_chunks, committed_files, batch_files, batch_chunk_count
                if not batch_files:
                    return

                flat_chunks = [c for _, fcs in batch_files for c in fcs]
                contents = [c.content for c in flat_chunks]
                base = committed_chunks

                def _on_progress(done: int, _total: int) -> None:
                    state["indexed_chunks"] = base + done

                state["phase"] = "embedding"
                embeddings = embed_documents(contents, progress_cb=_on_progress)

                state["phase"] = "committing"
                offset = 0
                for file_path, file_chunks in batch_files:
                    n = len(file_chunks)
                    store.upsert_chunks(
                        file_path=file_path,
                        contents=[c.content for c in file_chunks],
                        start_lines=[c.start_line for c in file_chunks],
                        end_lines=[c.end_line for c in file_chunks],
                        languages=[c.language for c in file_chunks],
                        parent_scopes=[c.parent_scope for c in file_chunks],
                        content_hashes=[c.content_hash for c in file_chunks],
                        embeddings=embeddings[offset : offset + n],
                    )
                    offset += n
                    committed_files += 1
                    state["indexed_files"] = committed_files

                committed_chunks += len(flat_chunks)
                state["indexed_chunks"] = committed_chunks
                batch_files = []
                batch_chunk_count = 0

            for file_path, file_chunks in files_to_index:
                if (
                    batch_chunk_count + len(file_chunks) > _COMMIT_BATCH_CHUNKS
                    and batch_files
                ):
                    flush()
                batch_files.append((file_path, file_chunks))
                batch_chunk_count += len(file_chunks)
            flush()

            elapsed = time.time() - t0
            state["status"] = "ready"
            state["phase"] = None
            state["indexed_at"] = time.time()
            state["indexed_chunks"] = committed_chunks
            state["indexed_files"] = committed_files

            return {
                "chunks": committed_chunks,
                "files": len(by_file),
                "time_s": round(elapsed, 2),
            }

        except Exception as e:
            state["status"] = "error"
            state["phase"] = None
            state["error"] = str(e)
            raise


@app.route("/ping", methods=["GET"])
def handle_ping():
    """Liveness probe. Used by clients to verify a daemon is alive
    before connecting to it (vs. a stale portfile pointing at a dead PID)."""
    return jsonify({"ok": True, "pid": os.getpid()})


@app.route("/projects", methods=["GET"])
def handle_projects():
    """List project_dirs the daemon currently has state for."""
    with _registry_lock:
        return jsonify({"projects": list(_states.keys())})


@app.route("/index", methods=["POST"])
def handle_index():
    """Full index of a project directory."""
    data = request.get_json(force=True)
    project_dir = data.get("project_dir")
    if not project_dir:
        return jsonify({"error": "project_dir required"}), 400
    if not os.path.isdir(project_dir):
        return jsonify({"error": f"not a directory: {project_dir}"}), 400

    try:
        result = _index_directory(project_dir)
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


def _hit(r, mode, fts_rank=None, semantic_score=None):
    """Serialize a SearchResult to a response hit with provenance."""
    d = {
        "file_path": r.file_path, "start_line": r.start_line,
        "end_line": r.end_line, "content": r.content, "language": r.language,
        "parent_scope": r.parent_scope, "mode": mode, "score": round(r.score, 4),
    }
    if fts_rank is not None:
        d["fts_rank"] = fts_rank
    if semantic_score is not None:
        d["semantic_score"] = round(float(semantic_score), 4)
    return d


def _mixed_hit(c):
    """Serialize a hybrid.Candidate (mixed mode) with all sub-scores."""
    r = c.result
    d = {
        "file_path": r.file_path, "start_line": r.start_line,
        "end_line": r.end_line, "content": r.content, "language": r.language,
        "parent_scope": r.parent_scope, "mode": "mixed", "score": round(c.score, 4),
        "rerank_score": (round(float(c.rerank_score), 4) if c.rerank_score is not None else None),
    }
    if c.fts_rank is not None:
        d["fts_rank"] = c.fts_rank
    if c.semantic_score is not None:
        d["semantic_score"] = round(float(c.semantic_score), 4)
    return d


@app.route("/search", methods=["POST"])
def handle_search():
    """Hybrid search across an indexed project. `mode` ∈ {fts, semantic, mixed};
    `grep` is handled host-side (channel), not here. Returns a discriminated
    status: {status:'ready', results} | {status:'indexing'|'unavailable', ...}.

    NOTE: `fts`/`mixed` currently query the BASE store only (no worktree
    overlay); `semantic` remains overlay-aware via merged_search. Overlay-aware
    fts/mixed is a follow-up — the panel tests the base project (no worktree),
    and the dirty-set /update keeps the active project's base index fresh."""
    data = request.get_json(force=True)
    project_dir = data.get("project_dir")
    if not project_dir:
        return jsonify({"error": "project_dir required"}), 400

    query = data.get("query")
    if not query:
        return jsonify({"error": "query required"}), 400

    mode = data.get("mode", "mixed")
    if mode == "grep":
        return jsonify({"status": "unavailable", "error": "grep runs host-side"})

    store = _get_store(project_dir)
    if store is None:
        # Not indexed yet in this daemon — the client should show 'indexing'
        # and retry (or kick /index), not treat it as an error.
        return jsonify({"status": "indexing"})

    limit = min(data.get("limit", 10), 50)
    scope = data.get("scope")
    extensions = data.get("extensions")
    worktree_root = data.get("worktree_root")  # semantic overlay only (see note)

    try:
        if mode == "fts":
            with _get_project_lock(project_dir):
                results = store.fts_search(query, limit, scope, extensions)
            hits = [_hit(r, "fts", fts_rank=i) for i, r in enumerate(results)]
        elif mode == "semantic":
            init_embedder()
            query_vec = embed_query(query)
            with _get_project_lock(project_dir):
                if worktree_root:
                    results = merged_search(
                        base=store, overlay=_get_overlay(worktree_root),
                        query_embedding=query_vec, limit=limit,
                        scope=scope, extensions=extensions,
                    )
                else:
                    results = store.search(query_vec, limit=limit, scope=scope, extensions=extensions)
            hits = [_hit(r, "semantic", semantic_score=r.score) for r in results]
        else:  # mixed (default)
            init_embedder()
            query_vec = embed_query(query)
            with _get_project_lock(project_dir):
                cands = store.mixed_search(
                    query_vec, query, limit=limit, scope=scope, extensions=extensions
                )
            hits = [_mixed_hit(c) for c in cands]

        return jsonify({"status": "ready", "results": hits})
    except Exception as e:
        return jsonify({"status": "unavailable", "error": str(e)})


@app.route("/update", methods=["POST"])
def handle_update():
    """Incremental re-index of specific files."""
    data = request.get_json(force=True)
    project_dir = data.get("project_dir")
    if not project_dir:
        return jsonify({"error": "project_dir required"}), 400

    store = _get_store(project_dir)
    if store is None:
        return jsonify({"error": f"index not built for {project_dir} — call /index first"}), 400

    files = data.get("files", [])
    if not files:
        return jsonify({"error": "files list required"}), 400
    worktree_root = data.get("worktree_root")  # optional; routes to overlay

    target_store = _get_overlay(worktree_root) if worktree_root else store

    try:
        init_embedder()
        updated = 0
        deleted = 0

        # Same threading constraint as /search — serialize store access
        # per project to avoid sqlite-vec "Already borrowed" errors.
        proj_lock = _get_project_lock(project_dir)

        rel_root = worktree_root or project_dir

        def _to_rel(p: str) -> str:
            if not rel_root:
                return p
            try:
                rp = os.path.relpath(p, rel_root)
                if rp.startswith(".."):
                    return p
                return rp
            except ValueError:
                return p

        with proj_lock:
            for file_path in files:
                if not os.path.exists(file_path):
                    rel = _to_rel(file_path)
                    if worktree_root:
                        target_store.mark_deleted(rel)  # type: ignore[attr-defined]
                    else:
                        target_store.delete_file(rel)
                    deleted += 1
                    continue

                abs_path = file_path
                rel = _to_rel(file_path)
                chunks = chunk_file(abs_path)
                for c in chunks:
                    c.file_path = rel
                if not chunks:
                    if worktree_root:
                        target_store.mark_deleted(rel)  # type: ignore[attr-defined]
                    else:
                        target_store.delete_file(rel)
                    deleted += 1
                    continue

                if worktree_root:
                    target_store.clear_deleted(rel)  # type: ignore[attr-defined]

                contents = [c.content for c in chunks]
                embeddings = embed_documents(contents)

                target_store.upsert_chunks(
                    file_path=rel,
                    contents=contents,
                    start_lines=[c.start_line for c in chunks],
                    end_lines=[c.end_line for c in chunks],
                    languages=[c.language for c in chunks],
                    parent_scopes=[c.parent_scope for c in chunks],
                    content_hashes=[c.content_hash for c in chunks],
                    embeddings=embeddings,
                )
                updated += 1

            if not worktree_root:
                stats = store.stats()
                state = _get_state(project_dir)
                state["total_chunks"] = stats["total_chunks"]
                state["total_files"] = stats["total_files"]

        return jsonify({"updated": updated, "deleted": deleted})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/reconcile", methods=["POST"])
def handle_reconcile():
    """Bring a session's worktree overlay up to date with the worktree
    on disk. Self-healing — called on session resume so that edits made
    in a previous node process (whose in-memory dirty-file set was lost
    on restart) get embedded into the overlay before the next semantic
    search.

    Logic: walk the worktree, compute current chunks per file, compare
    against the base index and the existing overlay. Embed any files
    that differ from BOTH base and overlay. Drop overlay entries that
    now match base (the session reverted them). Tombstone files the
    worktree no longer contains but the base still does.

    Idempotent: a clean worktree-matches-base state produces an
    embedded/dropped/tombstoned=0 response and walks the tree at hash-
    comparison cost only (no embedding).
    """
    data = request.get_json(force=True)
    project_dir = data.get("project_dir")
    worktree_root = data.get("worktree_root")
    if not project_dir:
        return jsonify({"error": "project_dir required"}), 400
    if not worktree_root:
        return jsonify({"error": "worktree_root required"}), 400
    if not os.path.isdir(worktree_root):
        return jsonify({"error": f"not a directory: {worktree_root}"}), 400

    base_store = _get_store(project_dir)
    if base_store is None:
        return jsonify(
            {"error": f"base index not built for {project_dir} — call /index first"}
        ), 400

    overlay = _get_overlay(worktree_root)
    proj_lock = _get_project_lock(project_dir)

    try:
        t0 = time.time()
        # Walk the worktree once. chunk_directory emits chunks with
        # paths relative to its root, matching how the base store keys
        # its chunks (relative to project_dir). Same project layout in
        # both, so relative keys align.
        wt_chunks = chunk_directory(worktree_root)
        by_file: dict[str, list] = {}
        for c in wt_chunks:
            by_file.setdefault(c.file_path, []).append(c)

        with proj_lock:
            base_hashes = base_store.get_all_file_hashes()
            overlay_hashes = overlay.get_all_file_hashes()
            tombstoned = overlay.tombstoned_paths()

            files_to_embed: list[tuple[str, list]] = []
            files_to_drop: list[str] = []  # remove from overlay
            files_to_tombstone: list[str] = []  # mark deleted in overlay

            for rel, chunks in by_file.items():
                current = {c.content_hash for c in chunks}
                base = base_hashes.get(rel, set())
                ov = overlay_hashes.get(rel, set())

                if current and current == base:
                    # Worktree file matches base — overlay should not
                    # claim it (and any tombstone should clear).
                    if rel in overlay_hashes or rel in tombstoned:
                        files_to_drop.append(rel)
                elif current == ov and current:
                    # Overlay already has this exact version.
                    pass
                else:
                    files_to_embed.append((rel, chunks))

            # Files the base has but the worktree doesn't — the session
            # deleted them. Tombstone in overlay so base hits get masked.
            # Skip ones already tombstoned so the count reflects only
            # newly-discovered deletions (lets the caller log meaningful
            # "actually moved" signal vs. a steady-state no-op).
            for rel in base_hashes:
                if rel not in by_file and rel not in tombstoned:
                    files_to_tombstone.append(rel)

            # Overlay entries for files that no longer exist anywhere —
            # drop them (no point keeping stale chunks for a path the
            # session has abandoned and base doesn't have either).
            for rel in overlay_hashes:
                if rel not in by_file and rel not in base_hashes:
                    files_to_drop.append(rel)

            embedded = 0
            if files_to_embed:
                init_embedder()
                flat = [c for _, fcs in files_to_embed for c in fcs]
                contents = [c.content for c in flat]
                embeddings = embed_documents(contents)
                offset = 0
                for rel, chunks in files_to_embed:
                    n = len(chunks)
                    overlay.upsert_chunks(
                        file_path=rel,
                        contents=[c.content for c in chunks],
                        start_lines=[c.start_line for c in chunks],
                        end_lines=[c.end_line for c in chunks],
                        languages=[c.language for c in chunks],
                        parent_scopes=[c.parent_scope for c in chunks],
                        content_hashes=[c.content_hash for c in chunks],
                        embeddings=embeddings[offset : offset + n],
                    )
                    overlay.clear_deleted(rel)
                    offset += n
                    embedded += 1

            for rel in files_to_drop:
                overlay.delete_file(rel)
                overlay.clear_deleted(rel)

            for rel in files_to_tombstone:
                overlay.mark_deleted(rel)

        elapsed = round(time.time() - t0, 2)
        print(
            f"[indexer] reconcile {worktree_root}: "
            f"embedded={embedded} dropped={len(files_to_drop)} "
            f"tombstoned={len(files_to_tombstone)} in {elapsed}s",
            file=sys.stderr,
            flush=True,
        )
        return jsonify(
            {
                "embedded": embedded,
                "dropped": len(files_to_drop),
                "tombstoned": len(files_to_tombstone),
                "time_s": elapsed,
            }
        )
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/status", methods=["POST", "GET"])
def handle_status():
    """Return current index state for a project.

    Accepts either POST {project_dir} or GET ?project_dir=...
    """
    if request.method == "POST":
        data = request.get_json(silent=True) or {}
        project_dir = data.get("project_dir")
    else:
        project_dir = request.args.get("project_dir")

    if not project_dir:
        return jsonify({"error": "project_dir required"}), 400

    state = _get_state(project_dir)
    return jsonify(_public_state(state))


@app.route("/shutdown", methods=["POST"])
def handle_shutdown():
    """Graceful shutdown."""
    with _registry_lock:
        for store in _stores.values():
            try:
                store.close()
            except Exception:
                pass
        _stores.clear()
    with _overlay_lock:
        for ov in _overlays.values():
            try:
                ov.close()
            except Exception:
                pass
        _overlays.clear()
    func = request.environ.get("werkzeug.server.shutdown")
    if func:
        func()
    else:
        os._exit(0)
    return jsonify({"ok": True})


def main() -> None:
    parser = argparse.ArgumentParser(description="Codebase index server")
    parser.add_argument(
        "--port",
        type=int,
        default=0,
        help="Port to listen on (0 = auto-assign)",
    )
    args = parser.parse_args()

    # Disable Flask's banner and request logging.
    import logging
    log = logging.getLogger("werkzeug")
    log.setLevel(logging.ERROR)

    # Daemon mode: we no longer watch parent stdin. The node-side
    # daemon launcher is responsible for spawning us detached and
    # writing the portfile; we live until /shutdown or SIGTERM.

    # Bind via werkzeug so the socket goes straight into LISTEN state
    # — no probe-and-close dance. The previous implementation bound a
    # throwaway socket, called .close() (releasing the port), printed
    # the handshake, then asked Flask to re-bind. On a busy Windows
    # runner the window between close and re-bind let pings hit a
    # closed port; the daemon was reported "spawned" but every
    # subsequent /ping returned ECONNREFUSED, the manager re-spawned
    # in a loop, and indexProject eventually bailed with `fetch
    # failed`. Caught by the new bundled-binaries smoke as
    # `[smoke:race fail]` after `[indexer] kickoff failed: fetch
    # failed`. make_server returns with the socket already listening,
    # so by the time we print the handshake the daemon is reachable.
    from werkzeug.serving import make_server
    server = make_server("127.0.0.1", args.port, app, threaded=True)
    port = server.server_port

    # Print the port as a JSON line so the launcher can capture it.
    print(json.dumps({"port": port, "pid": os.getpid()}), flush=True)

    # Block accepting requests on the already-bound socket.
    server.serve_forever()


if __name__ == "__main__":
    main()
