# Coding-Agent Restoration to Monolith Parity — Design

**Status:** approved design, pre-plan
**Date:** 2026-07-02
**Author:** brainstormed with the user

## Goal

Restore ugly-code's client-side coding agent to **full parity with the deleted
ugly-studio monolith**: the complete original tool set, the original system
instruction verbatim, every tool covered by tests, and a real coding-session
end-to-end test proving the agent actually uses the tools in the deployed
Studio.

When the monolith's coding backend was deleted (ugly-studio `f5a74c2`, "delete
the coding backend") and the agent was re-homed client-side in ugly-code, the
toolset was cut to a 9-tool minimal core. This program brings the rest back.

## Guiding principle

Each tool is **ported from `f5a74c2^:server/coding-agent/tools/<tool>.ts`**,
adapting server-side Node (`fs` / `child_process` / `url`) → the browser-safe
UglyNative facade (`native.fs` / `native.process`) — the exact pattern proven in
the 2026-07-02 LSP restoration (see `plans/2026-07-02-lsp-restoration.md`). The
monolith source is the behavioral source-of-truth; the implementation plan
recovers each tool's exact schema/description from it.

## Current state (the delta)

**Present in ugly-code today (9):** `list_dir`, `read_file`, `write_file`,
`edit_file`, `run_command` (= monolith `bash`), `codebase_search`
(= semantic search), `db_query`, `db_get`, `db_set`.

Tools live in:
- `shared/agent.ts` — `AGENT_TOOL_NAMES`, `AGENT_TOOLS` (JSON-schema specs sent
  to the model), `AGENT_BINARIES` (spawn allowlist), `AGENT_SYSTEM_PROMPT`.
- `client/agent/tools.ts` — `dispatchTool(name, input, ctx)`, running
  client-side over `native.*`. `ctx` carries the workspace/project path + sandbox.
- `client/studio/agent/clientAgent.ts` — the agent loop; injects `systemPrompt`,
  `tools`, `toolHandlers`.
- `client/studio/agent/lsp/registry.ts` — `getEditorLspClient(root, lang)`,
  `languageIdForPath` (restored in the LSP work; reused by grep/lsp_diagnostics).

**Monolith exposed tools NOT yet restored (~27)** — the scope of this program.

## Architecture

