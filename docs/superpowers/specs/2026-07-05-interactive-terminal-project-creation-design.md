# Interactive terminal for new-project creation + streaming binary-download progress

**Date:** 2026-07-05
**Status:** Approved (design)

## Problem

On a fresh install of ugly-studio on a new computer, two first-run flows give no feedback:

1. **Binary-download popup never shows progress.** The download-binaries popup bar sits frozen at 0% "Downloading" for the entire download, then jumps to 50% (extract) and 100% (done).
2. **New-project setup looks broken.** Creating a new project shows a bare spinner + "Starting…" with no output for a long time, then output suddenly appears.

### Root causes (verified against source)

1. **Binary download** — `ugly-app/src/native/server/binaries/installer.ts` `download()` did a single **buffered** fetch (`Buffer.from(await res.arrayBuffer())`) with no byte-level streaming. The only progress events were three phase markers: `download` `pct:0` fired *before* the fetch, `extract` `pct:50` after the whole archive landed, `done` `pct:100`. The popup UI (`ugly-studio/electron/browser/install-progress.ts`) and the IPC/callback wiring are correct — it faithfully renders a bar with no mid-download data.

2. **New-project setup** — `ugly-code/client/studio/panels/ProjectCreationProgress.tsx` spawns `bash -lc "… npx -y ugly-app@latest init … && pnpm …"` over `native.process.spawn`, which uses **pipes, not a PTY**. When npx/pnpm detect a non-TTY pipe they suppress spinners/progress, so the child is genuinely silent during the (cold-cache) `npx @latest` download; the first visible output is scaffold's own `console.log` + pnpm's append-only progress. The Studio→UI streaming itself is live and not the bottleneck. The panel renders output as an append-only `<ConsoleText>` and has **no way to run a command from elsewhere** and **no interactivity**.

## Scope

Two independent fixes:

- **Fix A — streaming binary-download progress** (ugly-app). *Already implemented and typechecked.*
- **Fix B — reuse the interactive terminal for new-project creation** (ugly-code). This spec's main work.

Explicitly **out of scope:** any PTY/xterm work, any ugly-app native-contract change for Fix B, dropping `npx -y ugly-app@latest` in favor of the bundled CLI (the redundant fetch is left as-is but made visible), and changing the standalone Terminal tab's behavior. Because Fix B stays on the pipe (non-TTY) path, npx/pnpm animated spinners still will not render — accepted; this matches the existing terminal panel's fidelity, and echoing the command + live streaming addresses "what's going on."

---

## Fix A — streaming binary-download progress (ugly-app) — DONE

**File:** `ugly-app/src/native/server/binaries/installer.ts`

`download()` now streams the response body via `res.body.getReader()`, accumulates chunks, and emits `onProgress({ name, phase: 'download', pct })` throttled to integer-pct changes. Bytes map into the **first half** of the bar (`pct = min(50, round(received/total * 50))`) because the existing markers put `extract` at 50 and `done` at 100. When the server sends no `Content-Length` (or exposes no stream) it falls back to the previous single buffered read (no mid-download progress). The per-attempt timeout + 3-retry loop and sha256 verification are unchanged.

The popup (`install-progress.ts`) needs **no change** — it already renders `p.pct` and `LABEL[p.phase]`, so a rising `download` pct animates the bar under the "Downloading" label.

**Status:** implemented; `pnpm tsc` on ugly-app passes clean (0 errors). Full runtime verification requires exercising a real binary download (packaged Studio / fresh cache).

---

## Fix B — reuse the interactive terminal for new-project creation (ugly-code)

### B.1 Extract a reusable `<InteractiveTerminal>` component

Pull the terminal implementation out of `client/studio/panels/TerminalPanel.tsx` into a new `client/studio/components/InteractiveTerminal.tsx`. It keeps **all** current behavior — streaming `bash -lc` per command, `$ <cmd>` echo, command history (Up/Down), Tab filename completion, Ctrl+C (SIGINT running proc / clear line), inline prompt at the tail, auto-scroll, auto-focus — and adds three props:

```ts
interface InteractiveTerminalProps {
  /** cwd for typed commands. undefined ⇒ spawn with no cwd option
   *  (the target dir may not exist yet during creation). */
  cwd?: string;
  /** Auto-run exactly once on mount, echoed as `$ <cmd>` and executed like a typed command. */
  initialCommand?: string;
  /** Fires on each command's exit with the exit code and the command string. */
  onCommandExit?: (code: number | null, command: string) => void;
}
```

