import { describe, it, expect, vi } from 'vitest';

vi.mock('ugly-app/native', () => ({ native: { fs: {} } }));
vi.mock('../../../client/agent/tools/spawn', () => ({ spawnCollect: vi.fn() }));

import {
  ensureBinary,
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
    now: () => 1000,
  };
}

describe('ensureBinary', () => {
  it('installs when absent, then records the manifest', async () => {
    const io = memIo();
    const installer = vi.fn((dest: string) => {
      io.files.set(dest + '/bin/python3', '#');
      return Promise.resolve();
    });
    const dir = await ensureBinary('python', installer, io);
    expect(installer).toHaveBeenCalledTimes(1);
    expect(dir).toMatch(/binaries\/.*\/python$/);
    const manifestKey = [...io.files.keys()].find((k) =>
      k.endsWith('manifest.json'),
    )!;
    const manifest = JSON.parse(io.files.get(manifestKey)!) as Record<
      string,
      { installedAt: number }
    >;
    expect(manifest.python.installedAt).toBe(1000);
  });

  it('is a no-op when already installed (installer not called)', async () => {
    const io = memIo();
    const installer = vi.fn((dest: string) => {
      io.files.set(dest + '/bin/python3', '#');
      return Promise.resolve();
    });
    await ensureBinary('python', installer, io);
    installer.mockClear();
    await ensureBinary('python', installer, io);
    expect(installer).not.toHaveBeenCalled();
  });

  it('serializes concurrent installs of the same binary (installer called once)', async () => {
    const io = memIo();
    let running = 0;
    let maxConcurrent = 0;
    const installer = vi.fn(async (dest: string) => {
      running++;
      maxConcurrent = Math.max(maxConcurrent, running);
      await Promise.resolve();
      io.files.set(dest + '/bin/python3', '#');
      running--;
    });
    await Promise.all([
      ensureBinary('python', installer, io),
      ensureBinary('python', installer, io),
    ]);
    expect(maxConcurrent).toBe(1);
    expect(installer).toHaveBeenCalledTimes(1);
  });
});
