// Ported from ugly-studio's coding-agent tool tests (tools.test.ts +
// browser-host.test.ts), adapted to ugly-code's client-side `dispatchTool`.
// Tools run through the REAL ugly-app `native` wrapper over an in-memory
// UglyNative mock (tests/helpers/uglyNativeMock) — the same unified protocol
// production uses — so this is the faithful analog of the studio tests that
// ran tools against an in-memory UglyHost. Tool names match the monolith
// (read/write/edit/bash), not the earlier read_file/run_command port.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchTool, killSessionBashProcs } from '../../client/agent/tools';
import { annotateLines } from '../../client/agent/tools/hashline';
import { runAgent, type StepFn } from '../../client/agent/engine';
import type { AgentMessage } from '../../shared/agent';
import { mockCalls, mockFiles, resetMock } from '../helpers/uglyNativeMock';

beforeEach(() => resetMock());

describe('read', () => {
  it('returns hashline-annotated contents (<n>:<hash>|content in a <file> wrapper)', async () => {
    resetMock({ files: { 'a.txt': 'one\ntwo\n' } });
    const out = await dispatchTool('read', { path: 'a.txt' });
    expect(out).toMatch(/<file path="a.txt">/);
    expect(out).toMatch(/1:[0-9a-f]{2}\|one/);
    expect(out).toMatch(/2:[0-9a-f]{2}\|two/);
  });

  it('supports offset/limit', async () => {
    resetMock({ files: { 'a.txt': 'L1\nL2\nL3\nL4\n' } });
    const out = await dispatchTool('read', { path: 'a.txt', offset: 1, limit: 2 });
    expect(out).toMatch(/2:[0-9a-f]{2}\|L2/);
    expect(out).toMatch(/3:[0-9a-f]{2}\|L3/);
    expect(out).not.toMatch(/\|L1/);
  });

  it('rejects on a missing file', async () => {
    await expect(dispatchTool('read', { path: 'missing.txt' })).rejects.toThrow(/ENOENT/);
  });
});

describe('write', () => {
  it('writes content and reports the path', async () => {
    const out = await dispatchTool('write', { path: 'deep/nested/file.txt', content: 'x' });
    expect(out).toBe('Wrote deep/nested/file.txt');
    expect(mockFiles().get('deep/nested/file.txt')).toBe('x');
  });

  it('overwrites an existing file', async () => {
    resetMock({ files: { 'a.txt': 'old' } });
    await dispatchTool('write', { path: 'a.txt', content: 'new' });
    expect(mockFiles().get('a.txt')).toBe('new');
  });
});

describe('edit', () => {
  it('replaces a unique substring', async () => {
    resetMock({ files: { 'x.ts': 'const x = 1;\n' } });
    const out = await dispatchTool('edit', { path: 'x.ts', old: '1', new: '2' });
    expect(out).toBe('Edited x.ts');
    expect(mockFiles().get('x.ts')).toBe('const x = 2;\n');
  });

  it('reports when the old text is not found', async () => {
    resetMock({ files: { 'x.ts': 'const x = 1;\n' } });
    expect(await dispatchTool('edit', { path: 'x.ts', old: 'nope', new: 'y' })).toMatch(/not found/);
  });

  it('reports when the old text is not unique', async () => {
    resetMock({ files: { 'y.ts': 'a;\na;\n' } });
    expect(await dispatchTool('edit', { path: 'y.ts', old: 'a;', new: 'b;' })).toMatch(/not unique/);
    // unchanged
    expect(mockFiles().get('y.ts')).toBe('a;\na;\n');
  });

  it('replace_all replaces every occurrence', async () => {
    resetMock({ files: { 'y.ts': 'a;\na;\n' } });
    await dispatchTool('edit', { path: 'y.ts', old_string: 'a;', new_string: 'b;', replace_all: true });
    expect(mockFiles().get('y.ts')).toBe('b;\nb;\n');
  });

  it('anchor mode replaces a single line (bare line number)', async () => {
    resetMock({ files: { 'a.ts': 'l1\nl2\nl3\n' } });
    const out = await dispatchTool('edit', { path: 'a.ts', anchor: '2', new_content: 'L2' });
    expect(out).toMatch(/Edited/);
    expect(mockFiles().get('a.ts')).toBe('l1\nL2\nl3\n');
  });

  it('insert_after inserts a line', async () => {
    resetMock({ files: { 'a.ts': 'l1\nl2\n' } });
    await dispatchTool('edit', { path: 'a.ts', insert_after: '1', new_content: 'X' });
    expect(mockFiles().get('a.ts')).toBe('l1\nX\nl2\n');
  });

  it('range mode replaces a range; empty new_content deletes', async () => {
    resetMock({ files: { 'a.ts': 'l1\nl2\nl3\n' } });
    await dispatchTool('edit', { path: 'a.ts', range: '1..2', new_content: 'Z' });
    expect(mockFiles().get('a.ts')).toBe('Z\nl3\n');
    resetMock({ files: { 'b.ts': 'l1\nl2\nl3\n' } });
    await dispatchTool('edit', { path: 'b.ts', range: '2..2' });
    expect(mockFiles().get('b.ts')).toBe('l1\nl3\n');
  });

  it('a stale-hash anchor returns a diagnostic and leaves the file unchanged', async () => {
    resetMock({ files: { 'a.ts': 'l1\nl2\n' } });
    const wrong = annotateLines('l1\nl2\n')[1].hash === '00' ? '01' : '00';
    const out = await dispatchTool('edit', { path: 'a.ts', anchor: `2:${wrong}`, new_content: 'X' });
    expect(out).toMatch(/stale hash|failed/i);
    expect(mockFiles().get('a.ts')).toBe('l1\nl2\n');
  });
});

