# python_exec One-Shot Hardening (Plan 2a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace the bare `python -c` `python_exec` with a hardened one-shot runner ported from the monolith — `uv run --script` in a temp file with SIGTERM→SIGKILL timeout, output-buffer caps, head+tail truncation, and guaranteed tempfile cleanup — plus the two integration fixes the Plan-1 review surfaced (uv bootstrap, permission-by-path).

**Architecture:** Port the monolith `python-runtime/one-shot.ts` + `output-truncate.ts` into ugly-code's client-agent world: `native.process.spawn`/`native.fs` instead of the host abstraction, and the `~/.ugly-bot/binaries` resolver (`ensureUv`) instead of bundled-binary paths. The stateful `PythonSession` + `recursive_llm` TCP bridge + guard-mode are **out of scope** (Plan 2b).

**Tech Stack:** TypeScript (ESM), `uv`, `native.process`/`native.fs`, vitest.

## Global Constraints

- **pnpm, never npm/yarn** for repo tooling.
- **Binaries root:** `~/.ugly-bot/binaries/<platform>-<arch>/` (Plan 1). uv installs here on demand.
- **`native.fs` has no append**; `UglyProcess` = `{ onStdout, onStderr, onExit, onError, write, closeStdin, kill(signal?) }`.
- **Truncation constants (verbatim from monolith):** HEAD_LINES=100, TAIL_LINES=50, MAX_BYTES=200_000; one-shot buffer cap MAX_BUF=400_000; timeout SIGTERM then SIGKILL after 2000ms; default timeout 60_000ms.
- **Guard-mode / stateful / recursive_llm are Plan 2b** — do not add `mode`, `PythonSession`, or bridge here.
- **TDD, DRY, one commit per task.**

## Scope

Plan 2a of the Plan-2 subsystem. Delivers hardened one-shot `python_exec` + uv bootstrap + permission fix. Out of scope: stateful sessions, `recursive_llm`/`final`, guard-mode, curated-library provisioning (a script that `import numpy` still fails unless it declares PEP 723 deps — deferred), Ep 04 A/B footage (needs Plan 4 comparison harness).

## File Structure

- Modify `client/agent/binaries/resolve.ts` — add `ensureUv()` (resolve uv: PATH → else install into the binaries root via the astral installer).
- Create `client/agent/tools/outputTruncate.ts` — `truncateOutput` (verbatim port).
- Create `client/agent/tools/pythonOneShot.ts` — `runPythonOneShot` (ported, native-backed).
- Modify `client/agent/tools/pythonExec.ts` — call `runPythonOneShot`; add optional `timeout_ms`.
- Modify `client/cli/taskDriver.ts` — grant `process: 'full'` (permission-by-path fix).
- Tests: `tests/unit/binaries/ensureUv.test.ts`, `tests/unit/tools/outputTruncate.test.ts`, `tests/unit/tools/pythonOneShot.test.ts`; update `tests/unit/tools/python.test.ts`, `tests/unit/cli/taskDriver.test.ts`.

---

### Task 1: `ensureUv()` — uv bootstrap

**Files:** Modify `client/agent/binaries/resolve.ts`; Test `tests/unit/binaries/ensureUv.test.ts`.

**Interfaces:**
- Consumes: `ensureBinary`, `spawnCollect`.
- Produces: `ensureUv(io?): Promise<string>` → absolute `uv` path. If `uv` is on PATH, returns `'uv'`; else installs into `~/.ugly-bot/binaries/uv/` via the astral installer and returns `<dir>/uv`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/binaries/ensureUv.test.ts
import { describe, it, expect, vi } from 'vitest';
const { spawnCollect } = vi.hoisted(() => ({ spawnCollect: vi.fn(async () => ({ stdout: '', stderr: '', code: 0 })) }));
vi.mock('ugly-app/native', () => ({ native: { fs: {} } }));
vi.mock('../../../client/agent/tools/spawn', () => ({ spawnCollect }));
import { ensureUv, __setUvIo, type BinariesIo } from '../../../client/agent/binaries/resolve';

