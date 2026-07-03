# Hybrid Code Search (FTS + grep + semantic + mixed re-rank) — Design

**Date:** 2026-07-04
**Supersedes/extends:** `2026-07-03-semantic-search-fix-design.md` (the semantic freshness
fixes are folded into this work).
**Repos:** `ugly-studio` (host — Python indexer + `codebase.search` channel) and
`ugly-code` (consumers — the agent `grep` tool + a new FilePanel search UI).

## Goal

One shared hybrid-search backend exposing four retrieval modes — **grep**
(ripgrep regex/exact), **fts** (SQLite FTS5 / BM25), **semantic** (embedding
vector search), and **mixed** (FTS + semantic candidates re-ranked by a
cross-encoder). Both the coding agent's `grep` tool and a new **FilePanel search
UI** consume it, so the panel is a direct, manual harness for testing retrieval
effectiveness against the exact search the agent uses.

## Non-goals

- No new UI framework or panel system — extend the existing `FilePanel.tsx`.
- No LM-based reranking (the coding model) — the re-ranker is a dedicated ONNX
  cross-encoder.
- `grep` (regex) is NOT fused into `mixed` — it stays a separate exact mode.
  `mixed` fuses only the two *ranked* retrievers (FTS + semantic).
- No change to the chunker/embedder internals beyond adding the FTS table and
  the freshness call-sites.

## Architecture

```
FilePanel (ugly-code) ─┐                             ┌─ FTS5 (BM25)        ┐
                       ├─ codebase.search ───────────┤─ vec_chunks (sem.)  ├─ cross-encoder
grep tool  (ugly-code) ┘   { mode, query, limit,     └─ ripgrep (grep)     ┘   re-rank (mixed)
                            path?, worktreeRoot? }
```

- **Host (ugly-studio):** the Python indexer daemon (`server/coding-agent/indexer/`)
  gains an FTS5 table + a cross-encoder reranker + hybrid `mixed` search. The
  `codebase.search` native channel (`server/coding-agent/codebaseNative.ts` →
  `manager.ts`/`client.ts` → `server.py`) gains a `mode` param and returns
  scored, provenance-tagged results. `grep` mode runs ripgrep host-side (file
  based), independent of the SQLite index.
- **Client (ugly-code):** `grep` tool adds `mode: 'fts' | 'mixed'`; `FilePanel.tsx`
  adds a search section. Both call the same channel.

## Components

### 1. FTS5 index (Python `store.py`)

- Add an FTS5 **external-content** virtual table over `chunks.content`
  (`content='chunks', content_rowid='id'`, `tokenize='unicode61'`), kept in sync
  with `chunks` via triggers (or explicit upsert in `upsert_chunks` /
  `delete_*`). External-content → near-zero extra storage (FTS stores only the
  index, not a copy of the text).
- `fts_search(query, limit, scope, extensions)` → BM25-ranked rows joined back to
  `chunks` for metadata. Query is sanitized for FTS5 syntax (quote bare terms;
  strip operators unless the caller opts into raw FTS syntax).

### 2. Cross-encoder re-ranker (Python `reranker.py`, new)

- Model: **`jinaai/jina-reranker-v2-base-multilingual`** (ONNX, ~278MB), swappable
  via `UGLY_STUDIO_RERANK_MODEL`. Provisioned exactly like the embedder
  (`embedder.py` pattern): download on first use to
  `~/.ugly-studio/coding-agent/models/jina-reranker-v2/`, run on CPU via
  `onnxruntime`, threads capped, mem-arena bounded. Lazy singleton.
- `rerank(query, candidates, top_k) -> [(candidate, score)]`: tokenize each
  `(query, chunk.content)` pair (truncate to model max, e.g. 512 tokens),
  batch through the ONNX graph, return the logit score. Ablation gate
  `UGLY_STUDIO_DISABLE_RERANK=1` → fall back to RRF fusion so `mixed` still works
  without the model.

### 3. Hybrid `mixed` search (Python `server.py`/`store.py`)

1. Gather top-`N` (default 30) from **FTS** and top-`N` from **semantic** in
   parallel (both already scoped/overlay-aware).
2. **Dedupe** by `(file_path, start_line, end_line)` — a chunk found by both
   retrievers is one candidate carrying both sub-scores.
3. **Re-rank** the deduped candidate set with the cross-encoder; sort by rerank
   score; return top-`limit`. (If the reranker is disabled/unavailable, fuse by
   Reciprocal Rank Fusion instead and tag `rerank_score: null`.)

### 4. Channel API (`codebaseNative.ts` + `manager.ts` + `client.ts` + `server.py`)

`codebase.search` request: `{ projectPath, mode, query, limit?, path?, worktreeRoot? }`
where `mode ∈ {grep, fts, semantic, mixed}` (default `mixed`).

