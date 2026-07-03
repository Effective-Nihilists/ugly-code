// Task B3.3 download + B3.4 dep_docs (real uglyNativeMock).
import { describe, it, expect, beforeEach } from 'vitest';
import { resetMock, mockCalls } from '../../helpers/uglyNativeMock';
import { downloadTool } from '../../../client/agent/tools/download';
import { depDocsTool } from '../../../client/agent/tools/depDocs';

describe('download', () => {
  beforeEach(() => resetMock({ proc: (cmd) => ({ stdout: cmd === 'node' ? 'downloaded 1234 bytes to out.bin' : '', code: 0 }) }));
  it('spawns node to fetch + write the file', async () => {
    const out = await downloadTool.run({ url: 'https://ex.com/f.bin', path: 'out.bin' }, { projectDir: '/proj' });
    expect(out).toMatch(/downloaded 1234 bytes/);
    const spawn = mockCalls().find((c) => c.channel === 'process.spawn');
    expect((spawn?.payload as { cmd: string }).cmd).toBe('node');
  });
  it('rejects non-http URLs', async () => {
    expect(await downloadTool.run({ url: 'ftp://x', path: 'a' }, undefined)).toMatch(/http/i);
  });
});

describe('dep_docs', () => {
  it('reads a package README from node_modules', async () => {
    resetMock({ files: { '/proj/node_modules/left-pad/README.md': '# left-pad\nPad a string.' } });
    const out = await depDocsTool.run({ package: 'left-pad' }, { projectDir: '/proj' });
    expect(out).toContain('left-pad');
    expect(out).toContain('Pad a string');
  });
  it('falls back to package.json when no README', async () => {
    resetMock({ files: { '/proj/node_modules/foo/package.json': JSON.stringify({ description: 'Foo lib', version: '1.2.3' }) } });
    const out = await depDocsTool.run({ package: 'foo' }, { projectDir: '/proj' });
    expect(out).toContain('Foo lib');
  });
  it('reports when the package is not installed', async () => {
    resetMock({ files: {} });
    const out = await depDocsTool.run({ package: 'nope' }, { projectDir: '/proj' });
    expect(out).toMatch(/no docs|not installed/i);
  });
});
