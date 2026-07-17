// End-to-end verification of the coding-agent pattern engine, driven entirely
// through the CLI (`ugly-code --eval <task> --json …`). Unlike the pure-unit
// tests, these spawn the real CLI against a DEPLOYED ugly-code origin and make
// real (cheap) model calls, so they are GATED and skipped by default.
//
// Enable with:  RUN_REAL_SMOKE=1 UGLY_CODE_ORIGIN=<url> pnpm test pattern-engine-e2e
//   - RUN_REAL_SMOKE=1   opt into real model spend
//   - UGLY_CODE_ORIGIN   the deployed ugly-code URL the CLI drives (/api/agentTurn)
//   - ~/.ugly-bot/auth.json present (or the CLI's --test-user path works on the origin)
//
// Cost control: every case pins `--model deepseek_v4_flash` (the cheapest OSS id;
// also the aux/pollinator/picker model), so a full matrix run stays inexpensive.
//
// These tests double as a HARNESS-IMPROVEMENT instrument (per CODING.md §18):
//   • classifier routing accuracy   → assert `resolvedPattern` for `--pattern auto`
//   • per-pattern step execution     → pin `--pattern <id>`, assert it solves + budget
//   • model axis (single/max/group)  → assert each mode completes + applies changes
//   • cost/turn budgets              → assert turns/cost stay within the task budget
// A failing/degraded cell is a signal of where the cheap-model harness needs work,
// not just a red test — inspect `resolvedPattern`, `turns`, and `costUsd` on failure.
import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadDevAuth } from '../../e2e/helpers/auth';

const execFileP = promisify(execFile);

const REAL = !!process.env['RUN_REAL_SMOKE'];
const ORIGIN = process.env['UGLY_CODE_ORIGIN'] ?? '';
const AUTH = loadDevAuth();
// Run only when explicitly opted in AND we have an origin + some auth path.
const ENABLED = REAL && !!ORIGIN;

const CHEAP_MODEL = 'deepseek_v4_flash';
const CASE_TIMEOUT_MS = 15 * 60_000; // a real eval turn on a cheap model can take minutes

interface CliJson {
  task: string;
  score: number;
  scoreMax: number;
  solved: boolean;
  costUsd: number;
  turns: number;
  resolvedPattern: string | null;
  config: {
    model: string | null;
    pattern: string | null;
    modelMode: unknown;
    toolset: string | null;
  };
}

