// Client-side tool dispatcher — turns a model `tool_use` block into a real
// operation against the unified native API (fulfilled by the Ugly Studio
// desktop daemon). Returns a string the agent loop feeds back as `tool_result`.

import { native } from 'ugly-app/native';
import type { SandboxMode } from 'ugly-app/native';
import type { AgentToolName } from '../../shared/agent';
import type { StepFn } from './engine';
import { DB_SCRIPT } from '../studio/db/dbScript';
import { runRegisteredTool } from './tools/registry';
import { formatHashlineRead } from './tools/hashline';
import { applyEdit, type EditOp } from './tools/applyEdit';
import { markDirty } from './tools/codebaseDirty';

/** Project + mode context so tool subprocesses can be OS-user sandboxed by the
 *  daemon. Resolved by the agent loop (clientAgent) per turn. */
export interface ToolContext {
  /** The agent session this tool call belongs to (for per-session tool state:
   *  todos, scratchpad, blackboard). */
  sessionId?: string;
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
  /** Model-call function for subagents (delegate/agent). Provided by the agent
   *  loop; absent → delegation tools degrade gracefully. */
  step?: StepFn;
}

/** Coerce an `unknown` tool-input value to a string. Strings pass through;
 *  objects are JSON-encoded (instead of the useless `[object Object]`); other
 *  primitives use their default string form. */
function str(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** The base a model-supplied relative path resolves against: the worktree root
 *  when the session is worktree-isolated, else the open project dir. */
function resolutionBase(ctx: ToolContext | undefined): string | null {
  return ctx?.workspaceDir ?? ctx?.projectDir ?? null;
}

/** Best-effort home dir from the absolute project/worktree path (macOS/Linux). */
function deriveHome(ctx: ToolContext | undefined): string | null {
  const p = ctx?.workspaceDir ?? ctx?.projectDir ?? '';
  const m = /^(\/Users\/[^/]+|\/home\/[^/]+|\/root)/.exec(p);
  return m ? m[1] : null;
}

/** Collapse `.`/`..` segments in a POSIX path (no fs access). */
function normalizePosix(p: string): string {
  const isAbs = p.startsWith('/');
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (!isAbs) out.push('..');
    } else {
      out.push(seg);
    }
  }
  return (isAbs ? '/' : '') + out.join('/');
}

/** Resolve a model-supplied path to an absolute fs path. Handles absolute
 *  (`/foo`), home (`~/foo`), and relative (`foo`, `./foo`, `../foo`) forms;
 *  relative paths root at the worktree (if any) else the project dir. When no
 *  base is known, the path passes through so the daemon can resolve it. */
export function resolvePath(ctx: ToolContext | undefined, path: string): string {
  if (path.startsWith('/')) return normalizePosix(path);
  if (path === '~' || path.startsWith('~/')) {
    const home = deriveHome(ctx);
    return home ? normalizePosix(home + '/' + path.slice(path === '~' ? 1 : 2)) : path;
  }
  const base = resolutionBase(ctx);
  if (!base) return path;
  return normalizePosix(base.replace(/\/+$/, '') + '/' + path);
}

/** Render an absolute fs path back as a base-relative path for the model (paths
 *  returned to the model must be relative — see TOOLS.md "Path handling"). Paths
 *  outside the base, or when no base is known, are returned unchanged. */
export function relativizePath(ctx: ToolContext | undefined, absPath: string): string {
  const base = resolutionBase(ctx);
  if (!base) return absPath;
  const root = base.replace(/\/+$/, '');
  if (absPath === root) return '.';
  return absPath.startsWith(root + '/') ? absPath.slice(root.length + 1) : absPath;
}

export type ToolDispatch = (name: string, input: unknown, ctx?: ToolContext) => Promise<string>;

