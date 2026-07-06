// The eval run: clone the task's fixture, drive the agent's turns in-process, then
// grade the on-disk project with the existing gradeProject. Turn data is persisted
// by the CLI's filesystem session store (installed in bootDriver), not the server.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getEvalTask, firstTurnPrompt } from '../studio/evals/registry';
import { gradeProject, type GradeDeps } from '../studio/evals/grader';
import type { EvalGradeResult } from '../studio/shared/api';
import { spawnCollect } from '../agent/tools/spawn';
import { bootDriver, runTurn } from './taskDriver';

const execFileP = promisify(execFile);

const ZERO_TOTALS: EvalGradeResult['runTotals'] = {
  durationMs: 0,
  turns: 0,
  cost: { total: 0, input: 0, output: 0, cacheRead: 0 },
  tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
};

/** Clone the task's fixture repo into ~/.ugly-code/eval-projects/<task>-<stamp> and re-init git. */
async function cloneFixture(taskName: string, repoUrl: string | undefined): Promise<string> {
  const safe = taskName.replace(/[^a-zA-Z0-9_.-]/g, '_');
  const stamp = String(Date.now());
  const base = `$HOME/.ugly-code/eval-projects/${safe}-${stamp}`;
  const seedGit =
    `rm -rf .git && git init -b main -q && git add -A && ` +
    `git -c user.email=eval@ugly.bot -c user.name=eval commit -q -m "eval: seed ${safe}"`;
  const cmd = repoUrl
    ? `mkdir -p "$HOME/.ugly-code/eval-projects" && ` +
      `git clone --depth 1 "${repoUrl.replace(/"/g, '\\"')}" "${base}" && cd "${base}" && ` +
      `${seedGit} && pwd`
    : `mkdir -p "${base}" && cd "${base}" && ` +
      `printf '{"name":"%s","version":"0.0.0","private":true}\\n' "${safe}" > package.json && ` +
      `${seedGit} && pwd`;
  // Node child_process (not native.process) — this is CLI infra that runs before
  // the agent's UglyNative + permissions are installed.
  const { stdout } = await execFileP('bash', ['-lc', cmd], { maxBuffer: 16 * 1024 * 1024 });
  const path = stdout.trim().split('\n').pop() ?? '';
  if (!path) throw new Error('fixture clone failed (no path printed)');
  return path;
}

const cliGradeDeps: GradeDeps = {
  run: async (cmd, args, cwd) => {
    const r = await spawnCollect(cmd, args, { cwd });
    return { out: r.stdout + r.stderr, code: r.code };
  },
  readFile: async (p) => {
    const { native } = await import('ugly-app/native');
    return native.fs.readFile(p);
  },
  exists: async (p) => {
    const { native } = await import('ugly-app/native');
    return native.fs.exists(p);
  },
  // judge omitted for Plan 1 (judge: gates stay pending); Plan 4 wires the /api/agentStep judge.
};

export async function runEval(cfg: { taskName: string; origin: string; token: string; model?: string }): Promise<{ score: number; scoreMax: number }> {
  const task = getEvalTask(cfg.taskName);
  if (!task) throw new Error(`Unknown eval task: ${cfg.taskName}`);
  const projectPath = await cloneFixture(task.name, task.repoUrl);
  const sessionId = `cli:${task.name}:${Date.now()}`;
  const storeRoot = `${process.env.HOME ?? '.'}/.ugly-code/session`;
  await bootDriver({ projectPath, sessionId, origin: cfg.origin, token: cfg.token, storeRoot });
  const turns = [firstTurnPrompt(task), ...task.turns.slice(1)];
  for (const turn of turns) {
    await runTurn(sessionId, turn, () => { /* transcript persisted by the fs store */ });
  }
  const result = await gradeProject(
    {
      taskName: task.name,
      projectPath,
      ...(task.gates ? { gates: task.gates } : {}),
      ...(task.successCriteria ? { successCriteria: task.successCriteria } : {}),
      runTotals: ZERO_TOTALS,
    },
    cliGradeDeps,
  );
  return { score: result.score ?? 0, scoreMax: result.scoreMax ?? 0 };
}
