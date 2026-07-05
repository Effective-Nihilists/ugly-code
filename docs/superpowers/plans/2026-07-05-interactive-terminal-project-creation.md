# Interactive Terminal for New-Project Creation + Streaming Binary-Download Progress — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give first-run ugly-studio users real feedback — a live binary-download progress bar, and a new-project creation flow that runs inside the interactive terminal (echoing each command, streaming output, typeable).

**Architecture:** Two independent fixes. (A) `ugly-app` binary installer streams the download body so the existing popup bar animates. (B) `ugly-code` extracts its terminal panel into a reusable `<InteractiveTerminal>` that accepts an auto-run initial command + cwd + exit callback, and the new-project creation screen renders it with the scaffold command injected. No PTY/xterm, no native-contract change — Fix B stays on the existing pipe path.

**Tech Stack:** TypeScript, React, `native.process` facade (`ugly-app/native`), vitest (node env).

## Global Constraints

- Package manager is **pnpm**, never npm.
- **No `any`** — `noExplicitAny` is enforced. **No `as`** to type external/unknown JSON — use zod. (Neither is needed here.)
- Vitest env is **`node`** (no DOM) — unit-test **pure functions**, not React rendering. Component/reactive behavior is verified via `tsc` + manual Studio run, matching the repo's `useIsMobile.test.ts` precedent.
- Work directly on `main`, commit frequently (repo convention).
- The scaffold command is **unchanged verbatim**: `mkdir -p "<parent>" && cd "<parent>" && npx -y ugly-app@latest init "<name>" && cd "<name>" && pwd`. Do **not** swap to the bundled CLI (deliberately out of scope).
- Fix B stays on the **pipe** (non-TTY) path — animated npx/pnpm spinners still won't render; that's accepted.

---

## File Structure

- `ugly-app/src/native/server/binaries/installer.ts` — **modify** (Fix A, already implemented): stream `download()` with byte progress.
- `ugly-code/client/studio/panels/scaffoldCommand.ts` — **create**: pure `buildScaffoldCommand` + `parseScaffoldResult`.
- `ugly-code/tests/unit/scaffoldCommand.test.ts` — **create**: unit tests for the two pure functions.
- `ugly-code/client/studio/components/InteractiveTerminal.tsx` — **create**: reusable interactive terminal (extracted from `TerminalPanel`).
- `ugly-code/client/studio/panels/TerminalPanel.tsx` — **modify**: collapse to a thin wrapper over `<InteractiveTerminal>`.
- `ugly-code/client/studio/panels/ProjectCreationProgress.tsx` — **modify**: render `<InteractiveTerminal>` with the injected scaffold command.

---

## Task 1: Fix A — streaming binary-download progress (ugly-app) [already implemented]

The code change is already written and typechecks. This task commits it and documents propagation. There is no unit test — it is streaming I/O; correctness is verified at runtime by an actual download (packaged Studio / cold cache). The popup UI needs no change (it already renders `p.pct`).

**Files:**
- Modify: `ugly-app/src/native/server/binaries/installer.ts` (done — `download()` now streams via `res.body.getReader()`, emits `phase:'download'` pct in the 0–50 range, buffered fallback when no `Content-Length`).

**Interfaces:**
- Produces: no signature change. `install()` / `download()` keep the same exports; only richer `onProgress` emission during download.

- [ ] **Step 1: Confirm the change is present**

Run:
```bash
cd /Users/admin/Documents/GitHub/ugly-app
grep -n "getReader\|received / total" src/native/server/binaries/installer.ts
```
Expected: matches inside `download()` (the streaming reader loop and the `pct = Math.min(50, Math.round((received / total) * 50))` mapping).

- [ ] **Step 2: Typecheck**

Run:
```bash
cd /Users/admin/Documents/GitHub/ugly-app && pnpm exec tsc --noEmit -p tsconfig.json
```
Expected: exit 0, no errors.

- [ ] **Step 3: Commit (ugly-app)**