export const dispatchTool: ToolDispatch = async (name, input, ctx) => {
  const p = (input ?? {}) as Record<string, unknown>;
  // Restored tools live in the registry; a name it doesn't own falls through to
  // the legacy inline switch below.
  const fromRegistry = await runRegisteredTool(name, p, ctx);
  if (fromRegistry !== undefined) return fromRegistry;
  switch (name as AgentToolName) {
    case 'read': {
      const rawPath = String(p.path);
      const raw = await native.fs.readFile(resolvePath(ctx, rawPath));
      return formatHashlineRead(
        rawPath,
        raw,
        p.offset != null ? Number(p.offset) : 0,
        p.limit != null ? Number(p.limit) : undefined,
      );
    }
    case 'write': {
      const abs = resolvePath(ctx, String(p.path));
      await native.fs.writeFile(abs, str(p.content ?? ''));
      if (ctx?.sessionId) markDirty(ctx.sessionId, abs);
      return `Wrote ${relativizePath(ctx, abs)}`;
    }
    case 'edit': {
      const rawPath = String(p.path);
      const path = resolvePath(ctx, rawPath);
      const cur = await native.fs.readFile(path);
      // Accept `old`/`new` as aliases for old_string/new_string (legacy callers).
      const op: EditOp = {
        ...(p as EditOp),
        ...(p.old != null ? { old_string: String(p.old) } : {}),
        ...(p.new != null && p.new_string == null && p.new_content == null
          ? { new_string: str(p.new) }
          : {}),
      };
      const r = applyEdit(cur, op);
      if (!r.ok) return `edit failed in ${relativizePath(ctx, path)}: ${r.error}`;
      await native.fs.writeFile(path, r.body!);
      if (ctx?.sessionId) markDirty(ctx.sessionId, path);
      return `Edited ${relativizePath(ctx, path)}`;
    }
    case 'bash':
      return runBash(str(p.command ?? ''), await sandboxOptFor(ctx), ctx, p.working_dir != null ? str(p.working_dir) : undefined);
    case 'database':
      return runDb(ctx, 'getQuery', {
        collection: String(p.collection),
        ...(Array.isArray(p.filters) ? { filters: p.filters } : {}),
        ...(p.sort != null ? { sort: p.sort } : {}),
        ...(p.limit != null ? { limit: Number(p.limit) } : {}),
        ...(p.skip != null ? { skip: Number(p.skip) } : {}),
      });
    case 'database_sql_query':
      return runDb(ctx, 'exec', {
        sql: str(p.sql ?? ''),
        ...(Array.isArray(p.params) ? { params: p.params } : {}),
        // Raw SQL tool allows writes (seed/fix dev state); the daemon runs it
        // against the bundled local dev postgres.
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
      proc.onError((e) => { resolve(`[error: ${e}]`); });
      proc.onExit((code) => { resolve(code === 0 ? truncate(out.trim()) : `[error: ${out.trim().slice(-400) || 'node exited ' + String(code)}]`); });
    } catch (e) {
      console.error('[agentTools:runDbScript]', JSON.stringify({ op, projectDir, error: e instanceof Error ? e.message : String(e) }), e instanceof Error ? e.stack : undefined);
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

// Cached per project dir — is this an ugly-app project? (Gates the UGLY_APP
// tool set.) Mirrors the monolith `isUglyAppProject`: a `.uglyapp` marker, or
// an `ugly-app` dependency in package.json.
const uglyAppCache = new Map<string, boolean>();
export async function isUglyAppProject(projectDir: string): Promise<boolean> {
  const cached = uglyAppCache.get(projectDir);
  if (cached !== undefined) return cached;
  let res = false;
  try {
    await native.fs.readFile(projectDir + '/.uglyapp');
    res = true;
  } catch {
    try {
      const pkg = JSON.parse(await native.fs.readFile(projectDir + '/package.json')) as {
        dependencies?: Record<string, unknown>;
        devDependencies?: Record<string, unknown>;
      };
      res = pkg.dependencies?.['ugly-app'] !== undefined || pkg.devDependencies?.['ugly-app'] !== undefined;
    } catch {
      res = false;
    }
  }
  uglyAppCache.set(projectDir, res);
  return res;
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

/** Run a shell command through the daemon (POSIX `sh -c`), resolving with the
 *  combined output. The daemon OS-user-sandboxes the subprocess when `sandbox`
 *  is provided; PORT (so `pnpm dev` binds the session's port → Preview loads it)
 *  and DATABASE_URL (so the dev server boots against the bundled local DB) are
 *  injected. `workingDir` overrides the cwd (else the worktree/project root). */
function runBash(
  command: string,
  sandbox: { projectId: string; mode: SandboxMode; projectDir: string } | undefined,
  ctx: ToolContext | undefined,
  workingDir?: string,
): Promise<string> {
  return new Promise((resolve) => {
    let out = '';
    try {
      const cwd = workingDir
        ? resolvePath(ctx, workingDir)
        : ctx?.workspaceDir ?? ctx?.projectDir ?? undefined;
      const env: Record<string, string> = {
        ...(ctx?.port ? { PORT: String(ctx.port) } : {}),
        ...(ctx?.databaseUrl ? { DATABASE_URL: ctx.databaseUrl } : {}),
      };
      const opts: Parameters<typeof native.process.spawn>[2] = {
        ...(sandbox ? { sandbox } : {}),
        ...(cwd ? { cwd } : {}),
        ...(Object.keys(env).length ? { env } : {}),
      };
      const proc = native.process.spawn('sh', ['-c', command], opts);
      proc.onStdout((c) => (out += c));
      proc.onStderr((c) => (out += c));
      proc.onError((e) => { resolve(`${out}\n[error: ${e}]`); });
      proc.onExit((code) => { resolve(`${out.trimEnd()}\n[exit ${code ?? 'null'}]`); });
    } catch (e) {
      console.error('[agentTools:runBash]', JSON.stringify({ command, workingDir, projectDir: ctx?.projectDir, error: e instanceof Error ? e.message : String(e) }), e instanceof Error ? e.stack : undefined);
      resolve(`[error: ${(e as Error).message}]`);
    }
  });
}
