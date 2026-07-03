// Ported from ugly-studio's coding-agent tool tests (tools.test.ts +
// browser-host.test.ts), adapted to ugly-code's client-side `dispatchTool`.
// Tools run through the REAL ugly-app `native` wrapper over an in-memory
// UglyNative mock (tests/helpers/uglyNativeMock) — the same unified protocol
// production uses — so this is the faithful analog of the studio tests that
// ran tools against an in-memory UglyHost.

import { beforeEach, describe, expect, it } from 'vitest';
import { dispatchTool } from '../../client/agent/tools';
import { annotateLines } from '../../client/agent/tools/hashline';
import { runAgent, type StepFn } from '../../client/agent/engine';
import type { AgentMessage } from '../../shared/agent';
import { mockCalls, mockFiles, resetMock } from '../helpers/uglyNativeMock';

beforeEach(() => resetMock());

describe('list_dir', () => {
  it('lists entries with directories first and a trailing slash on dirs', async () => {
    resetMock({ files: { 'README.md': '#', 'src/a.ts': 'a', 'src/b.ts': 'b' } });
    const out = await dispatchTool('list_dir', { path: '.' });
    expect(out).toBe('src/\nREADME.md');
  });

  it('lists a nested directory', async () => {
    resetMock({ files: { 'src/a.ts': 'a', 'src/b.ts': 'b' } });
    const out = await dispatchTool('list_dir', { path: 'src' });
    expect(out.split('\n').sort()).toEqual(['a.ts', 'b.ts']);
  });

  it('reports an empty directory', async () => {
    const out = await dispatchTool('list_dir', { path: 'nope' });
    expect(out).toBe('(empty directory)');
  });
});

describe('read_file', () => {
  it('returns hashline-annotated contents (<n>:<hash>|content in a <file> wrapper)', async () => {
    resetMock({ files: { 'a.txt': 'one\ntwo\n' } });
    const out = await dispatchTool('read_file', { path: 'a.txt' });
    expect(out).toMatch(/<file path="a.txt">/);
    expect(out).toMatch(/1:[0-9a-f]{2}\|one/);
    expect(out).toMatch(/2:[0-9a-f]{2}\|two/);
  });

  it('supports offset/limit', async () => {
    resetMock({ files: { 'a.txt': 'L1\nL2\nL3\nL4\n' } });
    const out = await dispatchTool('read_file', { path: 'a.txt', offset: 1, limit: 2 });
    expect(out).toMatch(/2:[0-9a-f]{2}\|L2/);
    expect(out).toMatch(/3:[0-9a-f]{2}\|L3/);
    expect(out).not.toMatch(/\|L1/);
  });

  it('rejects on a missing file', async () => {
    await expect(dispatchTool('read_file', { path: 'missing.txt' })).rejects.toThrow(/ENOENT/);
  });
});

describe('write_file', () => {
  it('writes content and reports the path', async () => {
    const out = await dispatchTool('write_file', { path: 'deep/nested/file.txt', content: 'x' });
    expect(out).toBe('Wrote deep/nested/file.txt');
    expect(mockFiles().get('deep/nested/file.txt')).toBe('x');
  });

  it('overwrites an existing file', async () => {
    resetMock({ files: { 'a.txt': 'old' } });
    await dispatchTool('write_file', { path: 'a.txt', content: 'new' });
    expect(mockFiles().get('a.txt')).toBe('new');
  });
});

