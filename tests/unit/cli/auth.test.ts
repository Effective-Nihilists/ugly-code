import { describe, it, expect, vi } from 'vitest';

const { readFile } = vi.hoisted(() => ({ readFile: vi.fn() }));
vi.mock('node:fs/promises', () => ({ readFile }));
vi.mock('node:child_process', () => ({ execFile: vi.fn() }));

import { resolveAuth } from '../../../client/cli/auth';

const HOME = process.env.HOME ?? process.env.USERPROFILE ?? '.';

describe('resolveAuth', () => {
  it('prefers an explicit token', async () => {
    const r = await resolveAuth({ token: 'T', origin: 'https://x' });
    expect(r.token).toBe('T');
  });
  it('reads ~/.ugly-bot/auth.json when no flag', async () => {
    readFile.mockImplementation((p: string) =>
      p === `${HOME}/.ugly-bot/auth.json` ? Promise.resolve(JSON.stringify({ token: 'STORED' })) : Promise.reject(new Error('ENOENT')),
    );
    const r = await resolveAuth({ origin: 'https://x' });
    expect(r.token).toBe('STORED');
  });
  it('throws a login hint when nothing resolves', async () => {
    readFile.mockRejectedValue(new Error('ENOENT'));
    await expect(resolveAuth({ origin: 'https://x' })).rejects.toThrow(/ugly-code --login/);
  });
});
