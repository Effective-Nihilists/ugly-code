# Eval CLI Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `ugly-code evals run <task>` work end-to-end from a terminal — no Electron, no Studio — reusing the existing headless coding-agent task, installing Python on demand, and storing turn data on local disk instead of the server.

**Architecture:** The coding agent already runs as an ugly-app background task (`coding-task.ts`) over a React-free loop (`clientAgent.ts` → `runClientAgentTurn`) with a Node `UglyNative` (`createNodeUglyNative`) and an in-bundle `/api/*` fetch shim for LLM calls. This plan adds (a) a shared on-demand binaries resolver rooted at `~/.ugly-bot/binaries/`, (b) a swappable **session store** so turn data can go to `~/.ugly-code/session/<id>/` instead of the server, and (c) a thin CLI that boots the same globals in-process and drives turns non-interactively, then grades with the existing `gradeProject`.

**Tech Stack:** TypeScript (ESM), Node, `ugly-app` framework (`^0.1.788`), `vitest` for unit tests, `native.fs`/`native.process` (via `createNodeUglyNative`), `uv` for Python provisioning.

## Global Constraints

- **Package manager: pnpm, never npm/yarn** for this repo's own tooling (the eval grader still shells `npx tsc`/`npx vitest`/`npm test` *inside cloned fixtures* — leave those as-is).
- **ugly-app version floor:** `^0.1.788` (do not bump/release ugly-app as part of this plan — coordinate separately).
- **Deployed origin only:** the CLI targets the already-deployed ugly-code app for `/api/agentTurn` + `/api/agentStep`; it does **not** run its own server. LLM billing is the user's (ugly.bot metered proxy).
- **Auth required:** every CLI run needs a valid logged-in user token (`~/.ugly-bot/auth.json`) or an explicit test-user/`--token`.
- **Binaries root:** `~/.ugly-bot/binaries/` (co-located with the auth store). **Session store root:** `~/.ugly-code/session/<sanitized-sessionId>/`.
- **`native.fs` has no append** — the fs session store rewrites whole files (mirrors `sessionLog.ts`).
- **Best-effort persistence:** a session-store failure must never throw into the agent loop (mirrors `serverSessionApi`'s contract).
- **TDD, DRY, YAGNI, one commit per task.**

## Scope

This is **Plan 1 of 4**. It delivers only the ugly-code CLI foundation. Explicitly **out of scope** (their own later plans):
- **Plan 2 — `python_exec` full port** (stateful sessions, `recursive_llm`/`final`, guard-mode, leak meter) + Ep 04 eval tests.
- **Plan 3 — pattern engine + mid-step judge** + Ep 05 eval tests.
- **Plan 4 — A/B comparison harness, scoreboard, in-studio parity + parity test.**
- **Migrating ugly-studio and `ugly-app dev` to the shared `~/.ugly-bot/binaries/` root** — needs its own investigation of each repo's current binary provisioning; the resolver here is written to be hoistable into `ugly-app` later. Plan 1 only makes the **CLI** consume the shared root.

Design source: `docs/superpowers/specs/2026-07-05-eval-tests-python-rules-judge-cli-parity-and-shared-binaries-design.md` (W0, W1, W1b).

## File Structure

- Create `client/agent/binaries/resolve.ts` — shared binaries resolver (`binaryPath`/`ensureBinary`/`ensurePython`), manifest + install-lock. Hoistable to ugly-app later.
- Test `tests/unit/binaries/resolve.test.ts`.
- Modify `client/agent/tools/pythonExec.ts` — spawn the resolved python instead of bare `python`.
- Create `client/studio/agent/sessionStore.ts` — the `SessionStore` interface + swappable `activeStore` + `setSessionStore()`; move the current server impl here as `serverSessionStore`.
- Modify `client/studio/agent/serverSessionApi.ts` — `sessionApi` delegates to `activeStore`; keep all pure helpers/types.
- Create `client/studio/agent/fsSessionStore.ts` — `makeFsSessionStore(rootDir)` writing `~/.ugly-code/session/<id>/`.
- Test `tests/unit/agent/fsSessionStore.test.ts`.
- Create `client/cli/evalCli.ts` — arg parse + command dispatch (`run`, `resume`, `--login`).
- Create `client/cli/auth.ts` — token resolution (authStore / `--token` / `--test-user`) + login trigger.
- Create `client/cli/taskDriver.ts` — in-process boot (globals + fetch shim + store injection) + `runOneTurn`.
- Create `client/cli/evalRun.ts` — clone fixture, run turns, grade, print score.
- Create `bin/ugly-code.mjs` — executable entry; add `bin` + scripts to `package.json`.
- Test `tests/unit/cli/auth.test.ts`, `tests/unit/cli/evalRun.test.ts`.

---

### Task 1: Shared binaries resolver (`~/.ugly-bot/binaries/`)

**Files:**
- Create: `client/agent/binaries/resolve.ts`
- Test: `tests/unit/binaries/resolve.test.ts`

**Interfaces:**
- Produces:
  - `binariesRoot(): string` → `~/.ugly-bot/binaries/<platform>-<arch>`
  - `ensureBinary(name: string, installer: (destDir: string) => Promise<void>): Promise<string>` → resolves the binary's install dir, running `installer` under a lock + writing the manifest only if absent.
  - `readManifest(): Promise<Record<string, { installedAt: number }>>`
  - Uses injected IO for tests: `ensureBinary(name, installer, io?: BinariesIo)` where `BinariesIo = { exists(p): Promise<boolean>; mkdirp(p): Promise<void>; readFile(p): Promise<string>; writeFile(p, s): Promise<void>; now(): number }`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/binaries/resolve.test.ts
import { describe, it, expect, vi } from 'vitest';
import { ensureBinary, type BinariesIo } from '../../../client/agent/binaries/resolve';

function memIo(seed: Record<string, string> = {}): BinariesIo & { files: Map<string, string> } {
  const files = new Map(Object.entries(seed));
  return {
    files,
    exists: (p) => Promise.resolve(files.has(p) || [...files.keys()].some((k) => k.startsWith(p + '/'))),
    mkdirp: () => Promise.resolve(),
    readFile: (p) => Promise.resolve(files.get(p) ?? '{}'),
    writeFile: (p, s) => { files.set(p, s); return Promise.resolve(); },
    now: () => 1000,
  };
}

describe('ensureBinary', () => {
  it('installs when absent, then records the manifest', async () => {
    const io = memIo();
    const installer = vi.fn(async (dest: string) => { io.files.set(dest + '/bin/python3', '#'); });
    const dir = await ensureBinary('python', installer, io);
    expect(installer).toHaveBeenCalledTimes(1);
    expect(dir).toMatch(/binaries\/.*\/python$/);
    const manifest = JSON.parse(io.files.get([...io.files.keys()].find((k) => k.endsWith('manifest.json'))!)!);
    expect(manifest.python.installedAt).toBe(1000);
  });

  it('is a no-op when already installed (installer not called)', async () => {
    const io = memIo();
    const installer = vi.fn(async (dest: string) => { io.files.set(dest + '/bin/python3', '#'); });
    await ensureBinary('python', installer, io);       // first install
    installer.mockClear();
    await ensureBinary('python', installer, io);       // cached
    expect(installer).not.toHaveBeenCalled();
  });

  it('serializes concurrent installs of the same binary (installer called once)', async () => {
    const io = memIo();
    let running = 0, maxConcurrent = 0;
    const installer = vi.fn(async (dest: string) => {
      running++; maxConcurrent = Math.max(maxConcurrent, running);
      await Promise.resolve();
      io.files.set(dest + '/bin/python3', '#'); running--;
    });
    await Promise.all([ensureBinary('python', installer, io), ensureBinary('python', installer, io)]);
    expect(maxConcurrent).toBe(1);
    expect(installer).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/binaries/resolve.test.ts`
Expected: FAIL — `Cannot find module '.../resolve'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// client/agent/binaries/resolve.ts
// Shared on-demand binary provisioning under ~/.ugly-bot/binaries/<platform>-<arch>/.
// Designed to be hoisted into ugly-app so ugly-studio + `ugly-app dev` can share it.
import { native } from 'ugly-app/native';

export interface BinariesIo {
  exists(p: string): Promise<boolean>;
  mkdirp(p: string): Promise<void>;
  readFile(p: string): Promise<string>;
  writeFile(p: string, s: string): Promise<void>;
  now(): number;
}

function home(): string {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
  return env.HOME ?? env.USERPROFILE ?? '.';
}
function platformTag(): string {
  const p = (globalThis as { process?: { platform?: string; arch?: string } }).process ?? {};
  return `${p.platform ?? 'unknown'}-${p.arch ?? 'unknown'}`;
}

export function binariesRoot(): string {
  return `${home()}/.ugly-bot/binaries/${platformTag()}`;
}

// Default IO backed by native.fs (no host round-trip in a Node context).
const nativeIo: BinariesIo = {
  exists: async (p) => { try { await native.fs.readFile(p); return true; } catch { return false; } },
  mkdirp: (p) => native.fs.mkdir(p, { recursive: true }),
  readFile: (p) => native.fs.readFile(p),
  writeFile: (p, s) => native.fs.writeFile(p, s),
  now: () => Date.now(),
};

const inflight = new Map<string, Promise<string>>();

export async function ensureBinary(
  name: string,
  installer: (destDir: string) => Promise<void>,
  io: BinariesIo = nativeIo,
): Promise<string> {
  const destDir = `${binariesRoot()}/${name}`;
  const existing = inflight.get(destDir);
  if (existing) return existing;
  const task = (async () => {
    if (await io.exists(destDir)) return destDir;
    await io.mkdirp(destDir);
    await installer(destDir);
    const manifestPath = `${binariesRoot()}/manifest.json`;
    let manifest: Record<string, { installedAt: number }> = {};
    try { manifest = JSON.parse(await io.readFile(manifestPath)); } catch { /* first write */ }
    manifest[name] = { installedAt: io.now() };
    await io.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    return destDir;
  })();
  inflight.set(destDir, task);
  try { return await task; } finally { inflight.delete(destDir); }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/binaries/resolve.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add client/agent/binaries/resolve.ts tests/unit/binaries/resolve.test.ts
git commit -m "feat(binaries): shared on-demand resolver under ~/.ugly-bot/binaries"
```

---

### Task 2: On-demand Python + point `python_exec` at it

**Files:**
- Modify: `client/agent/binaries/resolve.ts` (add `ensurePython`)
- Modify: `client/agent/tools/pythonExec.ts:32` (use resolved python)
- Test: `tests/unit/binaries/ensurePython.test.ts`

**Interfaces:**
- Consumes: `ensureBinary` (Task 1).
- Produces: `ensurePython(io?: BinariesIo): Promise<string>` → absolute path to a `python3` executable, installing via `uv python install --install-dir <destDir>` on first use.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/binaries/ensurePython.test.ts
import { describe, it, expect, vi } from 'vitest';

const spawnCollect = vi.fn(async () => ({ stdout: '', stderr: '', code: 0 }));
vi.mock('../../../client/agent/tools/spawn', () => ({ spawnCollect }));

import { ensurePython, __setPythonIo } from '../../../client/agent/binaries/resolve';

describe('ensurePython', () => {
  it('runs uv python install once, returns the python3 path', async () => {
    const files = new Map<string, string>();
    __setPythonIo({
      exists: (p) => Promise.resolve([...files.keys()].some((k) => k === p || k.startsWith(p + '/'))),
      mkdirp: () => Promise.resolve(),
      readFile: (p) => Promise.resolve(files.get(p) ?? '{}'),
      writeFile: (p, s) => { files.set(p, s); return Promise.resolve(); },
      now: () => 1,
    });
    spawnCollect.mockImplementation(async (_cmd: string, args: string[]) => {
      // simulate uv creating the runtime
      const dest = args[args.indexOf('--install-dir') + 1];
      files.set(dest + '/bin/python3', '#');
      return { stdout: '', stderr: '', code: 0 };
    });
    const py = await ensurePython();
    expect(py).toMatch(/python\/bin\/python3$/);
    expect(spawnCollect).toHaveBeenCalledWith('uv', expect.arrayContaining(['python', 'install']), expect.anything());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/binaries/ensurePython.test.ts`
Expected: FAIL — `ensurePython`/`__setPythonIo` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `client/agent/binaries/resolve.ts`:

```ts
import { spawnCollect } from '../tools/spawn';

let pythonIo: BinariesIo | undefined;
/** Test seam: override the IO used by ensurePython. */
export function __setPythonIo(io: BinariesIo): void { pythonIo = io; }

export async function ensurePython(io: BinariesIo = pythonIo ?? nativeIo): Promise<string> {
  const dir = await ensureBinary('python', async (destDir) => {
    const res = await spawnCollect('uv', ['python', 'install', '--install-dir', destDir], {});
    if (res.code !== 0 && res.code !== null) {
      throw new Error(`uv python install failed (exit ${res.code}): ${res.stderr.slice(0, 400)}`);
    }
  }, io);
  return `${dir}/bin/python3`;
}
```

Modify `client/agent/tools/pythonExec.ts` — replace the bare `python` spawn (line 32):

```ts
import { ensurePython } from '../binaries/resolve';
// ...
    const root = projectRoot(ctx) ?? undefined;
    const python = await ensurePython();
    const { stdout, stderr, code: exit } = await spawnCollect(python, ['-c', code], {
      ...(root ? { cwd: root } : {}),
    });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/unit/binaries/ tests/unit/tools/python.test.ts`
Expected: PASS. (If the existing `python.test.ts` asserts the bare-`python` command, update its expectation to the resolved path via a mocked `ensurePython`.)

- [ ] **Step 5: Commit**

```bash
git add client/agent/binaries/resolve.ts client/agent/tools/pythonExec.ts tests/unit/binaries/ensurePython.test.ts
git commit -m "feat(binaries): on-demand python via uv; python_exec uses resolved runtime"
```

---

### Task 3: Swappable `SessionStore` seam

**Files:**
- Create: `client/studio/agent/sessionStore.ts`
- Modify: `client/studio/agent/serverSessionApi.ts:128-170` (delegate `sessionApi` to the active store)
- Test: `tests/unit/agent/sessionStore.test.ts`

**Interfaces:**
- Produces:
  - `interface SessionStore` with the 7 methods matching the current `sessionApi` shape (verbatim input/return types from `serverSessionApi.ts:128-170`).
  - `serverSessionStore: SessionStore` (the existing `api(...)`-backed impl, moved here).
  - `let activeStore` + `setSessionStore(s: SessionStore): void` + `getSessionStore(): SessionStore`.
- Consumes (from `serverSessionApi.ts`): the `api` helper, and types `StoredRole`, `StoredMessageRow`, `SessionListRow`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/agent/sessionStore.test.ts
import { describe, it, expect, vi } from 'vitest';
vi.mock('ugly-app/native', () => ({ native: { fs: {} } }));
import { setSessionStore, getSessionStore, type SessionStore } from '../../../client/studio/agent/sessionStore';
import { sessionApi } from '../../../client/studio/agent/serverSessionApi';

describe('sessionApi delegates to the active store', () => {
  it('routes appendMessage to the injected store', async () => {
    const appendMessage = vi.fn(async () => ({ ok: true }));
    const fake = { appendMessage } as unknown as SessionStore;
    const prev = getSessionStore();
    setSessionStore(fake);
    await sessionApi.appendMessage({ sessionId: 's', seq: 0, role: 'user', content: '"hi"' });
    expect(appendMessage).toHaveBeenCalledWith({ sessionId: 's', seq: 0, role: 'user', content: '"hi"' });
    setSessionStore(prev);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/agent/sessionStore.test.ts`
Expected: FAIL — `sessionStore` module missing / `sessionApi` not delegating.

- [ ] **Step 3: Write minimal implementation**

Create `client/studio/agent/sessionStore.ts`:

```ts
// The session-persistence seam. `sessionApi` (serverSessionApi.ts) delegates
// here so the surface (studio → server, CLI → filesystem) can be swapped without
// touching the agent loop. Server impl is the default.
import type { StoredRole, StoredMessageRow, SessionListRow } from './serverSessionApi';

export interface SessionStore {
  upsert(i: { sessionId: string; projectId: string; title?: string; kind?: 'main' | 'session'; model?: string; status?: 'running' | 'idle' | 'done' | 'error'; messageCount?: number; costUsd?: number }): Promise<{ ok: boolean } | null>;
  appendMessage(i: { sessionId: string; seq: number; role: StoredRole; content: string }): Promise<{ ok: boolean } | null>;
  compact(i: { sessionId: string; droppedIds: string[]; summaryId: string; summarySeq: number; summaryText: string }): Promise<{ ok: boolean } | null>;
  listMessages(i: { sessionId: string; limit?: number; includeCompacted?: boolean }): Promise<{ messages: StoredMessageRow[] } | null>;
  list(i: { projectId: string }): Promise<{ sessions: SessionListRow[] } | null>;
  archive(i: { sessionId: string }): Promise<{ ok: boolean } | null>;
  clearMessages(i: { sessionId: string }): Promise<{ ok: boolean; deleted: number } | null>;
}

let activeStore: SessionStore | undefined;
export function setSessionStore(s: SessionStore): void { activeStore = s; }
export function getSessionStore(): SessionStore {
  if (!activeStore) throw new Error('session store not initialised');
  return activeStore;
}
```

In `serverSessionApi.ts`: keep the `api()` helper + all types/pure helpers. Rename the current `export const sessionApi = {…}` object to `const serverSessionStore: SessionStore = {…}` (unchanged bodies), register it as the default, and export a delegating `sessionApi`:

```ts
import { setSessionStore, getSessionStore, type SessionStore } from './sessionStore';

const serverSessionStore: SessionStore = {
  upsert: (input) => api('codingSessionUpsert', input),
  appendMessage: (input) => api('codingSessionAppendMessage', input),
  compact: (input) => api('codingSessionCompact', input),
  listMessages: (input) => api('codingSessionListMessages', input),
  list: (input) => api('codingSessionList', input),
  archive: (input) => api('codingSessionArchive', input),
  clearMessages: (input) => api('codingSessionClearMessages', input),
};
setSessionStore(serverSessionStore);           // default = server

export const sessionApi: SessionStore = {
  upsert: (i) => getSessionStore().upsert(i),
  appendMessage: (i) => getSessionStore().appendMessage(i),
  compact: (i) => getSessionStore().compact(i),
  listMessages: (i) => getSessionStore().listMessages(i),
  list: (i) => getSessionStore().list(i),
  archive: (i) => getSessionStore().archive(i),
  clearMessages: (i) => getSessionStore().clearMessages(i),
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/unit/agent/sessionStore.test.ts && pnpm vitest run tests/unit/`
Expected: PASS, and the existing session/resume unit tests still pass (no behavior change on the server path).

- [ ] **Step 5: Commit**

```bash
git add client/studio/agent/sessionStore.ts client/studio/agent/serverSessionApi.ts tests/unit/agent/sessionStore.test.ts
git commit -m "refactor(agent): route sessionApi through a swappable SessionStore"
```

---

### Task 4: Filesystem session store (`~/.ugly-code/session/<id>/`)

**Files:**
- Create: `client/studio/agent/fsSessionStore.ts`
- Test: `tests/unit/agent/fsSessionStore.test.ts`

**Interfaces:**
- Consumes: `SessionStore` (Task 3); `native.fs`.
- Produces: `makeFsSessionStore(rootDir: string): SessionStore`. Writes `metadata.json` (upsert), `messages.jsonl` (append/list/compact/clear). One `StoredMessageRow` per JSONL line; `compact` marks dropped rows `compacted:true` and appends a `summary` row; `listMessages` filters on `includeCompacted`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/agent/fsSessionStore.test.ts
import { describe, it, expect, vi } from 'vitest';
const files = new Map<string, string>();
vi.mock('ugly-app/native', () => ({
  native: { fs: {
    mkdir: () => Promise.resolve(),
    writeFile: (p: string, s: string) => { files.set(p, s); return Promise.resolve(); },
    readFile: (p: string) => (files.has(p) ? Promise.resolve(files.get(p)!) : Promise.reject(new Error('ENOENT'))),
  } },
}));
import { makeFsSessionStore } from '../../../client/studio/agent/fsSessionStore';

describe('fsSessionStore', () => {
  it('appends rows and lists them in seq order (excluding compacted by default)', async () => {
    files.clear();
    const store = makeFsSessionStore('/root');
    await store.appendMessage({ sessionId: 's1', seq: 0, role: 'user', content: '"hi"' });
    await store.appendMessage({ sessionId: 's1', seq: 1, role: 'assistant', content: '{"content":[]}' });
    const listed = await store.listMessages({ sessionId: 's1' });
    expect(listed?.messages.map((m) => m.seq)).toEqual([0, 1]);
    expect(files.has('/root/s1/messages.jsonl')).toBe(true);
  });

  it('compact marks dropped rows and appends a summary row', async () => {
    files.clear();
    const store = makeFsSessionStore('/root');
    await store.appendMessage({ sessionId: 's1', seq: 0, role: 'user', content: '"a"' });
    await store.appendMessage({ sessionId: 's1', seq: 1, role: 'assistant', content: '{"content":[]}' });
    await store.compact({ sessionId: 's1', droppedIds: ['s1:0'], summaryId: 's1:summary:0', summarySeq: 0, summaryText: 'sum' });
    const normal = await store.listMessages({ sessionId: 's1' });
    const all = await store.listMessages({ sessionId: 's1', includeCompacted: true });
    expect(normal?.messages.find((m) => m.seq === 0 && m.kind === 'summary')).toBeTruthy();
    expect(all?.messages.some((m) => m.compacted)).toBe(true);
  });

  it('upsert writes metadata.json', async () => {
    files.clear();
    const store = makeFsSessionStore('/root');
    await store.upsert({ sessionId: 's1', projectId: 'p', title: 'T', model: 'glm_5_2' });
    expect(JSON.parse(files.get('/root/s1/metadata.json')!).title).toBe('T');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/agent/fsSessionStore.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Write minimal implementation**

```ts
// client/studio/agent/fsSessionStore.ts
// Filesystem SessionStore for the CLI: ~/.ugly-code/session/<id>/{metadata.json,messages.jsonl}.
// native.fs has no append, so we rewrite messages.jsonl each call (mirrors sessionLog.ts).
import { native } from 'ugly-app/native';
import type { SessionStore } from './sessionStore';
import type { StoredMessageRow, SessionListRow } from './serverSessionApi';

interface StoredRowFull extends StoredMessageRow { id: string }

function sessionDir(root: string, sessionId: string): string {
  return `${root}/${sessionId.replace(/[^a-zA-Z0-9_.:-]/g, '_')}`;
}

async function readRows(dir: string): Promise<StoredRowFull[]> {
  try {
    const raw = await native.fs.readFile(`${dir}/messages.jsonl`);
    return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l) as StoredRowFull);
  } catch { return []; }
}
async function writeRows(dir: string, rows: StoredRowFull[]): Promise<void> {
  await native.fs.mkdir(dir, { recursive: true });
  await native.fs.writeFile(`${dir}/messages.jsonl`, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

export function makeFsSessionStore(root: string): SessionStore {
  return {
    async upsert(i) {
      const dir = sessionDir(root, i.sessionId);
      await native.fs.mkdir(dir, { recursive: true });
      let prev: Record<string, unknown> = {};
      try { prev = JSON.parse(await native.fs.readFile(`${dir}/metadata.json`)); } catch { /* first */ }
      const next = { ...prev, ...i, updated: Date.now(), created: (prev.created as number) ?? Date.now() };
      await native.fs.writeFile(`${dir}/metadata.json`, JSON.stringify(next, null, 2));
      return { ok: true };
    },
    async appendMessage(i) {
      const dir = sessionDir(root, i.sessionId);
      const rows = await readRows(dir);
      rows.push({ id: `${i.sessionId}:${i.seq}`, seq: i.seq, role: i.role, kind: 'message', compacted: false, content: i.content });
      await writeRows(dir, rows);
      return { ok: true };
    },
    async compact(i) {
      const dir = sessionDir(root, i.sessionId);
      const rows = await readRows(dir);
      for (const r of rows) if (i.droppedIds.includes(r.id)) r.compacted = true;
      rows.push({ id: i.summaryId, seq: i.summarySeq, role: 'user', kind: 'summary', compacted: false, content: JSON.stringify(i.summaryText) });
      rows.sort((a, b) => a.seq - b.seq || Number(a.kind === 'summary') - Number(b.kind === 'summary'));
      await writeRows(dir, rows);
      return { ok: true };
    },
    async listMessages(i) {
      const rows = await readRows(sessionDir(root, i.sessionId));
      const filtered = (i.includeCompacted ? rows : rows.filter((r) => !r.compacted)).sort((a, b) => a.seq - b.seq);
      const limited = i.limit ? filtered.slice(-i.limit) : filtered;
      return { messages: limited.map(({ id: _id, ...m }) => m) };
    },
    async list(i) {
      // Single-session CLI runs don't need a sidebar; return the one session if metadata exists.
      void i;
      return { sessions: [] as SessionListRow[] };
    },
    async archive() { return { ok: true }; },
    async clearMessages(i) {
      const dir = sessionDir(root, i.sessionId);
      const n = (await readRows(dir)).length;
      await writeRows(dir, []);
      return { ok: true, deleted: n };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/agent/fsSessionStore.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add client/studio/agent/fsSessionStore.ts tests/unit/agent/fsSessionStore.test.ts
git commit -m "feat(agent): filesystem session store under ~/.ugly-code/session"
```

---

### Task 5: CLI auth resolution + `--login`

**Files:**
- Create: `client/cli/auth.ts`
- Test: `tests/unit/cli/auth.test.ts`

**Interfaces:**
- Produces: `resolveAuth(opts: { token?: string; testUser?: boolean }): Promise<{ token: string; origin: string }>`. Precedence: explicit `--token` → `--test-user` (mint via `ugly-app test-user create`, read `.result.token`) → `~/.ugly-bot/auth.json`. Throws a clear "run `ugly-code --login`" error when none resolve. `origin` comes from the project's `.uglyapp` deploy URL (fallback env `UGLY_CODE_ORIGIN`).
- Consumes: `spawnCollect` (to shell `ugly-app test-user create`); `native.fs` (read `~/.ugly-bot/auth.json`).

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/cli/auth.test.ts
import { describe, it, expect, vi } from 'vitest';
const store: Record<string, string> = {};
vi.mock('ugly-app/native', () => ({
  native: { fs: { readFile: (p: string) => (store[p] ? Promise.resolve(store[p]) : Promise.reject(new Error('ENOENT'))) } },
}));
import { resolveAuth } from '../../../client/cli/auth';

describe('resolveAuth', () => {
  it('prefers an explicit token', async () => {
    const r = await resolveAuth({ token: 'T', origin: 'https://x' } as never);
    expect(r.token).toBe('T');
  });
  it('reads ~/.ugly-bot/auth.json when no flag', async () => {
    store[`${process.env.HOME}/.ugly-bot/auth.json`] = JSON.stringify({ token: 'STORED' });
    const r = await resolveAuth({ origin: 'https://x' } as never);
    expect(r.token).toBe('STORED');
  });
  it('throws a login hint when nothing resolves', async () => {
    delete store[`${process.env.HOME}/.ugly-bot/auth.json`];
    await expect(resolveAuth({ origin: 'https://x' } as never)).rejects.toThrow(/ugly-code --login/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/cli/auth.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Write minimal implementation**

```ts
// client/cli/auth.ts
import { native } from 'ugly-app/native';
import { spawnCollect } from '../agent/tools/spawn';

export interface AuthOpts { token?: string; testUser?: boolean; origin: string }
export interface ResolvedAuth { token: string; origin: string }

function home(): string { return process.env.HOME ?? process.env.USERPROFILE ?? '.'; }

export async function resolveAuth(opts: AuthOpts): Promise<ResolvedAuth> {
  if (opts.token) return { token: opts.token, origin: opts.origin };
  if (opts.testUser) {
    const res = await spawnCollect('ugly-app', ['test-user', 'create'], {});
    const parsed = JSON.parse(res.stdout) as { result?: { token?: string } };
    const token = parsed.result?.token;
    if (!token) throw new Error(`test-user create returned no token: ${res.stdout.slice(0, 200)}`);
    return { token, origin: opts.origin };
  }
  try {
    const raw = await native.fs.readFile(`${home()}/.ugly-bot/auth.json`);
    const token = (JSON.parse(raw) as { token?: string }).token;
    if (token) return { token, origin: opts.origin };
  } catch { /* not logged in */ }
  throw new Error('Not logged in. Run `ugly-code --login` (or pass --test-user / --token).');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/cli/auth.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add client/cli/auth.ts tests/unit/cli/auth.test.ts
git commit -m "feat(cli): auth resolution (login token / test-user / --token)"
```

---

### Task 6: In-process task driver

**Files:**
- Create: `client/cli/taskDriver.ts`
- Test: `tests/unit/cli/taskDriver.test.ts`

**Interfaces:**
- Consumes: `createNodeUglyNative` (`ugly-app/native`), `setSessionStore` + `makeFsSessionStore`, `runClientAgentTurn` (`client/studio/agent/clientAgent`), `setActiveProjectPath` (`client/studio/projectPath`).
- Produces: `bootDriver(cfg: { projectPath: string; sessionId: string; origin: string; token: string; storeRoot: string }): void` (installs globals + fetch shim + fs store — mirrors `coding-task.ts` boot) and `runTurn(sessionId: string, text: string, onMsg: (m: unknown) => void): Promise<void>` (wraps `runClientAgentTurn`, resolves on turn completion).

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/cli/taskDriver.test.ts
import { describe, it, expect, vi } from 'vitest';
const runClientAgentTurn = vi.fn(async (_s: string, _t: string, emit: (m: unknown) => void) => { emit({ type: 'x' }); });
vi.mock('../../../client/studio/agent/clientAgent', () => ({ runClientAgentTurn, ensureCodebaseAnalysis: vi.fn() }));
vi.mock('../../../client/studio/projectPath', () => ({ setActiveProjectPath: vi.fn() }));
vi.mock('ugly-app/native', () => ({ createNodeUglyNative: () => ({}), native: { fs: {} } }));
const setSessionStore = vi.fn();
vi.mock('../../../client/studio/agent/sessionStore', () => ({ setSessionStore }));
vi.mock('../../../client/studio/agent/fsSessionStore', () => ({ makeFsSessionStore: () => ({ tag: 'fs' }) }));
import { bootDriver, runTurn } from '../../../client/cli/taskDriver';

describe('taskDriver', () => {
  it('installs the fs store on boot and forwards turn messages', async () => {
    bootDriver({ projectPath: '/p', sessionId: 's', origin: 'https://x', token: 'T', storeRoot: '/root' });
    expect(setSessionStore).toHaveBeenCalledWith({ tag: 'fs' });
    const msgs: unknown[] = [];
    await runTurn('s', 'hi', (m) => msgs.push(m));
    expect(runClientAgentTurn).toHaveBeenCalledWith('s', 'hi', expect.any(Function), undefined);
    expect(msgs).toEqual([{ type: 'x' }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/cli/taskDriver.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Write minimal implementation**

```ts
// client/cli/taskDriver.ts
// In-process boot of the coding-agent for the CLI — mirrors coding-task.ts's setup
// (Node UglyNative + /api/* fetch shim + session store) but runs in the CLI process
// instead of a task child. No Electron, no Studio host.
import { createNodeUglyNative } from 'ugly-app/native';
import { setActiveProjectPath } from '../studio/projectPath';
import { runClientAgentTurn } from '../studio/agent/clientAgent';
import { setSessionStore } from '../studio/agent/sessionStore';
import { makeFsSessionStore } from '../studio/agent/fsSessionStore';

export interface DriverCfg { projectPath: string; sessionId: string; origin: string; token: string; storeRoot: string }

export function bootDriver(cfg: DriverCfg): void {
  const g = globalThis as typeof globalThis & { UglyNative?: unknown; localStorage?: unknown };
  g.UglyNative = createNodeUglyNative();
  if (!g.localStorage) {
    const mem = new Map<string, string>();
    g.localStorage = {
      getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
      setItem: (k: string, v: string) => { mem.set(k, v); },
      removeItem: (k: string) => { mem.delete(k); },
      clear: () => { mem.clear(); }, key: (i: number) => [...mem.keys()][i] ?? null,
      get length() { return mem.size; },
    };
  }
  setActiveProjectPath(cfg.projectPath);
  setSessionStore(makeFsSessionStore(cfg.storeRoot));
  const realFetch = globalThis.fetch.bind(globalThis);
  (globalThis as { fetch: typeof fetch }).fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (typeof input === 'string' && input.startsWith('/')) {
      const headers = new Headers(init?.headers);
      if (!headers.has('Cookie')) headers.set('Cookie', `auth_token=${cfg.token}`);
      return realFetch(cfg.origin + input, { ...init, headers });
    }
    return realFetch(input, init);
  });
}

export async function runTurn(sessionId: string, text: string, onMsg: (m: unknown) => void): Promise<void> {
  await runClientAgentTurn(sessionId, text, onMsg);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/cli/taskDriver.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/cli/taskDriver.ts tests/unit/cli/taskDriver.test.ts
git commit -m "feat(cli): in-process coding-agent driver (globals + fetch shim + fs store)"
```

---

### Task 7: `evals run <task>` — clone, run turns, grade

**Files:**
- Create: `client/cli/evalRun.ts`
- Test: `tests/unit/cli/evalRun.test.ts`

**Interfaces:**
- Consumes: `getEvalTask`, `firstTurnPrompt` (`client/studio/evals/registry`); `gradeProject`, `type GradeDeps` (`client/studio/evals/grader`); `bootDriver`, `runTurn` (Task 6); `spawnCollect` (clone).
- Produces: `runEval(cfg: { taskName: string; origin: string; token: string; model?: string }): Promise<{ score: number; scoreMax: number }>`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/cli/evalRun.test.ts
import { describe, it, expect, vi } from 'vitest';
vi.mock('../../../client/studio/evals/registry', () => ({
  getEvalTask: (n: string) => (n === 'demo' ? { name: 'demo', turns: ['do it'], successCriteria: 'x', gates: [{ name: 'tsc', points: 1, kind: 'tsc' }], repoUrl: 'https://r.git', budget: { maxTurns: 5, maxCostUsd: 1, timeoutMs: 1000 } } : undefined),
  firstTurnPrompt: (t: { turns: string[] }) => t.turns[0],
}));
const gradeProject = vi.fn(async () => ({ score: 1, scoreMax: 1 }));
vi.mock('../../../client/studio/evals/grader', () => ({ gradeProject }));
const bootDriver = vi.fn(); const runTurn = vi.fn(async () => {});
vi.mock('../../../client/cli/taskDriver', () => ({ bootDriver, runTurn }));
const spawnCollect = vi.fn(async () => ({ stdout: '/tmp/demo-1', stderr: '', code: 0 }));
vi.mock('../../../client/agent/tools/spawn', () => ({ spawnCollect }));
import { runEval } from '../../../client/cli/evalRun';

describe('runEval', () => {
  it('clones, runs the first turn, and grades', async () => {
    const res = await runEval({ taskName: 'demo', origin: 'https://x', token: 'T' });
    expect(spawnCollect).toHaveBeenCalled();                 // fixture clone
    expect(bootDriver).toHaveBeenCalled();
    expect(runTurn).toHaveBeenCalledWith(expect.any(String), 'do it', expect.any(Function));
    expect(gradeProject).toHaveBeenCalled();
    expect(res).toEqual({ score: 1, scoreMax: 1 });
  });
  it('errors on unknown task', async () => {
    await expect(runEval({ taskName: 'nope', origin: 'https://x', token: 'T' })).rejects.toThrow(/Unknown eval task/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/cli/evalRun.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Write minimal implementation**

```ts
// client/cli/evalRun.ts
import { getEvalTask, firstTurnPrompt } from '../studio/evals/registry';
import { gradeProject, type GradeDeps } from '../studio/evals/grader';
import { spawnCollect } from '../agent/tools/spawn';
import { bootDriver, runTurn } from './taskDriver';

const ZERO_TOTALS = { costUsd: 0, turns: 0, promptTokens: 0, completionTokens: 0 };

/** Clone the task's fixture repo into ~/.ugly-code/eval-projects/<task>-<stamp> and re-init git. */
async function cloneFixture(taskName: string, repoUrl: string | undefined): Promise<string> {
  const safe = taskName.replace(/[^a-zA-Z0-9_.-]/g, '_');
  const stamp = String(Date.now());
  const base = `$HOME/.ugly-code/eval-projects/${safe}-${stamp}`;
  const seedGit = `rm -rf .git && git init -b main -q && git add -A && git -c user.email=eval@ugly.bot -c user.name=eval commit -q -m "eval: seed ${safe}"`;
  const cmd = repoUrl
    ? `mkdir -p "$HOME/.ugly-code/eval-projects" && git clone --depth 1 "${repoUrl.replace(/"/g, '\\"')}" "${base}" && cd "${base}" && ${seedGit} && pwd`
    : `mkdir -p "${base}" && cd "${base}" && printf '{"name":"%s","version":"0.0.0","private":true}\\n' "${safe}" > package.json && ${seedGit} && pwd`;
  const res = await spawnCollect('bash', ['-lc', cmd], {});
  const path = res.stdout.trim().split('\n').pop() ?? '';
  if (!path) throw new Error(`fixture clone failed: ${res.stderr.slice(0, 300)}`);
  return path;
}

const cliGradeDeps: GradeDeps = {
  run: async (cmd, args, cwd) => { const r = await spawnCollect(cmd, args, { cwd }); return { out: r.stdout + r.stderr, code: r.code }; },
  readFile: async (p) => { const { native } = await import('ugly-app/native'); return native.fs.readFile(p); },
  exists: async (p) => { try { const { native } = await import('ugly-app/native'); await native.fs.readFile(p); return true; } catch { return false; } },
  // judge omitted for Plan 1 (judge: gates stay pending); Plan 4 wires the /api/agentStep judge.
};

export async function runEval(cfg: { taskName: string; origin: string; token: string; model?: string }): Promise<{ score: number; scoreMax: number }> {
  const task = getEvalTask(cfg.taskName);
  if (!task) throw new Error(`Unknown eval task: ${cfg.taskName}`);
  const projectPath = await cloneFixture(task.name, task.repoUrl);
  const sessionId = `cli:${task.name}:${Date.now()}`;
  const storeRoot = `${process.env.HOME ?? '.'}/.ugly-code/session`;
  bootDriver({ projectPath, sessionId, origin: cfg.origin, token: cfg.token, storeRoot });
  for (const turn of [firstTurnPrompt(task), ...task.turns.slice(1)]) {
    await runTurn(sessionId, turn, () => { /* transcript persisted by the fs store */ });
  }
  const result = await gradeProject(
    { taskName: task.name, projectPath, ...(task.gates ? { gates: task.gates } : {}), ...(task.successCriteria ? { successCriteria: task.successCriteria } : {}), runTotals: ZERO_TOTALS },
    cliGradeDeps,
  );
  return { score: result.score, scoreMax: result.scoreMax };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/cli/evalRun.test.ts`
Expected: PASS (2 tests).

Note: confirm `EvalGradeResult` exposes `score`/`scoreMax` and `runTotals`'s shape (`client/studio/shared/api.ts`); adjust `ZERO_TOTALS` to match the real `runTotals` type if it differs.

- [ ] **Step 5: Commit**

```bash
git add client/cli/evalRun.ts tests/unit/cli/evalRun.test.ts
git commit -m "feat(cli): evals run — clone fixture, drive turns, grade"
```

---

### Task 8: CLI entry (`ugly-code` bin) + `run`/`resume`/`--login` dispatch

**Files:**
- Create: `client/cli/evalCli.ts`
- Create: `bin/ugly-code.mjs`
- Modify: `package.json` (add `bin` + a `cli` script)
- Test: `tests/unit/cli/evalCli.test.ts`

**Interfaces:**
- Consumes: `resolveAuth` (Task 5), `runEval` (Task 7), `reconstructResumeContext` + `makeFsSessionStore` (resume).
- Produces: `main(argv: string[]): Promise<number>` (exit code). Commands: `evals run <task> [--model m] [--token t] [--test-user] [--origin o]`; `evals resume <sessionId>`; `--login`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/cli/evalCli.test.ts
import { describe, it, expect, vi } from 'vitest';
const runEval = vi.fn(async () => ({ score: 2, scoreMax: 2 }));
vi.mock('../../../client/cli/evalRun', () => ({ runEval }));
const resolveAuth = vi.fn(async () => ({ token: 'T', origin: 'https://x' }));
vi.mock('../../../client/cli/auth', () => ({ resolveAuth }));
import { main } from '../../../client/cli/evalCli';

describe('evalCli', () => {
  it('routes `evals run <task>` through auth + runEval, exit 0', async () => {
    const code = await main(['evals', 'run', 'demo', '--origin', 'https://x']);
    expect(resolveAuth).toHaveBeenCalled();
    expect(runEval).toHaveBeenCalledWith(expect.objectContaining({ taskName: 'demo', token: 'T' }));
    expect(code).toBe(0);
  });
  it('returns non-zero on unknown command', async () => {
    expect(await main(['frobnicate'])).not.toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/cli/evalCli.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Write minimal implementation**

```ts
// client/cli/evalCli.ts
import { resolveAuth } from './auth';
import { runEval } from './evalRun';

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export async function main(argv: string[]): Promise<number> {
  try {
    if (argv[0] === '--login') {
      // Delegate to the ugly-app browser login flow (writes ~/.ugly-bot/auth.json).
      const { spawnCollect } = await import('../agent/tools/spawn');
      const r = await spawnCollect('ugly-app', ['login'], {});
      process.stdout.write(r.stdout);
      return r.code ?? 0;
    }
    if (argv[0] === 'evals' && argv[1] === 'run') {
      const taskName = argv[2];
      if (!taskName) { process.stderr.write('usage: ugly-code evals run <task>\n'); return 2; }
      const origin = flag(argv, '--origin') ?? process.env.UGLY_CODE_ORIGIN ?? '';
      const auth = await resolveAuth({ origin, ...(flag(argv, '--token') ? { token: flag(argv, '--token') } : {}), testUser: argv.includes('--test-user') });
      const res = await runEval({ taskName, origin: auth.origin, token: auth.token, ...(flag(argv, '--model') ? { model: flag(argv, '--model') } : {}) });
      process.stdout.write(`${taskName}: ${res.score}/${res.scoreMax}\n`);
      return res.score >= res.scoreMax ? 0 : 1;
    }
    if (argv[0] === 'evals' && argv[1] === 'resume') {
      // Plan 1: resume reconstructs context from the fs store on the next `run`;
      // a standalone resume command is wired in Plan 4 alongside multi-turn CLI sessions.
      process.stderr.write('resume: not yet available (Plan 4)\n');
      return 2;
    }
    process.stderr.write(`unknown command: ${argv.join(' ')}\n`);
    return 2;
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}
```

```js
// bin/ugly-code.mjs
#!/usr/bin/env node
import { main } from '../dist/cli/evalCli.js';
main(process.argv.slice(2)).then((code) => process.exit(code));
```

In `package.json` add:

```json
  "bin": { "ugly-code": "bin/ugly-code.mjs" },
```
and a script:
```json
    "cli": "tsx client/cli/evalCli.ts",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/cli/evalCli.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Manual smoke (real, gated) + commit**

Manual (requires login + deployed origin):
```bash
pnpm cli evals run breaking-change-find-callers --origin https://<deployed-ugly-code> --test-user
# Expect: clones the fixture, runs the agent, prints e.g. "breaking-change-find-callers: 2/2",
# and writes ~/.ugly-code/session/<id>/{metadata.json,messages.jsonl}
```

```bash
git add client/cli/evalCli.ts bin/ugly-code.mjs package.json tests/unit/cli/evalCli.test.ts
git commit -m "feat(cli): ugly-code bin — evals run / --login dispatch"
```

---

## Self-Review

**Spec coverage (W0/W1/W1b):**
- W0 shared binaries `~/.ugly-bot/binaries/` + on-demand Python → Tasks 1–2. (ugly-studio/ugly-app-dev migration deferred — stated in Scope.)
- W1 CLI over the existing task, auth flow → Tasks 5, 6, 7, 8.
- W1b filesystem session store + `sessionApi` seam → Tasks 3, 4 (injected in Task 6).
- Reuse of `createNodeUglyNative`, `runClientAgentTurn`, `gradeProject`, registry loaders, fixture-clone → Tasks 6, 7.

**Known integration checkpoints to confirm during execution (not placeholders — explicit verifications):**
- Task 2: existing `tests/unit/tools/python.test.ts` may assert the bare `python` command — update to the resolved path.
- Task 6: `runClientAgentTurn` internally calls `ensureWorkspaceStep` (worktree provisioning) and `ensureResumed`; for a plain cloned project confirm the main-session path is a no-op (it is for `kind:'main'`). If it requires a worktree, pass the project as the main session.
- Task 7: confirm `EvalGradeResult.runTotals` shape in `client/studio/shared/api.ts`; align `ZERO_TOTALS`.
- `native.fs` method names (`mkdir({recursive})`, `writeFile`, `readFile`) — confirm against `createNodeUglyNative` signatures.

**Placeholder scan:** none — every step has runnable code/commands. The `resume` command intentionally returns exit 2 with a Plan-4 pointer (a defined behavior + test, not a stub).

**Type consistency:** `SessionStore` (Task 3) is used verbatim by `makeFsSessionStore` (Task 4) and `setSessionStore` (Task 6). `ResolvedAuth {token,origin}` (Task 5) feeds `runEval` (Task 7) and `main` (Task 8). `runEval`'s return `{score,scoreMax}` matches `main`'s exit logic.

## The remaining plans (roadmap)

- **Plan 2 — `python_exec` full port + Ep 04 tests:** stateful `PythonSession`, `recursive_llm`/`final` via a `ugly_studio` helper, read-only guard-mode, tempfile-leak meter, `uv run --script`, timeouts; then the Ep 04 pro/con eval tasks (P-PRO-1/2, P-CON-1/2/3).
- **Plan 3 — pattern engine + mid-step judge + Ep 05 tests:** `patterns/registry.ts` (SBV steps with `allowedTools`/`systemPromptTail`/`advanceCriteria`), the judge (continue/advance), classifier + `--pattern`; then R-PRO-1/2, R-CON-1.
- **Plan 4 — A/B comparison harness + scoreboard + in-studio parity:** `EvalRunConfig` matrix runner, scoreboard/history (un-stub `evalListHistory`), in-studio comparison panel, and the CLI==studio parity test; plus multi-turn CLI sessions + `evals resume`.
