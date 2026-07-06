# Eval tests for the Python & Rules/Judge episodes — feature port, CLI/in-studio parity, and shared binaries

**Date:** 2026-07-05
**Status:** Design — approved scope, not yet implemented ("just write the plan for now")
**Repos touched:** `ugly-code` (primary), `ugly-studio` (host binaries + in-studio parity), `ugly-app` (dev binaries), `app/youtube` (episode guides — renumber already applied)

---

## 0. Why this exists

The YouTube season plan has two episodes built entirely around coding-agent
mechanisms:

- **Ep 04 — "Python in the Loop"** (`app/youtube/EP04_GUIDE.md`)
- **Ep 05 — "The Rules and the Judge"** (`app/youtube/EP05_GUIDE.md`)

The user asked to (a) renumber the episodes, (b) design a series of eval tests
that demonstrate the **pro/con** of these two approaches, (c) verify ugly-code
has the features, and (d) verify the tests run **both** from the ugly-code CLI
**and** inside ugly-code running in the studio. A late addition: consolidate the
**bundled binaries** so `ugly-app dev`, `ugly-studio`, and the new `ugly-code`
CLI all share one predictable location, installing on-demand for the CLI.

### Renumber (DONE)

Feral Coding was promoted from the 02.5 side quest into numbered slot **Ep 03**;
everything after shifted up one:

| New | Title | Old |
|-----|-------|-----|
| 03 | Feral Coding | 02.5 (`EP_BOT_SWARM_GUIDE.md`) → `EP03_GUIDE.md` |
| 04 | Python in the Loop | 03 → `EP04_GUIDE.md` |
| 05 | The Rules and the Judge | 04 → `EP05_GUIDE.md` |
| 06 | Three Ways to Be Wrong (Finale) | 05 → `EP06_GUIDE.md` |

Files renamed; `SEASON_1_GUIDE.md` index + locked-decisions + critical-files
sections updated; all in-body cross-references and scoreboard `week-N` filenames
bumped (Ep 01/02 unchanged). Verified no dangling links. (Cosmetic follow-up
deferred: the `visuals/ep02-5.html` asset filename still carries the old "02-5"
slug — left as-is because rendered PNGs reference it.)

---

## 1. Verification findings — the honest ground truth

The episode guides were written against the **old monolith** (`app/studio/server/coding-agent/…`).
That code moved into `ugly-code`, and most of the load-bearing features **did not
survive the move**. `app/studio/` is now empty. Four verification passes over
`ugly-code` and `ugly-studio` found:

### 1a. `python_exec` (Ep 04) — mostly MISSING
`ugly-code/client/agent/tools/pythonExec.ts` is a **41-line wrapper around
`python -c`** (line 32: `spawnCollect('python', ['-c', code], { cwd })`).

| Claimed feature | Status |
|---|---|
| Tool exists | PARTIAL — exists, but plain `python -c`, not `uv run --script` |
| Two modes (one-shot + stateful `PythonSession`, 60s default) | MISSING — one-shot only; no session; no timeout |
| `recursive_llm()` / `final()` via `ugly_studio` module | MISSING |
| Read-only guard-mode with verbatim block error | MISSING — `gating.ts` is a static allowlist, no per-step guard |
| Tempfile leak meter / resource tracking | MISSING — tool writes no tempfile |
| Timeout + safety limits | MISSING — `spawn.ts` has no timeout/kill/caps |

### 1b. Rules & Judge (Ep 05) — MISSING (UI scaffolding only)
No `patterns/registry.ts`, no step engine, no mid-step judge in `ugly-code`.

| Claimed feature | Status |
|---|---|
| SBV pattern registry w/ `allowedTools`/`systemPromptTail`/`advanceCriteria` | MISSING — only a `{id,label,hint}` UI strip in `PatternStrip.tsx:50-54` |
| SPEC read-only+`spec_write` / BUILD THREE-FIX / VERIFY RED-GREEN-REVERT | MISSING — strings absent; `spec_write` exists standalone in `specRead.ts` but ungated |
| Mid-step LLM judge (continue/advance verdicts) | MISSING — only a post-run whole-project grader (`grader.ts`) |
| `--pattern` flag or a pattern classifier | MISSING — `patternMode` is passthrough UI state; `clientAgent.ts:57` says "no auto-router / pattern engine" |
| Pattern list | Enum of 9 values exists (`api.ts:420-431`) but no registry object |

