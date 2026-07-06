import { describe, it, expect, vi } from 'vitest';

const { runEval, resolveAuth } = vi.hoisted(() => ({
  runEval: vi.fn(async () => ({ score: 2, scoreMax: 2 })),
  resolveAuth: vi.fn(async () => ({ token: 'T', origin: 'https://x' })),
}));
vi.mock('../../../client/cli/evalRun', () => ({ runEval }));
vi.mock('../../../client/cli/auth', () => ({ resolveAuth }));

import { main } from '../../../client/cli/evalCli';

describe('evalCli', () => {
  it('routes `--eval <task>` through auth + runEval, exit 0 on full score', async () => {
    const code = await main(['--eval', 'demo', '--origin', 'https://x']);
    expect(resolveAuth).toHaveBeenCalled();
    expect(runEval).toHaveBeenCalledWith(expect.objectContaining({ taskName: 'demo', token: 'T' }));
    expect(code).toBe(0);
  });

  it('errors (exit 2) when no origin is available', async () => {
    delete process.env.UGLY_CODE_ORIGIN;
    expect(await main(['--eval', 'demo'])).toBe(2);
  });

  it('returns usage (exit 2) with no recognized command', async () => {
    expect(await main([])).toBe(2);
  });
});