Response — a discriminated status (replacing the silent `null → []`):
```ts
type SearchResponse =
  | { status: 'ready'; results: SearchHit[] }
  | { status: 'indexing' | 'provisioning' | 'downloading-model' }
  | { status: 'unavailable'; error: string };

interface SearchHit {
  file_path: string; start_line: number; end_line: number; content: string;
  mode: 'grep' | 'fts' | 'semantic' | 'mixed';
  score: number;                 // the mode's primary score (rerank for mixed)
  fts_rank?: number;             // present when FTS contributed
  semantic_score?: number;       // present when semantic contributed
  rerank_score?: number | null;  // present for mixed (null if reranker disabled)
}
```
`grep` mode: `manager.ts`/channel shells ripgrep (reuse the grep tool's arg
builder where practical) and maps hits to `SearchHit` with `mode:'grep'`.

### 5. Semantic freshness fix (folded in)

Per the prior design doc, now implemented alongside:
- **Incremental re-index**: client drains a per-session dirty-set (populated by
  `write`/`edit`/`multiedit`) before each search and calls a new
  `codebase.update` channel → `/update` (writes land in the worktree overlay).
- **Reconcile on session start**: `codebaseReadiness` calls `codebase.reconcile`
  → `/reconcile` after the base index is ready.
- **Visible status + no silent failures**: `manager.indexerSearch` returns the
  discriminated `SearchResponse` above (no `catch → null`); the client surfaces
  `indexing`/`provisioning`/`unavailable` instead of empty results.
- **Model-version stamp**: the index stores the embedder model id; a mismatch
  forces re-index (prevents mixing Nomic/Jina vector spaces).

### 6. `grep` tool (ugly-code `client/agent/tools/grep.ts`)

- Add `'fts'` and `'mixed'` to the `mode` enum + schema + description. Both route
  to `codebase.search` (like the existing `semantic` branch) with the mode
  passed through. `mixed` is described as the best default for natural-language
  "where is X handled" lookups; `fts` for keyword/identifier ranking.
- Result formatting mirrors the semantic branch, appending provenance
  (`(mixed 0.87 · fts#3 · sem 0.71)`).

### 7. FilePanel search UI (ugly-code `client/studio/panels/FilePanel.tsx`)

- A collapsible **Search** section: query `<input>`, four **mode tabs**
  (grep / fts / semantic / mixed), an optional `limit`, and an
  include-glob/scope field.
- **Results list**: each hit renders `file_path:start-end`, a content snippet
  (first ~3 lines), and a **score/provenance line** (`mixed 0.87 · fts#3 ·
  sem 0.71`). Click → open the file at that line (reuse FilePanel's existing
  open-file affordance).
- A **status pill** reflecting `SearchResponse.status`
  (indexing / downloading-model / ready / unavailable) so backend state is
  visible while testing.
- Debounced submit (Enter or button); no live-as-you-type (searches are
  non-trivial and, for mixed, run a model).

## Data flow (a `mixed` query)

1. FilePanel/grep → `codebase.search({ mode:'mixed', query, worktreeRoot })`.
2. Channel drains the client dirty-set via `codebase.update` (freshness), then
   `manager.indexerSearch` → daemon `POST /search`.
3. `server.py`: FTS top-N ∥ semantic top-N → dedupe → cross-encoder rerank →
   top-`limit`, each tagged with provenance scores.
4. Response bubbles back as `{ status:'ready', results }`; the panel renders the
   scored list; the grep tool formats it as text for the model.

## Error handling

- **Reranker/embedder not downloaded yet** → `status:'downloading-model'` (panel
  shows the pill; grep tool tells the model to retry / use `fts`|`exact`).
- **Index cold/indexing** → `status:'indexing'`.
- **Daemon down / python unprovisioned** → `status:'unavailable'` with the error
  (no more silent empty results).
- **Reranker disabled** (`UGLY_STUDIO_DISABLE_RERANK=1`) → `mixed` uses RRF,
  `rerank_score:null`.
- **FTS syntax error** on a raw query → sanitize + retry as a phrase; never 500.

## Testing

- **Client pure-logic (vitest, node env):** grep `fts`/`mixed` mode dispatch +
  result/provenance formatting; FilePanel result-row + score-line rendering
  (pure formatter extracted from the component); the dirty-set drain logic;
  the `SearchResponse` status → UI-state mapping.
- **Python (indexer):** FTS5 sync (upsert/delete keeps FTS in step with chunks);
  `fts_search` BM25 ordering on a fixture corpus; dedupe/merge of FTS+semantic
  candidates; rerank ordering with a **mocked** ONNX scorer (deterministic);
  a seeded relevance case asserting `mixed` ranks the known-relevant chunk above
  what `fts` or `semantic` alone return.
- **Manual:** the FilePanel itself — run identical queries across the four tabs
  and compare rankings/scores. This is the effectiveness harness.

## Implementation order (plan will split here)

**Layer A — backend (untestable-without → build first):** FTS5 table + `fts_search`;
`reranker.py` + provisioning; `mixed` hybrid + dedupe; the freshness call-sites;
the `codebase.search` `mode` + `SearchResponse` contract; `codebase.update`/
`reconcile` channels.

**Layer B — consumers:** grep `fts`/`mixed` modes; FilePanel search UI.

Layer B is verifiable only once A is deployed to the host, so A lands first.