### 1c. Eval running — CLI MISSING, in-studio PARTIAL
- **59 tasks** defined in `ugly-code/client/studio/evals/tasks.json`, typed by
  `registry.ts` (`RawEvalTask`: `name, kind, turns[], successCriteria, budget,
  gates?[], repoUrl?, ticketPath?…`). **Tasks pin no model, no tools, no
  pattern.**
- **Grader** (`grader.ts` `gradeProject`) runs per-task `gates[]`
  (`tsc`/`vitest`/`fileExists`/`fileMatches`/`judge:<rubric>` LLM/`custom:`), or a
  `tsc + npm test` fallback out of 2. Score = `score/scoreMax`.
- **CLI: none.** No `run-one.ts` / `comparison.ts` / `scoreboard.ts` in
  `ugly-code` (they lived in the retired monolith). Only `vitest run` unit tests.
- **In-studio: single-task only.** `EvalPickerModal` → `evalCreateProject`
  (git-clones fixture) → session model runs the agent over the UglyNative bridge
  → `evalGradeSession` → `EvalScorecard`. **No** run-all/batch, **no**
  comparison, **no** scoreboard; `evalListHistory`/`evalDeleteRun` are stubs
  (`useSocket.ts:915-916`). Automated scoring is deterministic-gates-only; judge
  gates are manual.
- **Same agent core, two front-ends:** in-studio via
  `ugly-studio/electron/hostHub/taskRunner.mjs` (UglyNative bridge); in-process
  via `ugly-studio/tests/parity/harness.ts` (simulated provider). ugly-studio
  keeps recorded real-model baselines under `evals/baselines/`.

**Conclusion:** demonstrating the pro/con of these two approaches, and running
the tests via CLI + in-studio with parity, requires **building the approaches,
the CLI, and the A/B harness first.** Per the locked decision (below) we port the
full monolith feature set rather than scope the episodes down.

---

## 2. Locked decisions

1. **Build-first, full port.** Port the complete `python_exec` feature set and
   the full pattern-engine + mid-step-judge into `ugly-code`, plus a CLI and an
   A/B comparison harness. Episodes keep their original scripts.
2. **Both CLI + in-studio, with parity.** Every eval test must run from a
   `ugly-code` terminal command **and** from inside the studio, and produce
   equivalent scored results (the parity check is itself a test).
3. **Footage + lasting suite.** Each designed test lands as a permanent addition
   to the eval suite (new tasks + toggles + comparison configs) *and* captures
   the on-camera pro/con numbers.
4. **Shared bundled binaries.** One predictable location (`~/.ugly-bot/binaries/`,
   co-located with the auth store) used by `ugly-app dev`, `ugly-studio`, and
   `ugly-code` CLI; on-demand install for the CLI.
5. **CLI stores turn data locally, not on the server.** CLI runs persist session
   state to `~/.ugly-code/session/<id>/` via a filesystem provider swapped in for
   the `sessionApi` seam; LLM inference still hits the deployed origin. Studio
   keeps the server provider (cross-device).

---

## 3. Architecture