describe('edit_file', () => {
  it('replaces a unique substring', async () => {
    resetMock({ files: { 'x.ts': 'const x = 1;\n' } });
    const out = await dispatchTool('edit_file', { path: 'x.ts', old: '1', new: '2' });
    expect(out).toBe('Edited x.ts');
    expect(mockFiles().get('x.ts')).toBe('const x = 2;\n');
  });

  it('errors when the old text is not found', async () => {
    resetMock({ files: { 'x.ts': 'const x = 1;\n' } });
    await expect(dispatchTool('edit_file', { path: 'x.ts', old: 'nope', new: 'y' })).rejects.toThrow(
      /not found/,
    );
  });

  it('errors when the old text is not unique', async () => {
    resetMock({ files: { 'y.ts': 'a;\na;\n' } });
    await expect(dispatchTool('edit_file', { path: 'y.ts', old: 'a;', new: 'b;' })).rejects.toThrow(
      /not unique/,
    );
    // unchanged
    expect(mockFiles().get('y.ts')).toBe('a;\na;\n');
  });

  it('replace_all replaces every occurrence', async () => {
    resetMock({ files: { 'y.ts': 'a;\na;\n' } });
    await dispatchTool('edit_file', { path: 'y.ts', old_string: 'a;', new_string: 'b;', replace_all: true });
    expect(mockFiles().get('y.ts')).toBe('b;\nb;\n');
  });

  it('anchor mode replaces a single line (bare line number)', async () => {
    resetMock({ files: { 'a.ts': 'l1\nl2\nl3\n' } });
    const out = await dispatchTool('edit_file', { path: 'a.ts', anchor: '2', new_content: 'L2' });
    expect(out).toMatch(/Edited/);
    expect(mockFiles().get('a.ts')).toBe('l1\nL2\nl3\n');
  });

  it('insert_after inserts a line', async () => {
    resetMock({ files: { 'a.ts': 'l1\nl2\n' } });
    await dispatchTool('edit_file', { path: 'a.ts', insert_after: '1', new_content: 'X' });
    expect(mockFiles().get('a.ts')).toBe('l1\nX\nl2\n');
  });

  it('range mode replaces a range; empty new_content deletes', async () => {
    resetMock({ files: { 'a.ts': 'l1\nl2\nl3\n' } });
    await dispatchTool('edit_file', { path: 'a.ts', range: '1..2', new_content: 'Z' });
    expect(mockFiles().get('a.ts')).toBe('Z\nl3\n');
    resetMock({ files: { 'b.ts': 'l1\nl2\nl3\n' } });
    await dispatchTool('edit_file', { path: 'b.ts', range: '2..2' });
    expect(mockFiles().get('b.ts')).toBe('l1\nl3\n');
  });

  it('a stale-hash anchor returns a diagnostic and leaves the file unchanged', async () => {
    resetMock({ files: { 'a.ts': 'l1\nl2\n' } });
    const wrong = annotateLines('l1\nl2\n')[1].hash === '00' ? '01' : '00';
    const out = await dispatchTool('edit_file', { path: 'a.ts', anchor: `2:${wrong}`, new_content: 'X' });
    expect(out).toMatch(/stale hash|failed/i);
    expect(mockFiles().get('a.ts')).toBe('l1\nl2\n');
  });
});

describe('run_command', () => {
  it('streams stdout and appends the exit code', async () => {
    resetMock({ proc: () => ({ stdout: 'hello\n', code: 0 }) });
    const out = await dispatchTool('run_command', { cmd: 'echo', args: ['hello'] });
    expect(out).toContain('hello');
    expect(out).toContain('[exit 0]');
  });

  it('surfaces a non-zero exit code', async () => {
    resetMock({ proc: () => ({ stderr: 'boom\n', code: 1 }) });
    const out = await dispatchTool('run_command', { cmd: 'git', args: ['nope'] });
    expect(out).toContain('boom');
    expect(out).toContain('[exit 1]');
  });

  it('passes cmd + args through to native.process.spawn', async () => {
    await dispatchTool('run_command', { cmd: 'git', args: ['status', '--short'] });
    const spawn = mockCalls().find((c) => c.channel === 'process.spawn');
    expect(spawn?.payload).toMatchObject({ cmd: 'git', args: ['status', '--short'] });
  });
});

describe('full agent loop over the UglyNative mock', () => {
  it('a scripted write_file turn actually writes through the native mock', async () => {
    // Scripted model: turn 1 writes a file; turn 2 ends with text.
    const turns: AgentMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Creating the file.' },
          {
            type: 'tool_use',
            id: 'w1',
            name: 'write_file',
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
