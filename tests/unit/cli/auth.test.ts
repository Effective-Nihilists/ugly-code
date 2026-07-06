import { describe, it, expect, vi } from 'vitest';

const store: Record<string, string> = {};
vi.mock('ugly-app/native', () => ({
  native: { fs: { readFile: (p: string) => (store[p] ? Promise.resolve(store[p]) : Promise.reject(new Error('ENOENT'))) } },
}));
vi.mock('../../../client/agent/tools/spawn', () => ({ spawnCollect: vi.fn() }));

import { resolveAuth } from '../../../client/cli/auth';

const HOME = process.env.HOME ?? process.env.USERPROFILE ?? '.';

describe('resolveAuth', () => {
  it('prefers an explicit token', async () => {
    const r = await resolveAuth({ token: 'T', origin: 'https://x' });
    expect(r.token).toBe('T');
  });
  it('reads ~/.ugly-bot/auth.json when no flag', async () => {
    store[`${HOME}/.ugly-bot/auth.json`] = JSON.stringify({ token: 'STORED' });
    const r = await resolveAuth({ origin: 'https://x' });
    expect(r.token).toBe('STORED');
  });
  it('throws a login hint when nothing resolves', async () => {
    delete store[`${HOME}/.ugly-bot/auth.json`];
    await expect(resolveAuth({ origin: 'https://x' })).rejects.toThrow(/ugly-code --login/);
  });
});
