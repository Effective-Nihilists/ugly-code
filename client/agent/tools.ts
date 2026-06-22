// Client-side tool dispatcher — turns a model `tool_use` block into a real
// operation against the unified native API (fulfilled by the Ugly Studio
// desktop daemon). Returns a string the agent loop feeds back as `tool_result`.

import { native } from 'ugly-app/native';
import type { SandboxMode } from 'ugly-app/native';
import type { AgentToolName } from '../../shared/agent';
import { DB_SCRIPT } from '../studio/db/dbScript';

/** Project + mode context so tool subprocesses can be OS-user sandboxed by the
 *  daemon. Resolved by the agent loop (clientAgent) per turn. */
export interface ToolContext {
  projectDir?: string | null;
  /** Absolute root for resolving the model's (workspace-relative) fs paths. Set
   *  ONLY for worktree-isolated sessions; when unset, relative paths pass through
   *  unchanged (the daemon resolves them against the open project). */
  workspaceDir?: string | null;
  mode?: SandboxMode;
  /** Unique dev-server port, injected as PORT into run_command spawns. */
  port?: number;
  /** Local dev DB connection string, injected as DATABASE_URL into run_command. */
  databaseUrl?: string;
}

/** Resolve a model-supplied (workspace-relative) path. Absolute paths pass
 *  through; relative paths are rooted at `workspaceDir` when set (worktree). */
function resolvePath(ctx: ToolContext | undefined, path: string): string {
  if (path.startsWith('/')) return path;
  const root = ctx?.workspaceDir;
  if (!root) return path;
  return root.replace(/\/+$/, '') + '/' + path.replace(/^\.\/?/, '');
}

export type ToolDispatch = (name: string, input: unknown, ctx?: ToolContext) => Promise<string>;

