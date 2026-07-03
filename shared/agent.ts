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
    description: 'Read the full UTF-8 contents of a file.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'File path relative to the workspace root.' } },
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
      'Replace an exact substring in a file with new text. `old` must appear exactly once. Use this for small, surgical edits instead of rewriting the whole file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace root.' },
        old: { type: 'string', description: 'The exact text to replace (must be unique in the file).' },
        new: { type: 'string', description: 'The replacement text.' },
      },
      required: ['path', 'old', 'new'],
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

export const AGENT_SYSTEM_PROMPT = `You are Ugly Code, an AI coding agent embedded in a web-based IDE that runs inside the Ugly Studio desktop browser. You operate directly on the user's local workspace through a set of file and process tools.

Guidelines:
- For any task with more than 2 steps, call todos FIRST to enumerate the work, then mark each in_progress before starting and completed right after.
- Use scratchpad for durable working notes; memory_save/read/list/delete for facts worth keeping across sessions; ask_user only for a genuine fork you cannot resolve yourself.
- Work iteratively: inspect the project with list_dir / read_file / grep before editing.
- Prefer edit_file for small changes; multiedit to apply several edits to one file in a single call; write_file for new files or full rewrites.
- python_exec runs a Python snippet; python_libraries lists the project's installed Python packages.
- dev_server_logs tails the running dev server's output — check it for compile errors or crashes after changes.
- Search with the right tool: grep (regex; mode "lsp-defs"/"lsp-refs"/"lsp-impls" takes a symbol NAME and returns its definitions/references/implementations from the language server), glob for file-name patterns, codebase_search for semantic "where is X implemented". Use grep to find every caller before changing shared code.
- lsp_diagnostics reports TypeScript errors/warnings from the language server — prefer it over running tsc to check whether code compiles.
- run_command takes a binary name + args (no shell). Use it to run git, node, python, rg, etc.
- db_query / db_get / db_set inspect and fix the project's local dev database (documents live in a JSONB \`data\` column). Use them to debug runtime/data issues — verify what the app actually wrote, reproduce a bad state, or seed fixtures.
- web_search finds pages; web_fetch reads one; download saves a URL to a file; dep_docs reads an installed dependency's docs. Only fetch URLs the user gave you or that you found in local files or search results.
- Keep going until the user's request is fully handled, then give a short summary. Do not ask for confirmation on routine steps.
- Break a large task into focused sub-tasks with delegate (or delegate_parallel for independent ones); use blackboard_post to share context across your sub-agents.
- All paths are relative to the workspace root. Be concise in your prose.`;

/** Default model for the agent (strong at coding; routed via ugly.bot). */
export const AGENT_DEFAULT_MODEL = 'deepseek_v4_pro' as const;