```bash
cd /Users/admin/Documents/GitHub/ugly-app
git add src/native/server/binaries/installer.ts
git commit -m "feat(binaries): stream download with byte-level progress

download() streamed the whole archive via arrayBuffer() with no mid-download
progress, so the install popup bar sat frozen at 0% for the entire (slow, cold)
download. Stream res.body and emit throttled download-phase pct into the first
half of the bar; fall back to a buffered read when Content-Length is absent.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 4: Propagation note (do NOT auto-run)**

This change only reaches Studio after ugly-app is **released** and consumers update. That is a coordinated release action — flag it to the user; do not run it as part of autonomous plan execution, and never release ugly-app concurrently with another release. The propagation command, when the user approves, is:
```bash
cd /Users/admin/Documents/GitHub/ugly-app && pnpm run release:quick
# then in each consumer (e.g. ugly-studio): pnpm store prune && pnpm add ugly-app@latest
```

---

## Task 2: Pure scaffold-command helpers (ugly-code)

Extract the command-building and result-parsing logic (currently inline in `ProjectCreationProgress.tsx:41-46,83-88`) into a pure, testable module. TDD.

**Files:**
- Create: `client/studio/panels/scaffoldCommand.ts`
- Test: `tests/unit/scaffoldCommand.test.ts`

**Interfaces:**
- Produces:
  - `buildScaffoldCommand(name: string, parentDir: string): string`
  - `parseScaffoldResult(output: string, code: number | null): { ok: true; path: string } | { ok: false; code: number | null }`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/scaffoldCommand.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { buildScaffoldCommand, parseScaffoldResult } from '../../client/studio/panels/scaffoldCommand';

describe('buildScaffoldCommand', () => {
  it('expands a leading ~ to $HOME and quotes name + parent', () => {
    const cmd = buildScaffoldCommand('my-app', '~/Documents/Ugly Studio');
    expect(cmd).toContain('mkdir -p "$HOME/Documents/Ugly Studio"');
    expect(cmd).toContain('cd "$HOME/Documents/Ugly Studio"');
    expect(cmd).toContain('npx -y ugly-app@latest init "my-app"');
    expect(cmd).toContain('cd "my-app" && pwd');
  });

  it('defaults an empty/whitespace parent to $HOME', () => {
    expect(buildScaffoldCommand('a', '   ')).toContain('mkdir -p "$HOME"');
  });

  it('escapes embedded double quotes in the name', () => {
    expect(buildScaffoldCommand('a"b', '~')).toContain('init "a\\"b"');
  });
});

describe('parseScaffoldResult', () => {
  it('returns the last non-empty line as path on exit 0', () => {
    expect(parseScaffoldResult('[ugly-app] Creating…\n/Users/x/proj\n\n', 0))
      .toEqual({ ok: true, path: '/Users/x/proj' });
  });

  it('reports failure on non-zero exit', () => {
    expect(parseScaffoldResult('boom', 1)).toEqual({ ok: false, code: 1 });
  });

  it('is ok with an empty path when there is no output', () => {
    expect(parseScaffoldResult('', 0)).toEqual({ ok: true, path: '' });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
cd /Users/admin/Documents/GitHub/ugly-code && pnpm exec vitest run tests/unit/scaffoldCommand.test.ts
```
Expected: FAIL — cannot resolve `../../client/studio/panels/scaffoldCommand`.

- [ ] **Step 3: Write the implementation**

Create `client/studio/panels/scaffoldCommand.ts`:
```ts
/** Pure helpers for the new-project scaffold flow — the exact bash command
 *  driven into the interactive terminal, and parsing its result. Extracted from
 *  ProjectCreationProgress so it can be unit-tested (vitest env is `node`). */

export type ScaffoldResult =
  | { ok: true; path: string }
  | { ok: false; code: number | null };

/** Build the `bash -lc` scaffold command. A leading `~` is NOT expanded inside
 *  double quotes, so map it to `$HOME`. The command mkdir+cd's into the parent
 *  itself (it may not exist yet), runs `ugly-app init`, cd's into the project,
 *  and prints its absolute path via `pwd` (parsed by parseScaffoldResult). */
export function buildScaffoldCommand(name: string, parentDir: string): string {
  const parent = (parentDir.trim() || '~').replace(/^~(?=$|\/)/, '$HOME');
  const q = (s: string): string => s.replace(/"/g, '\\"');
  return (
    `mkdir -p "${q(parent)}" && cd "${q(parent)}" && ` +
    `npx -y ugly-app@latest init "${q(name)}" && cd "${q(name)}" && pwd`
  );
}

/** Interpret a finished scaffold command: exit 0 → the trailing `pwd` line is the
 *  project path; non-zero → failure. `path` may be '' if there was no output
 *  (the caller supplies a fallback). */
export function parseScaffoldResult(output: string, code: number | null): ScaffoldResult {
  if (code !== 0) return { ok: false, code };
  const lines = output.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  return { ok: true, path: lines[lines.length - 1] ?? '' };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
cd /Users/admin/Documents/GitHub/ugly-code && pnpm exec vitest run tests/unit/scaffoldCommand.test.ts
```
Expected: PASS (6 assertions across 2 suites).

