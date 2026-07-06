import { describe, it, expect, vi } from 'vitest';

const { gradeProject, bootDriver, runTurn, spawnCollect } = vi.hoisted(() => ({
  gradeProject: vi.fn(async () => ({ score: 1, scoreMax: 1 })),
  bootDriver: vi.fn(),
  runTurn: vi.fn(async () => {}),
  spawnCollect: vi.fn(async () => ({ stdout: '/tmp/demo-1', stderr: '', code: 0 })),
}));

vi.mock('../../../client/studio/evals/registry', () => ({
  getEvalTask: (n: string) =>
    n === 'demo'
      ? { name: 'demo', turns: ['do it'], successCriteria: 'x', gates: [{ name: 'tsc', points: 1, kind: 'tsc' }], repoUrl: 'https://r.git', budget: { maxTurns: 5, maxCostUsd: 1, timeoutMs: 1000 } }
      : undefined,
  firstTurnPrompt: (t: { turns: string[] }) => t.turns[0],
}));
vi.mock('../../../client/studio/evals/grader', () => ({ gradeProject }));
vi.mock('../../../client/cli/taskDriver', () => ({ bootDriver, runTurn }));
vi.mock('../../../client/agent/tools/spawn', () => ({ spawnCollect }));
vi.mock('ugly-app/native', () => ({ native: { fs: {} } }));

import { runEval } from '../../../client/cli/evalRun';

describe('runEval', () => {
  it('clones, runs the first turn, and grades', async () => {
    const res = await runEval({ taskName: 'demo', origin: 'https://x', token: 'T' });
    expect(spawnCollect).toHaveBeenCalled();
    expect(bootDriver).toHaveBeenCalled();
    expect(runTurn).toHaveBeenCalledWith(expect.any(String), 'do it', expect.any(Function));
    expect(gradeProject).toHaveBeenCalled();
    expect(res).toEqual({ score: 1, scoreMax: 1 });
  });

  it('errors on unknown task', async () => {
    await expect(runEval({ taskName: 'nope', origin: 'https://x', token: 'T' })).rejects.toThrow(/Unknown eval task/);
  });
});
