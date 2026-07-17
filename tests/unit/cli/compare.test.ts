import { describe, it, expect, vi } from 'vitest';
import { runComparison, renderScoreboard } from '../../../client/cli/compare';
import type { EvalRunResult } from '../../../client/cli/evalRun';

describe('runComparison', () => {
  it('runs every task × config cell and tags each result', async () => {
    const runOne = vi.fn(
      async (c: {
        taskName: string;
        pattern?: string;
      }): Promise<EvalRunResult> => ({
        score: c.pattern === 'spec-build-verify' ? 1 : 2,
        scoreMax: 2,
        costUsd: c.pattern === 'spec-build-verify' ? 0.003 : 0.001,
        turns: 5,
      }),
    );
    const r = await runComparison(
      {
        tasks: ['t1'],
        configs: [
          { label: 'flat', pattern: 'none' },
          { label: 'sbv', pattern: 'spec-build-verify' },
        ],
      },
      { origin: 'x', token: 'T', ranAt: 1 },
      runOne,
    );
    expect(runOne).toHaveBeenCalledTimes(2);
    expect(r.cells.map((c) => c.config)).toEqual(['flat', 'sbv']);
    expect(r.cells[1].score).toBe(1);
  });

  it('records a zero cell when a run throws', async () => {
    const runOne = vi.fn(async () => {
      throw new Error('boom');
    });
    const r = await runComparison(
      { tasks: ['t1'], configs: [{ label: 'flat' }] },
      { origin: 'x', token: 'T', ranAt: 1 },
      runOne,
    );
    expect(r.cells[0]).toMatchObject({
      task: 't1',
      config: 'flat',
      score: 0,
      scoreMax: 0,
    });
  });
});

describe('renderScoreboard', () => {
  it('renders a task × config table with score/cost/turns cells', () => {
    const table = renderScoreboard({
      ranAt: 1,
      cells: [
        {
          task: 't1',
          config: 'flat',
          score: 2,
          scoreMax: 2,
          costUsd: 0.001,
          turns: 5,
        },
        {
          task: 't1',
          config: 'sbv',
          score: 1,
          scoreMax: 2,
          costUsd: 0.003,
          turns: 12,
        },
      ],
    });
    expect(table).toContain('flat');
    expect(table).toContain('sbv');
    expect(table).toContain('2/2 $0.0010 5t');
    expect(table).toContain('1/2 $0.0030 12t');
  });
});