### 3.1 One agent core, three entry surfaces — all reuse the existing headless task
The coding agent already runs headless as an **ugly-app background task**. The
agent loop (`clientAgent.ts`, `client/agent/engine.ts`, all `client/agent/tools/*`)
is **React-free** and dispatches tools over an injected `UglyNative`. The `coding`
task bundle (`client/studio/agent/coding-task.ts`) already installs
`createNodeUglyNative()` (from `ugly-app/src/native/node.ts` — fs/process local,
non-local channels reject), a `localStorage` shim, and a `/api/*` `fetchSocket`
with auth-cookie injection. The three surfaces:
- **CLI** (new) — reuses the same `coding` task bundle. **No new `native`
  provider** — `createNodeUglyNative()` already exists and already services the
  entire eval tool set (read/write/edit/bash/grep/python_exec = 100% local
  fs/process; **no Studio host needed**). Recommended shape: run the bundle
  **in-process** (set `globalThis.defineTask/uglyTask/UglyNative`, `import()` the
  bundle, call `onCall.send({text})` directly and await it) — no child process,
  no IPC, no `taskRunner.mjs`, because eval needs neither a sandbox nor host
  forwarding.
- **In-studio** — existing UglyNative `native.task` → `taskRunner.mjs` path,
  unchanged.
- **In-process test harness** — existing parity harness (repair the possibly
  stale `server/coding-agent/index` import first).

CLI/in-studio parity falls out for free: both drive the *same* task bundle and
the same `createNodeUglyNative`; only the parent driver differs (in-process call
vs. `native.task` IPC). This is the single most important structural fact — W1 is
a thin driver, not a re-implementation.

**Correction to an earlier draft of this spec:** W1 does not build a Node `native`
abstraction; that already ships as `createNodeUglyNative`. W1's real new surface
is (a) a parent-side non-interactive driver, (b) a turn loop keyed on the `send`
promise resolving (there is no separate commit/final frame), and (c) auth+origin
plumbing so `/api/agentStep` authenticates. See W1.

### 3.2 Eval task schema extension
Extend `RawEvalTask` (`registry.ts`) with **optional, per-task or per-run**
overrides so A/B configs are declarative:

```ts
interface EvalRunConfig {
  model?: string;              // framework id, e.g. 'glm_5_2', 'claude_sonnet_4_6'
  pattern?: PatternId | null;  // force a pattern; null = flat loop
  toolset?: 'default' | 'no-python' | 'python-only' | string; // allowlist variant
  flags?: Record<string, boolean>;  // feature toggles (guard, judge-dedup, etc.)
  seed?: number;               // reserved
}
```

Tasks stay model-agnostic by default; a **comparison config** (§6) supplies the
matrix of `EvalRunConfig`s to sweep. This keeps the 59 existing tasks untouched
while enabling A/B.

### 3.3 Shared binaries (Workstream W0)
Consolidate binary provisioning into a shared library + predictable root:

```
~/.ugly-bot/binaries/
  <platform-arch>/
    python/…       (uv-managed runtime for python_exec)
    postgres/…     (ugly-app dev)
    minio/…        (ugly-app dev)
    manifest.json  (versions, checksums, install timestamps)
```

- A single resolver module (candidate home: shared package consumed by all
  three) exposes `binaryPath(name)`, `ensureBinary(name)`, and
  `whenBinariesReady(names[])`.
- `ugly-studio` currently gates launch on its own `whenBinariesReady()`; migrate
  it to read/write the shared root instead of a per-app copy.
- `ugly-app dev` currently bundles Postgres/MinIO (docker-free); point it at the
  shared root.
- **ugly-code CLI installs on-demand:** the first eval run (or `python_exec`
  invocation) that needs Python calls `ensureBinary('python')`, which downloads +
  unpacks into the shared root if absent, with a lock file to avoid concurrent
  double-installs. Subsequent runs are instant.
- **Migration/verification during implementation:** locate the current
  ugly-studio binary logic (`whenBinariesReady`, sealed-PATH handling on Windows,
  the `spawn` PATH shims) and the ugly-app dev bundling path; unify without
  regressing the Windows sealed-PATH and readiness-gate behavior already captured
  in memory.

---

### 3.4 Session persistence provider — server (studio) vs filesystem (CLI)
Turn/session state is written through a **single 7-method seam**, `sessionApi` in
`client/studio/agent/serverSessionApi.ts` (`upsert, appendMessage, compact,
listMessages, list, archive, clearMessages`) — all best-effort, all keyed by
`sessionId`, backed by the owner-scoped server collections `codingSession` +
`codingSessionMessage`. **LLM inference (`agentTurn`/`agentStep`) is a separate
path and stays on the server regardless.** For CLI we do not persist turn data to
the server — we swap this one module for a filesystem store; the agent loop is
untouched.

