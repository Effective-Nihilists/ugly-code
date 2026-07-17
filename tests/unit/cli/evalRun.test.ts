import { describe, it, expect, vi } from 'vitest';

const { gradeProject, bootDriver, runTurn, execFile } = vi.hoisted(() => ({
  gradeProject: vi.fn(async () => ({ score: 1, scoreMax: 1 })),
  bootDriver: vi.fn(async () => {}),
  runTurn: vi.fn(async () => {}),
  execFile: vi.fn(
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb: (e: unknown, r: { stdout: string; stderr: string }) => void,
    ) => cb(null, { stdout: '/tmp/demo-1', stderr: '' }),
  ),
}));

vi.mock('../../../client/studio/evals/registry', () => ({
  getEvalTask: (n: string) =>
    n === 'demo'
      ? {
          name: 'demo',
          turns: ['do it'],
          successCriteria: 'x',
          gates: [{ name: 'tsc', points: 1, kind: 'tsc' }],
          repoUrl: 'https://r.git',
          budget: { maxTurns: 5, maxCostUsd: 1, timeoutMs: 1000 },
        }
      : undefined,
  firstTurnPrompt: (t: { turns: string[] }) => t.turns[0],
}));
vi.mock('../../../client/studio/evals/grader', () => ({ gradeProject }));
vi.mock('../../../client/cli/taskDriver', () => ({ bootDriver, runTurn }));
vi.mock('../../../client/agent/tools/spawn', () => ({ spawnCollect: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile }));
vi.mock('node:fs/promises', () => ({
  readFile: async () => {
    throw new Error('ENOENT');
  },
}));
vi.mock('ugly-app/native', () => ({ native: { fs: {} } }));

import { runEval } from '../../../client/cli/evalRun';

describe('runEval', () => {
  it('clones, runs the first turn, and grades', async () => {
    const res = await runEval({
      taskName: 'demo',
      origin: 'https://x',
      token: 'T',
    });
    expect(execFile).toHaveBeenCalled(); // fixture clone (node child_process)
    expect(bootDriver).toHaveBeenCalled();
    // Eval runs force branchMode 'main' so the agent edits the cloned project dir
    // the grader inspects (not an isolated worktree). See evalRun.ts `selection`.
    expect(runTurn).toHaveBeenCalledWith(
      expect.any(String),
      'do it',
      expect.any(Function),
      { branchMode: 'main' },
    );
    expect(gradeProject).toHaveBeenCalled();
    expect(res).toEqual({
      score: 1,
      scoreMax: 1,
      costUsd: 0,
      turns: 0,
      resolvedPattern: null,
    });
  });

  it('errors on unknown task', async () => {
    await expect(
      runEval({ taskName: 'nope', origin: 'https://x', token: 'T' }),
    ).rejects.toThrow(/Unknown eval task/);
  });
});