- [ ] **Step 5: Commit**

```bash
cd /Users/admin/Documents/GitHub/ugly-code
git add client/studio/panels/scaffoldCommand.ts tests/unit/scaffoldCommand.test.ts
git commit -m "feat(studio): pure scaffold command + result helpers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Extract `<InteractiveTerminal>`; thin `TerminalPanel` wrapper (ugly-code)

Move the terminal implementation out of `TerminalPanel.tsx` into a reusable component with three new props, then reduce `TerminalPanel` to a wrapper. No unit test (DOM/reactive) — verified by `tsc` + manual: the existing Terminal tab must behave exactly as before.

**Files:**
- Create: `client/studio/components/InteractiveTerminal.tsx`
- Modify: `client/studio/panels/TerminalPanel.tsx` (full replacement below)

**Interfaces:**
- Consumes: `native.process.spawn` (from `ugly-app/native`), `native.fs.readdir`.
- Produces:
  - `InteractiveTerminal(props: { cwd?: string; initialCommand?: string; onCommandExit?: (code: number | null, command: string, output: string) => void }): React.ReactElement`
  - The `output` arg is the finished command's own accumulated stdout+stderr — the creation flow parses its trailing `pwd` line. `TerminalPanel` ignores the callback.

- [ ] **Step 1: Create `InteractiveTerminal.tsx`**

Create `client/studio/components/InteractiveTerminal.tsx` (this is `TerminalPanel`'s logic, parameterized — note: cwd is a prop; a `runCommand(c)` helper backs both typed submits and the auto-run `initialCommand`; `onExit` calls `onCommandExit`):
```tsx
import React from 'react';
import { native } from 'ugly-app/native';

export interface InteractiveTerminalProps {
  /** cwd for spawned commands. undefined ⇒ spawn with no cwd (dir may not exist yet). */
  cwd?: string;
  /** Run exactly once on mount, echoed as `$ <cmd>` and executed like a typed command. */
  initialCommand?: string;
  /** Fires when each command exits, with that command's accumulated stdout+stderr. */
  onCommandExit?: (code: number | null, command: string, output: string) => void;
}

/** Minimal interactive terminal: runs one `bash -lc` command at a time in `cwd`
 *  and streams output, with an inline prompt at the tail (like a real CLI).
 *  Not a full PTY. Extracted from TerminalPanel so the new-project flow can reuse
 *  it with an injected initialCommand. */
