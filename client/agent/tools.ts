// Client-side tool dispatcher — turns a model `tool_use` block into a real
// operation against the unified native API (fulfilled by the Ugly Studio
// desktop daemon). Returns a string the agent loop feeds back as `tool_result`.

import { native } from 'ugly-app/native';
import type { AgentToolName } from '../../shared/agent';

export type ToolDispatch = (name: string, input: unknown) => Promise<string>;

export const dispatchTool: ToolDispatch = async (name, input) => {
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
      return runCommand(String(p.cmd), Array.isArray(p.args) ? p.args.map(String) : []);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
};

/** Spawn a binary via native.process and resolve with its combined output. */
function runCommand(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    let out = '';
    try {
      const proc = native.process.spawn(cmd, args, {});
      proc.onStdout((c) => (out += c));
      proc.onStderr((c) => (out += c));
      proc.onError((e) => resolve(`${out}\n[error: ${e}]`));
      proc.onExit((code) => resolve(`${out.trimEnd()}\n[exit ${code ?? 'null'}]`));
    } catch (e) {
      resolve(`[error: ${(e as Error).message}]`);
    }
  });
}
