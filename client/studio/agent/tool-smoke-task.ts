// E2E fixture task bundle: runs EVERY coding-agent tool via the real `dispatchTool`
// inside a background-task Node child, to confirm the Studio task environment + bundled
// binaries work. Built by `ugly-app build:tasks` (declared in .uglyapp) and driven by the
// ugly-studio task-tools e2e (which spawns it through the real forkTaskChild + bundled env).
import { defineTask, taskContext, createNodeUglyNative } from 'ugly-app/native';
import { dispatchTool, type ToolContext } from '../../agent/tools';

// Node-backed window.UglyNative so the agent's tools resolve native.fs/process to node:fs /
// child_process. ugly-app's permissions read platform lazily, so this body-level install
// (after the imports) is respected.
(globalThis as { UglyNative?: unknown }).UglyNative = createNodeUglyNative();

const t = taskContext<{ dir?: string }>();

type ToolResult = { ok: boolean; out: string };

defineTask({
  onCall: {
    // Run each tool against `dir` and report { ok, out } per tool so the e2e can assert
    // fs ops + that run_command/db resolve the bundled node/git/bash via the task PATH.
    runAllTools: async ({ dir }: { dir: string }): Promise<Record<string, ToolResult>> => {
      const ctx: ToolContext = { projectDir: dir, workspaceDir: dir, mode: 'edit' };
      const results: Record<string, ToolResult> = {};
      const run = async (label: string, fn: () => Promise<string>): Promise<void> => {
        try {
          // Per-tool timeout so a db tool waiting on an absent dev postgres can't hang the
          // whole run (a timeout still implies node spawned — the env/binary point).
          const out = await Promise.race<string>([
            fn(),
            new Promise<string>((_, rej) => setTimeout(() => rej(new Error('TIMEOUT')), 8000)),
          ]);
          results[label] = { ok: true, out: out.slice(0, 300) };
        } catch (e) {
          results[label] = { ok: false, out: (e as Error)?.message ?? String(e) };
        }
      };

      // A .uglyapp so the db/run_command project-id resolution has something to read.
      await run('write_file:.uglyapp', () =>
        dispatchTool('write_file', { path: '.uglyapp', content: JSON.stringify({ projectId: 'tool-smoke' }) }, ctx));
      // fs tools
      await run('write_file', () => dispatchTool('write_file', { path: 'hello.txt', content: 'hi from task' }, ctx));
      await run('read_file', () => dispatchTool('read_file', { path: 'hello.txt' }, ctx));
      await run('edit_file', () => dispatchTool('edit_file', { path: 'hello.txt', old: 'hi from', new: 'edited by' }, ctx));
      await run('read_after_edit', () => dispatchTool('read_file', { path: 'hello.txt' }, ctx));
      await run('list_dir', () => dispatchTool('list_dir', { path: '.' }, ctx));
      // run_command — confirms the bundled binaries are on the task child's PATH
      await run('run_command:node', () => dispatchTool('run_command', { cmd: 'node', args: ['--version'] }, ctx));
      await run('run_command:node-path', () => dispatchTool('run_command', { cmd: 'node', args: ['-p', 'process.execPath'] }, ctx));
      await run('run_command:git', () => dispatchTool('run_command', { cmd: 'git', args: ['--version'] }, ctx));
      await run('run_command:bash', () => dispatchTool('run_command', { cmd: 'bash', args: ['-lc', 'echo task-bash-ok'] }, ctx));
      // db tools — spawn `node` with the DB script (confirms node resolves + the script runs;
      // a real query also needs the dev postgres, which the env confirmation doesn't require).
      await run('db_query', () => dispatchTool('db_query', { sql: 'select 1 as n' }, ctx));
      await run('db_set', () => dispatchTool('db_set', { collection: 'smoke', action: 'set', id: 'a', doc: { x: 1 } }, ctx));
      await run('db_get', () => dispatchTool('db_get', { collection: 'smoke', id: 'a' }, ctx));
      return results;
    },
  },
});

t.setSnapshot({ ready: true });
