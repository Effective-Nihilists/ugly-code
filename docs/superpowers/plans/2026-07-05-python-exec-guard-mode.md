# python_exec Guard-Mode (Plan 2b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use `- [ ]`.

**Goal:** Port the monolith's `ugly_studio._guard` Python module and wire read-only / project-scoped **guard-mode** into the one-shot runner, so a guarded `python_exec` call blocks filesystem writes with a clear PermissionError.

**Architecture:** Ship the `ugly_studio` package as a bundled asset in ugly-code; when `runPythonOneShot` is called with a `mode`, prepend `import ugly_studio._guard`, set `UGLY_STUDIO_GUARD_MODE`/`_CWD`, and add the bundle dir to `PYTHONPATH`. Faithful port of `python-runtime/one-shot.ts`'s guardActive branch + `bridge-lib/ugly_studio/_guard.py`.

**Tech Stack:** TypeScript (ESM), Python (guard module), `native.process` (env-capable), vitest.

## Global Constraints

- Guard env: `UGLY_STUDIO_GUARD_MODE` ∈ {`spec`,`edit`}, `UGLY_STUDIO_GUARD_CWD` = project dir. `spec` = reject ALL writes; `edit` = allow writes under CWD + tmp roots.
- `_guard.py` is ported **verbatim** (it's a self-contained monkey-patch of `open`/`os.*`/`shutil.*`/`pathlib.Path.*`).
- The package `__init__.py` for this plan is **minimal** (no `_bridge` import — that's Plan 2c). `import ugly_studio._guard` must work standalone.
- `SpawnOpts` supports `env` + `replaceEnv`.
- Out of scope: stateful `PythonSession`, `recursive_llm`/`final`, the TCP bridge (Plan 2c); auto-triggering guard-mode from read-only pattern steps (Plan 3). This plan exposes `mode` on `runPythonOneShot` + verifies it directly.
- TDD, one commit per task.

## File Structure

- Create `client/agent/python-lib/ugly_studio/__init__.py` — minimal package marker.
- Create `client/agent/python-lib/ugly_studio/_guard.py` — verbatim port.
- Modify `client/agent/tools/pythonOneShot.ts` — `bridgeLibPath()` + `mode` option + guard wiring.
- Tests: extend `tests/unit/tools/pythonOneShot.test.ts`.

---

### Task 1: Bundle the `ugly_studio` guard package

**Files:** Create `client/agent/python-lib/ugly_studio/__init__.py`, `client/agent/python-lib/ugly_studio/_guard.py`.

**Interfaces:** Produces the importable package. No TS test (pure asset); exercised by Task 3's real smoke.

- [ ] **Step 1:** Create `__init__.py`:

```python
"""ugly-studio Python helpers for python_exec.

In one-shot mode only `_guard` (the filesystem-write guard, installed via
`import ugly_studio._guard`) is available. `recursive_llm()` / `final()` are
added in stateful mode (the loopback-TCP bridge) — Plan 2c.
"""
```

- [ ] **Step 2:** Create `_guard.py` — the verbatim monolith module (full source is in this repo's plan notes / recovered from ugly-studio `f5a74c2^:server/coding-agent/python-runtime/bridge-lib/ugly_studio/_guard.py`). Copy it byte-for-byte (docstring + the `if _MODE not in ("spec","edit")` guard installer that monkey-patches `builtins.open`, `io.open`, `os.open`, the os unary/binary mutators, `shutil.*`, and `pathlib.Path.*`).

- [ ] **Step 3: Sanity-check the module imports + blocks** (real python, quick):

Run: `UGLY_STUDIO_GUARD_MODE=spec PYTHONPATH=client/agent/python-lib python3 -c "import ugly_studio._guard; open('/tmp/should_fail.txt','w')"`
Expected: raises `PermissionError: ugly-studio guard blocked ...`. And with no env: `PYTHONPATH=client/agent/python-lib python3 -c "import ugly_studio._guard; print('noop ok')"` prints `noop ok`.

- [ ] **Step 4: Commit**

```bash
git add client/agent/python-lib/ugly_studio/
git commit -m "feat(python): bundle ugly_studio._guard filesystem-write guard"
```

---

### Task 2: Guard-mode wiring in `runPythonOneShot`

**Files:** Modify `client/agent/tools/pythonOneShot.ts`; extend `tests/unit/tools/pythonOneShot.test.ts`.

**Interfaces:** `OneShotOptions` gains `mode?: 'spec' | 'edit'`. When set: prepend `import ugly_studio._guard\n`; set env `UGLY_STUDIO_GUARD_MODE`, `UGLY_STUDIO_GUARD_CWD` (= cwd), and prepend the bundle dir to `PYTHONPATH`. Produces `bridgeLibPath(): string`.

- [ ] **Step 1: Add the failing test** (append to pythonOneShot.test.ts):

```ts
  it('guard mode injects the import, env, and PYTHONPATH', async () => {
    const fp = fakeProc();
    let seenArgs: string[] = [];
    let seenOpts: { env?: Record<string, string> } = {};
    spawn.mockImplementation((_cmd: string, args: string[], opts: { env?: Record<string, string> }) => {
      seenArgs = args; seenOpts = opts;
      queueMicrotask(() => { fp.cbs.exit(0); });
      return fp.handle;
    });
    await runPythonOneShot({ code: "open('x','w')", cwd: '/proj', mode: 'spec' });
    // script content written to the tmp file starts with the guard import
    const written = writeFile.mock.calls[0][1] as string;
    expect(written.startsWith('import ugly_studio._guard')).toBe(true);
    expect(seenOpts.env?.UGLY_STUDIO_GUARD_MODE).toBe('spec');
    expect(seenOpts.env?.UGLY_STUDIO_GUARD_CWD).toBe('/proj');
    expect(seenOpts.env?.PYTHONPATH).toContain('python-lib');
    expect(seenArgs.slice(0, 2)).toEqual(['run', '--script']);
  });
```

(Requires the `spawn` mock to receive `opts` and `writeFile` to be inspectable — both already hoisted in the file.)

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement.** In `pythonOneShot.ts`:

Add imports + resolver:
```ts
import { fileURLToPath } from 'node:url';
// ...
/** Absolute path to the bundled Python package dir (contains ugly_studio/). */
export function bridgeLibPath(): string {
  return fileURLToPath(new URL('../python-lib', import.meta.url));
}
```

Extend `OneShotOptions`:
```ts
export interface OneShotOptions { code: string; cwd?: string; timeoutMs?: number; signal?: AbortSignal; mode?: 'spec' | 'edit' }
```

In `runPythonOneShot`, replace the script-write + spawn to honor `mode`:
```ts
  const guardActive = opts.mode !== undefined;
  const scriptContent = guardActive ? `import ugly_studio._guard  # ugly-studio guard\n${opts.code}` : opts.code;
  await native.fs.writeFile(tmpFile, scriptContent);
  // ...
      const env: Record<string, string> = {};
      if (guardActive) {
        env.UGLY_STUDIO_GUARD_MODE = opts.mode!;
        env.UGLY_STUDIO_GUARD_CWD = opts.cwd ?? '';
        const existing = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.PYTHONPATH;
        env.PYTHONPATH = existing ? `${bridgeLibPath()}:${existing}` : bridgeLibPath();
      }
      const spawnOpts = { ...(opts.cwd ? { cwd: opts.cwd } : {}), ...(guardActive ? { env } : {}) };
      const proc = native.process.spawn(uv, ['run', '--script', tmpFile], spawnOpts);
```

- [ ] **Step 4: Run → PASS** (`pnpm vitest run tests/unit/tools/pythonOneShot.test.ts`).

- [ ] **Step 5: Commit**

```bash
git add client/agent/tools/pythonOneShot.ts tests/unit/tools/pythonOneShot.test.ts
git commit -m "feat(tools): python one-shot guard-mode (spec/edit write guard)"
```

---

### Task 3: Real guard smoke

**Files:** none committed (temp smoke, like Plan 2a).

- [ ] **Step 1:** Bootstrap smoke calling `runPythonOneShot({ code: "open('/etc/xyz','w')", cwd: <tmp>, mode: 'spec' })`; assert the output contains `ugly-studio guard blocked` and `isError: true`. Also assert `mode: 'edit'` with a write UNDER cwd succeeds.

- [ ] **Step 2:** Run it (needs uv + python). Confirm spec blocks, edit-under-cwd allows. Remove the smoke file.

- [ ] **Step 3:** No commit (verification only); note the result.

---

## Self-Review

- **Coverage:** guard package (Task 1) + one-shot guard wiring (Task 2) + real block verification (Task 3). Matches W2's guard-mode item.
- **Deferred:** recursive_llm/final + TCP bridge (2c); pattern-step auto-trigger (Plan 3); production bundling of the .py assets into the built task bundle (CLI/tsx resolves via import.meta.url; note esbuild asset-copy as a follow-up).
- **Checkpoints:** confirm `uv run` passes `PYTHONPATH` through to the script's interpreter (if uv strips it, set env via the script's PEP 723 or use `UV_` passthrough — verify in Task 3). Confirm `import.meta.url` resolves under tsx.
- **Placeholders:** none (Task 1 Step 2 copies a fully-recovered verbatim module).
