# Hybrid Search Consumers (Plan 2 of 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Wire ugly-code to the deployed hybrid-search backend — the agent `grep` tool gains `fts`/`mixed` modes, the FilePanel gets a search UI to directly test the four modes, and the semantic freshness fixes (dirty-set drain + reconcile-on-start) are wired client-side.

**Architecture:** `codebase.search` now returns a discriminated `SearchResponse` with per-hit provenance (Plan 1). grep's index-backed modes and a new `<CodebaseSearch>` FilePanel section both call it and render provenance. A per-session dirty-set (populated by `write`/`edit`/`multiedit`) drains via `codebase.update` before each index search; `codebase.reconcile` fires at session start.

**Tech Stack:** TypeScript/React (ugly-code client over UglyNative), vitest (node env, pure-logic).

**Spec:** `docs/superpowers/specs/2026-07-04-hybrid-code-search-design.md`. Depends on Plan 1 (backend) being deployed to the host for live behavior; code + typecheck + unit tests do not.

## Global Constraints

- Modes: `grep`(client rg) / `fts` / `semantic` / `mixed`(default). (spec)
- `SearchResponse` = `{status:'ready',results:SearchHit[]} | {status:'indexing'|'provisioning'|'downloading-model'} | {status:'unavailable',error}`. `SearchHit` = `{file_path,start_line,end_line,content,mode,score,fts_rank?,semantic_score?,rerank_score?}`. (spec §4)
- Provenance line format: `mixed 0.87 · fts#3 · sem 0.71` (spec §4/§7).
- No emojis in UI — lucide icons only. (project rule)
- FilePanel popups/overlays: none needed — inline section.

## File Structure

- `client/agent/tools/searchResponse.ts` — CREATE: the `SearchResponse`/`SearchHit` types (client mirror of the host contract) + `formatSearchResult(resp, mode)` pure formatter (text for the agent).
- `client/agent/tools/grep.ts` — MODIFY: add `fts`/`mixed` to `GrepMode` + enum + description; route them (and `semantic`) through one `runIndexSearch(mode, args, ctx)` that handles `SearchResponse`.
- `client/agent/tools/codebaseDirty.ts` — CREATE: per-session dirty-path set (`markDirty(sessionId, path)`, `drainDirty(sessionId)`).
- `client/agent/tools.ts` — MODIFY: `write`/`edit`/`multiedit` call `markDirty`; index searches drain + `codebase.update` first.
- `client/studio/panels/CodebaseSearch.tsx` — CREATE: the search UI (query + mode tabs + results + status pill + provenance) — self-contained, `onOpen(path,line)` callback.
- `client/studio/panels/FilePanel.tsx` — MODIFY: mount `<CodebaseSearch onOpen={openFile}/>`.
- `client/studio/agent/codebaseReadiness.ts` — MODIFY: `codebase.reconcile` after base index ready.
- Tests: `tests/unit/tools/searchResponse.test.ts`, `tests/unit/tools/codebaseDirty.test.ts`, `tests/unit/panels/codebaseSearchFormat.test.ts`.

---

### Task 1: `SearchResponse` types + formatter + grep `fts`/`mixed`

**Files:**
- Create: `client/agent/tools/searchResponse.ts`, `tests/unit/tools/searchResponse.test.ts`
- Modify: `client/agent/tools/grep.ts`

**Interfaces:**
- Produces: `type SearchMode`, `interface SearchHit`, `type SearchResponse`, `formatSearchResult(resp: SearchResponse): string` (agent-facing text; provenance appended per hit).

- [ ] **Step 1: Failing test**

