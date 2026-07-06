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

  it('judge gates are pending when no judge dep is available', async () => {
    const r = await grade([{ name: 'rubric', points: 4, kind: 'judge:decision-rubric' }], deps({}));
    expect(r.judgeResults?.[0]).toMatchObject({ gateName: 'rubric', points: 4, pointsAwarded: 0, rubricKey: 'decision-rubric' });
    expect(r.score).toBe(0);
    expect(r.scoreMax).toBe(4);
    expect(r.summary).toMatch(/judge/i);
  });

  it('judge gates call the LLM judge, parse points, and add to the score', async () => {
    const seen: { system: string; user: string }[] = [];
    const d: GradeDeps = {
      ...deps({ run: () => ({ out: 'diff --git a b', code: 0 }) }),
      judge: async (system, user) => {
        seen.push({ system, user });
        return 'Looks good.\n```json\n{"points": 3, "verdict": "covers most criteria"}\n```';
      },
    };
    const r = await gradeProject(
      {
        taskName: 't',
        projectPath: '/proj',
        gates: [{ name: 'rubric', points: 4, kind: 'judge:decision-rubric' }],
        successCriteria: 'Do the thing well.',
        runTotals: RUN_TOTALS,
      },
      d,
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.user).toContain('Do the thing well.'); // criteria fed to the judge
    expect(seen[0]?.user).toContain('diff --git'); // diff evidence fed in
    expect(r.judgeResults?.[0]).toMatchObject({ pointsAwarded: 3, verdict: 'covers most criteria' });
    expect(r.score).toBe(3);
    expect(r.scoreMax).toBe(4);
  });

  it('judge points are clamped to the gate max', async () => {
    const d: GradeDeps = { ...deps({}), judge: async () => '{"points": 99, "verdict": "great"}' };
    const r = await gradeProject(
      { taskName: 't', projectPath: '/p', gates: [{ name: 'g', points: 2, kind: 'judge:x' }], runTotals: RUN_TOTALS },
      d,
    );
    expect(r.judgeResults?.[0]?.pointsAwarded).toBe(2);
    expect(r.score).toBe(2);
  });

  it('custom gates become manual checks', async () => {
    const r = await grade([{ name: 'seed runs', points: 2, kind: 'custom:seed' }], deps({}));
    expect(r.checks?.[0]).toMatchObject({ name: 'seed runs', passed: false });
    expect(r.checks?.[0]?.detail).toMatch(/manual/i);
  });

  it('no gates + tsconfig → universal tsc + npm test signals (2 points)', async () => {
    const calls: string[] = [];
    const d = deps({
      files: { 'tsconfig.json': '{}' },
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

  it('no gates + NO tsconfig → skips tsc, scores on tests alone (1 point)', async () => {
    const calls: string[] = [];
    const d = deps({
      run: (cmd, args) => {
        calls.push(`${cmd} ${args.join(' ')}`);
        return { out: '', code: 0 };
      },
    });
    const r = await grade([], d);
    expect(calls.some((c) => c.startsWith('npx tsc'))).toBe(false); // tsc skipped for non-TS fixture
    expect(calls.some((c) => c.startsWith('npm test'))).toBe(true);
    expect(r.scoreMax).toBe(1);
    expect(r.score).toBe(1);
  });

  it('no gates + judge + successCriteria → 0–5 rubric score (round(5·passed/total))', async () => {
    const judge = async (system: string): Promise<string> =>
      system.includes('code-review judge')
        ? '[{"id":"C1","pass":true,"reason":"ok","evidence":"f:1"},{"id":"C2","pass":true,"reason":"ok"},{"id":"C3","pass":true,"reason":"ok"},{"id":"C4","pass":false,"reason":"missing"}]'
        : '[{"id":"C1","statement":"a","rationale":"x"},{"id":"C2","statement":"b","rationale":"y"},{"id":"C3","statement":"c","rationale":"z"},{"id":"C4","statement":"d","rationale":"w"}]';
    const d: GradeDeps = { ...deps({ run: () => ({ out: '', code: 0 }) }), judge };
    const r = await gradeProject(
      { taskName: 't', projectPath: '/p', successCriteria: 'do the thing with A, B, C, and D', runTotals: RUN_TOTALS },
      d,
    );
    expect(r.scoreMax).toBe(5);
    expect(r.score).toBe(4); // 3/4 pass → round(3.75) = 4
    expect(r.checks?.some((c) => c.name.includes('C4') && !c.passed)).toBe(true);
  });
});