- **Seam:** today `clientAgent.ts:36-45` hardcodes
  `import { sessionApi } from './serverSessionApi'`. Make the store an **injected
  dependency threaded from `coding-task.ts`** (preferred — the task knows its
  surface), or branch inside `serverSessionApi.ts`'s `api()` helper on a CLI flag.
  Reuse the FS-agnostic helpers as-is: `planCompaction`, `rowToMessage`,
  `reconstructResumeContext`, and the `StoredMessageRow`/`SessionListRow` shapes.
- **CLI store location:** `~/.ugly-code/session/<sanitized-sessionId>/`:
  - `metadata.json` — the `codingSession` row (title, kind, model, status,
    messageCount, costUsd, archived, timestamps).
  - `messages.jsonl` — the transcript as `StoredMessageRow`s, **preserving `seq`
    and the `compacted` flag** so `reconstructResumeContext` rebuilds the exact
    post-compaction working context; supports the 7 ops (append / list
    compacted-vs-all / compact / clear).
  - `workspace.json` — the `SessionWorkspace` worktree binding (`dir, port,
    isWorktree, branch`) currently in `localStorage`, so a resumed CLI session
    reattaches its git worktree instead of re-provisioning.
  - (optional) `transcript.jsonl` — verbatim uncompacted event log for issue
    bundles; not required for resume.
- **CLI opts out of (all fine single-machine):** cross-device resume, live
  listen-only mirroring, the server session sidebar, owner-scoping. The studio
  path keeps the server provider for those.
- Note: a local JSONL already exists (`sessionLog.ts` → `.ugly-studio/sessions/`)
  but it's a debug event-log, not compaction-aware — `sessionApi` is the correct
  seam, not that log.

## 4. Workstreams

Ordered by dependency. Each lists deliverable, key files, and acceptance.

### W0 — Shared bundled binaries
- **Deliverable:** shared resolver + `~/.ugly-bot/binaries/` root; ugly-studio and
  ugly-app dev migrated; ugly-code CLI on-demand install with lockfile.
- **Files:** new shared binaries module; `ugly-studio` host readiness gate;
  `ugly-app` dev infra; `ugly-code` CLI bootstrap; `pythonExec.ts` resolves
  `binaryPath('python')` instead of bare `python`.
- **Acceptance:** all three surfaces run Python from the same location; deleting
  the root and running one CLI eval re-installs Python once; Windows sealed-PATH
  and studio readiness-gate still pass.

### W1 — Headless CLI driver over the existing `coding` task bundle
Reuses the existing background-task path — **not** a new agent runner or native
provider. Verified: the `coding` bundle + `clientAgent`/`engine`/tools +
`createNodeUglyNative` + `fetchSocket` run the full eval tool set locally with no
Studio host.
- **Deliverable:** a `ugly-code` CLI entry (`ugly-code evals run <task>`,
  `… compare <config>`, `… scoreboard`) plus a thin **non-interactive task
  driver**. Recommended: **in-process** — set `globalThis.defineTask/uglyTask/UglyNative`,
  `import()` the built bundle, invoke `onCall.send({text})` per turn, await
  resolution (completion signal), collect `emit('msg', …)` frames as the
  transcript. (Heavier alt: copy `ugly-studio/electron/hostHub/taskManager.ts`
  and fork `taskRunner.mjs` — overkill for eval; keep as fallback if we later
  need sandbox/host-forwarding parity.)
- **Reuse as-is:** `client/studio/agent/coding-task.ts`, `clientAgent.ts`,
  `client/agent/engine.ts`, `client/agent/tools/*`, `createNodeUglyNative`
  (`ugly-app/src/native/node.ts`), the in-bundle `fetchSocket`; `registry.ts`
  task loader + `grader.ts` for setup/grading.
