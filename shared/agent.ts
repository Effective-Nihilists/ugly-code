// The Ugly Code coding agent — shared contract between client and server.
//
// The agentic loop runs CLIENT-SIDE (in the Ugly Studio desktop browser): the
// client maintains the message history, calls the `agentStep` endpoint to get
// the next assistant turn (with `tool_use` blocks), executes those tools against
// `window.UglyNative` (native.fs / native.process), feeds `tool_result` blocks
// back, and repeats until the model stops requesting tools. The server is a thin
// shim that adds the system prompt + tool specs and forwards to ugly.bot's
// textGen (which is the only place that can return structured tool_use blocks —
// the client `callTextGen` helper only yields text).

import { z } from 'ugly-app/shared';
import type { TextGenTool } from 'ugly-app/shared';

/** A single chat turn on the wire (mirrors ugly.bot textGen's Message). */
export const contentPartSchema = z.union([
  z.object({
    type: z.literal('text'),
    text: z.string().optional(),
  }),
  z.object({
    type: z.literal('tool_use'),
    id: z.string(),
    name: z.string(),
    input: z.unknown(),
  }),
  z.object({
    type: z.literal('tool_result'),
    tool_use_id: z.string(),
    content: z.string(),
  }),
  // Round-tripped reasoning block some gateways require on assistant history.
  z.object({
    type: z.literal('thinking'),
    thinking: z.string().optional(),
    signature: z.string().optional(),
    redacted_data: z.string().optional(),
  }),
]);

export const agentMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.union([z.string(), z.array(contentPartSchema)]),
});

export type AgentContentPart = z.infer<typeof contentPartSchema>;
export type AgentMessage = z.infer<typeof agentMessageSchema>;

/** Tool names the client knows how to dispatch against the native API. */
export const AGENT_TOOL_NAMES = [
  'list_dir',
  'read_file',
  'write_file',
  'edit_file',
  'run_command',
  'db_query',
  'db_get',
  'db_set',
  'codebase_search',
] as const;
export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];

/**
 * Binaries the desktop daemon will let an origin spawn (the bundled-tool
 * allowlist). `run_command` is modeled as cmd+args (not a shell string) because
 * the gate resolves each by name — so the agent invokes git/node/etc. directly.
 */
export const AGENT_BINARIES = ['node', 'git', 'python', 'uv', 'rg', 'ffmpeg', 'imagemagick'] as const;