export const dispatchTool: ToolDispatch = async (name, input, ctx) => {
  const p = (input ?? {}) as Record<string, unknown>;
  switch (name as AgentToolName) {
    case 'list_dir': {
      const items = await native.fs.readdir(resolvePath(ctx, String(p.path ?? '.')));
      items.sort((a, b) =>
        a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1,
      );
      return items.map((e) => (e.isDirectory ? `${e.name}/` : e.name)).join('\n') || '(empty directory)';
    }
    case 'read_file':
      return native.fs.readFile(resolvePath(ctx, String(p.path)));
    case 'write_file':
      await native.fs.writeFile(resolvePath(ctx, String(p.path)), String(p.content ?? ''));
      return `Wrote ${String(p.path)}`;
    case 'edit_file': {
      const rawPath = String(p.path);
      const path = resolvePath(ctx, rawPath);
      const oldStr = String(p.old);
      const newStr = String(p.new ?? '');
      const cur = await native.fs.readFile(path);
      const idx = cur.indexOf(oldStr);
      if (idx === -1) throw new Error(`edit_file: \`old\` text not found in ${rawPath}`);
      if (cur.indexOf(oldStr, idx + oldStr.length) !== -1)
        throw new Error(`edit_file: \`old\` text is not unique in ${rawPath} — include more surrounding context`);
      await native.fs.writeFile(path, cur.slice(0, idx) + newStr + cur.slice(idx + oldStr.length));
      return `Edited ${rawPath}`;
    }
    case 'run_command':
      return runCommand(String(p.cmd), Array.isArray(p.args) ? p.args.map(String) : [], await sandboxOptFor(ctx), ctx?.port, ctx?.databaseUrl);
    case 'db_query':
      return runDb(ctx, 'exec', { sql: String(p.sql ?? ''), allowWrite: false });
    case 'db_get':
      return runDb(ctx, 'getDoc', { collection: String(p.collection), id: String(p.id) });
    case 'db_set':
      return runDb(ctx, 'mutate', {
        collection: String(p.collection),
        action: String(p.action),
        id: p.id == null ? undefined : String(p.id),
        doc: (p.doc ?? {}) as Record<string, unknown>,
        allowWrite: true,
      });
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
};

/** Run one DB op (db/dbScript) against the project's local dev DB via a node
 *  subprocess — same plumbing the Database panel uses. Returns a JSON string the
 *  agent reads as the tool_result. The dev DB is the bundled local postgres
 *  (p_<projectId>), so this is the same data the app's dev server sees. */
function runDb(ctx: ToolContext | undefined, op: string, input: Record<string, unknown>): Promise<string> {
  const projectDir = ctx?.projectDir;
  if (!projectDir) return Promise.resolve('[error: no open project — db tools need a project]');
  return new Promise((resolve) => {
    let out = '';
    try {
      const proc = native.process.spawn('node', ['--input-type=module', '-e', DB_SCRIPT], {
        cwd: projectDir,
        env: {
          UGLY_DB_MODE: 'dev',
          UGLY_DB_PROJECT: projectDir,
          UGLY_DB_OP: op,
          UGLY_DB_INPUT: JSON.stringify(input),
        },
      });
      proc.onStdout((c) => (out += c));
      proc.onStderr((c) => (out += c));
      proc.onError((e) => resolve(`[error: ${e}]`));
      proc.onExit((code) => resolve(code === 0 ? truncate(out.trim()) : `[error: ${out.trim().slice(-400) || 'node exited ' + code}]`));
    } catch (e) {
      resolve(`[error: ${(e as Error).message}]`);
    }
  });
}

/** Keep tool results bounded so a huge result set doesn't blow the context. */
function truncate(s: string): string {
  const MAX = 12_000;
  return s.length > MAX ? s.slice(0, MAX) + `\n…[truncated ${s.length - MAX} chars]` : s;
}

// `.uglyapp.projectId` per project dir — read once, cached (it never changes for
// an open project), so we don't re-read the file on every tool call.
const projectIdCache = new Map<string, string | null>();
async function readProjectId(projectDir: string): Promise<string | null> {
  const cached = projectIdCache.get(projectDir);
  if (cached !== undefined) return cached;
  let pid: string | null = null;
  try {
    pid = (JSON.parse(await native.fs.readFile(projectDir + '/.uglyapp')) as { projectId?: string }).projectId ?? null;
  } catch {
    pid = null;
  }
  projectIdCache.set(projectDir, pid);
  return pid;
}

/** Build the daemon sandbox spawn option for this tool call (or undefined when
 *  there's no project / projectId → spawn runs unsandboxed). */
async function sandboxOptFor(
  ctx?: ToolContext,
): Promise<{ projectId: string; mode: SandboxMode; projectDir: string } | undefined> {
  const mode = ctx?.mode ?? 'edit';
  const projectDir = ctx?.projectDir;
  if (!projectDir) return undefined;
  const projectId = await readProjectId(projectDir);
  if (!projectId) return undefined;
  return { projectId, projectDir, mode };
}

/** Spawn a binary via native.process and resolve with its combined output. The
 *  daemon OS-user-sandboxes the subprocess when `sandbox` is provided. */
function runCommand(
  cmd: string,
  args: string[],
  sandbox?: { projectId: string; mode: SandboxMode; projectDir: string },
  port?: number,
  databaseUrl?: string,
): Promise<string> {
  return new Promise((resolve) => {
    let out = '';
    try {
      // Inject PORT (so `pnpm dev` binds the session's port → Preview loads it)
      // and DATABASE_URL (so the dev server boots against the bundled local DB).
      const env: Record<string, string> = {
        ...(port ? { PORT: String(port) } : {}),
        ...(databaseUrl ? { DATABASE_URL: databaseUrl } : {}),
      };
      const opts: Parameters<typeof native.process.spawn>[2] = {
        ...(sandbox ? { sandbox } : {}),
        ...(Object.keys(env).length ? { env } : {}),
      };
      const proc = native.process.spawn(cmd, args, opts);
      proc.onStdout((c) => (out += c));
      proc.onStderr((c) => (out += c));
      proc.onError((e) => resolve(`${out}\n[error: ${e}]`));
      proc.onExit((code) => resolve(`${out.trimEnd()}\n[exit ${code ?? 'null'}]`));
    } catch (e) {
      resolve(`[error: ${(e as Error).message}]`);
    }
  });
}