```ts
// tests/unit/tools/searchResponse.test.ts
import { describe, it, expect } from 'vitest';
import { formatSearchResult } from '../../../client/agent/tools/searchResponse';

describe('formatSearchResult', () => {
  it('renders ready hits with provenance', () => {
    const out = formatSearchResult({ status: 'ready', results: [
      { file_path: 'a.ts', start_line: 3, end_line: 5, content: 'x', mode: 'mixed',
        score: 0.87, fts_rank: 3, semantic_score: 0.71, rerank_score: 0.87 },
    ]});
    expect(out).toContain('a.ts:3-5');
    expect(out).toMatch(/mixed 0\.87/);
    expect(out).toMatch(/fts#3/);
    expect(out).toMatch(/sem 0\.71/);
  });
  it('reports non-ready statuses instead of empty', () => {
    expect(formatSearchResult({ status: 'indexing' })).toMatch(/indexing/i);
    expect(formatSearchResult({ status: 'downloading-model' })).toMatch(/download/i);
    expect(formatSearchResult({ status: 'unavailable', error: 'boom' })).toMatch(/boom/);
    expect(formatSearchResult({ status: 'ready', results: [] })).toMatch(/no matches/i);
  });
});
```

- [ ] **Step 2: Run → FAIL** (`Cannot find module '.../searchResponse'`).
Run: `cd /Users/admin/Documents/GitHub/ugly-code && npx vitest run tests/unit/tools/searchResponse.test.ts`

- [ ] **Step 3: Implement `searchResponse.ts`**

```ts
export type SearchMode = 'grep' | 'fts' | 'semantic' | 'mixed';
export interface SearchHit {
  file_path: string; start_line: number; end_line: number; content: string;
  mode: SearchMode; score: number;
  fts_rank?: number; semantic_score?: number; rerank_score?: number | null;
}
export type SearchResponse =
  | { status: 'ready'; results: SearchHit[] }
  | { status: 'indexing' | 'provisioning' | 'downloading-model' }
  | { status: 'unavailable'; error: string };

/** Provenance suffix like `mixed 0.87 · fts#3 · sem 0.71`. */
export function provenance(h: SearchHit): string {
  const parts = [`${h.mode} ${h.score.toFixed(2)}`];
  if (h.fts_rank !== undefined) parts.push(`fts#${h.fts_rank}`);
  if (h.semantic_score !== undefined) parts.push(`sem ${h.semantic_score.toFixed(2)}`);
  return parts.join(' · ');
}

/** Agent-facing text — never a silent empty list. */
export function formatSearchResult(resp: SearchResponse): string {
  if (resp.status === 'indexing') return '(codebase index still building — retry shortly, or use mode="exact")';
  if (resp.status === 'provisioning' || resp.status === 'downloading-model')
    return '(search model still downloading — retry shortly, or use mode="exact"/"fts")';
  if (resp.status === 'unavailable') return `(search unavailable: ${resp.error})`;
  if (resp.results.length === 0) return '(no matches — try mode="exact" or a different query)';
  return resp.results
    .map((h) => `${h.file_path}:${h.start_line}-${h.end_line}  (${provenance(h)})\n${h.content}`)
    .join('\n\n---\n\n');
}
```

- [ ] **Step 4: Run → PASS.** Then wire grep: in `grep.ts`, add `'fts' | 'mixed'` to `GrepMode`; add both to the `mode` enum in SPEC + a description note; replace `runSemantic` with a general `runIndexSearch(mode, args, ctx)` that invokes `codebase.search` with `{ mode, projectPath, query: args.pattern, limit, worktreeRoot }`, casts the result to `SearchResponse`, and returns `formatSearchResult(resp)`. Route `mode === 'semantic' | 'fts' | 'mixed'` to it in `run()`.

- [ ] **Step 5: Typecheck + test.**
Run: `npx tsc --noEmit -p tsconfig.json` (EXIT 0) and `npx vitest run tests/unit/tools/searchResponse.test.ts`.

- [ ] **Step 6: Commit**
```bash
git add client/agent/tools/searchResponse.ts client/agent/tools/grep.ts tests/unit/tools/searchResponse.test.ts
git commit -m "feat(agent): grep fts/mixed modes + SearchResponse formatting"
```

---

### Task 2: FilePanel search UI (`<CodebaseSearch>`)

**Files:**
- Create: `client/studio/panels/CodebaseSearch.tsx`, `client/studio/panels/codebaseSearchFormat.ts` (pure), `tests/unit/panels/codebaseSearchFormat.test.ts`
- Modify: `client/studio/panels/FilePanel.tsx`

**Interfaces:**
- Consumes: `installUglyNative().invoke('codebase.search', {...})`, `getActiveProjectPath`, `formatSearchResult`/`provenance`/`SearchHit` types, `FilePanel.openFile`.
- Produces: `<CodebaseSearch onOpen={(path:string, line:number)=>void} />`.

- [ ] **Step 1: Failing test** for the pure result-row formatter (extract rendering-independent logic):

```ts
// tests/unit/panels/codebaseSearchFormat.test.ts
import { describe, it, expect } from 'vitest';
import { resultLabel, snippet } from '../../../client/studio/panels/codebaseSearchFormat';

