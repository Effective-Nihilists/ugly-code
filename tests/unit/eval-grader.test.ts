import { describe, expect, it } from 'vitest';
import { gradeProject, type GradeDeps } from '../../client/studio/evals/grader';
import type { EvalGate } from '../../client/studio/evals/registry';

const RUN_TOTALS = {
  durationMs: 0,
  turns: 1,
  cost: { total: 0, input: 0, output: 0, cacheRead: 0 },
  tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
};

/** Build deps from canned reactions keyed by the command and by file. */
function deps(over: {
  run?: (cmd: string, args: string[]) => { out: string; code: number | null };
  files?: Record<string, string>;
}): GradeDeps {
  const files = over.files ?? {};
  return {
    run: async (cmd, args) => over.run?.(cmd, args) ?? { out: '', code: 0 },
    readFile: async (p) => {
      const hit = Object.entries(files).find(([k]) => p.endsWith(k));
      if (!hit) throw new Error('ENOENT ' + p);
      return hit[1];
    },
    exists: async (p) => Object.keys(files).some((k) => p.endsWith(k)),
  };
}

function grade(gates: EvalGate[], d: GradeDeps) {
  return gradeProject({ taskName: 't', projectPath: '/proj', gates, runTotals: RUN_TOTALS }, d);
}

describe('eval grader — deterministic gates', () => {
  it('tsc gate passes on a clean compile, contributes its points', async () => {
    const r = await grade([{ name: 'tsc clean', points: 2, kind: 'tsc' }], deps({ run: () => ({ out: 'ok', code: 0 }) }));
    expect(r.checks?.[0]).toMatchObject({ name: 'tsc clean', passed: true });
    expect(r.tscErrors).toBe(0);
    expect(r.score).toBe(2);
    expect(r.scoreMax).toBe(2);
  });

  it('tsc gate fails + counts errors + samples output', async () => {
    const out = "src/a.ts(1,1): error TS2322: bad\nsrc/b.ts(2,2): error TS1005: bad";
    const r = await grade([{ name: 'tsc clean', points: 2, kind: 'tsc' }], deps({ run: () => ({ out, code: 1 }) }));
    expect(r.checks?.[0]?.passed).toBe(false);
    expect(r.tscErrors).toBe(2);
    expect(r.tscErrorSample).toContain('error TS2322');
    expect(r.score).toBe(0);
  });

  it('vitest:<file> runs the specific file and scores on exit 0', async () => {
    const seen: string[][] = [];
    const d = deps({
      run: (_c, args) => {
        seen.push(args);
        return { out: '', code: 0 };
      },
    });
    const r = await grade([{ name: 'tests', points: 3, kind: 'vitest:src/x.test.ts' }], d);
    expect(seen[0]).toEqual(['vitest', 'run', 'src/x.test.ts']);
    expect(r.score).toBe(3);
  });

  it('fileExists + fileMatches evaluate against the project files', async () => {
    const d = deps({ files: { 'package.json': '{"dependencies":{"drizzle-orm":"^1"}}', 'DECISION.md': '# decision' } });
    const r = await grade(
      [
        { name: 'decision present', points: 1, kind: 'fileExists:DECISION.md' },
        { name: 'drizzle in deps', points: 1, kind: 'fileMatches:package.json:drizzle' },
        { name: 'missing', points: 1, kind: 'fileExists:NOPE.md' },
      ],
      d,
    );
    expect(r.checks?.map((c) => c.passed)).toEqual([true, true, false]);
    expect(r.score).toBe(2);
    expect(r.scoreMax).toBe(3);
  });

  it('judge gates are surfaced (pending), counted in max but awarded 0', async () => {
    const r = await grade([{ name: 'rubric', points: 4, kind: 'judge:decision-rubric' }], deps({}));
    expect(r.judgeResults?.[0]).toMatchObject({ gateName: 'rubric', points: 4, pointsAwarded: 0, rubricKey: 'decision-rubric' });
    expect(r.score).toBe(0);
    expect(r.scoreMax).toBe(4);
    expect(r.summary).toMatch(/judge/i);
  });

  it('custom gates become manual checks', async () => {
    const r = await grade([{ name: 'seed runs', points: 2, kind: 'custom:seed' }], deps({}));
    expect(r.checks?.[0]).toMatchObject({ name: 'seed runs', passed: false });
    expect(r.checks?.[0]?.detail).toMatch(/manual/i);
  });

  it('no gates → universal tsc + npm test signals', async () => {
    const calls: string[] = [];
    const d = deps({
      run: (cmd, args) => {
        calls.push(`${cmd} ${args.join(' ')}`);
        return { out: '', code: 0 };
      },
    });
    const r = await grade([], d);
    expect(calls.some((c) => c.startsWith('npx tsc'))).toBe(true);
    expect(calls.some((c) => c.startsWith('npm test'))).toBe(true);
    expect(r.scoreMax).toBe(2);
    expect(r.score).toBe(2);
  });
});