- **New:** the CLI bin + `package.json` scripts; the in-process driver + turn
  loop; and the **auth** flow (below). The `origin` is the **already-deployed
  ugly-code app** — the CLI does **not** run its own server. Tools run locally;
  only LLM calls (`/api/agentTurn`+`/api/agentStep`) hit the deployed origin, and
  billing is the user's (ugly.bot metered proxy — see [[uglyapp_user_billed_ai]]).
- **Skip / tolerate rejection:** `ensureCodebaseAnalysis` (`codebase.*`, host-only
  boot poll — does not gate `send`) and the `webFetch` tool (`browse.*`). Neither
  is needed for grading.
- **Acceptance:** with a logged-in user (or a test-user token),
  `ugly-code evals run breaking-change-find-callers --model glm_5_2` clones the
  fixture, runs the agent in-process over the bundle against the deployed origin,
  grades via `gradeProject`, prints `score/scoreMax` — no Studio, no Electron,
  no child process, no local server.

#### W1 auth — require a valid logged-in user
The CLI passes the user's session token to the task's fetch shim as the
`auth_token` cookie, so `/api/agentStep` on the deployed app authenticates as
that user. Three paths:
- **Normal users — reuse `ugly-app login`.** Token lives in `~/.ugly-bot/auth.json`
  (written by `npx ugly-app login`; read via `src/cli/authStore.ts` `readAuthToken`
  / `uglyBotAuth.ts` `readUglyBotAuth`; validity checked like `probeAuth.ts`).
- **Auto or manual login trigger.** On a missing/expired token: if interactive,
  the CLI **auto-triggers the login flow** (opens a browser, same path as
  `ugly-app login`); manual invocation is `ugly-code --login` (a thin alias that
  delegates to the ugly-app user-login flow). If non-interactive (CI), fail fast
  with the instruction + fall back to a test-user token (below). Model after the
  existing "Not logged in. Run: ugly-app login" pattern in `textGen.ts` /
  `feedbackResolve.ts`.
- **Local testing / CI — framework test users** (same mechanism ugly-studio uses,
  see [[uglyapp_test_users_framework]]): `ugly-app test-user create --email …`
  mints a real user session token (response `{result:{userId,email,token}}` —
  read `.result.token`), signed with the project AUTH_SECRET against the deployed
  app; reaped after 7 days. The eval CLI accepts `--test-user` (create+use
  ephemerally) or an explicit `--token`/`UGLY_AUTH_TOKEN` so E2E and the CLI==studio
  parity test run unattended. This keeps eval spend on isolated synthetic users,
  not the operator's account.

### W1b — Filesystem session store (CLI provider for `sessionApi`)
- **Deliverable:** a `~/.ugly-code/session/<id>/` filesystem implementation of the
  `sessionApi` interface (all 7 methods) selected for CLI runs; the server
  provider stays for studio. No turn data written to the server on CLI runs.
- **Files:** new `fsSessionApi.ts` (mirrors `serverSessionApi.ts`'s interface over
  `native.fs`); make `sessionApi` injectable in `clientAgent.ts` + `coding-task.ts`
  (select the provider by surface/param); persist the worktree binding to
  `workspace.json` instead of the `localStorage` shim for CLI.
- **Reuse:** `planCompaction`, `rowToMessage`, `reconstructResumeContext`,
  `StoredMessageRow`/`SessionListRow` (unchanged).
- **Acceptance:** a CLI eval run writes `metadata.json` + `messages.jsonl`
  (+ `workspace.json`) under `~/.ugly-code/session/<id>/`, makes **zero** server
  session-state calls (only `agentTurn`/`agentStep` hit the network), and a
  follow-up `ugly-code evals resume <id>` reconstructs the exact working context
  from disk.

