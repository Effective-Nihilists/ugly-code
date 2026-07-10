"""
Vector store backed by SQLite + sqlite-vec.

Stores code chunks with their embeddings in a single SQLite file.
Supports incremental updates via content hashing.
"""

from __future__ import annotations

import hashlib
import os
import sqlite3
import struct
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import numpy as np

try:
    import sqlite_vec
    HAS_SQLITE_VEC = True
except ImportError:
    HAS_SQLITE_VEC = False


@dataclass
class SearchResult:
    file_path: str
    start_line: int
    end_line: int
    content: str
    language: str
    parent_scope: str
    score: float


def _db_path(project_dir: str) -> str:
    """Return the index database path for a project.

    Default: `<project_dir>/.ugly-studio/codebase-index.db`. Living
    with the project means the index travels with `mv`/`cp` of the
    repo, a renamed project doesn't orphan its index in a home-dir
    hash-bucket, and `rm -rf .ugly-studio/` is a one-line nuke that
    doesn't leave cross-project leftovers.

    Fallback: if the project tree is unwritable (CI /nix/store
    mounts, read-only snapshots), fall back to the legacy home-dir
    cache at `~/.ugly-studio/coding-agent/indexes/{project_hash}.db`.
    Also honors `UGLY_STUDIO_CACHE` for the home-dir base when the
    fallback triggers.

    The node-side `projectInit` hook writes a `.metadata_never_index`
    sentinel and a `.gitignore` entry so the `.db` (plus WAL/SHM)
    files don't pollute Spotlight or `git status` — that setup runs
    once on project open, so by the time we land here the directory
    is ready.
    """
    # When `UGLY_INDEX_CACHE_KEY` is set, skip the in-repo path and
    # store the DB in the home cache keyed by that env var. Used by
    # the eval harness so re-runs of the same task (in fresh
    # `mkdtemp` workspaces every time) share one index — without
    # this, every eval run re-indexes the codebase from scratch
    # because the in-repo `.ugly-studio/codebase-index.db` lives in
    # a tmpdir that gets nuked between runs.
    cache_key = os.environ.get("UGLY_INDEX_CACHE_KEY")
    if cache_key:
        base = os.environ.get(
            "UGLY_STUDIO_CACHE",
            os.path.join(os.path.expanduser("~"), ".ugly-studio"),
        )
        key_hash = hashlib.md5(cache_key.encode("utf-8")).hexdigest()[:12]
        db_dir = os.path.join(base, "coding-agent", "indexes")
        os.makedirs(db_dir, exist_ok=True)
        return os.path.join(db_dir, f"key-{key_hash}.db")

    in_repo_dir = os.path.join(project_dir, ".ugly-studio")
    try:
        os.makedirs(in_repo_dir, exist_ok=True)
        return os.path.join(in_repo_dir, "codebase-index.db")
    except OSError:
        # Fall through to home-dir if the project tree is
        # unwritable (CI /nix/store mounts, etc.).
        pass

    base = os.environ.get(
        "UGLY_STUDIO_CACHE",
        os.path.join(os.path.expanduser("~"), ".ugly-studio"),
    )
    project_hash = hashlib.md5(
        project_dir.encode("utf-8")
    ).hexdigest()[:12]
    db_dir = os.path.join(base, "coding-agent", "indexes")
    os.makedirs(db_dir, exist_ok=True)
    return os.path.join(db_dir, f"{project_hash}.db")


def _serialize_f32(vec: np.ndarray) -> bytes:
    """Serialize a float32 vector to bytes for sqlite-vec."""
    return struct.pack(f"{len(vec)}f", *vec.tolist())


def _normalize_extensions(
    exts: Optional[list[str]],
) -> Optional[set[str]]:
    """Return a lowercased set of extensions with leading dots, or None
    if the caller passed no filter. Accepts "ts" or ".ts" interchangeably.
    """
    if not exts:
        return None
    out: set[str] = set()
    for raw in exts:
        e = raw.strip().lower()
        if not e:
            continue
        out.add(e if e.startswith(".") else f".{e}")
    return out or None


def _ext_ok(file_path: str, ext_set: set[str]) -> bool:
    """True if file_path's extension (with leading dot) is in ext_set.
    ext_set entries carry a leading dot (see _normalize_extensions)."""
    dot = file_path.rfind(".")
    return dot != -1 and file_path[dot:].lower() in ext_set


