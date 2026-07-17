import { describe, it, expect, vi } from 'vitest';

const { spawnCollect } = vi.hoisted(() => ({
  spawnCollect: vi.fn(async () => ({ stdout: '', stderr: '', code: 0 })),
}));
vi.mock('ugly-app/native', () => ({ native: { fs: {} } }));
vi.mock('../../../client/agent/tools/spawn', () => ({ spawnCollect }));

import {
  ensureUv,
  __setUvIo,
  type BinariesIo,
} from '../../../client/agent/binaries/resolve';

function memIo(
  seed: Record<string, string> = {},
): BinariesIo & { files: Map<string, string> } {
  const files = new Map(Object.entries(seed));
  return {
    files,
    exists: (p) =>
      Promise.resolve(
        files.has(p) || [...files.keys()].some((k) => k.startsWith(p + '/')),
      ),
    mkdirp: () => Promise.resolve(),
    readFile: (p) => Promise.resolve(files.get(p) ?? '{}'),
    writeFile: (p, s) => {
      files.set(p, s);
      return Promise.resolve();
    },
    now: () => 1,
  };
}

describe('ensureUv', () => {
  it('returns "uv" when already on PATH', async () => {
    __setUvIo(memIo());
    spawnCollect.mockImplementation(async (cmd: string, args: string[]) =>
      cmd === 'uv' && args[0] === '--version'
        ? { stdout: 'uv 0.5.0', stderr: '', code: 0 }
        : { stdout: '', stderr: '', code: 1 },
    );
    expect(await ensureUv()).toBe('uv');
  });

  it('installs into the binaries root when uv is absent', async () => {
    const io = memIo();
    __setUvIo(io);
    spawnCollect.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'uv' && args[0] === '--version')
        return { stdout: '', stderr: 'not found', code: 127 };
      const m = /UV_INSTALL_DIR="([^"]+)"/.exec(args.join(' '));
      if (m) io.files.set(m[1] + '/uv', '#');
      return { stdout: '', stderr: '', code: 0 };
    });
    const p = await ensureUv();
    expect(p).toMatch(/binaries\/.*\/uv\/uv$/);
  });
});