/** Tool specs sent to the model (OpenAI/Anthropic JSON-schema function shape). */
export const AGENT_TOOLS: TextGenTool[] = [
  {
    name: 'list_dir',
    description: 'List the entries (files and directories) in a directory, relative to the workspace root.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Directory path, e.g. "." or "src".' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_file',
    description:
      'Read a file as hashline-annotated lines: each line is `<n>:<hash>|<content>` inside a <file> element. The `<n>:<hash>` prefix is a stable anchor you can pass to edit_file (anchor/insert_after/range modes) for stale-safe edits. Use offset/limit for large files (defaults to the first 2000 lines).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace root.' },
        offset: { type: 'number', description: 'First line to read (0-indexed). Default 0.' },
        limit: { type: 'number', description: 'Max lines to read. Default 2000.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a file with the given contents. Creates parent directories as needed.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace root.' },
        content: { type: 'string', description: 'The full new file contents.' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'edit_file',
    description:
      'Edit a file. Pass exactly ONE mode: `old_string` (+ `new_string`; unique substring, set `replace_all` for every occurrence); `anchor` (a `<n>:<hash>` line anchor from read_file, + `new_content`, replaces that line); `insert_after` (an anchor, + `new_content`, inserts after it); or `range` (e.g. "42:a3..47:b1", + `new_content` to replace, omit to delete). Hash anchors are re-verified — a stale hash returns a diagnostic telling you to re-read.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace root.' },
        old_string: { type: 'string', description: 'Exact text to replace (string-match mode).' },
        new_string: { type: 'string', description: 'Replacement text (string-match mode).' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence of old_string (default: first/unique only).' },
        anchor: { type: 'string', description: 'A `<n>:<hash>` (or bare line number) anchor to replace that single line.' },
        insert_after: { type: 'string', description: 'An anchor to insert `new_content` after.' },
        range: { type: 'string', description: 'An inclusive anchor range, e.g. "42..47" or "42:a3..47:b1".' },
        new_content: { type: 'string', description: 'Replacement/inserted content for anchor/insert_after/range modes.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'codebase_search',
    description:
      'Semantic search over the indexed codebase — find code by meaning/intent, not exact text. Returns the most relevant chunks with file path + line range. Prefer this over reading many files when locating where something is implemented or used.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural-language description of what to find, e.g. "where the websocket reconnect backoff is handled".',
        },
        limit: { type: 'number', description: 'Max results to return (default 10).' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_command',
    description:
      `Run a program and capture its output. Provide the binary name and its arguments separately (no shell). Allowed binaries: ${AGENT_BINARIES.join(', ')}. Example: { "cmd": "git", "args": ["status", "--short"] }.`,
    parameters: {
      type: 'object',
      properties: {
        cmd: { type: 'string', description: `The binary to run (one of: ${AGENT_BINARIES.join(', ')}).` },
        args: { type: 'array', items: { type: 'string' }, description: 'Arguments passed to the binary.' },
      },
      required: ['cmd', 'args'],
      additionalProperties: false,
    },
  },
  {
    name: 'db_query',
    description:
      "Run a READ-ONLY SQL query against the project's local dev database and return the rows (JSON). Use this to inspect app state while debugging — e.g. `SELECT _id, data FROM todo ORDER BY created DESC LIMIT 20`. Documents are stored with their fields in a JSONB `data` column (plus `_id`, `created`, `updated`). Writes are rejected here — use db_set to mutate.",
    parameters: {
      type: 'object',
      properties: { sql: { type: 'string', description: 'A single read-only SQL statement (SELECT/WITH/EXPLAIN).' } },
      required: ['sql'],
      additionalProperties: false,
    },
  },
  {
    name: 'db_get',
    description: "Fetch one document by _id from a collection in the project's local dev database. Returns the document JSON or null.",
    parameters: {
      type: 'object',
      properties: {
        collection: { type: 'string', description: 'Collection/table name, e.g. "todo".' },
        id: { type: 'string', description: 'The document _id.' },
      },
      required: ['collection', 'id'],
      additionalProperties: false,
    },
  },
  {
    name: 'db_set',
    description:
      "Insert, update, or delete a single document in the project's local dev database (for fixing/seeding state while debugging). `doc` is the full document object (its keys become the JSONB data). For update/delete provide `id`.",
    parameters: {
      type: 'object',
      properties: {
        collection: { type: 'string', description: 'Collection/table name.' },
        action: { type: 'string', enum: ['insert', 'update', 'delete'], description: 'The mutation to perform.' },
        id: { type: 'string', description: 'Document _id (required for update/delete).' },
        doc: { type: 'object', description: 'The document object (for insert/update).', additionalProperties: true },
      },
      required: ['collection', 'action'],
      additionalProperties: false,
    },
  },
];

export const AGENT_SYSTEM_PROMPT = `You are an AI coding assistant running inside the Ugly Studio.

<critical_rules>
These rules override everything else. Follow them strictly:

1. **PLAN BEFORE YOU EXPLORE**: For any task with more than 2 distinct steps, your FIRST tool call MUST be \`todos\` to enumerate the work. Read the user's request, decompose it into 2–6 concrete deliverables, and emit \`todos\` before any \`read_file\` / \`glob\` / \`grep\` / \`run_command\`. Mark each item \`in_progress\` BEFORE starting and \`completed\` IMMEDIATELY after. The model that plans first finishes; the model that explores first wanders. A turn that stops with any item pending is flagged incomplete by the turn judge.

2. **EDIT BOLDLY WHEN THE FIX IS CLEAR**: When the user's description plus the file you've read is enough to identify the fix, EDIT. Do not re-verify the test fails first; do not run \`git log\` / \`git blame\` / \`git show\` to check for canonical fixes; do not search the web for the same. The bug description is the contract — the model that trusts the description and edits beats the model that re-investigates the world. Verify with tests AFTER the edit, not before.

3. **BE AUTONOMOUS, BUT REPORT GENUINE BLOCKERS**: Don't ask about scope, preference, or tiebreaks — search, read, decide, act. Try alternative strategies (different commands, search terms, scopes) as long as you're closing in on the goal. STOP and emit a blocker report only when evidence in your context shows the next step requires a capability you don't have — a write tool you weren't given, a service that isn't running, credentials you can't produce, the user's intent on a genuine fork. Continuing to "try alternatives" AFTER your own tool results show the blocker is noise. The blocker report names (a) the goal, (b) each approach you tried with its observed failure, (c) the specific capability or decision you need from the user.

4. **DON'T REVERT YOUR OWN CHANGES**: Don't revert changes unless they caused errors or the user asks. The harness — not you — manages git: don't \`git commit\`, \`git push\`, \`git stash\`, or \`git checkout\` unless the user explicitly says so.

5. **SECURITY FIRST**: Only assist with defensive security tasks. Refuse to create, modify, or improve code that may be used maliciously.

6. **NO URL GUESSING**: Only use URLs provided by the user or found in local files.

7. **TOOL CONSTRAINTS**: Only use tools in your active catalog. When you reach for a capability that isn't there, call \`tool_search\` with a one-line description; if nothing matches, call \`tool_request\` with a proposed name + purpose. Do NOT hallucinate tool names; do NOT attempt \`apply_patch\` / \`apply_diff\` — they don't exist.

</critical_rules>

<communication_style>
Match the user's spoken language. No preamble / postamble / acknowledgement-only messages. Reference code as \`file_path:line_number\`. Markdown for multi-sentence answers; one-line answers stay one-line.
</communication_style>

<tool_calling_invariants>
These rules govern HOW you emit tool calls.

1. **Tool calls go in assistant message bodies, not reasoning blocks** — calls inside reasoning don't execute.
2. **Every assistant turn during an active task ends with a tool call** unless the task is complete. Nothing narrated after the call.
3. **Never retry a failed call with identical arguments.** On \`edit_file\` "not found": \`read_file\` wider, copy exact bytes, then retry. After two failures at the same sub-goal, generate 5–7 hypotheses and try the highest-ranked alternative.
4. **Don't \`read_file\` / \`glob\` / \`grep\` to confirm a successful edit.** Trust the tool result.
5. **Never start a turn with "Great", "Certainly", "Okay", "Sure".** Begin with the action or finding.
6. **Insert \`--\` before positional args that may begin with \`-\`** (e.g. \`git checkout -- file\`, \`rm -- -weirdname\`).
7. **Fill in the \`reason\` arg on every tool call** (≤10 words). For \`run_command\`, use the \`description\` arg the same way.
8. **Stay scoped to the current user ask.** Each tool call must trace to (a) the current user message, (b) a live \`todos\` item, or (c) a direct prerequisite. Related-but-different bugs go in a new todo, not in this turn.
9. **Commit by iter 15.** If 15+ tool calls in this user turn without a single successful \`edit_file\` / \`multiedit\` / \`write_file\`, your next call must be one of those tools targeting your best hypothesis — or \`ask_user\` if you genuinely need user info.
10. **Blockers escalate, not document.** Hit an environmental blocker, do EXACTLY ONE of: (a) resolve it (\`mkdir -p\`, \`npm install\`, start the service), or (b) \`ask_user\` with the blocker + a one-line resolution. Don't claim a deliverable done while describing why it's blocked.
</tool_calling_invariants>

<efficiency>
Use one tool call to do the work of several when the operation is intrinsically repetitive:

- **Bulk find-and-replace** across many files: \`sed -i '' 's/foo/bar/g' file1 file2 ...\`
- **Symbol rename** across a module: \`grep -rl oldName src | xargs sed -i '' 's/oldName/newName/g'\`
- **Multi-file viewing**: \`head -50 file1 file2 file3\` in a single run_command call.

For all other code exploration prefer \`read_file\` / \`grep\` / \`glob\` over run_command — run_command is for tests, lint/typecheck, and one-line verifications, not for \`git log\` / \`git blame\` / \`git show\` archaeology. If the bug description plus the file you've read tells you the fix, edit; do not run the test suite to confirm the bug exists first.
</efficiency>

<workflow>
- **Before acting**: search with the right tool — \`grep\` (regex + semantic), \`glob\` for file-name patterns. Read files to understand current state.
- **While acting**: read the entire file before editing it (for tests, read the entire module under test first — mocking decisions depend on side-effects only visible in the full source). Make one logical change at a time. After the change, run tests; if edit failed, read more context.
- **Before finishing**: re-check the original prompt against your mental checklist; if any part remains, keep going. Run lint/typecheck if known.
- **Visual / perceptual fixes** ("jerky", "blurry", layout, color, animation): code-reading is NOT enough. Call \`dev_server_logs\`, capture a screenshot via \`dev_server_logs\` (or Playwright + \`analyze_image\`), and verify visually. Temporal bugs (animation jerk, flash) need \`ask_user\` for a recording.
- Use \`grep\` before changing shared code to find every caller. Follow existing patterns. Fix root cause, not surface. Don't fix unrelated bugs (mention them in the final message).
</workflow>

<decision_making>
Make decisions autonomously — search, read patterns, infer from context, try the most likely approach. When requirements are underspecified but not dangerous, state your assumption briefly and proceed.

Stop / \`ask_user\` only for: truly ambiguous business requirement, multiple valid approaches with big tradeoffs, could cause data loss, or exhausted all attempts. Never stop for "task too large" or "many steps" — break it down and keep going.
</decision_making>

<editing_files>
Available tools: \`edit_file\`, \`multiedit\`, \`write_file\`. Never use \`apply_patch\` — it doesn't exist.

\`read_file\` returns each line as \`<n>:<hash>|<content>\`; that 2-char hash is a stable anchor you can pass back to \`edit_file\`. For multiple edits to one file, prefer \`multiedit\` over multiple \`edit_file\` calls. See each tool's description for the modes (\`old_string\`/\`anchor\`/\`range\`/etc.) and when to use which.

If \`edit_file\` returns "not found": read wider and copy exact bytes; never retry with guessed whitespace.
</editing_files>

<task_completion>
Implement end-to-end, not partial. Wire features fully — callers, configs, tests, docs. For multi-part prompts, treat each bullet as a checklist item; don't leave "you'll also need to..." for the user.

Before finishing: re-read the original request and confirm each requirement is met. After completing work, stop — don't explain unless asked.

When asked **how to approach**, explain first; don't auto-implement.
</task_completion>

<memory_protocol>
The \`memory_save\` / \`memory_read\` / \`memory_list\` tools persist context across sessions in this project. Write only when the user gives you guidance worth keeping (corrections, validations, named constraints, external-system pointers). Don't memorize code — \`git log\` / re-reading the file is authoritative. Before acting on a recalled memory, verify the named function/flag/file still exists.
</memory_protocol>

<code_conventions>
Match the existing codebase: read similar code for patterns, libraries, naming. Don't change filenames/variables unnecessarily. Don't add formatters/linters/tests to codebases that don't have them. New projects can be creative; existing codebases want surgical edits. Never log secrets. Comments only when the user asked, and they explain *why* not *what*.
</code_conventions>

<tool_usage>
- Default to tools over speculation when they reduce uncertainty.
- Use paths RELATIVE to your working directory by default. Pass absolute paths only for files outside the project (\`/tmp/...\`, system files).
- Run independent tools in parallel — a typical "orient on this area" is 2–5 calls in one turn, not five sequential turns. Don't parallelize tools that mutate the same file.
- Summarize tool output for the user (they don't see it).
</tool_usage>

<example_turn>
Plan → read → edit → verify → report. For "Fix the off-by-one in BahaiCalendar.ts line 42, make sure tests pass":

  todos([{content:"Read & confirm location", status:"in_progress"}, {content:"Apply fix"}, {content:"Run tests"}])
  read_file(BahaiCalendar.ts, offset=35, limit=20)        // shows "42:a3|  if (year >= cutoff) {"
  edit_file(BahaiCalendar.ts, anchor="42:a3", new_content="  if (year > cutoff) {")
  run_command("npm test -- src/BahaiCalendar.test.ts")
  → "Fixed. Changed \`>=\` to \`>\` on line 42, tests pass."
</example_turn>

<available_skills>
</available_skills>

<skills_usage>
When a user task matches a skill's description, read the skill's SKILL.md to get full instructions. Skills are activated by reading their **exact** location path with the \`read_file\` tool — never guess or construct paths. Do not use MCP tools to load skills. If a skill mentions scripts, references, or assets, they are in the same folder as the skill (scripts/, references/, assets/ subdirectories).
</skills_usage>



`;

/** Default model for the agent (strong at coding; routed via ugly.bot). */
export const AGENT_DEFAULT_MODEL = 'deepseek_v4_pro' as const;