describe('bash', () => {
  it('streams stdout and appends the exit code', async () => {
    resetMock({ proc: () => ({ stdout: 'hello\n', code: 0 }) });
    const out = await dispatchTool('bash', { command: 'echo hello', description: 'echo' });
    expect(out).toContain('hello');
    expect(out).toContain('[exit 0]');
  });

  it('surfaces a non-zero exit code', async () => {
    resetMock({ proc: () => ({ stderr: 'boom\n', code: 1 }) });
    const out = await dispatchTool('bash', { command: 'git nope', description: 'fail' });
    expect(out).toContain('boom');
    expect(out).toContain('[exit 1]');
  });

  it('runs the command via `sh -c` through native.process.spawn', async () => {
    await dispatchTool('bash', { command: 'git status --short', description: 'status' });
    const spawn = mockCalls().find((c) => c.channel === 'process.spawn');
    expect(spawn?.payload).toMatchObject({ cmd: 'sh', args: ['-c', 'git status --short'] });
  });
});

describe('bash dev-server guard', () => {
  // Each case uses a distinct projectDir — isUglyAppProject caches per dir.
  const blocked = ['npx ugly-app dev', 'pnpm dlx ugly-app dev', 'pnpm dev', 'pnpm run dev', 'npm run dev', 'ugly-app dev --watch'];
  blocked.forEach((command, i) => {
    it(`redirects \`${command}\` to dev_server_start in an ugly-app project`, async () => {
      const dir = `/guard-block-${i}`;
      resetMock({ files: { [`${dir}/.uglyapp`]: '{"projectId":"p"}' } });
      const out = await dispatchTool('bash', { command, description: 'run dev' }, { projectDir: dir });
      expect(out).toMatch(/dev_server_start/);
      // The blocking command must NOT have been spawned.
      expect(mockCalls().find((c) => c.channel === 'process.spawn')).toBeUndefined();
    });
  });

  it('does not block non-dev commands (e.g. `pnpm dlx ugly-app doctor`)', async () => {
    const dir = '/guard-allow-doctor';
    resetMock({ files: { [`${dir}/.uglyapp`]: '{"projectId":"p"}' }, proc: () => ({ stdout: 'ok\n', code: 0 }) });
    await dispatchTool('bash', { command: 'pnpm dlx ugly-app doctor', description: 'doctor' }, { projectDir: dir });
    expect(mockCalls().find((c) => c.channel === 'process.spawn')).toBeDefined();
  });

  it('does not block `pnpm run dev-check` (only exact `dev`)', async () => {
    const dir = '/guard-allow-devcheck';
    resetMock({ files: { [`${dir}/.uglyapp`]: '{"projectId":"p"}' }, proc: () => ({ stdout: 'ok\n', code: 0 }) });
    await dispatchTool('bash', { command: 'pnpm run dev-check', description: 'dev-check' }, { projectDir: dir });
    expect(mockCalls().find((c) => c.channel === 'process.spawn')).toBeDefined();
  });

  it('does not block dev-server commands in a non-ugly-app project', async () => {
    const dir = '/guard-plain-project';
    resetMock({ files: { [`${dir}/package.json`]: '{}' }, proc: () => ({ stdout: 'ok\n', code: 0 }) });
    await dispatchTool('bash', { command: 'pnpm dev', description: 'run dev' }, { projectDir: dir });
    expect(mockCalls().find((c) => c.channel === 'process.spawn')).toBeDefined();
  });
});

describe('bash timeout + stop', () => {
  it('kills a hung command after its timeout and reports it', async () => {
    vi.useFakeTimers();
    try {
      resetMock({ proc: () => ({ hang: true }) });
      const p = dispatchTool(
        'bash',
        { command: 'sleep 999', description: 'hang', timeout_ms: 5000 },
        { sessionId: 'timeout-s1' },
      );
      await vi.advanceTimersByTimeAsync(6000);
      expect(await p).toMatch(/timed out after 5s/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('killSessionBashProcs ends a running bash for that session', async () => {
    resetMock({ proc: () => ({ hang: true }) });
    let done = false;
    const p = dispatchTool('bash', { command: 'sleep 999', description: 'hang' }, { sessionId: 'kill-s2' })
      .then((r) => { done = true; return r; });
    await new Promise((r) => setTimeout(r, 5)); // let the spawn register
    expect(done).toBe(false);
    expect(killSessionBashProcs('kill-s2')).toBe(1);
    expect(await p).toMatch(/\[exit null\]/);
    expect(done).toBe(true);
  });

  it('killSessionBashProcs returns 0 when the session has no live procs', () => {
    expect(killSessionBashProcs('no-such-session')).toBe(0);
  });
});

describe('full agent loop over the UglyNative mock', () => {
  it('a scripted write turn actually writes through the native mock', async () => {
    // Scripted model: turn 1 writes a file; turn 2 ends with text.
    const turns: AgentMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Creating the file.' },
          {
            type: 'tool_use',
            id: 'w1',
            name: 'write',
            input: { path: 'hello.txt', content: 'from the agent' },
          },
        ],
      },
      { role: 'assistant', content: 'Created hello.txt.' },
    ];
    let i = 0;
    const step: StepFn = () => Promise.resolve({ message: turns[i++]! });
    const events: string[] = [];
    const history: AgentMessage[] = [{ role: 'user', content: 'make hello.txt' }];

    await runAgent({ history, step, dispatch: dispatchTool, onEvent: (e) => events.push(e.type) });

    // The tool ran for real against the mock fs.
    expect(mockFiles().get('hello.txt')).toBe('from the agent');
    // The loop fed a tool_result back as a user turn, then finished.
    expect(history[2]).toMatchObject({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'w1', content: 'Wrote hello.txt' }],
    });
    expect(events).toContain('done');
  });
});