export function InteractiveTerminal({ cwd, initialCommand, onCommandExit }: InteractiveTerminalProps): React.ReactElement {
  const [log, setLog] = React.useState('');
  const [cmd, setCmd] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [history, setHistory] = React.useState<string[]>([]);
  const histIdx = React.useRef<number>(-1);
  const procRef = React.useRef<{ kill: (signal?: string) => void } | null>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const cwdRef = React.useRef<string | undefined>(cwd);
  cwdRef.current = cwd;

  React.useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [log]);

  // Run an arbitrary command string (typed or injected). Reads cwd via ref so the
  // parent can hand off a new cwd (e.g. after project creation) without races.
  const runCommand = React.useCallback((c: string): void => {
    const command = c.trim();
    if (!command) return;
    const runCwd = cwdRef.current;
    setHistory((h) => (h[h.length - 1] === command ? h : [...h, command]));
    histIdx.current = -1;
    setLog((l) => `${l}$ ${command}\n`);
    setBusy(true);
    try {
      // Per-command buffer so onCommandExit gets this command's own output
      // (the creation flow parses the trailing `pwd` line from it).
      let outBuf = '';
      const push = (chunk: string): void => { outBuf += chunk; setLog((l) => l + chunk); };
      const p = native.process.spawn('bash', ['-lc', command], runCwd ? { cwd: runCwd } : {});
      procRef.current = p;
      p.onStdout(push);
      p.onStderr(push);
      p.onError((e) => {
        procRef.current = null;
        setLog((l) => `${l}[error: ${e}]\n`);
        setBusy(false);
        onCommandExit?.(null, command, outBuf);
      });
      p.onExit((code) => {
        procRef.current = null;
        setLog((l) => `${l}${code === 0 ? '' : `[exit ${code ?? 'null'}]\n`}`);
        setBusy(false);
        inputRef.current?.focus();
        onCommandExit?.(code, command, outBuf);
      });
    } catch (e) {
      console.error('[InteractiveTerminal:spawn-bash]', JSON.stringify({ cmd: command, cwd: runCwd, error: e instanceof Error ? e.message : String(e) }), e instanceof Error ? e.stack : undefined);
      setLog((l) => `${l}[error: ${(e as Error).message}]\n`);
      setBusy(false);
      onCommandExit?.(null, command, '');
    }
  }, [onCommandExit]);

  const submit = React.useCallback(() => {
    if (busy) return;
    const c = cmd.trim();
    if (!c) return;
    setCmd('');
    runCommand(c);
  }, [cmd, busy, runCommand]);

  // Auto-run the injected command exactly once on mount.
  const ranInitial = React.useRef(false);
  React.useEffect(() => {
    if (ranInitial.current || !initialCommand) return;
    ranInitial.current = true;
    runCommand(initialCommand);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount only
  }, []);

  // Tab: complete the last token as a filesystem path against cwd.
  const complete = React.useCallback(async () => {
    const runCwd = cwdRef.current;
    if (!runCwd) return;
    const tokens = cmd.split(/(\s+)/); // keep separators so we can rejoin verbatim
    const lastIdx = tokens.length - 1;
    const last = tokens[lastIdx] ?? '';
    if (!last || /\s/.test(last)) return;
    const slash = last.lastIndexOf('/');
    const dirPart = slash >= 0 ? last.slice(0, slash + 1) : '';
    const partial = slash >= 0 ? last.slice(slash + 1) : last;
    const abs = dirPart.startsWith('/') || dirPart.startsWith('~');
    const baseDir = (abs ? dirPart : `${runCwd}/${dirPart}`).replace(/\/+$/, '') || '/';
    try {
      const entries = await native.fs.readdir(baseDir);
      const matches = entries.filter((en) => en.name.startsWith(partial));
      if (matches.length === 0) return;
      let completedTok: string;
      if (matches.length === 1) {
        completedTok = dirPart + matches[0].name + (matches[0].isDirectory ? '/' : ' ');
      } else {
        const lcp = matches.reduce((pre, m) => {
          let i = 0;
          while (i < pre.length && i < m.name.length && pre[i] === m.name[i]) i++;
          return pre.slice(0, i);
        }, matches[0].name);
        if (lcp.length <= partial.length) return; // nothing unambiguous to add
        completedTok = dirPart + lcp;
      }
      tokens[lastIdx] = completedTok;
      setCmd(tokens.join(''));
    } catch { /* dir unreadable — nothing to complete */ }
  }, [cmd]);

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Tab') { e.preventDefault(); void complete(); return; }
    if (e.ctrlKey && (e.key === 'c' || e.key === 'C')) {
      e.preventDefault();
      if (busy && procRef.current) {
        try { procRef.current.kill('SIGINT'); } catch { /* already exited */ }
        setLog((l) => `${l}^C\n`);
      } else if (cmd) {
        setCmd('');
        setLog((l) => `${l}^C\n`);
      }
      return;
    }
    if (e.key === 'Enter') { submit(); return; }
    if (e.key === 'ArrowUp' && history.length > 0) {
      e.preventDefault();
      const i = histIdx.current < 0 ? history.length - 1 : Math.max(0, histIdx.current - 1);
      histIdx.current = i;
      setCmd(history[i]);
    } else if (e.key === 'ArrowDown' && histIdx.current >= 0) {
      e.preventDefault();
      const i = histIdx.current + 1;
      if (i >= history.length) { histIdx.current = -1; setCmd(''); }
      else { histIdx.current = i; setCmd(history[i]); }
    }
  };

  // Kill any running proc on unmount.
  React.useEffect(() => () => { try { procRef.current?.kill(); } catch { /* gone */ } }, []);

  return (
    <div data-id="interactive-terminal" style={S.root} onClick={() => inputRef.current?.focus()}>
      <div ref={scrollRef} style={S.out}>
        {log
          ? <span style={S.stream}>{log}</span>
          : <span style={S.hint}>Run a command in the project (e.g. `npm test`, `git status`).{'\n'}</span>}
        <div style={S.promptLine}>
          <span style={S.prompt}>$&nbsp;</span>
          <input
            ref={inputRef}
            data-id="terminal-input"
            value={cmd}
            onChange={(e) => { setCmd(e.target.value); }}
            onKeyDown={onKeyDown}
            placeholder={busy ? 'running…' : ''}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            autoFocus
            style={S.input}
          />
        </div>
      </div>
    </div>
  );
}

