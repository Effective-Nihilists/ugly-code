import { describe, it, expect, vi } from 'vitest';

const { spawnCollect } = vi.hoisted(() => ({ spawnCollect: vi.fn(async () => ({ stdout: '', stderr: '', code: 0 })) }));
vi.mock('ugly-app/native', () => ({ native: { fs: {} } }));
vi.mock('../../../client/agent/tools/spawn', () => ({ spawnCollect }));

import { ensurePython, __setPythonIo, type BinariesIo } from '../../../client/agent/binaries/resolve';

describe('ensurePython', () => {
  it('runs uv python install once, returns the python3 path', async () => {
    const files = new Map<string, string>();
    const io: BinariesIo = {
      exists: (p) => Promise.resolve([...files.keys()].some((k) => k === p || k.startsWith(p + '/'))),
      mkdirp: () => Promise.resolve(),
      readFile: (p) => Promise.resolve(files.get(p) ?? '{}'),
      writeFile: (p, s) => { files.set(p, s); return Promise.resolve(); },
      now: () => 1,
    };
    __setPythonIo(io);
    spawnCollect.mockImplementation(async (_cmd: string, args: string[]) => {
      const dest = args[args.indexOf('--install-dir') + 1];
      files.set(dest + '/bin/python3', '#');
      return { stdout: '', stderr: '', code: 0 };
    });
    const py = await ensurePython();
    expect(py).toMatch(/python\/bin\/python3$/);
    expect(spawnCollect).toHaveBeenCalledWith('uv', expect.arrayContaining(['python', 'install']), expect.anything());
  });
});
