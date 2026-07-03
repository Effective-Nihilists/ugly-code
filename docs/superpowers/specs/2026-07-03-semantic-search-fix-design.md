# Semantic Code Search Fix — Design

**Status:** Design only. Do NOT implement yet. Sequencing (per the user):
**tool correction → tool e2e testing → manual prod verification → THEN this fix.**

**Date:** 2026-07-03
**Repos touched:** `ugly-studio` (host / Python indexer) and `ugly-code` (client agent).

---

## TL;DR

Semantic search is **not gone**. The Python embedding indexer (`jinaai/jina-embeddings-v2-base-code`, quantized ONNX, downloaded at runtime; SQLite + `sqlite-vec` store; git-worktree overlay) was faithfully ported into ugly-studio's host and is reachable through the `codebase.search` UglyNative channel. What regressed is **freshness and cold-start reliability**, because the port kept the indexer functions but **dropped their call-sites**. Three concrete gaps, in priority order:

1. **Stale index / empty overlay** — nothing calls `indexerUpdateFiles` after edits or `reconcileWorktreeOverlay` on session start. The agent searches a base index that never sees its own edits, and the worktree overlay is always empty. *(Dominant symptom.)*
2. **Silent lazy cold start** — no `initProject`-style visible pre-provision; uv → CPython 3.12 → ~200MB pip → 162MB HF model download all happen lazily inside the first request, and every failure collapses to `[]` at both `manager.ts` and the client tool, so "cold" is indistinguishable from "broken." The agent trains itself onto the grep fallback.
3. **Model swap without invalidation** — the embedder was swapped `nomic-embed-text-v1.5` → `jina-embeddings-v2-base-code` (both 768-dim, same schema) with no model-version stamp, so any pre-swap index returns plausible-but-wrong low-relevance matches instead of re-embedding.

## Evidence (call-site gaps)

- Client tool: `ugly-code/client/agent/tools.ts:79-100` invokes `codebase.search` with `projectPath` + `worktreeRoot: ctx.workspaceDir`; empty results → soft "fall back to rg" message (`:94-96`). Failures are invisible.
- Host channel: `ugly-studio/server/coding-agent/codebaseNative.ts:41-53` (`codebase.search` → `indexerSearch`). Router: `ugly-studio/electron/uglyNative/router.ts:571-573` (`codebase.*`).
- `indexerSearch` swallows all errors → `null`, mapped to `{ results: [] }` (`ugly-studio/server/coding-agent/indexer/manager.ts:353-374`).
- **Dead functions (zero external callers):** `indexerUpdateFiles` (`manager.ts:379`), `reconcileWorktreeOverlay` (`manager.ts:287`), `client.updateFiles` / `client.reconcileOverlay` (`indexer/client.ts`). The Python side fully supports them (`server.py` `/update`, `/reconcile`; `overlay.py merged_search`).
- **Dead pre-install:** `initProject` / `ensureIndexerDepsInstalled` (`indexer/daemon.ts:206-216, 387-435`) have no external caller — provisioning runs lazily in `spawnDaemon()`.
- **One thing wired correctly:** `ugly-code/client/studio/agent/codebaseReadiness.ts:28` calls `codebase.ensureIndex` on session start against the **base** project, so the base index does get kicked off. Freshness + cold-start visibility are what's missing.
- Embedder swap with no version stamp: `ugly-studio/server/coding-agent/indexer/embedder.py:26-46` (no invalidation on model change found in the index path).

## Goals / Non-goals

**Goals**
- The agent's own edits are searchable within a turn or two (incremental re-index into the worktree overlay).
- Session start repairs overlay drift (reconcile) so resumed sessions aren't stale.
- Cold-start provisioning is explicit and observable; failures surface instead of masquerading as "no matches."
- Model changes force re-index rather than silently degrading quality.