function memIo(seed: Record<string, string> = {}): BinariesIo & { files: Map<string, string> } {
  const files = new Map(Object.entries(seed));
  return { files,
    exists: (p) => Promise.resolve(files.has(p) || [...files.keys()].some((k) => k.startsWith(p + '/'))),
    mkdirp: () => Promise.resolve(), readFile: (p) => Promise.resolve(files.get(p) ?? '{}'),
    writeFile: (p, s) => { files.set(p, s); return Promise.resolve(); }, now: () => 1 };
}

describe('ensureUv', () => {
  it('returns "uv" when already on PATH', async () => {
    const io = memIo();
    __setUvIo(io);
    spawnCollect.mockImplementation(async (cmd: string, args: string[]) =>
      cmd === 'uv' && args[0] === '--version' ? { stdout: 'uv 0.5.0', stderr: '', code: 0 } : { stdout: '', stderr: '', code: 1 });
    expect(await ensureUv()).toBe('uv');
  });

  it('installs into the binaries root when uv is absent', async () => {
    const io = memIo();
    __setUvIo(io);
    spawnCollect.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'uv' && args[0] === '--version') return { stdout: '', stderr: 'not found', code: 127 };
      // installer writes uv into UV_INSTALL_DIR (last token of the sh -c script's env)
      const m = /UV_INSTALL_DIR=(\S+)/.exec(args.join(' '));
      if (m) io.files.set(m[1] + '/uv', '#');
      return { stdout: '', stderr: '', code: 0 };
    });
    const p = await ensureUv();
    expect(p).toMatch(/binaries\/.*\/uv\/uv$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `pnpm vitest run tests/unit/binaries/ensureUv.test.ts` → FAIL (`ensureUv` missing).

- [ ] **Step 3: Write minimal implementation** — append to `client/agent/binaries/resolve.ts`:

```ts
let uvIo: BinariesIo | undefined;
/** Test seam: override the IO used by ensureUv. */
export function __setUvIo(io: BinariesIo): void { uvIo = io; }

/** Resolve a `uv` executable — PATH first, else install into the shared binaries root. */
export async function ensureUv(io: BinariesIo = uvIo ?? nativeIo): Promise<string> {
  const probe = await spawnCollect('uv', ['--version'], {});
  if (probe.code === 0) return 'uv';
  const dir = await ensureBinary('uv', async (destDir) => {
    // Astral installer honors UV_INSTALL_DIR; INSTALLER_NO_MODIFY_PATH keeps it self-contained.
    const script = `curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR="${destDir}" INSTALLER_NO_MODIFY_PATH=1 sh`;
    const res = await spawnCollect('sh', ['-c', script], {});
    if (res.code !== 0 && res.code !== null) throw new Error(`uv install failed (exit ${res.code}): ${res.stderr.slice(0, 400)}`);
  }, io);
  return `${dir}/uv`;
}
```

- [ ] **Step 4: Run test to verify it passes** — `pnpm vitest run tests/unit/binaries/ensureUv.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add client/agent/binaries/resolve.ts tests/unit/binaries/ensureUv.test.ts
git commit -m "feat(binaries): ensureUv — resolve/install uv into ~/.ugly-bot/binaries"
```

---

### Task 2: `truncateOutput` port

**Files:** Create `client/agent/tools/outputTruncate.ts`; Test `tests/unit/tools/outputTruncate.test.ts`.

**Interfaces:** Produces `truncateOutput(text: string): string`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/tools/outputTruncate.test.ts
import { describe, it, expect } from 'vitest';
import { truncateOutput } from '../../../client/agent/tools/outputTruncate';

describe('truncateOutput', () => {
  it('passes short output through unchanged', () => {
    expect(truncateOutput('a\nb\nc')).toBe('a\nb\nc');
  });
  it('collapses long output to head + tail with an elision marker', () => {
    const text = Array.from({ length: 300 }, (_, i) => `line${i}`).join('\n');
    const out = truncateOutput(text);
    expect(out).toContain('line0');
    expect(out).toContain('line299');
    expect(out).toMatch(/truncated \d+ lines, showing first 100 and last 50/);
    expect(out).not.toContain('line150');
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — FAIL (module missing).

- [ ] **Step 3: Write minimal implementation** — port verbatim:

```ts
// client/agent/tools/outputTruncate.ts
// Head+tail output truncation (ported from ugly-studio python-runtime/output-truncate.ts).
const HEAD_LINES = 100;
const TAIL_LINES = 50;
const MAX_BYTES = 200_000;

export function truncateOutput(text: string): string {
  if (text.length <= MAX_BYTES) {
    const lineCount = text.split('\n').length;
    if (lineCount <= HEAD_LINES + TAIL_LINES + 5) return text;
  }
  const lines = text.split('\n');
  if (lines.length <= HEAD_LINES + TAIL_LINES + 5) {
    const head = text.slice(0, MAX_BYTES / 2);
    const tail = text.slice(text.length - MAX_BYTES / 2);
    return (
      head.slice(0, head.lastIndexOf('\n') + 1) +
      `\n... [truncated ${text.length - MAX_BYTES} bytes from the middle] ...\n` +
      tail.slice(tail.indexOf('\n') + 1)
    );
  }
  const head = lines.slice(0, HEAD_LINES);
  const tail = lines.slice(lines.length - TAIL_LINES);
  const dropped = lines.length - HEAD_LINES - TAIL_LINES;
  return (
    head.join('\n') +
    `\n... [truncated ${dropped} line${dropped === 1 ? '' : 's'}, showing first ${HEAD_LINES} and last ${TAIL_LINES}] ...\n` +
    tail.join('\n')
  );
}
```

- [ ] **Step 4: Run test to verify it passes** — PASS.

- [ ] **Step 5: Commit**

```bash
git add client/agent/tools/outputTruncate.ts tests/unit/tools/outputTruncate.test.ts
git commit -m "feat(tools): port head+tail truncateOutput"
```

---

### Task 3: `runPythonOneShot` port

**Files:** Create `client/agent/tools/pythonOneShot.ts`; Test `tests/unit/tools/pythonOneShot.test.ts`.

**Interfaces:**
- Consumes: `native.process.spawn`, `native.fs` (writeFile/rm), `ensureUv` (Task 1), `truncateOutput` (Task 2).
- Produces: `runPythonOneShot(opts: { code: string; cwd?: string; timeoutMs?: number; signal?: AbortSignal }): Promise<{ output: string; isError: boolean; timedOut: boolean; exitCode: number | null }>`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/tools/pythonOneShot.test.ts
import { describe, it, expect, vi } from 'vitest';

const { spawn, writeFile, rm } = vi.hoisted(() => ({ spawn: vi.fn(), writeFile: vi.fn(async () => {}), rm: vi.fn(async () => {}) }));
vi.mock('ugly-app/native', () => ({ native: { process: { spawn }, fs: { writeFile, rm } } }));
vi.mock('../../../client/agent/binaries/resolve', () => ({ ensureUv: async () => 'uv' }));

import { runPythonOneShot } from '../../../client/agent/tools/pythonOneShot';

function fakeProc() {
  const cbs: Record<string, (a?: unknown) => void> = {};
  return {
    handle: {
      onStdout: (cb: (c: string) => void) => { cbs.stdout = cb as never; },
      onStderr: (cb: (c: string) => void) => { cbs.stderr = cb as never; },
      onExit: (cb: (c: number | null) => void) => { cbs.exit = cb as never; },
      onError: (cb: (e: string) => void) => { cbs.error = cb as never; },
      write: () => {}, closeStdin: () => {}, kill: vi.fn(),
    },
    cbs,
  };
}

describe('runPythonOneShot', () => {
  it('runs uv run --script and returns stdout, cleaning up the tempfile', async () => {
    const fp = fakeProc();
    spawn.mockImplementation((cmd: string, args: string[]) => {
      expect(cmd).toBe('uv');
      expect(args.slice(0, 2)).toEqual(['run', '--script']);
      queueMicrotask(() => { fp.cbs.stdout('hello\n'); fp.cbs.exit(0); });
      return fp.handle;
    });
    const r = await runPythonOneShot({ code: "print('hello')" });
    expect(r.output).toContain('hello');
    expect(r.isError).toBe(false);
    expect(writeFile).toHaveBeenCalled();
    expect(rm).toHaveBeenCalled();          // tempfile cleanup (leak handling)
  });

  it('annotates a non-zero exit', async () => {
    const fp = fakeProc();
    spawn.mockImplementation(() => { queueMicrotask(() => { fp.cbs.stderr('boom\n'); fp.cbs.exit(1); }); return fp.handle; });
    const r = await runPythonOneShot({ code: 'raise SystemExit(1)' });
    expect(r.output).toMatch(/boom/);
    expect(r.output).toMatch(/exit 1/);
    expect(r.isError).toBe(true);
  });

  it('kills on timeout and reports timedOut', async () => {
    vi.useFakeTimers();
    const fp = fakeProc();
    spawn.mockImplementation(() => fp.handle); // never exits
    const p = runPythonOneShot({ code: 'while True: pass', timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(60);
    expect(fp.handle.kill).toHaveBeenCalledWith('SIGTERM');
    fp.cbs.exit(null);                        // process finally dies
    const r = await p;
    expect(r.timedOut).toBe(true);
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — FAIL (module missing).

- [ ] **Step 3: Write minimal implementation** (ported/adapted from the monolith one-shot):

```ts
// client/agent/tools/pythonOneShot.ts
// One-shot Python runner — write the snippet to a temp file and `uv run --script`.
// Ported from ugly-studio python-runtime/one-shot.ts, adapted to native.process/fs
// and the ~/.ugly-bot/binaries uv resolver. Guard-mode + recursive_llm are Plan 2b.
import { native } from 'ugly-app/native';
import { ensureUv } from '../binaries/resolve';
import { truncateOutput } from './outputTruncate';

export interface OneShotOptions { code: string; cwd?: string; timeoutMs?: number; signal?: AbortSignal }
export interface OneShotResult { output: string; isError: boolean; timedOut: boolean; exitCode: number | null }

const MAX_BUF = 400_000;
const DEFAULT_TIMEOUT = 60_000;

function tmpDir(): string {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
  return env.TMPDIR ?? '/tmp';
}

export async function runPythonOneShot(opts: OneShotOptions): Promise<OneShotResult> {
  const uv = await ensureUv();
  const pid = (globalThis as { process?: { pid?: number } }).process?.pid ?? 0;
  const tmpFile = `${tmpDir()}/ugly-code-pyexec-${pid}-${Date.now()}.py`;
  await native.fs.writeFile(tmpFile, opts.code);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  try {
    return await new Promise<OneShotResult>((resolve) => {
      const proc = native.process.spawn(uv, ['run', '--script', tmpFile], opts.cwd ? { cwd: opts.cwd } : {});
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;
      proc.onStdout((c) => { if (stdout.length < MAX_BUF) stdout += c; });
      proc.onStderr((c) => { if (stderr.length < MAX_BUF) stderr += c; });
      const timer = setTimeout(() => {
        timedOut = true;
        try { proc.kill('SIGTERM'); } catch { /* ignore */ }
        setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* ignore */ } }, 2000).unref?.();
      }, timeoutMs);
      timer.unref?.();
      const onAbort = (): void => { try { proc.kill('SIGTERM'); } catch { /* ignore */ } };
      opts.signal?.addEventListener('abort', onAbort);
      const finish = (result: OneShotResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        resolve(result);
      };
      proc.onError((err) => finish({ output: `python_exec spawn error: ${err}`, isError: true, timedOut: false, exitCode: null }));
      proc.onExit((code) => {
        const parts: string[] = [];
        if (stdout) parts.push(stdout);
        if (stderr) parts.push(stderr);
        if (timedOut) parts.push(`\n[timed out after ${timeoutMs}ms]`);
        if (!timedOut && code !== null && code !== 0) parts.push(`\n[exit ${code}]`);
        let combined = parts.join('').trim();
        if (combined.length === 0) {
          combined = code === 0
            ? '(no stdout or stderr; script exited 0)\n\nThe script ran but printed nothing — remember to print() your result (e.g. print(json.dumps(results))).'
            : `(no output; script exited ${code ?? 'null'})`;
        }
        finish({ output: truncateOutput(combined), isError: timedOut || (code !== null && code !== 0), timedOut, exitCode: code });
      });
    });
  } finally {
    try { await native.fs.rm(tmpFile, { force: true }); } catch { /* ignore */ }
  }
}
```

- [ ] **Step 4: Run test to verify it passes** — PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add client/agent/tools/pythonOneShot.ts tests/unit/tools/pythonOneShot.test.ts
git commit -m "feat(tools): hardened python one-shot (uv run, timeout, truncation, cleanup)"
```

---

### Task 4: Wire `python_exec` to the one-shot runner

**Files:** Modify `client/agent/tools/pythonExec.ts`; Modify `tests/unit/tools/python.test.ts`.

**Interfaces:** `python_exec` gains an optional `timeout_ms` param; delegates to `runPythonOneShot`.

- [ ] **Step 1: Update the test** — replace python.test.ts's `python_exec` block (it mocked `ensurePython` + the raw spawn) to mock `runPythonOneShot`:

```ts
// tests/unit/tools/python.test.ts (python_exec describe block)
import { describe, it, expect, vi } from 'vitest';
const { runPythonOneShot } = vi.hoisted(() => ({ runPythonOneShot: vi.fn() }));
vi.mock('../../../client/agent/tools/pythonOneShot', () => ({ runPythonOneShot }));
import { resetMock } from '../../helpers/uglyNativeMock';
import { pythonExecTool } from '../../../client/agent/tools/pythonExec';
import { pythonLibrariesTool } from '../../../client/agent/tools/pythonLibraries';

describe('python_exec', () => {
  it('runs the snippet via the one-shot runner and returns its output', async () => {
    runPythonOneShot.mockResolvedValue({ output: 'hello', isError: false, timedOut: false, exitCode: 0 });
    const out = await pythonExecTool.run({ code: "print('hello')" }, { projectDir: '/proj' });
    expect(out).toBe('hello');
    expect(runPythonOneShot).toHaveBeenCalledWith(expect.objectContaining({ code: "print('hello')", cwd: '/proj' }));
  });
  it('passes an explicit timeout_ms through', async () => {
    runPythonOneShot.mockResolvedValue({ output: 'x', isError: false, timedOut: false, exitCode: 0 });
    await pythonExecTool.run({ code: 'x=1', timeout_ms: 5000 }, undefined);
    expect(runPythonOneShot).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 5000 }));
  });
});
// (keep the existing python_libraries describe block unchanged)
```

- [ ] **Step 2: Run test to verify it fails** — FAIL (pythonExec still uses old path).

- [ ] **Step 3: Rewrite `pythonExec.ts`:**

```ts
// `python_exec` — run a Python snippet via the hardened one-shot runner.
import type { TextGenTool } from 'ugly-app/shared';
import type { ToolModule } from './registry';
import { projectRoot } from './lspForProject';
import { runPythonOneShot } from './pythonOneShot';

const SPEC: TextGenTool = {
  name: 'python_exec',
  description:
    'Run a Python snippet via `uv run` in the project environment and return its ' +
    'stdout/stderr. Use for quick computation, data inspection, or scripting — not ' +
    'for long-running processes. Times out after 60s by default (override timeout_ms).',
  parameters: {
    type: 'object',
    properties: {
      code: { type: 'string', description: 'Python source to execute.' },
      timeout_ms: { type: 'number', description: 'Max run time in ms (default 60000).' },
    },
    required: ['code'],
    additionalProperties: false,
  },
};

export const pythonExecTool: ToolModule = {
  name: 'python_exec',
  spec: SPEC,
  async run(input, ctx) {
    const code = typeof input.code === 'string' ? input.code : '';
    if (!code) return 'python_exec: `code` is required';
    const root = projectRoot(ctx) ?? undefined;
    const timeoutMs = typeof input.timeout_ms === 'number' ? input.timeout_ms : undefined;
    const r = await runPythonOneShot({ code, ...(root ? { cwd: root } : {}), ...(timeoutMs ? { timeoutMs } : {}) });
    return r.output || '(no output)';
  },
};
```

- [ ] **Step 4: Run tests to verify they pass** — `pnpm vitest run tests/unit/tools/python.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add client/agent/tools/pythonExec.ts tests/unit/tools/python.test.ts
git commit -m "feat(tools): python_exec uses hardened one-shot + timeout_ms"
```

---

### Task 5: Permission-by-path fix (CLI grants `process: 'full'`)

**Files:** Modify `client/cli/taskDriver.ts`; Modify `tests/unit/cli/taskDriver.test.ts`.

**Rationale:** `python_exec` now spawns the resolved absolute `uv` path; a name-based grant won't match it. `GrantState` includes `'full'`.

- [ ] **Step 1: Update the taskDriver test** — assert the grant is `process: 'full'`:

```ts
// in tests/unit/cli/taskDriver.test.ts — add permissions capture to the mock and a check
// (extend the existing 'installs the fs store on boot' test)
```
Add to the `ugly-app/native` mock: `permissions: { request: vi.fn(async () => ({})) }` (already present from Plan 1); then in the first test:
```ts
    const { permissions } = await import('ugly-app/native');
    expect((permissions.request as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0]).toMatchObject({ process: 'full' });
```

- [ ] **Step 2: Run test to verify it fails** — FAIL (currently grants a name list).

- [ ] **Step 3: Update `taskDriver.ts`:**

```ts
// replace the AGENT_TOOLS constant + grant line
// (remove: const AGENT_TOOLS = [...]; )
  type GrantReq = Parameters<typeof permissions.request>[0];
  // Grant full process access for the CLI (a trusted local process): python_exec /
  // grep spawn RESOLVED ABSOLUTE binary paths that a name-based allowlist can't match.
  await permissions.request({ fs: 'full', process: 'full' } as unknown as GrantReq).catch(() => undefined);
```

- [ ] **Step 4: Run tests to verify they pass** — `pnpm vitest run tests/unit/cli/taskDriver.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add client/cli/taskDriver.ts tests/unit/cli/taskDriver.test.ts
git commit -m "fix(cli): grant process:full so python_exec's resolved uv path isn't blocked"
```

---

## Self-Review

- **Coverage:** one-shot port (uv run, timeout, truncation, cleanup, buffer cap) = Tasks 2–4; uv bootstrap = Task 1; permission-by-path = Task 5. Matches the two carried fixes + W2 one-shot slice.
- **Deferred (stated in Scope):** stateful `PythonSession`, `recursive_llm`/`final` TCP bridge, guard-mode, curated libraries, Ep 04 A/B footage.
- **Integration checkpoints (verify during exec):** confirm `native.process.spawn` opts accept `{cwd}` only (no `env`/`replaceEnv` needed for 2a); confirm `native.fs.rm(path, {force})` signature; real smoke: `ensureUv()` then `python_exec` on a compute snippet (needs network for the uv install). If `uv run --script` needs PEP 723 metadata for third-party imports, that's expected (curated libs deferred).
- **Placeholders:** none.
- **Type consistency:** `OneShotResult` shape consistent across Tasks 3–4; `ensureUv(): Promise<string>` consumed by Task 3.