Design notes:
- **cwd handling.** Today the panel hard-requires an active project path and prints "No project open." if absent. In the reusable component, `cwd` is optional: when set, spawn with `{ cwd }`; when undefined, spawn with no cwd option (inherits the daemon default) — required because the creation flow runs before the project dir exists. The "No project open." guard moves into the `TerminalPanel` wrapper (see B.2), not the reusable component.
- **initialCommand runs once.** Guard with a ref/effect so re-renders don't re-run it. A separate `attempt`-style re-run is driven by the parent remounting or a key change (used by Retry in B.3), not by prop churn.
- **onCommandExit** fires from the existing `p.onExit` handler, passing `(code, command)` so the parent can react (creation uses it for completion; the wrapper ignores it).
- The reusable component owns no project/scaffold knowledge — it is a pure interactive terminal over `native.process.spawn`.

### B.2 `TerminalPanel` becomes a thin wrapper

`TerminalPanel.tsx` collapses to `<InteractiveTerminal cwd={getActiveProjectPath()} />` (plus the "No project open." affordance when there's no active project). Behavior is unchanged — this keeps the refactor verifiable: the existing Terminal tab must look and act exactly as before.

### B.3 New-project creation renders the terminal

Rewrite `client/studio/panels/ProjectCreationProgress.tsx` to keep its header (spinner → done state, project name) and Retry/Cancel controls, but replace the append-only `<ConsoleText>` body with `<InteractiveTerminal>`:

- **`initialCommand`** = the existing scaffold command, unchanged:
  `mkdir -p "<parent>" && cd "<parent>" && npx -y ugly-app@latest init "<name>" && cd "<name>" && pwd`
  (with the existing `~`→`$HOME` expansion and quote-escaping). The user sees `$ npx … init "<name>"` echoed immediately — fixing the "looks broken" perception — and its output streams live.
- **Completion.** Each injected command is its own `bash -lc` that exits, so `onCommandExit(code, cmd)` fires naturally (no persistent-shell sentinel needed):
  - `code === 0` → parse the last non-empty output line (the `pwd`) as the project path → call `onDone(name, path)` (same promotion logic the panel has today).
  - non-zero / null → set error state; **Retry** re-injects the command (remount `<InteractiveTerminal>` via a bumped `key`/`attempt`).
  - The terminal stays interactive in both cases.
- **cwd hand-off.** The initial command runs with **no cwd** (it `mkdir`s + `cd`s itself, and the parent dir may not exist). On success the panel stores `createdPath` and passes `cwd={createdPath}` so the user's *next typed command* (`ls`, `git status`) runs inside the new project, not the parent.
- **Unmount** kills the running proc (existing cleanup, now delegated to the component).

### Data flow (Fix B)

```
ProjectOnboarding → beginProjectCreation (ProjectsContext)
  → ProjectCreationProgress (creating tab)
      renders <InteractiveTerminal initialCommand=scaffoldCmd onCommandExit=handleExit />
        → native.process.spawn('bash', ['-lc', scaffoldCmd], { /* no cwd */ })
        → onStdout/onStderr stream → terminal buffer (rendered)
        → onExit(code) → onCommandExit(code, cmd) → handleExit:
             code 0 → parse pwd → onDone(name, path); set cwd=createdPath
             else   → error + Retry
      user can type further commands (cwd = createdPath after success)
```

### Components & boundaries

- **`<InteractiveTerminal>`** (new) — pure interactive terminal over `native.process.spawn`; props in B.1; no project/scaffold knowledge. Independently testable with a mocked `native.process`.
- **`TerminalPanel`** (thinned) — active-project wrapper around `<InteractiveTerminal>`.
- **`ProjectCreationProgress`** (rewritten body) — owns the scaffold command string, completion parsing, cwd hand-off, and Retry/Cancel chrome. The sentinel/last-line parser is a small pure function, unit-testable in isolation.

## Testing

- **Unit — `<InteractiveTerminal>`** (mock `native.process.spawn`): `initialCommand` auto-runs exactly once and echoes `$ cmd`; `onCommandExit` fires with the exit code and command; a typed command spawns with the current `cwd`; Ctrl+C sends SIGINT to a running proc; history/Tab behavior preserved.
- **Unit — creation completion parser:** `code 0` + trailing `pwd` line → correct project path; non-zero → error state; blank/again handled.
- **Verify (manual, Studio):** create a project → the scaffold command is echoed and its output streams in the terminal; on success the cwd switches to the project (typing `ls` shows project files) and `onDone` promotes the tab; Retry re-runs the scaffold; the standalone Terminal tab still behaves exactly as before.

## Risks / notes

- Still the pipe (non-TTY) path → no animated npx/pnpm spinners. Accepted per scope. If the silent `npx -y ugly-app@latest` cold fetch remains a complaint, a **follow-up** could either switch to the bundled ugly-app CLI or add non-TTY progress flags — both deliberately out of scope here.
- `native.process.spawn` with an undefined cwd must be honored by the daemon as "inherit default" — verify the facade/daemon accept the absence of `cwd` (current `ProjectCreationProgress` already spawns with `{}`, so this is the established behavior).
- Retry must fully tear down the previous proc before re-injecting (remount via `key` bump handles this cleanly).