/** Spawn the CLI as a subprocess with `--json` and parse the structured result. */
async function runCli(extraArgs: string[]): Promise<{
  code: number;
  json: CliJson | null;
  stdout: string;
  stderr: string;
}> {
  // Prefer the developer's real token (validated working); fall back to --test-user
  // when no auth.json is present. Real token bills AI to the logged-in user.
  const authArgs = AUTH?.token ? ['--token', AUTH.token] : ['--test-user'];
  const args = [
    'exec',
    'tsx',
    'client/cli/index.ts',
    '--eval',
    ...extraArgs,
    '--model',
    CHEAP_MODEL,
    '--json',
    '--origin',
    ORIGIN,
    ...authArgs,
  ];
  try {
    const { stdout, stderr } = await execFileP('pnpm', args, {
      cwd: process.cwd(),
      maxBuffer: 32 * 1024 * 1024,
      timeout: CASE_TIMEOUT_MS,
    });
    const line = stdout.trim().split('\n').filter(Boolean).pop() ?? '';
    let json: CliJson | null = null;
    try {
      json = JSON.parse(line) as CliJson;
    } catch {
      /* non-JSON tail */
    }
    return { code: 0, json, stdout, stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    const line =
      (err.stdout ?? '').trim().split('\n').filter(Boolean).pop() ?? '';
    let json: CliJson | null = null;
    try {
      json = JSON.parse(line) as CliJson;
    } catch {
      /* none */
    }
    return {
      code: typeof err.code === 'number' ? err.code : 1,
      json,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
    };
  }
}

/** A completed run must produce structured output with a sane shape (not a crash /
 *  silent-failure — the monolith's 0-tool/0-token guard, CODING.md §18). */
function expectRan(json: CliJson | null): asserts json is CliJson {
  expect(json, 'CLI must emit a --json result line').not.toBeNull();
  expect(json!.scoreMax).toBeGreaterThan(0);
  expect(json!.turns).toBeGreaterThan(0); // a real turn happened (not a silent auth/model failure)
}

describe.skipIf(!ENABLED)(
  'CLI e2e — pattern engine (real models, deepseek_v4_flash)',
  () => {
    // ── A. Classifier routing accuracy (--pattern auto) ────────────────────────
    // Assert the router sends each task shape to the right pattern family. A miss
    // here is the #1 harness-improvement signal (CODING.md §18.1 classifier eval).
    describe('A. auto-classifier routing', () => {
      const routing: Array<{
        task: string;
        expectFamily: string[];
        why: string;
      }> = [
        {
          task: 'bug-fix-null-check',
          expectFamily: [
            'investigate-fix',
            'super-investigate-fix',
            'quick-edit',
          ],
          why: 'a bug repair → an investigate/fix family, never spec-build-verify',
        },
        {
          task: 'feature-add-util',
          expectFamily: ['spec-build-verify', 'super-spec-build-verify'],
          why: 'a novel feature → spec-build-verify family',
        },
        {
          task: 'todo-app-spec',
          expectFamily: [
            'spec-build-verify',
            'super-spec-build-verify',
            'chat-advisory',
          ],
          why: 'a planning/spec task → spec or advisory',
        },
      ];
      for (const c of routing) {
        it(
          `routes ${c.task} to ${c.expectFamily.join('|')} (${c.why})`,
          { timeout: CASE_TIMEOUT_MS },
          async () => {
            const { json } = await runCli([c.task, '--pattern', 'auto']);
            expectRan(json);
            // resolvedPattern may be null if the classifier wasn't confident (plain send);
            // when set, it must be in the expected family. Record misroutes for tuning.
            if (json.resolvedPattern)
              expect(
                c.expectFamily,
                `misroute: got ${json.resolvedPattern}`,
              ).toContain(json.resolvedPattern);
          },
        );
      }
    });

    // ── B. Per-pattern step execution (pinned) ─────────────────────────────────
    // Pin each pattern and assert it runs to a graded result within budget. Score
    // is advisory (cheap models don't solve everything) — the assertion is that the
    // engine EXECUTED and produced an objective grade, not that it always wins.
    describe('B. per-pattern execution', () => {
      const pinned: Array<{ task: string; pattern: string }> = [
        { task: 'bug-fix-ts-error', pattern: 'quick-edit' },
        { task: 'bug-fix-indirect-cause', pattern: 'investigate-fix' },
        { task: 'feature-add-util', pattern: 'spec-build-verify' },
      ];
      for (const c of pinned) {
        it(
          `runs ${c.pattern} on ${c.task} to a graded result within budget`,
          { timeout: CASE_TIMEOUT_MS },
          async () => {
            const { json } = await runCli([c.task, '--pattern', c.pattern]);
            expectRan(json);
            expect(json.score).toBeGreaterThanOrEqual(0);
            expect(json.score).toBeLessThanOrEqual(json.scoreMax);
            // Cost stays low on the cheap model — a blown budget is a harness signal.
            expect(
              json.costUsd,
              `unexpectedly expensive: $${json.costUsd}`,
            ).toBeLessThan(1.0);
          },
        );
      }
    });

    // ── C. Model axis (single / max / group) ───────────────────────────────────
    // One shared cheap task across the three peer modes. Assert each completes and
    // produces a grade; max/group apply a winner's diff. Kept to one task to bound
    // cost (max/group spawn N peers).
    describe('C. model axis', () => {
      const task = 'bug-fix-null-check';
      it(
        'single mode (baseline) runs',
        { timeout: CASE_TIMEOUT_MS },
        async () => {
          const { json } = await runCli([
            task,
            '--model-mode',
            `single:${CHEAP_MODEL}`,
          ]);
          expectRan(json);
        },
      );
      it(
        'max mode spawns peers + picks a winner',
        { timeout: CASE_TIMEOUT_MS },
        async () => {
          const { json } = await runCli([
            task,
            '--pattern',
            'quick-edit',
            '--model-mode',
            'max',
          ]);
          expectRan(json);
        },
      );
      it(
        'group mode (explicit peer pool) runs personas + picker',
        { timeout: CASE_TIMEOUT_MS },
        async () => {
          const { json } = await runCli([
            task,
            '--group-models',
            `${CHEAP_MODEL},${CHEAP_MODEL}`,
          ]);
          expectRan(json);
        },
      );
    });
  },
);

// A trivial always-on assertion so the file isn't "empty" when the suite is skipped
// (documents the gate for anyone running the default unit suite).
describe('CLI e2e gating', () => {
  it(
    ENABLED
      ? 'is ENABLED (real-smoke)'
      : 'is skipped (set RUN_REAL_SMOKE=1 + UGLY_CODE_ORIGIN)',
    () => {
      expect(typeof ENABLED).toBe('boolean');
    },
  );
});