- **Adaptation pattern:** server `fs.readFileSync`→`await native.fs.readFile`;
  `child_process.spawn`→`native.process.spawn`; `url` file:// helpers hand-rolled;
  no Node builtins in client code. Tools run in the agent task context, which has
  its own `native` + its own LSP registry instance (separate from the editor's) —
  designed for that.
- **LSP access:** tools import `getEditorLspClient` / `languageIdForPath` from
  `client/studio/agent/lsp/registry` (the tools file already imports from
  `client/studio/`). TypeScript-only for v1 (Python LSP deferred, matching the
  LSP restoration).
- **Dynamic tool catalog:** `tool_request` / `tool_search` require the model's
  active tool catalog to be **dynamic per session** rather than a fixed
  `AGENT_TOOLS` array. Design: a full registry of tool specs + a per-session
  *active set*; `tool_search` queries the registry, `tool_request` activates a
  tool into the session's set. This is a prerequisite for B6 and is built in that
  batch.
- **Subagents:** `delegate` / `delegate_parallel` / `agent` run a **nested agent
  loop** (`runAgent`) with a scoped task + a reduced tool set, returning the
  sub-run's final result. `blackboard_post` writes to a per-session shared store
  the delegates read. Built in B5.

## Tool inventory (batches)

Each tool below: **[monolith source]** — purpose — client adaptation — interface
sketch — test focus. Exact schema recovered from the monolith during planning.

### B1 — Search / navigation
- **`grep`** [`tools/grep.ts`] — regex search + LSP modes + auto-supplement.
  Adapt: exact pass spawns `rg` (already in `AGENT_BINARIES`) via `native.process`;
  LSP modes via `getEditorLspClient` → `workspaceSymbol` → `findDefinition/
  References/Implementations`. Input (trimmed): `pattern`, `path?`, `include?`,
  `literal_text?`, `caseInsensitive?`, `include_ignored?`,
  `mode?(auto|exact|lsp-defs|lsp-refs|lsp-impls)`,
  `output_mode?(content|files_with_matches|count)`, `head_limit?`, `before_lines?`,
  `after_lines?`. **Dropped:** `semantic` (covered by `codebase_search`), `.specs`
  virtual path (monolith-only). Auto-supplement: bare-identifier `auto` greps run
  regex + `workspaceSymbol` in parallel and append an `LSP DEFINITIONS` section
  when LSP is ready (bounded wait; silent degrade). Tests: arg→`rg`-flags mapping;
  `runLspMode`/supplement formatting vs a mocked LSP client; real-server e2e.
- **`glob`** [`tools/glob.ts`] — file-name-pattern finding. Adapt: `rg --files -g
  <pattern>` via `native.process`. Input: `pattern`, `path?`, `include_ignored?`.
  Tests: glob matching, ignored-dir handling.
- **`lsp_diagnostics`** [new; monolith surfaced diagnostics via grep] — project/
  file diagnostics. Adapt: `getEditorLspClient` → `ensureProjectLoaded` →
  `getDiagnostics(path)` / `getAllDiagnostics()` / `formatSummary()`. Input:
  `path?`. Tests: mocked-LSP diagnostics formatting; ready/not-ready states.

### B2 — Editing / exec
- **`multiedit`** [`tools/multiedit.ts`] — apply a sequence of old→new edits to
  one file atomically. Adapt: `native.fs` read → apply in memory → write; abort
  whole set if any edit's `old` not found. Input: `path`, `edits:[{old_string,
  new_string, replace_all?}]`. Tests: sequential apply, not-found atomicity,
  replace_all.
- **`python_exec`** [`tools/python-exec.ts`] — run a Python snippet. Adapt:
  `native.process.spawn('python'|'uv', …)` (both allowlisted). Input: `code`,
  `timeout?`. Tests: stdout/stderr/exit capture, timeout.
- **`python_libraries`** [`tools/python-libraries.ts`] — list/inspect installed
  Python libraries in the project env. Adapt: `uv pip list` / `python -m pip list`
  via `native.process`. Input: `filter?`. Tests: parse + filter installed list.
- **`dev_server_logs`** [`tools/dev-server-logs`] — tail the project's dev-server
  output. Adapt (ugly-code-specific): read the studio dev-server task's log stream
  (`native.task`) or its log file. Input: `lines?`, `filter?`. Tests: mocked log
  source.

### B3 — Web / deps
- **`web_search`** [`tools/web_search.ts`] — web search. Adapt: route via the
  ugly.bot proxy (`native.uglybot`) or the platform search endpoint. Input:
  `query`, `count?`. Tests: mocked provider.
- **`web_fetch`** [`tools/web-fetch.ts`] — fetch a URL → readable text/markdown.
  Adapt: `native.browse` extraction (or fetch + readability). Input: `url`,
  `mode?`. Tests: mocked fetch/extract.
- **`download`** [`tools/download.ts`] — download a URL into the workspace. Adapt:
  fetch bytes → `native.fs.writeFileBytes`. Input: `url`, `path`. Tests: mocked
  fetch → file written.
- **`dep_docs`** [`tools/dep-docs.ts`] — fetch a dependency's docs/README. Adapt:
  resolve from `node_modules` via `native.fs`, else registry fetch. Input:
  `package`, `symbol?`. Tests: local-first resolution, fallback.

### B4 — Planning / memory
- **`todos`** [`tools/todos.ts`] — the plan-first task list the system prompt
  mandates. Adapt: persist per session + surface on the existing studio chat-header
  todos indicator (emit a studio event). Input: `todos:[{content, status,
  activeForm?}]`. Tests: state transitions, header surfacing.
- **`scratchpad`** [`tools/scratchpad.ts`] — durable agent scratch notes across a
  session. Adapt: per-session store (`native.fs` under the project's studio dir).
  Input: `action(append|read|clear)`, `content?`. Tests: CRUD.
- **`memory_save` / `memory_read` / `memory_list` / `memory_delete`**
  [`tools/memory-*.ts`] — persistent cross-session project memory. Adapt: JSON
  files under a per-project memory dir via `native.fs`. Input per op. Tests: CRUD
  + persistence across "sessions".
- **`ask_user`** [`tools/ask_user.ts`] — pause the turn to ask the user (genuine
  fork only, per the prompt). Adapt: emit a studio event + await the user's reply
  through the chat input. Input: `question`, `options?`. Tests: mocked reply
  round-trip.

### B5 — Orchestration (subagents)
- **`delegate`** [`tools/delegate.ts`] — run a scoped subtask in a nested agent
  loop. Adapt: recursive `runAgent` with a reduced tool set + isolated context;
  return the sub-run's result. Input: `task`, `context?`, `tools?`. Tests: mocked
  nested loop returns/propagates.
- **`delegate_parallel`** [`tools/delegate-parallel.ts`] — N delegates
  concurrently. Adapt: `Promise.all` of nested loops. Input: `tasks:[…]`. Tests:
  concurrency + aggregation.
- **`agent`** [`tools/agent.ts`] — spawn a named/role sub-agent. Adapt: nested
  loop with a role prompt. Input: `role`, `task`. Tests: role wiring.
- **`blackboard_post`** [`tools/blackboard.ts`] — shared coordination note read by
  delegates. Adapt: per-session shared store. Input: `message`, `tag?`. Tests:
  post → delegate reads.

### B6 — Dynamic catalog / specs / media
- **`tool_search`** [`tools/tool-search.ts`] — search the full tool registry by
  intent. Adapt: query the static registry catalog. Input: `query`. Tests: ranking.
- **`tool_request`** [`tools/tool-request.ts`] — activate a tool into the session's
  active set. Adapt: mutate the per-session active-tools set (dynamic catalog).
  Input: `name`, `purpose`. Tests: activation reflected in the next turn's catalog.
- **`spec_read`** [`tools/spec-tools.ts` + `spec-vfs.ts`] — read specs from
  ugly.bot (the `.specs` virtual path). Adapt: fetch via the ugly.bot API. Input:
  `id?`/`path?`. Tests: mocked spec fetch + listing.
- **`analyze_image`** [`tools/analyze-image.ts`] — vision analysis of an image.
  Adapt: route to a vision model via the ugly.bot proxy (`native.uglybot`). Input:
  `path`/`url`, `prompt?`. Tests: mocked vision response.
- **`inspect_ux`** [`tools/inspect-ux.ts`] — run `window.__uglyInspect` UX probe.
  Adapt: reuse ugly-code's existing `verify-ux` machinery, exposed as an agent
  tool. Input: `url_path?`, `device?`, `actions?`. Tests: mocked inspect report.

## System instruction

**Final state = the monolith `f5a74c2^:server/coding-agent/llm/system-prompt.txt`
verbatim** (125 lines: `<critical_rules>` — plan-first via `todos`, edit-boldly,
autonomy/blockers, tool-catalog constraints incl. `tool_search`/`tool_request`,
etc.). It replaces the current 9-line `AGENT_SYSTEM_PROMPT`.

Because the prompt references tools by name, it is **gated during the build**:
each batch adds back the prompt sections for the tools it restores, so the agent
never sees guidance for a tool that doesn't exist yet. The **last batch lands the
verbatim monolith prompt** (all referenced tools now exist). Any monolith
prompt-builder variants (`prompt-variants.ts`, `system-prompt.ts`) are folded in
as needed. A **prompt-parity test** (ported from the monolith
`system-prompt-parts.test.ts`) asserts the final assembled prompt equals the
monolith original.

## Test plan

Per the user's emphasis — every tool is verified, and the whole is proven usable.

1. **Per-tool unit tests** (`tests/unit/<tool>.test.ts`): each tool gets a spec
   exercising success, error, and edge cases through `dispatchTool` over the
   in-memory `uglyNativeMock` (`tests/helpers/uglyNativeMock`). Specifics per tool
   listed in the inventory above (e.g. grep arg→`rg`-flags mapping; multiedit
   atomicity; memory CRUD; delegate nested-loop propagation; tool_request catalog
   mutation).
2. **Real-subprocess e2e** where a mock can't prove it: grep's LSP modes drive a
   **real `typescript-language-server`** via the `createNodeUglyNative` pattern
   (from the LSP restoration) — `grep(mode:'lsp-defs','foo')` resolves to `a.ts`
   on a fixture. Similarly `python_exec` against a real interpreter (skip-if-absent).
3. **Prompt-parity test:** assert the assembled system prompt === the monolith
   `system-prompt.txt`.
4. **Final coding-session e2e:** deploy ugly-code, then drive the **real deployed
   Studio agent** (the Electron-harness Playwright pattern used to verify LSP) on a
   fixture repo through a real multi-step task, and assert the agent actually
   *calls* the restored tools (`todos` first, then `grep`/`glob`/`read`/`edit`/
   `lsp_diagnostics`, …) and completes — proving real usability, not just unit
   correctness.

Every batch ships with its tools' unit tests green before the next batch starts.

## Phasing

One spec, executed as a multi-phase plan:

**B1 (search/nav) → B2 (edit/exec) → B3 (web/deps) → B4 (planning/memory) →
B5 (orchestration) → B6 (dynamic/specs/media) → prompt-parity → coding-session
e2e.**

Rationale: B1–B4 are the high-value workhorses and are mostly clean ports; B5–B6
introduce the two architectural pieces (subagent recursion, dynamic catalog) and
land last before the prompt reaches verbatim parity and the e2e proves it.

## Risks & open questions

- **Dynamic catalog (B6)** is a real architectural change to how `tools` are sent
  per turn; it must not regress the fixed-catalog path B1–B5 rely on.
- **Subagent recursion (B5)** must bound depth/turns to avoid runaway loops +
  token blowups; reuse the loop's existing budget controls.
- **Platform-routed tools** (`web_search`, `analyze_image`, `spec_read`,
  `dep_docs`) depend on ugly.bot endpoints being reachable from the agent task
  context; confirm each during its batch.
- **`dev_server_logs` / `inspect_ux`** are ugly-code-studio-specific rather than
  literal monolith ports — they wire to studio's dev-server task / `verify-ux`.
- **Model behavior:** restoring the plan-first prompt changes agent behavior
  (todos-first); the coding-session e2e is the guard that the new prompt + tools
  actually cohere.

## Out of scope (separate specs)

- **SP-A — CodeMirror file-view editor + LSP navigation** (editing/save, hover,
  go-to-definition, find-references). A separate user-facing spec; tracked, not
  part of this agent-tool program.
