# Coding-Agent Tool Catalog

**Source of truth:** the ugly-studio monolith coding agent at commit `f5a74c2^`
(`server/coding-agent/tools/*`), the parent of the commit that deleted the
coding backend. This file documents the **authoritative** tool set — every
registered tool, exactly when it is enabled, its input schema, its output
shape, and its model-facing description. ugly-code's client-side agent is a
port of this set; where the current port diverges, see
[Current ugly-code divergences](#current-ugly-code-divergences) at the bottom.

> Every tool file defines a runtime **zod `schema`** (the internal validator)
> but takes its **model-facing description + parameters** from a shared JSON
> catalog (`tool-specs.json`) via `getToolSpec(name)`. The catalog also injects
> a universal `reason: string` parameter into every tool's model-facing schema
> **except `bash` and `ask_user`** (`REASON_INJECTION_SKIP`). The `reason`
> param is model-facing only — it is not part of the zod validation and is
> omitted from the input schemas below.

---

## Path handling (convention for all file tools)

**Return paths are relative.** Any `file_path` a tool emits (in output text,
echoes, or `metadata.path` for display) must be **relative to the project root**
— or, when the session runs inside a git worktree, relative to the **worktree
root**. This keeps output stable and drop-in-ready for the next `read`/`edit`
call. (The monolith already does this for `glob` results and via
`formatPathForEcho`; the ugly-code port must match it for every file tool.)

**Accepted input paths.** Every path-taking tool (`read`, `write`, `edit`,
`multiedit`, `glob`, `grep`, `bash working_dir`, …) must resolve all of:
- **Project-relative** — `src/foo.ts` → resolved against the project root.
- **Worktree-relative** — same, but against the worktree root when running in a
  worktree (worktree root takes precedence over the main repo root).
- **Absolute** — `/file/foo`.
- **Home-expanded** — `~/foo` → the user's home directory.
- **Parent-relative** — `../foo` (and any `.`/`..` segments) → normalized
  against the resolution base.

Resolution base = worktree root if in a worktree, else project root. After
resolving to an absolute path for the filesystem op, relativize back to that
base for anything returned to the model.

---

## How gating works

A session's available tools are the intersection of two things:

1. **A mode allow-list ceiling** — computed from the session's model mode:
   - **Single mode** (default interactive coding): `getSingleModeTools(cwd)`
   - **Group mode** (multi-model blackboard): `getGroupModeTools(cwd)`
   Both start from `COMMON_TOOLS` and append `UGLY_APP_TOOLS` **only when
   `isUglyAppProject(cwd)`** is true (a `.uglyapp` marker file exists, or
   `package.json` declares `ugly-app` in deps/devDeps).
2. **Per-tool registration floor** — feature gates applied in
   `buildTurnRegistry`. A tool must be both registered (floor) and within the
   mode ceiling to appear.

`isUglyAppProject(cwd)` gates most project tools; `database`/`database_sql_query`
use a distinct `hasUglyAppProject` check (resolves the project root / worktree
main repo rather than just `cwd`).

### Tiers at a glance

| Tier | Tools | Enabled when |
|---|---|---|
| **COMMON** | `bash`, `read`, `write`, `edit`, `multiedit`, `glob`, `grep`, `todos`, `python_exec`, `web_fetch` | Always — every session, both modes |
| **Single-mode** | `spec_read`, `spec_write`, `scratchpad`, `memory_read`, `memory_save`, `memory_list`, `memory_delete`, `delegate`, `delegate_parallel`, `ask_user`, `web_search`, `analyze_image`, `dep_docs`, `python_libraries`, `tool_search`, `tool_request` | Single mode only (each also subject to its feature gate below) |
| **Group-mode** | `blackboard_post` | Group mode only (`modelMode.kind === 'group'`) |
| **Ugly-app project** | `database`, `database_sql_query`, `dev_server_start`, `dev_server_stop`, `dev_server_logs`, `dev_server_errors`, `dev_server_screenshot`, `inspect_ux` | Only when the open project is an ugly-app project |
| **Retired** | `agent`, `download`, `codebase_search` | Never — in-tree but unregistered (see [Retired tools](#retired--unregistered-tools)) |

### Feature gates (registration floor)

| Tool(s) | Gate |
|---|---|
| `spec_read`, `spec_write` | `features.specs.enabled` |
| `memory_read`, `memory_list` | `features.memory.read` |
| `memory_save`, `memory_delete` | `features.memory.write` |
| `delegate`, `delegate_parallel` | `features.multiAgent.enabled` — **defaults OFF** |
| `blackboard_post` | `modelMode.kind === 'group'` |
| `ask_user` | **not** `isNonInteractive()` (off in eval / non-interactive) |
| `dev_server_start/stop/logs/errors` | `isUglyAppProject(cwd)` |
| `dev_server_screenshot` | `isUglyAppProject(cwd)` **and** vision-capable model |
| `inspect_ux` | `isUglyAppProject(cwd)` |
| `database`, `database_sql_query` | `hasUglyAppProject` (resolved project root) |
| `python_exec`, `python_libraries` | Always registered (recursive-LM always-on since 2026-04-25) |
| `multiedit` | Registered unless `UGLY_STUDIO_DISABLE_MULTIEDIT=1` (eval ablation) |

> The stub machinery (`stub.ts` / `stubbedToolNames()`) exists but is **dormant**:
> every catalog entry has a real implementation, so it registers zero stubs.

---

## COMMON tools

Always enabled, in every session, in both modes.

### `read`
**When enabled:** always.
**Input:**
- `file_path` *(string, required)*
- `offset` *(number, optional, 0-based)*
- `limit` *(number, optional, default 2000)*

**Output:** file body wrapped in `<file path="...">…</file>`, every line
annotated as `<lineNumber>:<hash>|<content>` — line number right-padded to 6
chars, `<hash>` a stable 2-hex-char per-line content hash. Appends
`[truncated: N more lines]` when paging cuts off, a "Did you mean:" list on
ENOENT (basename matches, max 8), and a related-tests hint for source files.
Renders images (PNG/JPEG/GIF/BMP/SVG/WebP); max 5MB; lines >2000 chars truncated.

**Description:** Read a file and return its contents annotated as
`<line>:<hash>|<content>`. The core file-reading tool — use it before editing
any file. The `<hash>` is a stable per-line anchor: pass it back to `edit` (as
`anchor`, `insert_after`, or `range`) for line-targeted edits that survive
whitespace drift. Same hash means same content, so re-reads of an unchanged file
are byte-identical and prompt-cache cleanly. `offset` (0-based) + `limit`
(default 2000) page through large files. For directory listings use `glob`; for
content search use `grep`.

### `write`
**When enabled:** always.
**Input:**
- `file_path` *(string, required)*
- `content` *(string, required)*

**Output:** `mutating`. Creates parent dirs, writes `content` verbatim, echoes a
hashline-annotated context head window + a `N bytes, M lines written` note. A
`<warning>` is appended on zero-byte writes. Refuses during a read-only step
unless the path is a scratch path. Skips byte-identical no-op writes.

**Description:** Create a new file, or overwrite an existing one, with the EXACT
content you pass — the whole final file body as one string, never a stub or TODO
marker. Parent dirs are created automatically. Use `edit`/`multiedit` for
surgical changes, `bash mv` for renames. Appending is not supported (write
always replaces the whole file). For an existing file you must have `read` it
earlier (external-modification safety check).

### `edit`
**When enabled:** always.
**Input:** `file_path` *(string, required)* plus **exactly one** mode discriminator:
- **String-match:** `old_string` *(string)* + `new_string` *(string)* (+ `replace_all` *(bool)*)
- **Replace one line:** `anchor` *(string|number)* + `new_content` *(string)*
- **Insert:** `insert_after` *(string|number)* + `new_content` *(string)*
- **Replace/delete a span:** `range` *(string)* (+ optional `new_content`; omit to delete)

**Output:** `mutating`. Emits `<result>` + a hashline context window;
`metadata.mode` is one of `string` / `replace_line` / `insert_after` /
`replace_range` / `delete_range`. String-match requires a unique match unless
`replace_all`; near-miss diagnostics on failure. Anchor forms accept
`"<line>:<hash>"` (hash verified at apply time), a bare line number (no hash
check), or sentinels `start`/`top`/`0` and `end`/`bottom`. On hash mismatch the
tool returns the current anchor + line so the model can re-align.

**Description:** Modify an EXISTING file. Pass exactly ONE of `old_string`,
`anchor`, `insert_after`, or `range` — the field you set picks the mode. Prefer
`"<line>:<hash>"` anchors copied from `read` output; the hash is verified and a
mismatch returns the current content so you can re-align without guessing. For a
NEW file use `write`; for renames use `bash mv`. For many edits to one file,
prefer `multiedit`. (This tool is the unified successor to a former
`edit` + `edit_hashline` split.)

### `multiedit`
**When enabled:** always (unless `UGLY_STUDIO_DISABLE_MULTIEDIT=1`).
**Input:**
- `file_path` *(string, required)*
- `edits` *(array, min 1)* — each entry has the **same four-mode shape as `edit`** (exactly one of `old_string`/`anchor`/`insert_after`/`range`)

**Output:** `mutating`, **atomic**. Applies edits sequentially against one
in-memory buffer, writes back once. The first failing entry aborts the whole
batch (file unchanged); error names the failing index (`Edit #N: …`),
`metadata: { failed_index, total_edits }`. Anchors verify against buffer state
at the time each edit runs (after prior entries applied). Output shows a context
window for the first edit's region.

**Description:** Apply a sequence of edits to a single file atomically. Each
entry uses the same shape as `edit`. Edits run in order; each operates on the
result of the prior — plan so later anchors/old_strings still match after
earlier edits. If any edit fails, the whole batch rolls back.

### `glob`
**When enabled:** always.
**Input:**
- `pattern` *(string, required)*
- `path` *(string, optional, defaults to cwd)*
- `include_ignored` *(boolean, optional, default false)*

**Output:** paths relative to cwd, sorted by mtime descending (alpha tiebreak),
capped at 500. `.gitignore` respected by default (auto-disabled when `path`
scopes into an ignored dir). Empty result returns literal `No matches found`.

**Description:** Find files by name/path pattern. Use when you know (part of) the
filename; for file *contents* use `grep`. Standard glob syntax (`*`, `**`, `?`,
`[...]`) plus brace expansion `{a,b}` — e.g. `src/**/*.{ts,tsx}`. Bare filename
patterns match at any depth. Returns paths relative to cwd, ready to drop into
the next `read`/`edit`.

### `grep`
**When enabled:** always.
**Input:**
- `pattern` *(string, required)* — regex, or a **symbol name** when `mode` is `lsp-*`
- `path` *(string, optional)* — scope dir
- `include` *(string, optional)* — glob filter
- `literal_text` *(boolean, optional)* — escape regex, match literally
- `caseInsensitive` *(boolean, optional)*
- `include_ignored` *(boolean, optional)* — search `.gitignore`-d files
- `mode` *(enum, optional)* — `auto` | `exact` | `semantic` | `lsp-impls` | `lsp-refs` | `lsp-defs`
- `output_mode` *(enum, optional)* — `content` | `files_with_matches` | `count`
- `head_limit` *(int 1–200, optional)* — cap exact-pass hits
- `before_lines` / `after_lines` *(int 0–50, optional)* — context lines (content mode)
- `limit` *(int 1–50, optional)* — caps the **semantic** pass

**Output:** for `content`, `<path>:<line>:<col>`-style hits with optional
context; for `files_with_matches`/`count`, the corresponding summaries. In
`auto`/identifier searches it appends `LSP DEFINITIONS` + `LSP REFERENCES`
sections (blocks up to 30s on LSP readiness) and a `RELATED TESTS` section for
top hits.

**Description:** The merged search tool — regex, semantic, and LSP in one.
- **`exact`** — ripgrep regex.
- **`semantic`** — embedding-based search over the codebase index (Python
  sidecar indexer, scored chunks, incremental re-index, worktree overlay DB).
  Gated behind `UGLY_STUDIO_DISABLE_SEMANTIC_GREP=1` (eval ablation → collapses
  to `exact`).
- **`auto`** — runs both exact and semantic (or extracts identifier tokens),
  and auto-appends an LSP definitions/references supplement for bare-identifier
  patterns.
- **`lsp-defs` / `lsp-refs` / `lsp-impls`** — `pattern` is a symbol name;
  resolves via `workspaceSymbol` then definitions / references / implementations.

`semantic` search absorbed the old `codebase_search` tool (removed 2026-04-21).

### `bash`
**When enabled:** always.
**Input:**
- `command` *(string, required)*
- `description` *(string, required in the model-facing spec)* — `bash` skips `reason`; `description` serves that role
- `working_dir` *(string, optional)*
- `timeout_ms` *(number, optional, default 120000)*
- `filter` *(string, optional)* — a shell pipeline applied to the model-facing output only

**Output:** `mutating` (blocked in plan mode). Runs via POSIX `sh -c` (or
`cmd.exe /c` on Windows); interleaved stdout+stderr, 200KB cap. Sealed env
(bundled-only PATH, `CI=true`, session-reserved `PORT`). GUI tooling
(playwright/chromium/etc.) bypasses the sandbox wrapper. Appends
new-image-artifact hints from `test-results/` / `playwright-report/`.

**Description:** Execute a shell command via POSIX sh, 2-minute default timeout.
**Avoid** using it for `find`/`grep`/`cat`/`head`/`tail`/`sed`/`awk`/`echo` —
use the dedicated tool (`glob`, `grep`, `read`, `edit`/`multiedit`, `write`, or
plain text output). Bash is for tests, lint/typecheck, one-line verifications,
and long-running processes. **Do NOT** use bash for git — the harness manages
commits/branches/pushes. State does not persist between calls (don't `cd`). Use
bundled `pnpm` for node projects.

### `todos`
**When enabled:** always.
**Input:**
- `todos` *(array, required)* — each item `{ content: string, status: 'pending'|'in_progress'|'completed', active_form: string, success_criteria?: { description?, command?, file_contains?, file_not_contains? } }`

**Output:** `mutating` session state (replaces the full list each call). Optional
`success_criteria` feeds judge grading; an auto-delegation path can spawn
sub-agents for newly `in_progress` execution items on strong-tier `auto` models.

**Description:** Track and surface the task plan. Replace the whole list each
call. Plan first, keep exactly one item `in_progress`, mark items `completed` as
you finish.

### `python_exec`
**When enabled:** always (recursive-LM always-on).
**Input:**
- `code` *(string, required)*
- `timeout_ms` *(number, optional)*
- `stdin` *(string, optional)*

**Output:** captured stdout/stderr from executing `code` in the bundled Python.

**Description:** Execute Python code — for computation, data wrangling, and
scripted checks that don't belong in the shell.

### `web_fetch`
**When enabled:** always.
**Input:**
- `url` *(string, required)*
- `prompt` *(string, optional)* — when set, agentic summarize mode
- `format` *(string, optional)*
- `timeout` / `timeout_ms` *(number, optional)*

**Output:** raw body (1MB cap), or — when `prompt` is set — a sub-agent summary
(200KB cap). Rolled up the old `agentic_fetch` tool.

**Description:** Fetch a URL. Without `prompt`, returns the raw body; with
`prompt`, a sub-agent reads the page and answers the prompt.

---

## Single-mode tools

Enabled only in single (default interactive) mode, each subject to its feature gate.

### `spec_read`
**When enabled:** single mode **and** `features.specs.enabled`.
**Input:** none (`{}`).
**Output:** the session's spec document (via the spec virtual-FS).
**Description:** Read the current session spec.

### `spec_write`
**When enabled:** single mode **and** `features.specs.enabled`.
**Input:** `content` *(string, required)*.
**Output:** `mutating` — overwrites the session spec.
**Description:** Write/replace the current session spec.

### `scratchpad`
**When enabled:** single mode.
**Input:**
- `operation` *(enum, required)* — `write` | `delete` | `list`
- `key` *(string, optional)*
- `value` *(string, optional)*
- `merge_to_memory` *(boolean, optional)*

**Output:** persistent notes (max 20 entries / 4096 chars) injected into the
system prompt each turn. `merge_to_memory` flags an entry for promotion to agent
memory at session end.

**Description:** A durable scratchpad for notes that persist across turns.

### `memory_read`
**When enabled:** single mode **and** `features.memory.read`.
**Input:** `name` *(string, required)*.
**Output:** the named memory's body.
**Description:** Read a saved agent memory by name.

### `memory_list`
**When enabled:** single mode **and** `features.memory.read`.
**Input:** none (`{}`).
**Output:** the list of saved memories.
**Description:** List saved agent memories.

### `memory_save`
**When enabled:** single mode **and** `features.memory.write`.
**Input:**
- `name` *(string, required)*
- `type` *(enum, optional)* — `architecture` | `convention` | `gotcha` | `todo` | `user` | `note`
- `body` *(string, required)*

**Output:** `mutating` — persists a memory file.
**Description:** Save a durable memory (architecture, convention, gotcha, …).

### `memory_delete`
**When enabled:** single mode **and** `features.memory.write`.
**Input:** `name` *(string, required)*.
**Output:** `mutating` — deletes the named memory.
**Description:** Delete a saved memory by name.

### `delegate`
**When enabled:** single mode **and** `features.multiAgent.enabled` (**defaults OFF**).
**Input:**
- `task` *(string, required)*
- `tools` *(string[], optional)* — restrict the child's toolset
- `max_iterations` *(number, optional)*
- `timeout_ms` *(number, optional)*

**Output:** spawns an isolated sub-agent (`spawnDelegateChild`) with a fresh
history, restricted toolset, recursion depth capped at 2; returns its result.

**Description:** Delegate a self-contained task to a fresh sub-agent. The
canonical sub-agent primitive (superseded the retired `agent` tool).

### `delegate_parallel`
**When enabled:** single mode **and** `features.multiAgent.enabled` (**defaults OFF**).
**Input:**
- `tasks` *(string[], required, 1–5)*
- `tools` *(string[], optional)*
- `max_iterations` *(number, optional)*

**Output:** fans out up to 5 sub-agents concurrently; returns all results.
**Description:** Run up to 5 delegated tasks in parallel.

### `ask_user`
**When enabled:** single mode **and not** `isNonInteractive()` (off in eval).
**Input:**
- `question` *(string, required)*
- `header` *(string, optional)*
- `options` *(array, required, 2–4)* — each `{ label, description }`

**Output:** blocks for a user selection.
**Description:** Ask the user a multiple-choice question when a decision is
genuinely theirs to make.

### `web_search`
**When enabled:** single mode.
**Input:**
- `query` *(string, required, min 1)*
- `limit` *(int 1–20, optional, default 10)*

**Output:** up to 10–20 `{ title, url, snippet }` results (DuckDuckGo HTML
endpoint, redirect-unwrapped).

**Description:** Search the web. Explicitly not for finding canonical bug fixes
to copy from other repos.

### `analyze_image`
**When enabled:** single mode.
**Input:**
- `imageId` *(string, optional)* — exactly one of imageId/path
- `path` *(string, optional)*
- `query` *(string, required)*

**Output:** a vision-model answer about the referenced image.
**Description:** Analyze an image (by id or path) against a query.

### `dep_docs`
**When enabled:** single mode.
**Input:** `package` *(string, optional)*.
**Output:** documentation for the dependency.
**Description:** Fetch documentation for a project dependency.

### `python_libraries`
**When enabled:** single mode (always registered, but only in the single-mode ceiling).
**Input:** `include_examples` *(boolean, optional)*.
**Output:** the available Python libraries (optionally with examples).
**Description:** List the Python libraries available to `python_exec`.

### `tool_search`
**When enabled:** single mode.
**Input:**
- `query` *(string, required)*
- `max_results` *(int 1–20, optional)*

**Output:** ranked catalog entries matching the query.
**Description:** Search the full tool catalog for a capability you need.

### `tool_request`
**When enabled:** single mode.
**Input:**
- `name` *(string, required)*
- `purpose` *(string, required)*
- `example_args` *(unknown, optional)*

**Output:** records a request/wishlist for a tool not currently available.
**Description:** Request a tool by name (a wishlist signal) when you need a
capability the current session doesn't expose.

---

## Group-mode tools

### `blackboard_post`
**When enabled:** group mode only (`modelMode.kind === 'group'`).
**Input:**
- `kind` *(enum, required)* — `spec` | `scratch` | `memory` | `observation` | `claim` | `finding` | `question` | `answer`
- `content` *(string, required)*
- `evidence` *(string, optional)*
- `target` *(string, optional)*
- `answer_to` *(string, optional)*

**Output:** posts a structured entry to the shared multi-model blackboard.
**Description:** Post to the shared blackboard so peer models in the group can
see your observations, claims, findings, and answers.

---

## Ugly-app project tools

Added to the session (single or group) only when the open project is an ugly-app
project. `dev_server_*` and `inspect_ux` gate on `isUglyAppProject(cwd)`;
`database`/`database_sql_query` gate on the resolved `hasUglyAppProject`.

### `dev_server_start`
**When enabled:** ugly-app project.
**Input:** `timeout_ms` *(int 5000–600000, optional)*.
**Output:** starts the project dev server on the session's reserved port.
**Description:** Start the ugly-app dev server for the open project.

### `dev_server_stop`
**When enabled:** ugly-app project.
**Input:** none (`{}`).
**Output:** stops the dev server.
**Description:** Stop the running dev server.

### `dev_server_logs`
**When enabled:** ugly-app project.
**Input:**
- `type` *(enum, optional)* — `console` | `error` | `network`
- `level` *(enum, optional)* — `error` | `warn` | `info` | `debug` | `log`
- `limit` *(number, optional)*
- `since` *(number, optional)*

**Output:** filtered dev-server / browser logs.
**Description:** Read dev-server and in-browser logs (console/error/network).

### `dev_server_errors`
**When enabled:** ugly-app project.
**Input:** none (`{}`).
**Output:** the current dev-server error set.
**Description:** Read the current build/runtime errors from the dev server.

### `dev_server_screenshot`
**When enabled:** ugly-app project **and** a vision-capable model.
**Input:**
- `region` *(object, optional)* — `{ x, y, width, height }`
- `quality` *(enum, optional)* — `full` | `compressed`
- `viewport` *(object, optional)* — `{ width, height }`
- `url_path` *(string, optional)*

**Output:** a screenshot of the running app for the vision model to inspect.
**Description:** Screenshot the running dev server to visually verify UI.

### `inspect_ux`
**When enabled:** ugly-app project.
**Input:**
- `url_path` *(string|null, optional)*
- `device` *(enum, optional)* — `desktop` | `ios` | `android`
- `actions` *(Action[], optional)* — `navigate` | `click` | `focus` | `hover` | `scroll` | `wait` | `simulate_keyboard`
- `settle_ms` *(number, optional)*
- `viewport` *(object, optional)* — `{ width, height }`

**Output:** drives a scripted UX interaction and reports the result.
**Description:** Drive the running app through a scripted interaction sequence to
inspect UX behavior.

### `database`
**When enabled:** ugly-app project (`hasUglyAppProject`).
**Input:**
- `collection` *(string, optional)*
- `filter` *(record, optional)*
- `sort` *(record<1|-1>, optional)*
- `limit` *(int 1–200, optional)*
- `skip` *(int ≥0, optional)*
- `dev_or_prod_mode` *(enum, optional)* — `dev` | `prod` (fetch requires collection + mode)

**Output:** documents from the app's collection store.
**Description:** Query the ugly-app project's collection database (dev or prod).

### `database_sql_query`
**When enabled:** ugly-app project (`hasUglyAppProject`).
**Input:**
- `dev_or_prod_mode` *(enum, required)* — `dev` | `prod`
- `sql` *(string, required)*
- `params` *(unknown[], optional)*
- `row_limit` *(int 1–5000, optional)*

**Output:** result rows from the SQL query.
**Description:** Run a parameterized SQL query against the project's Postgres
(dev or prod).

---

## Retired / unregistered tools

These files exist in-tree at `f5a74c2^` but are **not registered** by any session
builder. Documented so their absence is intentional and recorded.

- **`agent`** (`agent.ts`) — `{ prompt: string, timeout_ms?: number }`, spawns a
  sub-agent via `spawnSubAgent`. **Removed from registration 2026-04-25**:
  "model usage was inconsistent and overlapped with `delegate`. Keep `delegate`
  as the single canonical sub-agent primitive." Still importable but would throw
  (no `tool-specs.json` entry).
- **`download`** (`download.ts`) — `{ url, file_path, timeout? }`. Real impl but
  removed from the catalog; would throw at import (no spec entry).
- **`codebase_search`** (`codebase-search.ts`) — **removed 2026-04-21**, folded
  into `grep`'s `semantic` mode. The file survives only as the
  `runSemanticSearch` helper library that `grep` calls; it exports no tool.

---

## Current ugly-code divergences

The client-side port in this repo (`client/agent/tools/`, `shared/agent.ts`)
diverged from the authoritative set above. This section was the remediation
checklist.

> **Status — resolved in commit `6f0af6c` (2026-07-03).** Rows 1–5, 7, 8, 9 are
> done: names renamed to `read`/`write`/`edit`/`bash`, `codebase_search` folded
> into `grep semantic`, the `agent` tool retired, static gating adopted, tool
> names made type-safe (`ToolName` + `isTool`), path handling fixed.
> **Row 6 done:** `spec_write`, `database`, `database_sql_query`,
> `dev_server_start`, `dev_server_stop`, `dev_server_errors` are added.
> `dev_server_{start,stop}` drive PreviewPanel's dev server via a **control-file
> bridge** (`client/studio/panels/devServerControl.ts`, polled by PreviewPanel) —
> the renderer owns the dev server, so no host channel is needed; `dev_server_errors`
> reads the persisted dev log and filters error lines.
> **`dev_server_screenshot` is intentionally DROPPED** (removed from `ToolName` +
> gating) — ugly-code has no Preview-iframe capture surface, so unlike the
> monolith this tool does not exist here. This is the one deliberate divergence
> from the monolith's registered set.
>
> **Net vs the monolith's registered tools:** ugly-code has all of them EXCEPT
> `dev_server_screenshot` (dropped). The former standalone `lsp_diagnostics` tool
> was merged into `grep` as an `lsp-diagnostics` mode (alongside
> `lsp-defs`/`lsp-refs`/`lsp-impls`). The one remaining non-monolith extra is
> `download` (which the monolith tree had but left unregistered).

| # | Divergence | Monolith (authoritative) | Current ugly-code |
|---|---|---|---|
| 1 | **Core file/shell tool names** | `read`, `write`, `edit`, `bash` | `read_file`, `write_file`, `edit_file`, `run_command` |
| 2 | **`codebase_search` as a tool** | Not a tool — removed 2026-04-21, folded into `grep semantic` | Present as a real semantic tool (UglyNative `codebase.search`), and in `CORE_TOOLS` |
| 3 | **`grep` semantic mode** | `mode` enum includes `semantic` (embedding index) | `mode` enum is `auto/exact/lsp-defs/lsp-refs/lsp-impls` — **`semantic` dropped** |
| 4 | **`agent` tool** | Retired 2026-04-25 (unregistered) | Present and registered (`{ role, task }`) |
| 5 | **Gating model** | Static: COMMON + single/group mode ceiling + project gate + feature gates | Flat 14-tool `CORE_TOOLS` + dynamic `tool_search`/`tool_request` activation catalog |
| 6 | **Missing tools** | `spec_write`, `dev_server_start`, `dev_server_stop`, `dev_server_errors`, `dev_server_screenshot`, `database`, `database_sql_query` all present | Absent (has `dev_server_logs`, `spec_read` only) |
| 7 | **Tools not universally exposed** | `blackboard_post` group-only; `inspect_ux`/`dev_server_*`/`database*` ugly-app-project-only; `delegate*` behind `multiAgent` (default off); `memory_*` behind memory feature | All are flatly activatable in any session via `tool_request` |
| 8 | **System prompt token names** | `read`/`write`/`edit`/`bash` | Prompt uses `read_file`/`write_file`/`edit_file`/`run_command` (internally consistent with the port, not with the monolith) |
| 9 | **Path handling** | Returns project/worktree-relative paths; resolves project-relative, worktree-relative, absolute, `~`, and `../` inputs (see [Path handling](#path-handling-convention-for-all-file-tools)) | Verify/port the same behavior — return relative, resolve base = worktree root if in a worktree else project root |

**Notes for remediation:**
- The `_file`/`_command` core names predate this restoration (they were the
  minimal 9-tool core left when the backend was deleted); the prompt was adapted
  to them, so the port is internally consistent but not monolith-faithful.
- `grep semantic` depends on a Python sidecar embedding index that does not exist
  in the Workers/client deployment — restoring it faithfully requires either an
  UglyNative-backed index or explicitly keeping `codebase_search` as the
  client's semantic surface (a deliberate, documented divergence rather than an
  accidental one).