const S = {
  root: { height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--bg-primary)', color: 'var(--text-primary)', minHeight: 0, cursor: 'text' },
  out: { flex: 1, overflow: 'auto', padding: 16, fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.5, color: 'var(--text-primary)' },
  stream: { whiteSpace: 'pre-wrap' as const },
  hint: { whiteSpace: 'pre-wrap' as const, color: 'var(--text-muted)' },
  promptLine: { display: 'flex', alignItems: 'baseline' },
  prompt: { fontFamily: 'var(--font-mono)', color: 'var(--accent)', fontWeight: 700, whiteSpace: 'pre' as const },
  input: { flex: 1, background: 'transparent', border: 'none', outline: 'none', padding: 0, margin: 0, fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.5, color: 'var(--text-primary)' },
} satisfies Record<string, React.CSSProperties>;
```

- [ ] **Step 2: Replace `TerminalPanel.tsx` with a thin wrapper**

Replace the entire contents of `client/studio/panels/TerminalPanel.tsx` with:
```tsx
import React from 'react';
import { getActiveProjectPath } from '../hooks/useSocket';
import { InteractiveTerminal } from '../components/InteractiveTerminal';

/** The Terminal tab: an interactive terminal bound to the open project's dir.
 *  Guard (moved here from the old inline logic): with no project open there is
 *  no cwd to run in, so show a hint instead of a live prompt. */
export function TerminalPanel(): React.ReactElement {
  const cwd = getActiveProjectPath();
  if (!cwd) {
    return (
      <div data-id="terminal-panel" style={S.empty}>
        No project open.
      </div>
    );
  }
  return (
    <div data-id="terminal-panel" style={S.root}>
      <InteractiveTerminal cwd={cwd} />
    </div>
  );
}

const S = {
  root: { height: '100%', minHeight: 0 },
  empty: { height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 12, background: 'var(--bg-primary)' },
} satisfies Record<string, React.CSSProperties>;
```

Note: minor behavior change — with no project open the tab now shows a static "No project open." instead of a live prompt that errored on submit. This matches the spec (guard moved to the wrapper).

- [ ] **Step 3: Typecheck**

Run:
```bash
cd /Users/admin/Documents/GitHub/ugly-code && pnpm exec tsc --noEmit -p tsconfig.json
```
Expected: exit 0. If `native.fs.readdir`'s entry type differs from `{ name; isDirectory }`, match the exact shape used in the original `TerminalPanel` (it was copied verbatim, so it should already align).

- [ ] **Step 4: Run the full unit suite (no regressions)**

Run:
```bash
cd /Users/admin/Documents/GitHub/ugly-code && pnpm test
```
Expected: PASS (including the new `scaffoldCommand` tests; no other suite breaks).

- [ ] **Step 5: Commit**

```bash
cd /Users/admin/Documents/GitHub/ugly-code
git add client/studio/components/InteractiveTerminal.tsx client/studio/panels/TerminalPanel.tsx
git commit -m "refactor(studio): extract reusable InteractiveTerminal from TerminalPanel

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Wire new-project creation to `<InteractiveTerminal>` (ugly-code)

Replace the append-only console body of `ProjectCreationProgress` with the interactive terminal, injecting the scaffold command. Keep the header + Retry/Cancel chrome. Verified by `tsc` + manual Studio create-project.

**Files:**
- Modify: `client/studio/panels/ProjectCreationProgress.tsx`

**Interfaces:**
- Consumes: `buildScaffoldCommand`, `parseScaffoldResult` (Task 2); `InteractiveTerminal` (Task 3).

- [ ] **Step 1: Read the current file to preserve its props + chrome**

Run:
```bash
cd /Users/admin/Documents/GitHub/ugly-code && sed -n '1,40p;113,240p' client/studio/panels/ProjectCreationProgress.tsx
```
Note the component's props (e.g. `name`, `parentDir`, `onDone`, `onCancel`), the header/status markup, and the Retry/Cancel controls — these are preserved. Only the effect that spawns `bash` and the `<ConsoleText>` body are replaced.

- [ ] **Step 2: Rewrite the body**

Apply these changes to `ProjectCreationProgress.tsx`:

1. Add imports:
```tsx
import { InteractiveTerminal } from '../components/InteractiveTerminal';
import { buildScaffoldCommand, parseScaffoldResult } from './scaffoldCommand';
```
2. Remove the `React.useEffect` that builds `cmd`, calls `native.process.spawn`, and appends to `output` (the old lines ~39-108), and remove the now-unused `output`/`buf`/`procRef`/`ConsoleText` machinery. Replace the driving logic with state + a handler:
```tsx
// Bumping `attempt` remounts the terminal (via key) → the scaffold re-runs.
const [attempt, setAttempt] = React.useState(0);
const [status, setStatus] = React.useState<'running' | 'done' | 'error'>('running');
const [error, setError] = React.useState<string | null>(null);
const [createdPath, setCreatedPath] = React.useState<string | undefined>(undefined);

const scaffoldCmd = React.useMemo(() => buildScaffoldCommand(name, parentDir), [name, parentDir]);

const handleCommandExit = React.useCallback((code: number | null, _command: string, output: string): void => {
  const result = parseScaffoldResult(output, code);
  if (result.ok) {
    const path = result.path || `${parentDir.replace(/\/+$/, '')}/${name}`;
    setStatus('done');
    setCreatedPath(path);
    onDone(name, path);
  } else {
    setStatus('error');
    setError(`\`ugly-app init\` exited with code ${result.code ?? 'null'}`);
  }
}, [name, parentDir, onDone]);
```
(`InteractiveTerminal.onCommandExit` already passes the command's accumulated `output` as its third arg — see Task 3.)

3. Render the terminal in the body (replacing `<ConsoleText …/>`), keyed on `attempt` so Retry remounts it, with `cwd` handing off to the created project after success:
```tsx
<InteractiveTerminal
  key={attempt}
  cwd={createdPath}
  initialCommand={scaffoldCmd}
  onCommandExit={handleCommandExit}
/>
```
4. Wire Retry to reset state and bump `attempt`:
```tsx
const retry = React.useCallback(() => {
  setError(null);
  setStatus('running');
  setCreatedPath(undefined);
  setAttempt((a) => a + 1);
}, []);
```
Point the existing Retry button's handler at `retry`. Keep Cancel/Back as-is.

- [ ] **Step 3: Typecheck**

Run:
```bash
cd /Users/admin/Documents/GitHub/ugly-code && pnpm exec tsc --noEmit -p tsconfig.json
```
Expected: exit 0. Resolve any prop-name mismatches against the real `ProjectCreationProgress` props observed in Step 1.

- [ ] **Step 4: Run the full unit suite**

Run:
```bash
cd /Users/admin/Documents/GitHub/ugly-code && pnpm test
```
Expected: PASS.

- [ ] **Step 5: Manual verification in Studio**

Launch Studio, create a new project, and confirm:
- The scaffold command is echoed as `$ npx -y ugly-app@latest init "<name>"` immediately, and its output streams live in the terminal.
- On success the tab is promoted (`onDone` fired) and typing `ls` in the same terminal lists the **new project's** files (cwd handed off to `createdPath`).
- Forcing a failure (e.g. an invalid name) shows the error + Retry, and Retry re-runs the scaffold.
- The standalone Terminal tab still works, and shows "No project open." when no project is open.

- [ ] **Step 6: Commit**

```bash
cd /Users/admin/Documents/GitHub/ugly-code
git add client/studio/panels/ProjectCreationProgress.tsx client/studio/components/InteractiveTerminal.tsx
git commit -m "feat(studio): run new-project scaffold in the interactive terminal

Creation now renders InteractiveTerminal with the scaffold command injected, so
the user sees each command echoed + live output and can type into the same shell.
cwd hands off to the created project on success.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Fix A streaming download → Task 1. ✓
- Reusable `<InteractiveTerminal>` (cwd/initialCommand/onCommandExit) → Task 3. ✓
- `TerminalPanel` thin wrapper + guard moved → Task 3. ✓
- Creation renders terminal, injects scaffold, echoes command, streams → Task 4. ✓
- Completion via per-command exit + last-line parse → Task 2 (`parseScaffoldResult`) + Task 4. ✓
- cwd hand-off to created project → Task 4 (`createdPath`). ✓
- Retry via remount → Task 4 (`attempt` key). ✓
- Unit tests for pure logic (repo pattern) → Task 2. ✓
- Out-of-scope items (no PTY/xterm, no contract change, keep `npx @latest`) respected. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code.

**Type consistency:** `onCommandExit` signature is `(code: number | null, command: string, output: string) => void` — defined in Task 3 and consumed by `handleCommandExit` in Task 4; `TerminalPanel` (Task 3) ignores it. `buildScaffoldCommand`/`parseScaffoldResult` signatures match between Task 2 (definition) and Task 4 (use). `ScaffoldResult.code` is `number | null`, matching `parseScaffoldResult`'s `code` param.
