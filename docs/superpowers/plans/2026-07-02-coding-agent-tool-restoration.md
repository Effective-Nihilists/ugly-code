# Coding-Agent Tool Restoration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore ugly-code's client-side coding agent to full parity with the deleted ugly-studio monolith — ~27 tools (grep+LSP, glob, todos, memory, web, subagents, dynamic catalog, …), the monolith system prompt verbatim, per-tool tests, and a coding-session e2e.

**Architecture:** Each tool is ported from `f5a74c2^:server/coding-agent/tools/<tool>.ts` (ugly-studio repo) and adapted Node→UglyNative (`fs`/`child_process`/`url` → `native.fs`/`native.process` + hand-rolled `file://`). New tools become modules under `client/agent/tools/` registered in a tool registry that `dispatchTool` consults; each is declared in `shared/agent.ts` (`AGENT_TOOL_NAMES` + `AGENT_TOOLS`). LSP-backed tools reuse `client/studio/agent/lsp/registry.ts`. Two architectural pieces: a per-session **dynamic tool catalog** (B6) and **subagent recursion** (B5).

**Tech Stack:** TypeScript, ugly-app UglyNative (`native.fs`/`native.process`/`native.uglybot`/`native.browse`/`native.task`), ripgrep (`rg`), `typescript-language-server`, Zod, vitest. Model-facing tool specs are JSON-Schema (`TextGenTool`).

## Global Constraints

- Client runs in the **browser** (agent task context) — NO Node builtins. Use `native.*`; `path` is pure and fine. (Verbatim from LSP restoration.)
- Every new tool: (1) module `client/agent/tools/<tool>.ts` exporting a `ToolModule`; (2) registered in `TOOL_REGISTRY` (Task 0.1); (3) name added to `AGENT_TOOL_NAMES` and spec to `AGENT_TOOLS` in `shared/agent.ts`; (4) unit test `tests/unit/tools/<tool>.test.ts`.
- `dispatchTool` returns a **string** (the `tool_result` content). Tools return human/model-readable text.
- Tests run under vitest `tests/unit/**`, node env, with the `uglyNativeMock` installed by the setup file. Reset per test with `resetMock({ files, proc })` from `tests/helpers/uglyNativeMock`.
- `rg` is the only allowlisted search binary (`AGENT_BINARIES`); grep/glob spawn `rg`, never `grep`/`find`.
- TypeScript-only LSP for v1 (Python LSP deferred).
- Recovered source-of-truth: `git show f5a74c2^:server/coding-agent/tools/<tool>.ts` and `f5a74c2^:server/coding-agent/llm/system-prompt.txt` in the **ugly-studio** repo (`/Users/admin/Documents/GitHub/ugly-studio`).
- Commit after every task. Work on `main` (repo convention). Bump `package.json` version + deploy only in Phase E.

---

## File structure

- `client/agent/tools/registry.ts` — `ToolModule` interface + `TOOL_REGISTRY` + `runRegisteredTool`.
- `client/agent/tools/lspForProject.ts` — resolve the LSP client for a `ToolContext`.
- `client/agent/tools/<tool>.ts` — one file per new tool (grep, glob, lsp_diagnostics, multiedit, …).
- `client/agent/tools.ts` — `dispatchTool` consults `TOOL_REGISTRY` before its legacy switch.
- `shared/agent.ts` — `AGENT_TOOL_NAMES`, `AGENT_TOOLS`, `AGENT_SYSTEM_PROMPT` (→ monolith prompt), `AGENT_BINARIES`.
- `client/studio/agent/clientAgent.ts` — dynamic catalog wiring (B6), subagent loop entry (B5).
- `tests/unit/tools/<tool>.test.ts` — per-tool tests.
- `docs/superpowers/specs/2026-07-02-coding-agent-tool-restoration-design.md` — the spec.

---

## Phase 0 — Foundations

### Task 0.1: Tool registry

**Files:**
- Create: `client/agent/tools/registry.ts`
- Modify: `client/agent/tools.ts` (route through the registry before the legacy switch)
- Test: `tests/unit/tools/registry.test.ts`

**Interfaces:**
- Produces: `interface ToolModule { name: string; spec: TextGenTool; run(input: Record<string, unknown>, ctx: ToolContext | undefined): Promise<string>; }`; `const TOOL_REGISTRY: ToolModule[]`; `runRegisteredTool(name, input, ctx): Promise<string | undefined>` (undefined = not a registered tool → caller falls back to the legacy switch).

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/tools/registry.test.ts
import { describe, it, expect } from 'vitest';
import { TOOL_REGISTRY, runRegisteredTool } from '../../../client/agent/tools/registry';

