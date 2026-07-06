import { describe, it, expect, vi } from 'vitest';

const { runEval, resolveAuth } = vi.hoisted(() => ({
  runEval: vi.fn(async () => ({ score: 2, scoreMax: 2 })),
  resolveAuth: vi.fn(async () => ({ token: 'T', origin: 'https://x' })),
}));
vi.mock('../../../client/cli/evalRun', () => ({ runEval }));
vi.mock('../../../client/cli/auth', () => ({ resolveAuth }));

import { main, parseModelMode } from '../../../client/cli/evalCli';

describe('parseModelMode', () => {
  it('maps each --model-mode form to a modelMode union', () => {
    expect(parseModelMode(undefined, undefined)).toBeUndefined();
    expect(parseModelMode('auto', undefined)).toEqual({ kind: 'auto' });
    expect(parseModelMode('max', undefined)).toEqual({ kind: 'max' });
    expect(parseModelMode('single:deepseek_v4_flash', undefined)).toEqual({ kind: 'single', model: 'deepseek_v4_flash' });
    expect(parseModelMode('group', undefined)).toEqual({ kind: 'group', models: [] });
    expect(parseModelMode('bogus', undefined)).toBeUndefined();
  });
  it('--group-models wins and builds an explicit pool', () => {
    expect(parseModelMode(undefined, 'deepseek_v4_flash, glm_5_2 ,minimax_m2_7')).toEqual({
      kind: 'group',
      models: ['deepseek_v4_flash', 'glm_5_2', 'minimax_m2_7'],
    });
    // group-models overrides an explicit --model-mode
    expect(parseModelMode('max', 'a,b')).toEqual({ kind: 'group', models: ['a', 'b'] });
  });
});

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