describe('codebaseSearchFormat', () => {
  it('labels a hit with path:line-range', () => {
    expect(resultLabel({ file_path: 'src/a.ts', start_line: 3, end_line: 5 } as any)).toBe('src/a.ts:3-5');
  });
  it('trims a snippet to the first 3 lines', () => {
    expect(snippet('a\nb\nc\nd\ne')).toBe('a\nb\nc');
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `codebaseSearchFormat.ts`**

```ts
import type { SearchHit } from '../../agent/tools/searchResponse';
export function resultLabel(h: Pick<SearchHit, 'file_path' | 'start_line' | 'end_line'>): string {
  return `${h.file_path}:${h.start_line}-${h.end_line}`;
}
export function snippet(content: string, lines = 3): string {
  return content.split('\n').slice(0, lines).join('\n');
}
```

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Implement `CodebaseSearch.tsx`** — a collapsible section: a query `<input>`, four mode buttons (grep/fts/semantic/mixed) as a segmented control (lucide `Search` icon; active button highlighted), an optional `limit` (default 10), a **status pill** (from `SearchResponse.status`), and a results list. On submit (Enter / button): for `grep` mode call the existing client rg path (reuse the grep tool's exact search via `dispatchTool('grep', { pattern, mode:'exact' }, ctx)` OR `installUglyNative` rg — simplest: `native`-side rg through the grep tool); for `fts`/`semantic`/`mixed` call `installUglyNative().invoke('codebase.search', { projectPath: getActiveProjectPath(), query, mode, limit })` and read `SearchResponse`. Render each hit: `resultLabel(h)` (clickable → `onOpen(h.file_path, h.start_line)`), `provenance(h)` line, `snippet(h.content)` in a `<pre>`. Debounced/explicit submit (no live-as-you-type). Full component code written against the current FilePanel styling conventions.

- [ ] **Step 6: Mount in FilePanel** — add `<CodebaseSearch onOpen={(p) => { void openFile(p); }} />` above the tree (or in a collapsible header). `openFile` exists at `FilePanel.tsx:161`.

- [ ] **Step 7: Typecheck + test + eslint.**
Run: `npx tsc --noEmit -p tsconfig.json`; `npx vitest run tests/unit/panels/codebaseSearchFormat.test.ts`.

- [ ] **Step 8: Commit**
```bash
git add client/studio/panels/CodebaseSearch.tsx client/studio/panels/codebaseSearchFormat.ts client/studio/panels/FilePanel.tsx tests/unit/panels/codebaseSearchFormat.test.ts
git commit -m "feat(studio): FilePanel hybrid-search UI (grep/fts/semantic/mixed + provenance)"
```

---

### Task 3: Freshness — dirty-set drain + reconcile-on-start

**Files:**
- Create: `client/agent/tools/codebaseDirty.ts`, `tests/unit/tools/codebaseDirty.test.ts`
- Modify: `client/agent/tools.ts`, `client/agent/tools/grep.ts`, `client/studio/agent/codebaseReadiness.ts`

**Interfaces:**
- Produces: `markDirty(sessionId: string, path: string): void`, `drainDirty(sessionId: string): string[]` (returns + clears).

- [ ] **Step 1: Failing test**

```ts
// tests/unit/tools/codebaseDirty.test.ts
import { describe, it, expect } from 'vitest';
import { markDirty, drainDirty } from '../../../client/agent/tools/codebaseDirty';
describe('codebaseDirty', () => {
  it('accumulates unique paths and drains once', () => {
    markDirty('s1', '/p/a.ts'); markDirty('s1', '/p/a.ts'); markDirty('s1', '/p/b.ts');
    expect(drainDirty('s1').sort()).toEqual(['/p/a.ts', '/p/b.ts']);
    expect(drainDirty('s1')).toEqual([]);            // cleared
  });
  it('isolates sessions', () => {
    markDirty('s2', '/p/c.ts');
    expect(drainDirty('s3')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `codebaseDirty.ts`**

```ts
const dirty = new Map<string, Set<string>>();
export function markDirty(sessionId: string, path: string): void {
  if (!sessionId || !path) return;
  let s = dirty.get(sessionId);
  if (!s) { s = new Set(); dirty.set(sessionId, s); }
  s.add(path);
}
export function drainDirty(sessionId: string): string[] {
  const s = dirty.get(sessionId);
  if (!s || s.size === 0) return [];
  const out = [...s]; s.clear(); return out;
}
```

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Wire producers + drain.** In `tools.ts`: after a successful `write`/`edit`/`multiedit` (the registry `multiedit` too), call `markDirty(ctx.sessionId, resolvePath(ctx, path))`. In `grep.ts` `runIndexSearch` (fts/semantic/mixed), before invoking `codebase.search`, if `ctx.sessionId` has dirty paths: `await installUglyNative().invoke('codebase.update', { projectPath, files: drainDirty(ctx.sessionId), worktreeRoot })` (best-effort, swallow errors).

- [ ] **Step 6: Reconcile on start.** In `codebaseReadiness.ts`, after the base `codebase.ensureIndex` kickoff, once status is ready (or on the first poll that reports ready) and a worktree is present, fire-and-forget `installUglyNative().invoke('codebase.reconcile', { projectPath, worktreeRoot })`.

- [ ] **Step 7: Typecheck + test.**
Run: `npx tsc --noEmit -p tsconfig.json`; `npx vitest run tests/unit/tools/codebaseDirty.test.ts`.

- [ ] **Step 8: Commit**
```bash
git add client/agent/tools/codebaseDirty.ts client/agent/tools.ts client/agent/tools/grep.ts client/studio/agent/codebaseReadiness.ts tests/unit/tools/codebaseDirty.test.ts
git commit -m "feat(agent): incremental re-index (dirty-set drain) + overlay reconcile on start"
```

---

### Task 4: Full-suite gate + deploy

- [ ] `npx tsc --noEmit -p tsconfig.json` EXIT 0; `npm test` all green.
- [ ] Bump version, build, `npm run deploy`.
- [ ] Live verify against deployed backend (host must ship Plan 1): open a project, run each mode tab in FilePanel, compare rankings; confirm `mixed` downloads the reranker + returns provenance-scored hits.

## Self-Review

**Spec coverage:** grep fts/mixed → T1; FilePanel UI + provenance + status pill → T2; freshness (dirty drain + reconcile) → T3; grep client-side → T2 Step 5. **Placeholder scan:** T2 Step 5 and T3 Steps 5–6 describe edits into existing files (FilePanel styling, tools.ts write/edit sites, codebaseReadiness poll) — the implementer reads those spots; all NEW modules (searchResponse, codebaseSearchFormat, codebaseDirty) have complete code. **Type consistency:** `SearchHit`/`SearchResponse`/`SearchMode` identical to Plan 1's host contract and used consistently T1→T2→T3.