### W2 — `python_exec` full feature port
> **Status (2026-07-05):** Shipped as Plan 2a (one-shot hardening: `uv run --script`,
> SIGTERM→SIGKILL timeout, output truncation, guaranteed tempfile cleanup + uv
> bootstrap + `process:'full'` permission) and Plan 2b (guard-mode via bundled
> `ugly_studio._guard`). **2c (stateful `PythonSession` + `recursive_llm`/`final`
> loopback-TCP bridge) is CUT as specced.** Rationale: `recursive_llm` duplicates
> the existing `delegate`/`delegateParallel` tools with *worse* governance — it's
> an un-metered, un-judged provider call over a private socket, the opposite of the
> harness's own thesis; stateful sessions are marginal for coding vs. data-analysis
> tasks. The *one* usable kernel (LLM-as-a-function inside deterministic Python
> control flow over data too big/repetitive for the agent context) should, IF an
> eval ever proves the need, be built as a **budgeted `recursive_llm` routed
> through `ctx.step` (governed, metered) over a simple stdio/fd bridge — NOT a TCP
> server + long-running REPL.** Defer until evidence.
- **Deliverable:** one-shot + stateful `PythonSession`; `ugly_studio` helper
  exposing `recursive_llm()` / `final()`; read-only guard-mode with verbatim
  block error; tempfile-leak meter; `uv run --script`; per-call timeout (60s
  default) + kill.
- **Files:** `pythonExec.ts`, new `pythonSession.ts`, `spawn.ts` (add
  timeout/kill), `gating.ts` (per-step read-only guard), tool `registry.ts`;
  align `TOOLS.md` (currently documents `timeout_ms`/`stdin` the code lacks).
- **Acceptance:** unit + e2e prove each mode; guard blocks a write during a
  read-only step with the exact error; a runaway `recursive_llm` is capped; the
  leak meter reports non-zero on a deliberate leak.

### W3 — Pattern engine + mid-step judge port
- **Deliverable:** `patterns/registry.ts` with real step definitions
  (`allowedTools`, `systemPromptTail`, `advanceCriteria`); Spec-Build-Verify
  (SPEC read-only+`spec_write`; BUILD THREE-FIX; VERIFY RED-GREEN-REVERT-RED-GREEN);
  a mid-step LLM judge emitting `continue`/`advance` + reason; a pattern
  classifier + `--pattern` CLI flag / studio axis wired to the engine (today
  `resolvedPattern` is never populated).
- **Files:** new `patterns/` module; `eval-judge`/mid-step judge; wire
  `clientAgent.ts` (remove "no pattern engine" limitation), `PatternStrip.tsx`,
  `AgentAxisSelector.tsx`, `api.ts` (`resolvedPattern`).
- **Acceptance:** forcing `spec-build-verify` gates SPEC to read-only; the judge
  logs a `continue` then `advance` with reasons; classifier resolves a pattern
  per turn.

### W4 — A/B comparison harness + scoreboard/history (CLI + in-studio)
- **Deliverable:** a comparison runner that sweeps an `EvalRunConfig` matrix
  across tasks/models/patterns/toolsets, persists results, and renders a
  scoreboard; un-stub `evalListHistory`/`evalDeleteRun`; add an in-studio
  "run comparison" + scoreboard view.
- **Files:** new comparison + scoreboard modules (shared, CLI-first); studio
  `useSocket.ts` eval handlers + a comparison/scoreboard panel; storage under
  `~/.ugly-studio/eval-projects/…` + a results dir.
- **Acceptance:** one comparison config runs from CLI and from studio and
  produces the **same** cell values (parity test); scoreboard renders deltas.

### W5 — Eval test content (the designed tests, §5) + parity verification
- **Deliverable:** the new tasks, toggles, and comparison configs for Ep 04 and
  Ep 05; a parity test asserting CLI == in-studio per cell.
- **Acceptance:** every §5 test runs on both surfaces; pro/con deltas reproduce.

---

## 5. The eval test designs (the core ask)

Each test is an **A/B (or A/B/C) comparison** captured as a comparison config,
scored by `gradeProject`, producing an on-camera number **and** a permanent suite
entry. "Pro" tests show the technique winning; "con" tests show its failure mode
on tape (every episode needs a failure beat).

### 5.1 Ep 04 — Python in the Loop

