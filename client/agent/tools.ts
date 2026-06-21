// Client-side tool dispatcher — turns a model `tool_use` block into a real
// operation against the unified native API (fulfilled by the Ugly Studio
// desktop daemon). Returns a string the agent loop feeds back as `tool_result`.

import { native } from 'ugly-app/native';
import type { SandboxMode } from 'ugly-app/native';
import type { AgentToolName } from '../../shared/agent';

/** Project + mode context so tool subprocesses can be OS-user sandboxed by the
 *  daemon. Resolved by the agent loop (clientAgent) per turn. */
export interface ToolContext {
  projectDir?: string | null;
  mode?: SandboxMode;
}

export type ToolDispatch = (name: string, input: unknown, ctx?: ToolContext) => Promise<string>;

export const dispatchTool: ToolDispatch = async (name, input, ctx) => {
  const p = (input ?? {}) as Record<string, unknown>;
  switch (name as AgentToolName) {
    case 'list_dir': {
      const items = await native.fs.readdir(String(p.path ?? '.'));
      items.sort((a, b) =>
        a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1,
      );
      return items.map((e) => (e.isDirectory ? `${e.name}/` : e.name)).join('\n') || '(empty directory)';
    }
    case 'read_file':
      return native.fs.readFile(String(p.path));
    case 'write_file':
      await native.fs.writeFile(String(p.path), String(p.content ?? ''));
      return `Wrote ${String(p.path)}`;
    case 'edit_file': {
      const path = String(p.path);
      const oldStr = String(p.old);
      const newStr = String(p.new ?? '');
      const cur = await native.fs.readFile(path);
      const idx = cur.indexOf(oldStr);
      if (idx === -1) throw new Error(`edit_file: \`old\` text not found in ${path}`);
      if (cur.indexOf(oldStr, idx + oldStr.length) !== -1)
        throw new Error(`edit_file: \`old\` text is not unique in ${path} — include more surrounding context`);
      await native.fs.writeFile(path, cur.slice(0, idx) + newStr + cur.slice(idx + oldStr.length));
      return `Edited ${path}`;
    }
    case 'run_command':
      return runCommand(String(p.cmd), Array.isArray(p.args) ? p.args.map(String) : [], await sandboxOptFor(ctx));
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
};

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
): Promise<string> {
  return new Promise((resolve) => {
    let out = '';
    try {
      const proc = native.process.spawn(cmd, args, sandbox ? { sandbox } : {});
      proc.onStdout((c) => (out += c));
      proc.onStderr((c) => (out += c));
      proc.onError((e) => resolve(`${out}\n[error: ${e}]`));
      proc.onExit((code) => resolve(`${out.trimEnd()}\n[exit ${code ?? 'null'}]`));
    } catch (e) {
      resolve(`[error: ${(e as Error).message}]`);
    }
  });
}