**Non-goals**
- No new embedding model, no schema change (stay 768-dim / `sqlite-vec`).
- No File-Tree panel semantic UI (the monolith's `studio/server/semantic-search.ts` consumer is out of scope; agent search only).
- No change to chunking/embedding internals — they work; only the call-graph and observability change.

---

## Fix components

### 1. Wire incremental re-index (dominant fix)

**Host** — add two channels in `codebaseNative.ts`, wired to the already-present manager functions:
- `codebase.update` → `indexerUpdateFiles(projectPath, files, worktreeRoot)` → daemon `POST /update`. With `worktreeRoot` set, writes land in the session overlay.
- `codebase.reconcile` → `reconcileWorktreeOverlay(projectPath, worktreeRoot)` → daemon `POST /reconcile`.

**Client** — mirror the monolith's dirty-file mechanism, but across the bridge:
- Maintain a per-session dirty-path set in the client agent (module-scoped to the session, mirroring `INDEXER_DIRTY_FILES_KEY`). `write_file` / `edit_file` / `multiedit` add the resolved path.
- **Drain before each `codebase_search`** (cheapest, closest to the monolith): before invoking `codebase.search`, if the dirty set is non-empty, `await codebase.update({ projectPath, files, worktreeRoot })` then clear. This guarantees a search reflects edits made since the last search without a per-edit round trip.
- Files: `ugly-code/client/agent/tools.ts` (the `write_file`/`edit_file`/`multiedit`/`codebase_search` cases), a small `codebaseDirty.ts` helper for the set.

*Rationale for drain-before-search over update-per-edit:* batches multiple edits into one re-embed call, and only pays when semantic search is actually used.

### 2. Reconcile overlay on session start

- In `codebaseReadiness.ts` startup (already calls `codebase.ensureIndex`), after the base index reports ready, call `codebase.reconcile({ projectPath, worktreeRoot })` so a resumed worktree repairs its overlay (embed files differing from base+overlay, drop reverted entries, tombstone session-deleted files).
- Guard: only when `worktreeRoot` (the agent runs in a worktree) is present.
- File: `ugly-code/client/studio/agent/codebaseReadiness.ts`.

### 3. Visible pre-provision + non-silent failures

- **Host:** add a `codebase.warmup` (or extend `codebase.ensureIndex`) that calls the existing `ensureIndexerDepsInstalled` / venv-python provision path **eagerly** and returns a structured status (`provisioning` | `downloading-model` | `indexing` | `ready` | `error{message}`), rather than doing it lazily inside the first search.
- **Change the empty-vs-error contract:** `indexerSearch` (and the `codebase.search` channel) must return a discriminated result — `{ status: 'ready', results }` | `{ status: 'indexing' }` | `{ status: 'unavailable', error }` — instead of `null → []`. `manager.ts:353-374` currently `catch { return null }`; replace with an error-carrying shape.
- **Client:** in `tools.ts`, distinguish the three: `ready+empty` → "no semantic matches, use rg"; `indexing` → tell the model the index is warming (retry later / use rg meanwhile); `unavailable` → surface the real error (and log it) so cold≠broken is visible.
- Files: `ugly-studio/server/coding-agent/codebaseNative.ts`, `.../indexer/manager.ts`, `.../indexer/daemon.ts`; `ugly-code/client/agent/tools.ts`, `codebaseReadiness.ts`.

### 4. Index-version stamp (quality)

- Stamp the index (a `meta` row in the SQLite store, or a sidecar file next to `codebase-index.db`) with the embedder model id + `embed_dim`.
- On daemon index open: if the stamp mismatches the current `embedder.MODEL_REPO`, treat the base index as invalid and re-index (or drop + rebuild). This forces a clean re-embed after a model swap instead of mixing vector spaces.
- Files: `ugly-studio/server/coding-agent/indexer/store.py` (schema `meta` + open-time check), `embedder.py` (expose model id).

---

## Rollout order (within this fix, once we reach it)

1. Index-version stamp (#4) — cheap, prevents rebuilding-on-top-of-bad-vectors during the rest of the work.
2. Non-silent failures + status contract (#3, observability half) — so we can actually see whether the next steps work.
3. Incremental re-index (#1) — the dominant freshness fix.
4. Reconcile on start (#2).
5. Visible pre-provision (#3, warmup half).

## Verification plan (deferred to the fix phase)

Per the `verify` skill — runtime observation, driven through the deployed agent in real Studio (the same Electron-harness path used for the tool e2e), not unit tests:
- Cold machine: warm up → observe status transitions (`provisioning` → `downloading-model` → `indexing` → `ready`); confirm the 162MB Jina model lands in `~/.ugly-studio/coding-agent/models/jina-v2-code/`.
- Freshness: agent writes a new symbol, then `codebase_search` for it in the same session → it appears (overlay hit), proving `codebase.update` drained.
- Failure surfacing: block the HF host / corrupt the venv → `codebase_search` returns a visible `unavailable` error, not silent `[]`.
- Model-swap: point at a stale (pre-Jina) index → stamp mismatch forces re-index rather than low-relevance hits.

## Open questions for the fix phase

- Where should the client dirty-set live so it survives the cross-device agent transport (module state vs. session doc)? Leaning module-per-session, drained before search.
- Should `codebase.warmup` block session start or run truly in the background with the status surfaced in the readiness pill? Leaning background + pill.
- Overlay lifecycle on worktree teardown — is there a cleanup path, or does `.ugly-studio/session-index.db` leak per session? (Investigate during implementation.)