**Model:** default OSS pool cell (e.g. `glm_5_2` and `deepseek_v4_pro`), with a
`claude_sonnet_4_6` reference cell for the scoreboard.

**P-PRO-1 — AST find-callers, turns & cost (the headline pro).**
Config A `toolset:'no-python'` vs config B `toolset:'default'` on
`breaking-change-find-callers` (and `multi-file-refactor-ordered` if present).
- Metric: turn count and token cost to enumerate all call sites. Expected: A =
  N turns of grep/read; B = ~1 turn via a tree-sitter/libcst AST walk. Target
  60–80% cost reduction on AST-heavy tasks, **same grader score**.
- Gate: existing `tsc`+`vitest` (correctness held constant); the delta is
  turns/cost, surfaced in the comparison scoreboard's `$` and turn columns.

**P-PRO-2 — Stateful `recursive_llm` solves the otherwise-unsolvable.**
New task `python-recursive-decode` (small, self-contained fixture): decode a
binary/obfuscated protocol where a single flat turn stalls, but a stateful
Python session that calls `recursive_llm()` on sub-problems + `final()` converges.
- Config A `flags:{stateful:false}` (one-shot only) vs B `flags:{stateful:true}`.
- Metric: pass/fail. Expected: A fails, B passes. This is the "it now solves
  problems I cannot" beat.

**P-CON-1 — Recursive runaway (failure beat).**
Config with the recursion cap disabled on `python-recursive-decode` (or a
purpose-built `python-runaway` fixture): `recursive_llm` fans out unbounded.
- Metric: capture the runaway on tape; then show the cap firing (cost/turn
  ceiling) as the fix. Gate: budget `maxCostUsd`/`maxTurns` trip.

**P-CON-2 — Tempfile leak meter (failure beat).**
A task whose Python writes temp artifacts without cleanup; the leak meter reports
a non-zero count. Show the meter, then the cleanup fix zeroing it.

**P-CON-3 — Guard-mode catch (safety surface).**
Force a read-only step (SPEC, via W3) and have a weak model attempt a forbidden
`python_exec` write. Capture the **verbatim** guard block error. This doubles as
an Ep 05 governance beat — a nice cross-episode callback.

### 5.2 Ep 05 — The Rules and the Judge

**J0/J1/J2 sweep** on a task known to trigger SPEC-mutation (weak models edit
before specifying). Candidate: `multi-file-refactor-ordered` (per EP05 guide).

**R-PRO-1 — SBV governance prevents SPEC-mutation.**
Config A `pattern:null` (flat loop) vs B `pattern:'spec-build-verify'`.
- Metric: count source mutations during the SPEC phase. Expected: A mutates
  files mid-SPEC (the un-governed cold open); B's read-only gate blocks it.
- Gate: a `custom:spec-readonly` checker counts writes before the SPEC→BUILD
  advance.

**R-PRO-2 — The judge catches drift (continue vs advance).**
With `pattern:'spec-build-verify'` + judge enabled, capture a `verdict=continue`
(with reason) when `advanceCriteria` isn't met, then a `verdict=advance`.
Verbatim judge text on tape. Con-side: the "5 critiques in 138 seconds" dedup
failure — config `flags:{judgeDedup:false}` reproduces the flood; `true` fixes it.

**R-CON-1 — Pattern shape doesn't fix capability gaps (the honest finale beat).**
The §17.14.3 A/B: forced `pattern:'spec-build-verify'` vs classifier-resolved
`pattern:'investigate-fix'` on the ansible task
(`sbpro-ansible-ansible-39bd8b99`). Expected: **identical grader score** (e.g.
2/5) on both. The point of the episode — rules + judge are necessary but not
sufficient. Two comparison cells, same score, side by side.

### 5.3 Coverage summary