class VectorStore:
    """SQLite + sqlite-vec backed vector store for code chunks."""

    def __init__(self, project_dir: str, embed_dim: int = 768) -> None:
        self.project_dir = project_dir
        self.embed_dim = embed_dim
        self.db_path = _db_path(project_dir)
        self._conn: Optional[sqlite3.Connection] = None

    def _connect(self) -> sqlite3.Connection:
        if self._conn is not None:
            return self._conn

        conn = sqlite3.connect(self.db_path, check_same_thread=False)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")

        if HAS_SQLITE_VEC:
            conn.enable_load_extension(True)
            sqlite_vec.load(conn)
            conn.enable_load_extension(False)

        self._conn = conn
        self._ensure_schema()
        return conn

    def _ensure_schema(self) -> None:
        conn = self._conn
        assert conn is not None

        conn.executescript("""
            CREATE TABLE IF NOT EXISTS chunks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                file_path TEXT NOT NULL,
                start_line INTEGER NOT NULL,
                end_line INTEGER NOT NULL,
                content TEXT NOT NULL,
                language TEXT NOT NULL,
                parent_scope TEXT NOT NULL DEFAULT '',
                content_hash TEXT NOT NULL,
                updated_at REAL NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_chunks_file
                ON chunks(file_path);
            CREATE INDEX IF NOT EXISTS idx_chunks_hash
                ON chunks(content_hash);

            CREATE TABLE IF NOT EXISTS meta (
                key TEXT PRIMARY KEY,
                value TEXT
            );
        """)

        # FTS5 over chunk content (external-content: indexes chunks.content,
        # stores no copy). Kept in sync with `chunks` by triggers below.
        # `upsert_chunks` always delete_file + INSERT, so AI/AD triggers
        # cover updates — no update trigger needed.
        conn.executescript("""
            CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts
                USING fts5(content, content='chunks', content_rowid='id',
                           tokenize='unicode61');
            CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
                INSERT INTO chunks_fts(rowid, content) VALUES (new.id, new.content);
            END;
            CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
                INSERT INTO chunks_fts(chunks_fts, rowid, content)
                    VALUES('delete', old.id, old.content);
            END;
        """)

        if HAS_SQLITE_VEC:
            # Create the virtual table for vector search.
            try:
                conn.execute(
                    f"CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks "
                    f"USING vec0(embedding float[{self.embed_dim}])"
                )
            except sqlite3.OperationalError:
                # Table might already exist with different dimension.
                pass

        conn.commit()

    def get_indexed_hashes(self, file_path: str) -> dict[str, int]:
        """Return {content_hash: chunk_id} for all chunks of a file."""
        conn = self._connect()
        rows = conn.execute(
            "SELECT id, content_hash FROM chunks WHERE file_path = ?",
            (file_path,),
        ).fetchall()
        return {row[1]: row[0] for row in rows}

    def get_all_file_hashes(self) -> dict[str, set[str]]:
        """Return {file_path: {content_hash, ...}} for every indexed file.

        Used at the start of an index run to skip files whose chunks are
        already fully up to date — lets a crashed-and-restarted index
        resume where it left off instead of starting from zero.
        """
        conn = self._connect()
        rows = conn.execute(
            "SELECT file_path, content_hash FROM chunks"
        ).fetchall()
        result: dict[str, set[str]] = {}
        for file_path, content_hash in rows:
            result.setdefault(file_path, set()).add(content_hash)
        return result

    def delete_file(self, file_path: str) -> None:
        """Remove all chunks for a file."""
        conn = self._connect()
        ids = conn.execute(
            "SELECT id FROM chunks WHERE file_path = ?", (file_path,)
        ).fetchall()

        if ids:
            id_list = [row[0] for row in ids]
            placeholders = ",".join("?" * len(id_list))
            conn.execute(
                f"DELETE FROM chunks WHERE id IN ({placeholders})", id_list
            )
            if HAS_SQLITE_VEC:
                conn.execute(
                    f"DELETE FROM vec_chunks WHERE rowid IN ({placeholders})",
                    id_list,
                )
        conn.commit()

    def upsert_chunks(
        self,
        file_path: str,
        contents: list[str],
        start_lines: list[int],
        end_lines: list[int],
        languages: list[str],
        parent_scopes: list[str],
        content_hashes: list[str],
        embeddings: np.ndarray,
    ) -> int:
        """Insert or update chunks for a file.  Returns count inserted."""
        conn = self._connect()
        now = time.time()

        # Delete existing chunks for this file.
        self.delete_file(file_path)

        count = 0
        for i in range(len(contents)):
            cursor = conn.execute(
                """INSERT INTO chunks
                   (file_path, start_line, end_line, content, language,
                    parent_scope, content_hash, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    file_path,
                    start_lines[i],
                    end_lines[i],
                    contents[i],
                    languages[i],
                    parent_scopes[i],
                    content_hashes[i],
                    now,
                ),
            )
            chunk_id = cursor.lastrowid

            if HAS_SQLITE_VEC and chunk_id is not None:
                vec_bytes = _serialize_f32(embeddings[i])
                conn.execute(
                    "INSERT INTO vec_chunks (rowid, embedding) VALUES (?, ?)",
                    (chunk_id, vec_bytes),
                )
            count += 1

        conn.commit()
        return count

    def get_meta(self, key: str) -> Optional[str]:
        row = self._connect().execute(
            "SELECT value FROM meta WHERE key = ?", (key,)
        ).fetchone()
        return row[0] if row else None

    def set_meta(self, key: str, value: str) -> None:
        conn = self._connect()
        conn.execute(
            "INSERT INTO meta(key, value) VALUES(?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, str(value)),
        )
        conn.commit()

    def clear_all(self) -> None:
        """Drop every indexed chunk (chunks + vec + fts). Used when the
        embedder model changes so we don't mix vector spaces."""
        conn = self._connect()
        conn.execute("DELETE FROM chunks")  # AD trigger clears chunks_fts
        if HAS_SQLITE_VEC:
            conn.execute("DELETE FROM vec_chunks")
        conn.commit()

    def mixed_search(
        self,
        query_embedding: np.ndarray,
        query_text: str,
        limit: int = 10,
        scope: Optional[str] = None,
        extensions: Optional[list[str]] = None,
        fan_out: int = 30,
    ) -> list:
        """Hybrid search: gather top-`fan_out` from FTS + semantic, dedupe by
        (file, span), then re-rank with the cross-encoder. Falls back to RRF
        fusion when the re-ranker is disabled/unavailable. Returns a list of
        `hybrid.Candidate` (score set; rerank_score set when the re-ranker
        ran)."""
        import reranker
        from hybrid import dedupe_candidates, rrf_fuse

        fts = self.fts_search(query_text, fan_out, scope, extensions)
        sem = self.search(query_embedding, fan_out, scope, extensions)
        cands = dedupe_candidates(fts, sem)
        if not cands:
            return []

        if reranker.available():
            scored = reranker.rerank(
                query_text, [c.result.content for c in cands], top_k=limit
            )
            out = []
            for idx, sc in scored:
                c = cands[idx]
                c.rerank_score = sc
                c.score = sc
                out.append(c)
            return out

        return rrf_fuse(cands)[:limit]

    @staticmethod
    def _fts_query(raw: str) -> str:
        """Turn a free-text/code query into a safe FTS5 MATCH expression.
        Each alphanumeric term becomes a PREFIX match (`term*`) so a query
        like "reconnect" hits camelCase identifiers ("reconnectWebsocket")
        that unicode61 keeps as one token; terms are OR-ed. Punctuation is
        dropped, so operators in code queries can't cause a syntax error.
        Empty query → a token that never matches."""
        import re
        terms = re.findall(r"[A-Za-z0-9]+", raw)
        return " OR ".join(f"{t}*" for t in terms) if terms else '"\x00"'

    def fts_search(
        self,
        query: str,
        limit: int = 10,
        scope: Optional[str] = None,
        extensions: Optional[list[str]] = None,
    ) -> list[SearchResult]:
        """Full-text (BM25) search over chunk content. Returns ranked results
        with score = -bm25 (flipped so higher = better, matching semantic)."""
        conn = self._connect()
        ext_set = _normalize_extensions(extensions)
        over = max(limit * 3, limit) if (scope or ext_set) else limit
        rows = conn.execute(
            """SELECT c.file_path, c.start_line, c.end_line, c.content,
                      c.language, c.parent_scope, bm25(chunks_fts) AS rank
               FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid
               WHERE chunks_fts MATCH ? ORDER BY rank LIMIT ?""",
            (self._fts_query(query), over),
        ).fetchall()
        out: list[SearchResult] = []
        for fp, sl, el, content, lang, scope_, rank in rows:
            if scope and not fp.startswith(scope):
                continue
            if ext_set and not _ext_ok(fp, ext_set):
                continue
            out.append(
                SearchResult(
                    file_path=fp, start_line=sl, end_line=el, content=content,
                    language=lang, parent_scope=scope_, score=-float(rank),
                )
            )
            if len(out) >= limit:
                break
        return out

    def search(
        self,
        query_embedding: np.ndarray,
        limit: int = 10,
        scope: Optional[str] = None,
        extensions: Optional[list[str]] = None,
    ) -> list[SearchResult]:
        """Search for similar chunks.  Returns ranked results.

        `scope` is an absolute path prefix; only results whose file_path
        starts with it are returned.
        `extensions` is a list of file extensions (with or without the
        leading dot, case-insensitive); only matching files are returned.
        """
        conn = self._connect()

        ext_set = _normalize_extensions(extensions)

        if not HAS_SQLITE_VEC:
            return self._search_brute_force(
                query_embedding, limit, scope, ext_set
            )

        vec_bytes = _serialize_f32(query_embedding)

        # Over-fetch when any filter is active so the post-filter result
        # set still reaches `limit`.
        overfetch = limit * 3 if (scope or ext_set) else limit

        rows = conn.execute(
            """
            SELECT
                vec_chunks.rowid,
                vec_chunks.distance
            FROM vec_chunks
            WHERE embedding MATCH ?
            ORDER BY distance
            LIMIT ?
            """,
            (vec_bytes, overfetch),
        ).fetchall()

        if not rows:
            return []

        # Fetch chunk metadata.
        results: list[SearchResult] = []
        for rowid, distance in rows:
            chunk = conn.execute(
                """SELECT file_path, start_line, end_line, content,
                          language, parent_scope
                   FROM chunks WHERE id = ?""",
                (rowid,),
            ).fetchone()
            if chunk is None:
                continue

            file_path, start_line, end_line, content, language, parent_scope = chunk

            # Apply filters.
            if scope and not file_path.startswith(scope):
                continue
            if ext_set is not None:
                ext = os.path.splitext(file_path)[1].lower()
                if ext not in ext_set:
                    continue

            # Convert distance to similarity score (cosine distance → similarity).
            score = 1.0 - distance

            results.append(
                SearchResult(
                    file_path=file_path,
                    start_line=start_line,
                    end_line=end_line,
                    content=content,
                    language=language,
                    parent_scope=parent_scope,
                    score=score,
                )
            )
            if len(results) >= limit:
                break

        return results

    def _search_brute_force(
        self,
        query_embedding: np.ndarray,
        limit: int,
        scope: Optional[str],
        ext_set: Optional[set[str]] = None,
    ) -> list[SearchResult]:
        """Fallback brute-force cosine similarity when sqlite-vec missing."""
        conn = self._connect()
        where = "WHERE file_path LIKE ?" if scope else ""
        params = (f"{scope}%",) if scope else ()

        rows = conn.execute(
            f"SELECT id, file_path, start_line, end_line, content, "
            f"language, parent_scope FROM chunks {where}",
            params,
        ).fetchall()

        if ext_set is not None:
            rows = [
                r for r in rows
                if os.path.splitext(r[1])[1].lower() in ext_set
            ]

        if not rows:
            return []

        # This is O(N) but works for repos up to ~50K chunks.
        # For larger repos, sqlite-vec should be installed.
        scores: list[tuple[float, tuple]] = []
        for row in rows:
            chunk_id = row[0]
            # Without sqlite-vec we can't retrieve stored embeddings,
            # so this fallback re-embeds at query time — too expensive.
            # Instead, just return most recent chunks as a degraded mode.
            scores.append((0.5, row))

        scores.sort(key=lambda x: -x[0])
        results: list[SearchResult] = []
        for score, row in scores[:limit]:
            results.append(
                SearchResult(
                    file_path=row[1],
                    start_line=row[2],
                    end_line=row[3],
                    content=row[4],
                    language=row[5],
                    parent_scope=row[6],
                    score=score,
                )
            )
        return results

    def stats(self) -> dict:
        """Return index statistics."""
        conn = self._connect()
        total = conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
        files = conn.execute(
            "SELECT COUNT(DISTINCT file_path) FROM chunks"
        ).fetchone()[0]
        return {
            "total_chunks": total,
            "total_files": files,
            "db_path": self.db_path,
            "has_sqlite_vec": HAS_SQLITE_VEC,
        }

    def close(self) -> None:
        if self._conn:
            self._conn.close()
            self._conn = None