describe('tool registry', () => {
  it('registered tool names are unique', () => {
    const names = TOOL_REGISTRY.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });
  it('runRegisteredTool returns undefined for an unknown tool', async () => {
    expect(await runRegisteredTool('definitely_not_a_tool', {}, undefined)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run — Expected: FAIL** (module missing). `npx vitest run tests/unit/tools/registry.test.ts`

- [ ] **Step 3: Implement**

```ts
// client/agent/tools/registry.ts
import type { TextGenTool } from 'ugly-app'; // or wherever TextGenTool is imported in shared/agent.ts — match that import
import type { ToolContext } from '../tools';

export interface ToolModule {
  name: string;
  spec: TextGenTool;
  run(input: Record<string, unknown>, ctx: ToolContext | undefined): Promise<string>;
}

export const TOOL_REGISTRY: ToolModule[] = [];

export async function runRegisteredTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext | undefined,
): Promise<string | undefined> {
  const mod = TOOL_REGISTRY.find((t) => t.name === name);
  if (!mod) return undefined;
  return mod.run(input, ctx);
}
```

In `client/agent/tools.ts`, at the top of `dispatchTool` (before the `switch`):

```ts
const fromRegistry = await runRegisteredTool(name, p, ctx);
if (fromRegistry !== undefined) return fromRegistry;
```

(Resolve the exact `TextGenTool` import by matching `shared/agent.ts`'s import of that type.)

- [ ] **Step 4: Run — Expected: PASS.**
- [ ] **Step 5: Commit** — `feat(tools): tool registry for restored agent tools`

### Task 0.2: `lspForProject` helper

**Files:**
- Create: `client/agent/tools/lspForProject.ts`
- Test: `tests/unit/tools/lspForProject.test.ts`

**Interfaces:**
- Consumes: `getEditorLspClient`, `languageIdForPath` from `client/studio/agent/lsp/registry`; `getActiveProjectPath` from `client/studio/hooks/useSocket`.
- Produces: `projectRoot(ctx): string | null`; `lspForProject(ctx): Promise<LspClient | null>` (typescript client for the ctx's project; null if no project).

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/tools/lspForProject.test.ts
import { describe, it, expect, vi } from 'vitest';
vi.mock('../../../client/studio/agent/lsp/registry', () => ({
  getEditorLspClient: vi.fn(async () => ({ marker: 'fake-client' })),
  languageIdForPath: () => 'typescript',
}));
vi.mock('../../../client/studio/hooks/useSocket', () => ({ getActiveProjectPath: () => '/proj' }));
import { projectRoot, lspForProject } from '../../../client/agent/tools/lspForProject';

describe('lspForProject', () => {
  it('prefers ctx.projectDir, then workspaceDir, then active project', () => {
    expect(projectRoot({ projectDir: '/a' })).toBe('/a');
    expect(projectRoot({ workspaceDir: '/b' })).toBe('/b');
    expect(projectRoot(undefined)).toBe('/proj');
  });
  it('returns the typescript client for the project', async () => {
    const c = await lspForProject({ projectDir: '/a' });
    expect(c).toEqual({ marker: 'fake-client' });
  });
});
```

- [ ] **Step 2: Run — Expected: FAIL.**
- [ ] **Step 3: Implement**

```ts
// client/agent/tools/lspForProject.ts
import { getEditorLspClient } from '../../studio/agent/lsp/registry';
import { getActiveProjectPath } from '../../studio/hooks/useSocket';
import type { ToolContext } from '../tools';

export function projectRoot(ctx: ToolContext | undefined): string | null {
  return ctx?.projectDir ?? ctx?.workspaceDir ?? getActiveProjectPath() ?? null;
}

export async function lspForProject(ctx: ToolContext | undefined) {
  const root = projectRoot(ctx);
  if (!root) return null;
  try {
    return await getEditorLspClient(root, 'typescript');
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run — Expected: PASS** + `npx tsc --noEmit` clean.
- [ ] **Step 5: Commit** — `feat(tools): lspForProject helper (project→LSP client)`

---

## Phase B1 — Search / navigation

### Task B1.1: `grep` — exact regex pass

**Files:**
- Create: `client/agent/tools/grep.ts`
- Modify: `shared/agent.ts` (add `'grep'` to `AGENT_TOOL_NAMES`; add its `AGENT_TOOLS` spec), `client/agent/tools/registry.ts` (register)
- Test: `tests/unit/tools/grep.test.ts`

**Recovery:** base behavior + arg semantics from `git show f5a74c2^:server/coding-agent/tools/grep.ts`. Port only the **exact** pass here (LSP modes = B1.2, supplement = B1.3).

**Interfaces:**
- Produces: `grepTool: ToolModule`; internal `buildRgArgs(args): string[]` (pure, exported for test).
- Input schema: `{ pattern: string; path?: string; include?: string; literal_text?: boolean; caseInsensitive?: boolean; include_ignored?: boolean; mode?: 'auto'|'exact'|'lsp-defs'|'lsp-refs'|'lsp-impls'; output_mode?: 'content'|'files_with_matches'|'count'; head_limit?: number; before_lines?: number; after_lines?: number }`.

**Adaptation:** exact pass spawns `rg` via `native.process.spawn('rg', buildRgArgs(args), { cwd: projectRoot(ctx) })` (mirror the `spawnForOutput` pattern already in `client/agent/tools.ts:178`). Map args → flags: `-e <pattern>` (or `-F` when `literal_text`), `-i` (caseInsensitive), `-g <include>` (include), `--no-ignore` (include_ignored), `-l` (files_with_matches), `-c` (count), `-B/-A` (before/after_lines), `-m <head_limit>`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/tools/grep.test.ts
import { describe, it, expect } from 'vitest';
import { buildRgArgs } from '../../../client/agent/tools/grep';

describe('grep buildRgArgs', () => {
  it('content mode with context + case-insensitive', () => {
    const a = buildRgArgs({ pattern: 'foo', caseInsensitive: true, before_lines: 2, after_lines: 1, output_mode: 'content' });
    expect(a).toContain('-i'); expect(a).toContain('-B'); expect(a).toContain('2');
    expect(a).toContain('-A'); expect(a).toContain('1'); expect(a).toContain('foo');
  });
  it('literal + files_with_matches + include glob', () => {
    const a = buildRgArgs({ pattern: 'a.b', literal_text: true, output_mode: 'files_with_matches', include: '*.ts' });
    expect(a).toContain('-F'); expect(a).toContain('-l'); expect(a).toContain('-g'); expect(a).toContain('*.ts');
  });
});
```

- [ ] **Step 2: Run — Expected: FAIL.**
- [ ] **Step 3: Implement** `buildRgArgs` + `grepTool` (exact pass only: `mode` other than lsp-* runs `rg`; format stdout per `output_mode`). Register + declare the `AGENT_TOOLS` spec (description recovered from `f5a74c2^:server/coding-agent/tools/tool-specs.ts` `grep` entry).
- [ ] **Step 4: Run — Expected: PASS.**
- [ ] **Step 5: Commit** — `feat(tools): grep exact regex pass (rg)`

### Task B1.2: `grep` — LSP modes (`runLspMode`)

**Files:** Modify `client/agent/tools/grep.ts`; Test: extend `tests/unit/tools/grep.test.ts`

**Recovery:** port `runLspMode` + `formatLspHits` from `f5a74c2^:server/coding-agent/tools/grep.ts` (lines ~621–695 / formatLspHits). Replace `ctx.lsp` with `await lspForProject(ctx)`.

**Interfaces:** Produces `runLspMode(mode, symbol, ctx): Promise<string>` — `lsp-defs`→`workspaceSymbol(symbol)` formatted; `lsp-refs`/`lsp-impls`→ for the first 3 decl sites, `openFile` + `findReferences`/`findImplementations` at `(line-1, char-1)`, dedupe, format cwd-relative `path:line:col`.

- [ ] **Step 1: Write the failing test** (mock `lspForProject` to a fake client)

```ts
// add to tests/unit/tools/grep.test.ts
import { vi } from 'vitest';
vi.mock('../../../client/agent/tools/lspForProject', () => ({
  projectRoot: () => '/proj',
  lspForProject: vi.fn(),
}));
import { runLspMode } from '../../../client/agent/tools/grep';
import { lspForProject } from '../../../client/agent/tools/lspForProject';

it('lsp-defs formats workspaceSymbol hits', async () => {
  vi.mocked(lspForProject).mockResolvedValue({
    getState: () => 'ready',
    workspaceSymbol: async () => [{ name: 'foo', uri: 'file:///proj/a.ts', line: 3, character: 5 }],
  } as never);
  const out = await runLspMode('lsp-defs', 'foo', { projectDir: '/proj' });
  expect(out).toMatch(/a\.ts:3:5/);
});
```

- [ ] **Step 2: Run — Expected: FAIL.**
- [ ] **Step 3: Implement** `runLspMode`/`formatLspHits`; in `grepTool.run`, when `mode` ∈ lsp-* return `runLspMode(mode, pattern, ctx)`.
- [ ] **Step 4: Run — Expected: PASS** + `npx tsc --noEmit` clean.
- [ ] **Step 5: Commit** — `feat(tools): grep LSP modes (defs/refs/impls)`

### Task B1.3: `grep` — auto-supplement

**Files:** Modify `client/agent/tools/grep.ts`; Test: extend `tests/unit/tools/grep.test.ts`

**Recovery:** port `extractIdentSymbols` + `lspSupplementHitsMulti` + the "LSP DEFINITIONS" appended section from `f5a74c2^:.../grep.ts` (~lines 173–251). Gate: `mode` auto/undefined + `literal_text!==true` + bare identifier(s) + `lspForProject` ready.

- [ ] **Step 1: Write the failing test**

```ts
// add to tests/unit/tools/grep.test.ts
import { extractIdentSymbols } from '../../../client/agent/tools/grep';
it('extractIdentSymbols pulls bare identifiers and unions', () => {
  expect(extractIdentSymbols('AppTabPicker')).toEqual(['AppTabPicker']);
  expect(extractIdentSymbols('Foo|Bar')).toEqual(['Foo', 'Bar']);
  expect(extractIdentSymbols('foo\\s+bar')).toEqual([]); // not bare
});
```

- [ ] **Step 2: Run — Expected: FAIL.**
- [ ] **Step 3: Implement** `extractIdentSymbols` + supplement (append `\n\n# LSP DEFINITIONS\n…` to the exact-pass result when eligible + hits exist).
- [ ] **Step 4: Run — Expected: PASS.**
- [ ] **Step 5: Commit** — `feat(tools): grep LSP auto-supplement`

### Task B1.4: `glob`

**Files:** Create `client/agent/tools/glob.ts`; Modify `shared/agent.ts` + registry; Test `tests/unit/tools/glob.test.ts`

**Recovery:** `f5a74c2^:server/coding-agent/tools/glob.ts`. Adapt: run `rg --files -g <pattern>` (+`--no-ignore` when `include_ignored`) via `native.process`, `cwd: projectRoot(ctx)`; return newline-joined paths. Input: `{ pattern: string; path?: string; include_ignored?: boolean }`.

- [ ] **Step 1: Write the failing test** (mock `resetMock({ proc })` to script `rg --files` output)

```ts
// tests/unit/tools/glob.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { resetMock } from '../../helpers/uglyNativeMock';
import { globTool } from '../../../client/agent/tools/glob';
beforeEach(() => resetMock({ proc: (cmd, args) => ({
  stdout: cmd === 'rg' && args.includes('--files') ? 'src/a.ts\nsrc/b.ts\n' : '', code: 0,
}) }));
it('lists files matching the glob', async () => {
  const out = await globTool.run({ pattern: '**/*.ts' }, { projectDir: '/proj' });
  expect(out).toContain('src/a.ts'); expect(out).toContain('src/b.ts');
});
```

- [ ] **Step 2: Run — Expected: FAIL.** — [ ] **Step 3: Implement.** — [ ] **Step 4: PASS.** — [ ] **Step 5: Commit** — `feat(tools): glob (rg --files)`

### Task B1.5: `lsp_diagnostics`

**Files:** Create `client/agent/tools/lspDiagnostics.ts`; Modify `shared/agent.ts` + registry; Test `tests/unit/tools/lspDiagnostics.test.ts`

**Adaptation:** `const c = await lspForProject(ctx); if (!c) return '(no project / LSP unavailable)'; await c.ensureProjectLoaded();` then `path` → `c.getDiagnostics(path)` formatted; else `c.formatSummary()` (project-wide). Input: `{ path?: string }`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/tools/lspDiagnostics.test.ts
import { describe, it, expect, vi } from 'vitest';
vi.mock('../../../client/agent/tools/lspForProject', () => ({ projectRoot: () => '/proj', lspForProject: vi.fn() }));
import { lspDiagnosticsTool } from '../../../client/agent/tools/lspDiagnostics';
import { lspForProject } from '../../../client/agent/tools/lspForProject';
it('formats project diagnostics', async () => {
  vi.mocked(lspForProject).mockResolvedValue({
    ensureProjectLoaded: async () => {}, formatSummary: () => '# 1 error\nsrc/a.ts:2:1 error: boom',
  } as never);
  const out = await lspDiagnosticsTool.run({}, { projectDir: '/proj' });
  expect(out).toMatch(/1 error/); expect(out).toMatch(/src\/a\.ts:2:1/);
});
```

- [ ] **Step 2: FAIL.** — [ ] **Step 3: Implement.** — [ ] **Step 4: PASS** + tsc clean. — [ ] **Step 5: Commit** — `feat(tools): lsp_diagnostics`

### Task B1.6: B1 prompt section + real-server e2e

**Files:** Modify `shared/agent.ts` (add grep/glob/lsp_diagnostics guidance to `AGENT_SYSTEM_PROMPT`); Test `tests/unit/tools/grep-e2e.test.ts`

**Recovery:** the search-tool guidance lines from `f5a74c2^:.../system-prompt.txt` (the "search with the right tool — grep / glob" lines).

- [ ] **Step 1: Write the e2e** — reuse the LSP `createNodeUglyNative` override pattern from `tests/unit/lsp/e2e-definition.test.ts`: real fixture `a.ts`/`b.ts`, `grepTool.run({ mode: 'lsp-defs', pattern: 'foo' }, { projectDir: fixtureDir })` (with `binaryPath` shim or npx-offline) resolves to `a.ts`. Skip clearly if the server binary is absent.
- [ ] **Step 2: Run — Expected: PASS** (long timeout).
- [ ] **Step 3: Commit** — `test(tools): grep lsp-defs e2e on a real ts fixture`

---

## Phase B2 — Editing / exec

> Pattern for every tool task below: (1) recover `git show f5a74c2^:server/coding-agent/tools/<file>.ts`; (2) create `client/agent/tools/<tool>.ts` applying the listed adaptations; (3) add the name to `AGENT_TOOL_NAMES` + spec (from `tool-specs.ts`) to `AGENT_TOOLS`; (4) register in `TOOL_REGISTRY`; (5) write the shown test; (6) FAIL→implement→PASS→`tsc --noEmit`; (7) commit.

### Task B2.1: `multiedit`
**Recover:** `multiedit.ts`. **Adapt:** `native.fs.readFile`→apply edits in memory (each `old_string` must appear; `replace_all` optional)→`native.fs.writeFile`; abort the whole set if any `old_string` is missing (report which). Input `{ path, edits: [{ old_string, new_string, replace_all? }] }`.

- [ ] **Test:**
```ts
// tests/unit/tools/multiedit.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { resetMock, mockFiles } from '../../helpers/uglyNativeMock';
import { multieditTool } from '../../../client/agent/tools/multiedit';
beforeEach(() => resetMock({ files: { '/proj/a.ts': 'let x = 1;\nlet y = 2;\n' } }));
it('applies edits in sequence', async () => {
  await multieditTool.run({ path: '/proj/a.ts', edits: [{ old_string: 'x = 1', new_string: 'x = 10' }, { old_string: 'y = 2', new_string: 'y = 20' }] }, undefined);
  expect(mockFiles().get('/proj/a.ts')).toBe('let x = 10;\nlet y = 20;\n');
});
it('aborts atomically when an old_string is missing', async () => {
  const out = await multieditTool.run({ path: '/proj/a.ts', edits: [{ old_string: 'x = 1', new_string: 'x = 10' }, { old_string: 'NOPE', new_string: '!' }] }, undefined);
  expect(out).toMatch(/not found|no match/i);
  expect(mockFiles().get('/proj/a.ts')).toBe('let x = 1;\nlet y = 2;\n'); // unchanged
});
```
- [ ] FAIL → implement → PASS → commit `feat(tools): multiedit`

### Task B2.2: `python_exec`
**Recover:** `python-exec.ts`. **Adapt:** write the snippet to a temp file via `native.fs`, `native.process.spawn('python'|'uv', ['run','python',tmp] , { cwd })`, capture stdout/stderr/exit (mirror `spawnForOutput`). Input `{ code, timeout? }`.
- [ ] **Test:** `resetMock({ proc: (c,a) => ({ stdout: 'hello\n', code: 0 }) })`; assert `pythonExecTool.run({ code: "print('hello')" }, undefined)` contains `hello`. Also a non-zero-exit case surfaces stderr.
- [ ] FAIL → implement → PASS → commit `feat(tools): python_exec`

### Task B2.3: `python_libraries`
**Recover:** `python-libraries.ts`. **Adapt:** `native.process.spawn('uv', ['pip','list'] , { cwd })` (fallback `python -m pip list`); parse + optional `filter`. Input `{ filter? }`.
- [ ] **Test:** script `proc` to return `numpy 1.0\nrequests 2.0\n`; assert filtered output.
- [ ] FAIL → implement → PASS → commit `feat(tools): python_libraries`

### Task B2.4: `dev_server_logs`
**Recover:** monolith dev-server-logs behavior. **Adapt (ugly-code-specific):** read the studio dev-server task's recent output. Resolve the dev task via `native.task.enum()` → the project's dev task id → its buffered log (or a log file under the project's studio dir). Input `{ lines?, filter? }`. If no dev task running, return a clear message.
- [ ] **Test:** mock `native.task` (extend `uglyNativeMock` or `vi.mock('ugly-app/native')` locally) to return a fake task + log; assert last-N-lines + filter.
- [ ] FAIL → implement → PASS → commit `feat(tools): dev_server_logs`

### Task B2.5: B2 prompt section
- [ ] Add the edit/exec guidance lines from the monolith prompt (multiedit, python) to `AGENT_SYSTEM_PROMPT`; commit `feat(agent): B2 prompt guidance`.

---

## Phase B3 — Web / deps

### Task B3.1: `web_fetch`
**Recover:** `web-fetch.ts`. **Adapt:** `native.browse` extraction (readable text/markdown) for a URL; fall back to plain `fetch` + strip. Input `{ url, mode? }`.
- [ ] **Test:** `vi.mock('ugly-app/native')` so `native.browse.extract` returns `{ text: 'Article body' }`; assert output contains it. Error case: bad URL → clear message.
- [ ] FAIL → implement → PASS → commit `feat(tools): web_fetch`

### Task B3.2: `web_search`
**Recover:** `web_search.ts`. **Adapt:** route via `native.uglybot` search proxy (or the platform search endpoint). Input `{ query, count? }`.
- [ ] **Test:** mock the proxy to return ranked results; assert formatted list. Empty-results case.
- [ ] FAIL → implement → PASS → commit `feat(tools): web_search`

### Task B3.3: `download`
**Recover:** `download.ts`. **Adapt:** fetch bytes → `native.fs.writeFileBytes(path, bytes)`. Input `{ url, path }`.
- [ ] **Test:** stub global `fetch` to return bytes; assert `mockFiles()` has the target written; assert error on non-200.
- [ ] FAIL → implement → PASS → commit `feat(tools): download`

### Task B3.4: `dep_docs`
**Recover:** `dep-docs.ts`. **Adapt:** resolve `node_modules/<pkg>/README*` or `package.json` docs via `native.fs`; registry fetch fallback. Input `{ package, symbol? }`.
- [ ] **Test:** `resetMock({ files: { '/proj/node_modules/left-pad/README.md': '# left-pad' } })`; assert output contains it.
- [ ] FAIL → implement → PASS → commit `feat(tools): dep_docs`

### Task B3.5: B3 prompt section
- [ ] Add web/deps guidance to `AGENT_SYSTEM_PROMPT`; commit.

---

## Phase B4 — Planning / memory

### Task B4.1: `todos`
**Recover:** `todos.ts`. **Adapt:** persist the list per session + surface on the studio chat-header todos indicator by emitting a studio event (reuse the `emitCustom`/session-event path in `clientAgent.ts`). Input `{ todos: [{ content, status, activeForm? }] }`. Return a rendered checklist string.
- [ ] **Test:** call with a list; assert the returned string renders statuses; assert the persisted state (inject a capture fn) matches. Transition test (pending→in_progress→completed).
- [ ] FAIL → implement → PASS → commit `feat(tools): todos`

### Task B4.2: `scratchpad`
**Recover:** `scratchpad.ts`. **Adapt:** per-session store under the project's studio dir via `native.fs` (append/read/clear). Input `{ action, content? }`.
- [ ] **Test:** append twice → read returns both; clear → read empty (over `mockFiles`).
- [ ] FAIL → implement → PASS → commit `feat(tools): scratchpad`

### Task B4.3: `memory_save` / `memory_read` / `memory_list` / `memory_delete`
**Recover:** `memory-save.ts` / `memory-read.ts` / `memory-list.ts` / `memory-delete.ts`. **Adapt:** JSON files under a per-project memory dir (`<project>/.ugly-studio/memory/<slug>.json`) via `native.fs`. One module `client/agent/tools/memory.ts` exporting all four `ToolModule`s.
- [ ] **Test (one file):** save `{name, content}` → `mockFiles` has the json; list → includes name; read → content; delete → gone.
- [ ] FAIL → implement → PASS → commit `feat(tools): memory_{save,read,list,delete}`

### Task B4.4: `ask_user`
**Recover:** `ask_user.ts`. **Adapt:** emit a studio `ask_user` event and await the user's reply through the chat input (a pending-promise keyed by call id, resolved when the reply event arrives). Input `{ question, options? }`.
- [ ] **Test:** call `askUserTool.run(...)`, then fire the mocked reply; assert it resolves with the reply text. (Inject the reply channel.)
- [ ] FAIL → implement → PASS → commit `feat(tools): ask_user`

### Task B4.5: B4 prompt section
- [ ] Add the plan-first/todos + memory guidance from the monolith prompt; commit.

---

## Phase B5 — Orchestration (subagents)

### Task B5.1: Subagent loop entry
**Files:** Modify `client/studio/agent/clientAgent.ts` (export a `runSubAgent(task, opts)` that runs a nested `runAgent` with a reduced tool set, bounded `maxTurns`, isolated history, returning the final text). Test `tests/unit/tools/subagent.test.ts` (mock `runAgent`).
- [ ] **Test:** `runSubAgent('do X', { maxTurns: 3 })` invokes `runAgent` with the reduced tools + returns its final message.
- [ ] FAIL → implement → PASS → commit `feat(agent): subagent loop entry`

### Task B5.2: `delegate`
**Recover:** `delegate.ts`. **Adapt:** `runSubAgent(task, { tools, maxTurns })`. Input `{ task, context?, tools? }`.
- [ ] **Test:** mock `runSubAgent` → `delegateTool.run` returns its result; depth guard (a delegate inside a delegate is capped).
- [ ] FAIL → implement → PASS → commit `feat(tools): delegate`

### Task B5.3: `delegate_parallel`
**Recover:** `delegate-parallel.ts`. **Adapt:** `Promise.all(tasks.map(runSubAgent))`, aggregate. Input `{ tasks: [...] }`.
- [ ] **Test:** two tasks → aggregated result contains both; one failing task doesn't kill the others.
- [ ] FAIL → implement → PASS → commit `feat(tools): delegate_parallel`

### Task B5.4: `agent`
**Recover:** `agent.ts`. **Adapt:** `runSubAgent` with a role prompt. Input `{ role, task }`.
- [ ] **Test:** role is threaded into the sub-run's system prompt (assert via the mock).
- [ ] FAIL → implement → PASS → commit `feat(tools): agent`

### Task B5.5: `blackboard_post`
**Recover:** `blackboard.ts`. **Adapt:** per-session shared store (module singleton keyed by sessionId) that delegates read. Input `{ message, tag? }`.
- [ ] **Test:** post → a reader helper returns the message; scoped by session.
- [ ] FAIL → implement → PASS → commit `feat(tools): blackboard_post`

### Task B5.6: B5 prompt section
- [ ] Add delegation guidance from the monolith prompt; commit.

---

## Phase B6 — Dynamic catalog / specs / media

### Task B6.1: Dynamic tool catalog
**Files:** Modify `client/studio/agent/clientAgent.ts` (per-session **active tool set**; the `tools` sent per turn = active set, not the full `AGENT_TOOLS`) + `client/agent/tools/catalog.ts` (the full registry catalog + `activateTool(sessionId, name)` + `searchCatalog(query)`). Test `tests/unit/tools/catalog.test.ts`.
- [ ] **Test:** default active set = the always-on core; `activateTool` adds one; `searchCatalog('find references')` ranks `grep`/`lsp_diagnostics` high.
- [ ] FAIL → implement → PASS → commit `feat(agent): dynamic per-session tool catalog`

### Task B6.2: `tool_search`
**Recover:** `tool-search.ts`. **Adapt:** `searchCatalog(query)`. Input `{ query }`.
- [ ] **Test:** returns matching tool names + descriptions for an intent query.
- [ ] FAIL → implement → PASS → commit `feat(tools): tool_search`

### Task B6.3: `tool_request`
**Recover:** `tool-request.ts`. **Adapt:** `activateTool(sessionId, name)` → the tool appears in the next turn's catalog. Input `{ name, purpose }`.
- [ ] **Test:** after `tool_request`, the session's active set includes the name.
- [ ] FAIL → implement → PASS → commit `feat(tools): tool_request`

### Task B6.4: `spec_read`
**Recover:** `spec-tools.ts` + `spec-vfs.ts`. **Adapt:** fetch specs from ugly.bot via `native.uglybot` (list + read by id/path). Input `{ id?, path? }`.
- [ ] **Test:** mock the ugly.bot spec endpoint → returns spec body / listing.
- [ ] FAIL → implement → PASS → commit `feat(tools): spec_read`

### Task B6.5: `analyze_image`
**Recover:** `analyze-image.ts`. **Adapt:** read image bytes via `native.fs.readFileBytes` (or accept a URL); send to a vision model via `native.uglybot`. Input `{ path?|url?, prompt? }`.
- [ ] **Test:** mock the vision call → returns the analysis text.
- [ ] FAIL → implement → PASS → commit `feat(tools): analyze_image`

### Task B6.6: `inspect_ux`
**Recover:** `inspect-ux.ts`. **Adapt:** reuse ugly-code's existing `verify-ux`/`window.__uglyInspect` machinery, exposed as an agent tool. Input `{ url_path?, device?, actions? }`.
- [ ] **Test:** mock `__uglyInspect` → returns the structured report; assert defects surfaced.
- [ ] FAIL → implement → PASS → commit `feat(tools): inspect_ux`

### Task B6.7: B6 prompt section
- [ ] Add the `tool_search`/`tool_request` catalog-constraints guidance; commit.

---

## Phase P — System prompt parity

### Task P.1: Restore the monolith system prompt verbatim
**Files:** Modify `shared/agent.ts` (`AGENT_SYSTEM_PROMPT` = the full monolith `system-prompt.txt`); Test `tests/unit/prompt-parity.test.ts`.

**Recovery:** `git show f5a74c2^:server/coding-agent/llm/system-prompt.txt` → store as `AGENT_SYSTEM_PROMPT` (or a co-located `.txt` imported as a string, matching how `shared/` handles raw text). Reconcile any ugly-studio-specific wording (e.g. "ugly-studio IDE" → "Ugly Studio"), keeping the tool vocabulary intact (all referenced tools now exist).

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/prompt-parity.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { AGENT_SYSTEM_PROMPT } from '../../shared/agent';
it('every tool named in the prompt exists in AGENT_TOOL_NAMES', async () => {
  const { AGENT_TOOL_NAMES } = await import('../../shared/agent');
  for (const name of ['todos', 'grep', 'glob', 'read', 'edit', 'tool_search', 'tool_request']) {
    // map monolith read/edit/write/bash → ugly-code read_file/edit_file/write_file/run_command
  }
  expect(AGENT_SYSTEM_PROMPT).toMatch(/PLAN BEFORE YOU EXPLORE/);
  expect(AGENT_SYSTEM_PROMPT).toMatch(/tool_search/);
});
```

- [ ] **Step 2: FAIL** (current prompt lacks these). — [ ] **Step 3: Implement** the verbatim restore. — [ ] **Step 4: PASS** + `npx tsc --noEmit`. — [ ] **Step 5: Commit** — `feat(agent): restore monolith system prompt verbatim`

### Task P.2: Full-suite gate
- [ ] Run `npx vitest run` + `npx tsc --noEmit`; all green. Commit any fixes. (Note the pre-existing `agent.test.ts` tool-list assertion — update it to the new `AGENT_TOOL_NAMES`.)

---

## Phase E — Coding-session e2e

### Task E.1: Deploy + drive the real Studio agent
**Files:** Create `ugly-studio/scratch/agent-tools-e2e.mjs` (reuse the Electron-harness Playwright driver from the LSP verification).

- [ ] **Step 1:** Bump `package.json` version; `npm run build` (verify the client bundle); `npx ugly-app publish --from workers-build` → code.ugly.bot.
- [ ] **Step 2:** Launch the ugly-studio Electron harness (`tests/electron-harness/dist/main.mjs`) against `https://code.ugly.bot` with the real `auth_token` (`~/.ugly-bot/auth.json`) + `UGLY_HARNESS_BUNDLED=node,bash,npx,pnpm,git,rg` (mirror `scratch/lsp-realhost.mjs`).
- [ ] **Step 3:** Open the ugly-code repo as the project; start a coding session with a concrete task (e.g. "find every caller of `getEditorLspClient` and add a doc comment"); drive the agent one turn.
- [ ] **Step 4:** Assert from the captured session events that the agent called `todos` first, then `grep`/`lsp_diagnostics`/`read_file`/`edit_file`, and completed. Capture a transcript + screenshot as evidence.
- [ ] **Step 5: Commit** — `test(agent): coding-session e2e proves tool usage on real Studio`

---

## Self-Review

**Coverage:** every spec batch (B1–B6) → a phase; each of the ~27 tools → a task with a concrete test; system prompt → Phase P (verbatim + parity); coding-session e2e → Phase E. Dynamic catalog (B6.1) and subagent recursion (B5.1) — the two architectural pieces — get dedicated foundation tasks before the tools that need them.

**Risks:** the B2/B3/B6 tools depend on platform facades (`native.uglybot`/`native.browse`/`native.task`) whose exact method shapes must be confirmed at recovery time — each task's first action is `git show` the monolith file AND grep the ugly-app native facade for the real method name before writing the test. Subagent depth + dynamic-catalog-vs-fixed-catalog are the regression-prone seams; their foundation tasks include guards.

**Ordering note:** the prompt is grown per-batch (B*.N "prompt section" tasks) so the agent never sees guidance for a not-yet-registered tool; Phase P swaps in the verbatim monolith prompt only once all referenced tools exist.
