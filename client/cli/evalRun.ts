// The eval run: clone the task's fixture, drive the agent's turns in-process, then
// grade the on-disk project with the existing gradeProject. Turn data is persisted
// by the CLI's filesystem session store (installed in bootDriver), not the server.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { getEvalTask, firstTurnPrompt } from '../studio/evals/registry';
import { gradeProject, type GradeDeps } from '../studio/evals/grader';
import type { EvalGradeResult } from '../studio/shared/api';
import { spawnCollect } from '../agent/tools/spawn';
import { bootDriver, runTurn } from './taskDriver';
import { setSessionToolset, setSessionEval } from '../studio/agent/clientAgent';
import { isToolset } from '../studio/agent/toolsets';
import { appendRunHistory } from '../studio/evals/history';

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

export interface EvalRunResult { score: number; scoreMax: number; costUsd: number; turns: number }

/** Read the run's cost + turn count from the fs session store's metadata. */
async function readRunTotals(storeRoot: string, sessionId: string): Promise<{ costUsd: number; turns: number }> {
  const dir = sessionId.replace(/[^a-zA-Z0-9_.:-]/g, '_');
  try {
    const m = JSON.parse(await readFile(`${storeRoot}/${dir}/metadata.json`, 'utf8')) as { costUsd?: number; messageCount?: number };
    return { costUsd: m.costUsd ?? 0, turns: m.messageCount ?? 0 };
  } catch {
    return { costUsd: 0, turns: 0 };
  }
}

export async function runEval(cfg: { taskName: string; origin: string; token: string; model?: string; pattern?: string; toolset?: string }): Promise<EvalRunResult> {
  const task = getEvalTask(cfg.taskName);
  if (!task) throw new Error(`Unknown eval task: ${cfg.taskName}`);
  const projectPath = await cloneFixture(task.name, task.repoUrl);
  const sessionId = `cli:${task.name}:${Date.now()}`;
  const storeRoot = `${process.env.HOME ?? '.'}/.ugly-code/session`;
  await bootDriver({ projectPath, sessionId, origin: cfg.origin, token: cfg.token, storeRoot });
  setSessionEval(sessionId, true); // every CLI run is an eval → criteria judge active under SBV
  if (cfg.toolset && isToolset(cfg.toolset)) setSessionToolset(sessionId, cfg.toolset);
  const selection = cfg.pattern ? { patternMode: cfg.pattern as never } : undefined;
  const turns = [firstTurnPrompt(task), ...task.turns.slice(1)];
  for (const turn of turns) {
    await runTurn(sessionId, turn, () => { /* transcript persisted by the fs store */ }, selection);
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
  const totals = await readRunTotals(storeRoot, sessionId);
  const nowIso = new Date().toISOString();
  await appendRunHistory({
    taskName: task.name,
    projectName: projectPath.split('/').pop() ?? task.name,
    projectPath,
    sessionId,
    createdAt: nowIso,
    gradedAt: nowIso,
    score: result.score ?? 0,
    scoreMax: result.scoreMax ?? 0,
    costUsd: totals.costUsd,
    turns: totals.turns,
    config: [cfg.model, cfg.pattern, cfg.toolset].filter(Boolean).join('/') || 'default',
  }).catch(() => undefined);
  return { score: result.score ?? 0, scoreMax: result.scoreMax ?? 0, ...totals };
}