| Test | Type | A vs B toggle | Metric | Task |
|---|---|---|---|---|
| P-PRO-1 | Python pro | `no-python` vs `default` | turns, cost | breaking-change-find-callers |
| P-PRO-2 | Python pro | stateful off vs on | pass/fail | python-recursive-decode (new) |
| P-CON-1 | Python con | recursion cap off/on | runaway captured | python-recursive-decode / python-runaway (new) |
| P-CON-2 | Python con | leak meter | leak count | python-tempfile-leak (new) |
| P-CON-3 | Python con / Ep05 tie-in | guard on read-only step | verbatim block error | any SBV task |
| R-PRO-1 | Rules pro | flat vs SBV | SPEC-phase mutations | multi-file-refactor-ordered |
| R-PRO-2 | Judge pro/con | judgeDedup off/on | verdicts / flood | multi-file-refactor-ordered |
| R-CON-1 | Rules con | forced SBV vs classifier investigate-fix | grader score parity | sbpro-ansible-ansible-39bd8b99 |

New fixtures to author: `python-recursive-decode`, `python-runaway` (or reuse
the former with a cap toggle), `python-tempfile-leak`. New graders:
`custom:spec-readonly` (SPEC-phase write counter), `custom:leak-count`.

---

## 6. Run-surface parity (verification of the user's ask)

The deliverable proving "runs via CLI and inside the studio":

- **CLI:** `ugly-code evals run <task> [--model …] [--pattern …] [--toolset …]`
  and `ugly-code evals compare <config.json>` → prints per-cell scores + writes a
  scoreboard.
- **In-studio:** the same task/config launchable from `EvalPickerModal` (single)
  and a new comparison/scoreboard panel (matrix), over the UglyNative bridge.
- **Parity test (W5):** a fixed comparison config runs on both surfaces in CI;
  assert identical `score/scoreMax` per cell (allowing for model
  non-determinism by using the simulated provider or a fixed-seed cell for the
  deterministic gates). This is the concrete artifact that *verifies* both paths
  work, not just that they exist.

---

## 7. Sequencing

1. **W0** shared binaries in `~/.ugly-bot/binaries/` (unblocks CLI Python).
2. **W1** headless CLI driver over the existing task bundle + auth flow, and
   **W1b** filesystem session store (unblocks all CLI runs; W1b can land with or
   just after W1).
3. **W2** `python_exec` port and **W3** pattern/judge port — parallelizable.
4. **W4** comparison/scoreboard + in-studio parity.
5. **W5** author the §5 tests + parity verification, capture footage.

Milestone gate after W1: a single existing task runs green from the CLI. After
W4: one comparison config runs identically CLI vs studio. After W5: all eight
§5 tests reproduce their pro/con deltas on both surfaces.

---

## 8. Risks & open questions

- **Scope.** W0–W5 is a large port. If it must be staged for the episode
  calendar, W2 (Python) + W1 + W0 unblock Ep 04 alone; Ep 05 needs W3. The
  comparison/scoreboard (W4) is shared by both but a thin CLI scoreboard can ship
  before the in-studio panel.
- **Model non-determinism** complicates strict CLI==studio parity; the parity
  test should lean on deterministic gates and/or the simulated provider for the
  asserted cell, with real-model cells treated as footage, not CI assertions.
- **Stale in-process harness import** (`ugly-studio/tests/parity/harness.ts` →
  `server/coding-agent/index`) — confirm the entrypoint's new home before relying
  on it.
- **Binaries security/size** — on-demand download needs checksums + a trusted
  source; decide host (bundle vs fetch) and offline behavior.
- **Judge model/cost** — the mid-step judge adds per-turn LLM calls; budget it and
  make it toggleable (needed anyway for R-PRO-2's dedup A/B).
- **`week-N` scoreboard numbering** in the episode guides now tracks the new
  episode numbers; confirm that matches the actual `studio/evals/scoreboard/`
  scheme when those files get generated.

---

## 9. Not doing (YAGNI)

- No rewrite of the 59 existing tasks (schema extension is additive/optional).
- No mass-rename of `visuals/ep02-5.*` assets (cosmetic; PNGs reference them).
- No Max/Group/Super-spec parallelism work here (that's Ep 06 / a separate spec).
- No new UI beyond the comparison/scoreboard panel required for parity.
