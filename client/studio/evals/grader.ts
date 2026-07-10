// Client-side eval grader. Runs the task's `gates[]` against the project on
// disk (via native process/fs) and produces the EvalGradeResult the scorecard
// renders. Deterministic gate kinds are auto-scored; judge/custom gates are
// surfaced for manual review (the LLM-judge + repo-specific checkers are a
// follow-up). When a task defines no gates we still run tsc + the test script
// as universal signals so every run gets a score.

import type { EvalGate } from './registry';
import type { EvalGradeResult } from '../shared/api';
import { deriveCriteria, gradeAgainstCriteria, type Judge as JudgeFn } from '../agent/patterns/judge';
import { getMutationSuite } from './l6/mutation';
import { getHiddenSuite } from './l6/hidden';

/** IO seam so the gate logic is unit-testable without a real daemon. */
export interface GradeDeps {
  /** Run a command in `cwd`; resolve combined output + exit code. */
  run(cmd: string, args: string[], cwd: string): Promise<{ out: string; code: number | null }>;
  readFile(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  /** Required by the `mutationScore` / `hiddenTests` gates, which write files into the project. */
  writeFile?(path: string, content: string): Promise<void>;
  /**
   * One-shot LLM completion for `judge:*` gates. Omitted in unit tests (judge
   * gates then stay pending); in production it calls the model via the agent's
   * textGen path. Returns the raw model text.
   */
  judge?(system: string, user: string): Promise<string>;
}

interface Check { name: string; passed: boolean; detail?: string }
type Judge = NonNullable<EvalGradeResult['judgeResults']>[number];

const COUNT_TS_ERRORS = /error TS\d+:/g;
function countTscErrors(out: string): number {
  return (out.match(COUNT_TS_ERRORS) ?? []).length;
}

/** Parse a vitest run's summary line into pass/total counts, for proportional
 *  (0–N) scoring of a fixture's own vector suite. Reads the last `Tests …` line:
 *  `Tests  30 passed | 20 failed (50)` → {30, 50}. Total falls back to
 *  passed+failed when the `(N)` is absent; {0,0} when no suite ran. */
export function parseVitestCounts(out: string): { passed: number; total: number } {
  const line = out.split('\n').reverse().find((l) => /Tests\s+\d+\s+(passed|failed)/.test(l)) ?? '';
  const passed = Number(/(\d+)\s+passed/.exec(line)?.[1] ?? 0);
  const failed = Number(/(\d+)\s+failed/.exec(line)?.[1] ?? 0);
  const totalMatch = /\((\d+)\)/.exec(line);
  const total = totalMatch ? Number(totalMatch[1]) : passed + failed;
  return { passed, total };
}

/** `fileMatches:<path>:<regex>` — split off the path, the rest is the regex
 *  (which may itself contain colons). */
function splitFileMatches(rest: string): { path: string; regex: string } {
  const i = rest.indexOf(':');
  return i === -1 ? { path: rest, regex: '' } : { path: rest.slice(0, i), regex: rest.slice(i + 1) };
}

export interface GradeInput {
  taskName: string;
  projectPath: string;
  gates?: EvalGate[];
  /** Prose success criteria — given to the LLM judge as the rubric. */
  successCriteria?: string;
  /** The agent's final assistant message — extra evidence for judge grading of
   *  planning / write-to-spec tasks where the "output" isn't a code diff. */
  finalText?: string;
  runTotals: EvalGradeResult['runTotals'];
}

/** Parse the judge's `{"points": n, "verdict": "..."}` reply, tolerant of
 *  code fences / prose around the JSON. */
export function parseJudge(text: string, max: number): { points: number; verdict: string } {
  const m = /\{[\s\S]*\}/.exec(text);
  if (m) {
    try {
      const o = JSON.parse(m[0]) as { points?: unknown; verdict?: unknown };
      const pts = Math.max(0, Math.min(max, Math.round(Number(o.points) || 0)));
      const v = o.verdict;
      const verdictRaw =
        typeof v === 'string'
          ? v
          : v == null
            ? ''
            : typeof v === 'object'
              ? JSON.stringify(v)
              : typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint'
                ? v.toString()
                : typeof v === 'symbol'
                  ? v.toString()
                  : (v as (...args: unknown[]) => unknown).toString();
      return { points: pts, verdict: verdictRaw.slice(0, 600) || 'no verdict' };
    } catch {
      /* fall through */
    }
  }
  return { points: 0, verdict: `unparseable judge reply: ${text.slice(0, 200)}` };
}

export async function gradeProject(input: GradeInput, deps: GradeDeps): Promise<EvalGradeResult> {
  const checks: Check[] = [];
  const judgeResults: Judge[] = [];
  let tscExit: number | null = null;
  let tscErrors = 0;
  let tscErrorSample: string | undefined;
  let detScore = 0;
  let detMax = 0;
  const manual: string[] = [];

  // Run + cache `tsc` / `vitest` once even if referenced by multiple gates.
  let tscRun: { out: string; code: number | null } | null = null;
  const tsc = async (): Promise<{ out: string; code: number | null }> => {
    tscRun ??= await deps.run('npx', ['tsc', '--noEmit'], input.projectPath);
    return tscRun;
  };

  const gates = input.gates ?? [];

  for (const gate of gates) {
    const kind = gate.kind;
    const pts = gate.points;

    if (kind === 'tsc') {
      const r = await tsc();
      tscExit = r.code;
      tscErrors = countTscErrors(r.out);
      const passed = r.code === 0 && tscErrors === 0;
      if (!passed) tscErrorSample = r.out.slice(0, 800);
      checks.push({ name: gate.name, passed, detail: passed ? undefined : `${tscErrors} type error(s)` });
      detMax += pts;
      if (passed) detScore += pts;
    } else if (kind === 'vitest' || kind.startsWith('vitest:')) {
      const file = kind.startsWith('vitest:') ? kind.slice('vitest:'.length) : '';
      const r = await deps.run('npx', ['vitest', 'run', ...(file ? [file] : [])], input.projectPath);
      const passed = r.code === 0;
      checks.push({ name: gate.name, passed, detail: passed ? undefined : `vitest exit ${r.code ?? 'null'}` });
      detMax += pts;
      if (passed) detScore += pts;
    } else if (kind === 'vitestScore' || kind.startsWith('vitestScore:')) {
      // Proportional pass-rate scoring against the fixture's own vitest suite
      // (e.g. rrule's 50 RFC-5545 vectors): award round(pts · passed/total) so a
      // partial implementation earns partial credit and improvements are visible.
      const file = kind.startsWith('vitestScore:') ? kind.slice('vitestScore:'.length) : '';
      const r = await deps.run('npx', ['vitest', 'run', ...(file ? [file] : [])], input.projectPath);
      const { passed: np, total: nt } = parseVitestCounts(r.out);
      const awarded = nt > 0 ? Math.round((pts * np) / nt) : 0;
      checks.push({ name: `${gate.name} (${np}/${nt})`, passed: nt > 0 && np === nt, detail: nt > 0 ? undefined : `no vitest suite ran (exit ${r.code ?? 'null'})` });
      detMax += pts;
      detScore += awarded;
    } else if (kind === 'mutationScore') {
      // Score the suite the agent WROTE by how many seeded bugs it catches.
      const r = await scoreMutations(input, deps, pts);
      checks.push({ name: r.label ? `${gate.name} (${r.label})` : gate.name, passed: r.passed, detail: r.detail });
      detMax += pts;
      detScore += r.awarded;
    } else if (kind === 'hiddenTests') {
      // Inject a regression suite the agent never saw, run it, remove it.
      const r = await runHiddenTests(input, deps, pts);
      checks.push({ name: r.label ? `${gate.name} (${r.label})` : gate.name, passed: r.passed, detail: r.detail });
      detMax += pts;
      detScore += r.awarded;
    } else if (kind.startsWith('diffBudget:')) {
      // Reward restraint: a surgical fix, not a rewrite of everything nearby.
      const [softS, hardS, dir = '.'] = kind.slice('diffBudget:'.length).split(':');
      const soft = Number(softS);
      const hard = Number(hardS);
      const changed = await countChangedLines(input.projectPath, dir, deps);
      const awarded = changed <= soft ? pts : changed >= hard ? 0 : Math.round((pts * (hard - changed)) / (hard - soft));
      checks.push({
        name: `${gate.name} (${changed} lines in ${dir}/)`,
        passed: changed <= soft,
        detail: changed <= soft ? undefined : `${changed} changed lines exceeds the ${soft}-line budget (zero at ${hard})`,
      });
      detMax += pts;
      detScore += awarded;
    } else if (kind.startsWith('unchanged:')) {
      const rel = kind.slice('unchanged:'.length);
      const st = await deps.run('git', ['status', '--porcelain', '--', rel], input.projectPath);
      const passed = st.out.trim() === '';
      checks.push({ name: gate.name, passed, detail: passed ? undefined : `${rel} was modified or deleted` });
      detMax += pts;
      if (passed) detScore += pts;
    } else if (kind.startsWith('fileExists:')) {
      const rel = kind.slice('fileExists:'.length);
      const passed = await deps.exists(joinPath(input.projectPath, rel));
      checks.push({ name: gate.name, passed, detail: passed ? undefined : `${rel} not found` });
      detMax += pts;
      if (passed) detScore += pts;
    } else if (kind.startsWith('fileMatches:')) {
      const { path, regex } = splitFileMatches(kind.slice('fileMatches:'.length));
      let passed = false;
      try {
        passed = new RegExp(regex).test(await deps.readFile(joinPath(input.projectPath, path)));
      } catch {
        passed = false;
      }
      checks.push({ name: gate.name, passed, detail: passed ? undefined : `/${regex}/ not in ${path}` });
      detMax += pts;
      if (passed) detScore += pts;
    } else if (kind.startsWith('judge:')) {
      const rubricKey = kind.slice('judge:'.length);
      if (deps.judge) {
        // Score against the success criteria + the gate description, given the
        // agent's diff as evidence.
        const diff = await collectDiff(input.projectPath, deps);
        const system =
          'You are a strict automated code-eval judge. Award an INTEGER number of points from 0 ' +
          `to ${pts} based ONLY on the criteria below. Respond with JSON only: ` +
          '{"points": <int>, "verdict": "<one sentence>"}.';
        const user =
          `## Success criteria\n${input.successCriteria ?? '(none provided)'}\n\n` +
          `## Gate: ${gate.name} (max ${pts} points)\n${gate.description ?? rubricKey}\n\n` +
          `## The agent's diff\n${diff || '(no changes detected)'}`;
        try {
          const awarded = parseJudge(await deps.judge(system, user), pts);
          judgeResults.push({ gateName: gate.name, points: pts, pointsAwarded: awarded.points, rubricKey, verdict: awarded.verdict });
        } catch (e) {
          // A judge that THROWS (transport/parse failure after retries) is
          // UNGRADED, not a genuine 0 — award 0 out of 0 so the gate is excluded
          // from the score max instead of silently docking the cell. Otherwise a
          // flaky judge call turns a correct solution into a spurious -1 point
          // (this is exactly what made glm's correct breaking-change fix read 4/5).
          console.error('[grader:judge]', JSON.stringify({ gateName: gate.name, rubricKey, points: pts, error: e instanceof Error ? e.message : String(e) }), e instanceof Error ? e.stack : undefined);
          judgeResults.push({ gateName: gate.name, points: 0, pointsAwarded: 0, rubricKey, verdict: `ungraded — judge unreachable, gate excluded from score: ${(e as Error).message}` });
          manual.push(`${gate.name} (judge unreachable)`);
        }
      } else {
        // No judge available (unit tests) — surface as pending.
        judgeResults.push({
          gateName: gate.name,
          points: pts,
          pointsAwarded: 0,
          rubricKey,
          verdict: 'LLM judge unavailable — review against the rubric manually.',
        });
        manual.push(gate.name);
      }
    } else {
      // custom:<id> — repo-specific checker; not generically runnable client-side.
      checks.push({ name: gate.name, passed: false, detail: 'manual: run the task’s eval/ checker' });
      manual.push(gate.name);
    }
  }

  // No gates defined → 5-level judge rubric: derive an acceptance rubric from
  // successCriteria, grade the diff (+ final message) per-criterion, map to 0–5.
  // Falls back to the coarse tsc+npm signals when no judge is available (unit
  // tests) or a rubric can't be derived.
  if (gates.length === 0) {
    let graded = false;
    if (deps.judge && input.successCriteria && input.successCriteria.trim().length > 0) {
      const judgeFn: JudgeFn = (system, user) => deps.judge!(system, user);
      const diff = await collectDiff(input.projectPath, deps);
      const evidence = input.finalText
        ? `${diff}\n\n## Agent's final message\n${input.finalText.slice(0, 8000)}`
        : diff;
      try {
        const criteria = await deriveCriteria(input.successCriteria, '', judgeFn);
        if (criteria.length >= 2) {
          const g = await gradeAgainstCriteria(input.successCriteria, criteria, evidence, judgeFn);
          if (g.parsed && g.verdicts.length > 0) {
            const stmt = new Map(criteria.map((c) => [c.id, c.statement]));
            for (const v of g.verdicts) {
              checks.push({
                name: `${v.id}: ${stmt.get(v.id) ?? ''}`.slice(0, 200),
                passed: v.pass,
                detail: v.reason + (v.evidence ? ` [${v.evidence}]` : ''),
              });
            }
            const passed = g.verdicts.filter((v) => v.pass).length;
            detScore = Math.round(5 * (passed / g.verdicts.length));
            detMax = 5;
            graded = true;
          }
        }
        if (!graded) {
          // Per-criterion derivation was too thin to grade — score the whole rubric
          // in one 0–5 call so every judge-capable run still yields a /5 (no /2 blip).
          const system =
            'You are a strict automated code-eval judge. Award an INTEGER from 0 to 5 for how fully ' +
            'the change satisfies the success criteria (5 = fully; 3 = mostly; 0 = not at all). ' +
            'Respond with JSON only: {"points": <int 0-5>, "verdict": "<one sentence>"}.';
          const user = `## Success criteria\n${input.successCriteria}\n\n## The agent's change + final message\n${evidence || '(no changes detected)'}`;
          const awarded = parseJudge(await deps.judge(system, user), 5);
          checks.push({ name: 'rubric (0–5)', passed: awarded.points >= 3, detail: awarded.verdict });
          detScore = awarded.points;
          detMax = 5;
          graded = true;
        }
      } catch (e) {
        console.error('[grader:judge0to5]', JSON.stringify({ taskName: input.taskName, error: e instanceof Error ? e.message : String(e) }), e instanceof Error ? e.stack : undefined);
      }
    }
    if (!graded) {
      // Coarse fallback (0–2): tsc clean for TS projects + the test script. tsc is
      // only counted when a tsconfig.json exists (else `npx tsc` fails spuriously).
      const isTsProject = await deps.exists(`${input.projectPath}/tsconfig.json`);
      if (isTsProject) {
        const r = await tsc();
        tscExit = r.code;
        tscErrors = countTscErrors(r.out);
        const tscOk = r.code === 0 && tscErrors === 0;
        if (!tscOk) tscErrorSample = r.out.slice(0, 800);
        checks.push({ name: 'tsc clean', passed: tscOk, detail: tscOk ? undefined : `${tscErrors} type error(s)` });
        detMax += 1;
        if (tscOk) detScore += 1;
      }
      const t = await deps.run('npm', ['test', '--silent'], input.projectPath);
      const testsOk = t.code === 0;
      checks.push({ name: 'tests pass', passed: testsOk, detail: testsOk ? undefined : `npm test exit ${t.code ?? 'null'}` });
      detMax += 1;
      if (testsOk) detScore += 1;
    }
  }

  const judgeMax = judgeResults.reduce((a, j) => a + j.points, 0);
  const judgeAwarded = judgeResults.reduce((a, j) => a + j.pointsAwarded, 0);
  const score = detScore + judgeAwarded;
  const scoreMax = detMax + judgeMax;
  const summary = buildSummary(detScore, detMax, judgeResults.length, manual);

  return {
    taskName: input.taskName,
    gradedAt: new Date().toISOString(),
    score,
    scoreMax,
    summary,
    checks,
    tscExit,
    tscErrors,
    ...(tscErrorSample ? { tscErrorSample } : {}),
    ...(judgeResults.length ? { judgeResults } : {}),
    runTotals: input.runTotals,
  };
}

function buildSummary(score: number, max: number, judgeCount: number, manual: string[]): string {
  let s = `Auto-graded ${score}/${max} deterministic point(s).`;
  if (judgeCount) s += ` ${judgeCount} LLM-judge gate(s) pending manual review.`;
  if (manual.length) s += ` Manual gates: ${manual.join(', ')}.`;
  return s;
}

function joinPath(base: string, rel: string): string {
  return `${base.replace(/\/$/, '')}/${rel.replace(/^\//, '')}`;
}

interface MutationOutcome {
  awarded: number;
  passed: boolean;
  label?: string;
  detail?: string;
}

/** Added + deleted lines under `dir`, counting files the agent created. */
async function countChangedLines(projectPath: string, dir: string, deps: GradeDeps): Promise<number> {
  await deps.run('git', ['add', '-A', '--', dir], projectPath);
  const r = await deps.run('git', ['diff', '--cached', '--numstat', '--', dir], projectPath);
  let total = 0;
  for (const line of r.out.split('\n')) {
    // Binary files report '-' for both counts; Number('-') is NaN → 0.
    const [add, del] = line.trim().split(/\s+/);
    total += (Number(add) || 0) + (Number(del) || 0);
  }
  return total;
}

/**
 * Run a regression suite the agent never saw. Vendored out of the fixture repo so
 * it cannot be read, tuned to, or deleted; written in, run, then removed so it
 * does not pollute the diff that later gates measure.
 */
async function runHiddenTests(input: GradeInput, deps: GradeDeps, pts: number): Promise<MutationOutcome> {
  const suite = getHiddenSuite(input.taskName);
  if (!suite) return { awarded: 0, passed: false, detail: `no hidden suite registered for ${input.taskName}` };
  if (!deps.writeFile) return { awarded: 0, passed: false, detail: 'grader deps lack writeFile — cannot inject hidden tests' };

  try {
    await deps.writeFile(joinPath(input.projectPath, suite.path), suite.content);
    const r = await deps.run('npx', ['vitest', 'run', suite.path], input.projectPath);
    const { passed: np, total: nt } = parseVitestCounts(r.out);
    if (nt === 0) return { awarded: 0, passed: false, detail: `hidden suite did not run (exit ${r.code ?? 'null'})` };
    return {
      // Floor, for the same reason as scoreMutations: a failing regression is a
      // failing regression, and must not round up to full credit.
      awarded: Math.floor((pts * np) / nt),
      passed: np === nt,
      label: `${np}/${nt}`,
      detail: np === nt ? undefined : `${nt - np} hidden regression test(s) failed`,
    };
  } finally {
    await deps.run('rm', ['-f', suite.path], input.projectPath);
  }
}

/**
 * Grade a test suite the agent wrote by *mutation score*: seed each hidden bug
 * into the reference implementation, one at a time, and check the suite goes red.
 * Coverage says a line ran; this says a wrong line would have been caught.
 *
 * Three ways to score zero, each of them the point of the task:
 *   - the implementation was edited (the suite "passes" because the goalposts moved)
 *   - the suite is red against the correct implementation (it asserts wrong behaviour)
 *   - the suite goes red on a behaviour-PRESERVING rewrite (it asserts on source
 *     text — hashing/snapshotting the file — to farm the mutation score)
 */
async function scoreMutations(input: GradeInput, deps: GradeDeps, pts: number): Promise<MutationOutcome> {
  const suite = getMutationSuite(input.taskName);
  if (!suite) return { awarded: 0, passed: false, detail: `no mutation suite registered for ${input.taskName}` };
  if (!deps.writeFile) return { awarded: 0, passed: false, detail: 'grader deps lack writeFile — cannot seed mutants' };
  const writeFile = deps.writeFile.bind(deps);

  const cwd = input.projectPath;
  const targetPath = joinPath(cwd, suite.target);
  const srcDir = suite.target.replace(/\/[^/]*$/, '');
  const vitest = (): Promise<{ out: string; code: number | null }> => deps.run('npx', ['vitest', 'run'], cwd);

  const status = await deps.run('git', ['status', '--porcelain', '--', srcDir], cwd);
  if (status.out.trim()) {
    return { awarded: 0, passed: false, detail: `${srcDir}/ was modified — the implementation is the contract, not the variable` };
  }

  const reference = await deps.readFile(targetPath);
  if ((await vitest()).code !== 0) {
    return { awarded: 0, passed: false, detail: 'suite is red against the correct implementation' };
  }

  try {
    for (const eq of suite.equivalents) {
      if (!reference.includes(eq.find)) continue;
      await writeFile(targetPath, reference.replace(eq.find, eq.replace));
      if ((await vitest()).code !== 0) {
        return {
          awarded: 0,
          passed: false,
          detail: `suite fails on behaviour-preserving rewrite '${eq.id}' — it asserts on the implementation's source text, not its behaviour`,
        };
      }
    }

    const survivors: string[] = [];
    for (const m of suite.mutants) {
      if (!reference.includes(m.find)) {
        survivors.push(`${m.id} (could not be applied — fixture drifted from the mutant set)`);
        continue;
      }
      await writeFile(targetPath, reference.replace(m.find, m.replace));
      if ((await vitest()).code === 0) survivors.push(`${m.id}: ${m.desc}`);
    }

    const total = suite.mutants.length;
    const killed = total - survivors.length;
    // FLOOR, not round: the task is "prove this module correct". A suite that misses
    // a bug has not proved it, and must not be rounded up to a perfect score — that
    // rounding is what let a 21/22 suite read as 5/5 and hid the whole gradient.
    return {
      awarded: Math.floor((pts * killed) / total),
      passed: killed === total,
      label: `${killed}/${total} bugs caught`,
      detail: survivors.length ? `survived:\n  - ${survivors.join('\n  - ')}` : undefined,
    };
  } finally {
    await writeFile(targetPath, reference);
  }
}

/** Paths the judge should never see — installed deps, build output, the agent's
 *  isolated worktrees, and leaked session logs. Excluded from BOTH the stage and
 *  the diff so they don't crowd out the real change under the 20k-char cap
 *  (node_modules sorts before src/, so without this it fills the whole budget and
 *  the actual edit gets truncated away → the judge scores a correct fix as 0). */
const DIFF_EXCLUDES = [
  ':(exclude)node_modules',
  ':(exclude)dist',
  ':(exclude).ugly-studio',
  ':(exclude)*.jsonl',
  // Lockfiles: an agent that runs `npm/pnpm install` regenerates a huge lockfile
  // that sorts before src/ and would eat the whole 20k-char cap, truncating the
  // actual code change out of the judge's view (a correct fix then scores 0).
  ':(exclude)package-lock.json',
  ':(exclude)**/package-lock.json',
  ':(exclude)pnpm-lock.yaml',
  ':(exclude)**/pnpm-lock.yaml',
  ':(exclude)yarn.lock',
  ':(exclude)**/yarn.lock',
];

/** The agent's changes (capped) — evidence for the LLM judge. Stages everything
 *  first (`git add -A`) then diffs the index, so NEW/untracked files the agent
 *  wrote (e.g. DESIGN.md / DECISION.md for planning + write-to-spec tasks) are
 *  included — plain `git diff` only shows modified tracked files and would feed
 *  the judge an empty diff for doc-producing tasks. `cloneFixture` commits a
 *  baseline seed, so `--cached` diffs against that; with no baseline commit it
 *  diffs against the empty tree (still shows the new files). Junk dirs
 *  (node_modules/dist/…) are excluded so real edits survive the cap. */
async function collectDiff(projectPath: string, deps: GradeDeps): Promise<string> {
  await deps.run('git', ['add', '-A', '--', '.', ...DIFF_EXCLUDES], projectPath);
  // A --stat summary FIRST, so the judge always sees the COMPLETE set of changed
  // files + line counts even when the detailed diff below is truncated. `git diff`
  // orders files alphabetically, so late-sorting dirs (server/, shared/) fall off
  // the cap on a large build and the judge wrongly concludes that logic is absent
  // (e.g. "the server-side AI call isn't present") — a systematic under-grade of
  // big builds. This was self-identified by the improve-harness eval itself.
  const stat = (await deps.run('git', ['diff', '--cached', '--stat', '--', '.', ...DIFF_EXCLUDES], projectPath)).out;
  const r = await deps.run('git', ['diff', '--cached', '--no-color', '--', '.', ...DIFF_EXCLUDES], projectPath);
  // 60KB default (was 20KB — too small for a full-app build, which truncated the
  // graded logic). Override via UGLY_GRADER_DIFF_CAP. ~15k tokens for the judge.
  const CAP = Number(process.env.UGLY_GRADER_DIFF_CAP) || 60_000;
  const detail = r.out.length > CAP
    ? r.out.slice(0, CAP) + `\n…(diff detail truncated at ${CAP} chars — consult the complete file summary above; do NOT assume a file not shown here is missing or stubbed)`
    : r.out;
  return `## Changed files (complete list)\n${stat}\n\n## Diff detail\n${detail}`;
}
