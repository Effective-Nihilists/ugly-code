/**
 * Per-session workspace isolation (ported from the monolith's coding-agent
 * worktree). A non-main session runs in its own git worktree (separate branch +
 * directory) so parallel sessions don't clobber each other's files/branch; the
 * "main" session runs on the project itself (the canonical repo surface).
 *
 * The slow-but-reliable path: after `git worktree add` we run a real
 * `pnpm/npm install` in the worktree (NOT a node_modules symlink — that breaks
 * vite's file watcher and the live Preview). Install output streams to a
 * progress callback so the UI can show it. Everything is fail-safe: if the repo
 * isn't a git repo, or any step fails, the session falls back to the project dir
 * (no isolation, but the agent still works).
 *
 * Each session also gets a deterministic unique PORT (injected into the env of
 * the agent's run_command spawns, so `pnpm dev` binds it) which the Preview tab
 * loads as http://localhost:<port>.
 */

import { native } from 'ugly-app/native';
import { sessionApi, resolveProjectId } from './serverSessionApi';

export interface SessionWorkspace {
  /** The absolute dir the session's tools operate in (worktree, or project). */
  dir: string;
  /** Unique dev-server port for this session. */
  port: number;
  isWorktree: boolean;
  branch?: string;
}

export type ProgressFn = (stage: 'creating' | 'installing' | 'ready' | 'error', text: string) => void;

const cache = new Map<string, SessionWorkspace>();
const inflight = new Map<string, Promise<SessionWorkspace>>();
const wsKey = (sid: string): string => `ugly-studio:workspace:${sid}`;
const safeId = (sid: string): string => sid.replace(/[^a-zA-Z0-9_-]/g, '_');

/** Deterministic per-session port in 4100–4999 (stable across reloads). */
function portFor(sessionId: string): number {
  let h = 0;
  for (let i = 0; i < sessionId.length; i++) h = (Math.imul(h, 31) + sessionId.charCodeAt(i)) >>> 0;
  return 4100 + (h % 900);
}

interface ProcResult { code: number; out: string }
function runProc(cmd: string, args: string[], cwd?: string, onChunk?: (c: string) => void): Promise<ProcResult> {
  return new Promise((resolve) => {
    let out = '';
    try {
      const proc = native.process.spawn(cmd, args, cwd ? { cwd } : {});
      const take = (c: string): void => { out += c; onChunk?.(c); };
      proc.onStdout(take);
      proc.onStderr(take);
      proc.onError((e) => { resolve({ code: -1, out: out + '\n' + e }); });
      proc.onExit((code) => { resolve({ code: code ?? -1, out }); });
    } catch (e) {
      resolve({ code: -1, out: String(e) });
    }
  });
}

async function exists(path: string): Promise<boolean> {
  try { await native.fs.stat(path); return true; } catch { return false; }
}

/** Detect the package manager from the project's lockfile. */
async function detectInstall(projectPath: string): Promise<[string, string[]] | null> {
  if (await exists(`${projectPath}/pnpm-lock.yaml`)) return ['pnpm', ['install']];
  if (await exists(`${projectPath}/yarn.lock`)) return ['yarn', ['install']];
  if (await exists(`${projectPath}/package-lock.json`)) return ['npm', ['install']];
  if (await exists(`${projectPath}/package.json`)) return ['npm', ['install']];
  return null; // no node project — nothing to install
}

/** Resolve (creating if needed) the workspace for a session. Idempotent + cached. */
export async function ensureSessionWorkspace(sessionId: string, projectPath: string | null, onProgress?: ProgressFn): Promise<SessionWorkspace> {
  const cached = cache.get(sessionId);
  if (cached) return cached;
  const pending = inflight.get(sessionId);
  if (pending) return pending;
  const p = provision(sessionId, projectPath, onProgress).finally(() => inflight.delete(sessionId));
  inflight.set(sessionId, p);
  return p;
}

async function provision(sessionId: string, projectPath: string | null, onProgress?: ProgressFn): Promise<SessionWorkspace> {
  const port = portFor(sessionId);
  const fallback = (): SessionWorkspace => {
    const ws: SessionWorkspace = { dir: projectPath ?? '', port, isWorktree: false };
    cache.set(sessionId, ws);
    return ws;
  };
  if (!projectPath) return fallback();

  // Restore a previously-provisioned worktree across reloads.
  try {
    const saved = localStorage.getItem(wsKey(sessionId));
    if (saved) {
      const ws = JSON.parse(saved) as SessionWorkspace;
      if (ws.dir && (await exists(ws.dir))) { cache.set(sessionId, ws); return ws; }
    }
  } catch { /* ignore */ }

  // The MAIN session operates on the project itself (no worktree).
  let isMain = true;
  try {
    const projectId = await resolveProjectId(projectPath);
    const listed = await sessionApi.list({ projectId });
    const me = listed?.sessions.find((s) => s.sessionId === sessionId);
    const hasMain = listed?.sessions.some((s) => s.kind === 'main') ?? false;
    isMain = me ? me.kind === 'main' : !hasMain; // a brand-new session is main iff none exists yet
  } catch { /* default isMain=true on failure → safe */ }
  if (isMain) return fallback();

  const safe = safeId(sessionId);
  const dir = `${projectPath}/.ugly-studio/worktrees/${safe}`;
  const branch = `ugly-studio/session/${safe}`;

  try {
    if (!(await exists(dir))) {
      onProgress?.('creating', `Creating isolated worktree (${branch})…`);
      // New branch off HEAD; if the branch already exists (re-create), attach to it.
      let r = await runProc('git', ['-C', projectPath, 'worktree', 'add', '-b', branch, dir, 'HEAD']);
      if (r.code !== 0 && /already exists/i.test(r.out)) {
        r = await runProc('git', ['-C', projectPath, 'worktree', 'add', dir, branch]);
      }
      if (r.code !== 0 || !(await exists(dir))) throw new Error('git worktree add failed: ' + r.out.slice(-300));

      // Copy .env-style secrets the worktree needs but that aren't committed.
      for (const f of ['.env', '.dev.vars', '.env.local']) {
        if (await exists(`${projectPath}/${f}`)) {
          try { await native.fs.writeFile(`${dir}/${f}`, await native.fs.readFile(`${projectPath}/${f}`)); } catch { /* best effort */ }
        }
      }

      // Real install (reliable; supports the live dev server / Preview).
      const inst = await detectInstall(projectPath);
      if (inst) {
        onProgress?.('installing', `Installing dependencies (${inst[0]} ${inst[1].join(' ')})…`);
        let tail = '';
        const r2 = await runProc(inst[0], inst[1], dir, (c) => {
          tail = (tail + c).split('\n').slice(-12).join('\n');
          onProgress?.('installing', tail);
        });
        if (r2.code !== 0) onProgress?.('error', `Install exited ${r2.code} — the agent will still run, but commands needing deps may fail.`);
      }
    }
    onProgress?.('ready', 'Workspace ready.');
    const ws: SessionWorkspace = { dir, port, isWorktree: true, branch };
    cache.set(sessionId, ws);
    try { localStorage.setItem(wsKey(sessionId), JSON.stringify(ws)); } catch { /* ignore */ }
    return ws;
  } catch (e) {
    console.error('[sessionWorkspace] provision failed; using project dir', e);
    onProgress?.('error', 'Could not create an isolated worktree — running in the project directory.');
    return fallback();
  }
}

/** The session's dev-server port (deterministic; available before provisioning). */
export function sessionPort(sessionId: string): number {
  return getSessionWorkspace(sessionId)?.port ?? portFor(sessionId);
}

/** Sync accessor for tool handlers (null until ensureSessionWorkspace resolves). */
export function getSessionWorkspace(sessionId: string): SessionWorkspace | null {
  if (cache.has(sessionId)) return cache.get(sessionId)!;
  try {
    const saved = localStorage.getItem(wsKey(sessionId));
    if (saved) { const ws = JSON.parse(saved) as SessionWorkspace; cache.set(sessionId, ws); return ws; }
  } catch { /* ignore */ }
  return null;
}

/** Tear down a session's worktree (on archive). Best-effort. */
export async function removeSessionWorkspace(sessionId: string, projectPath: string | null): Promise<void> {
  const ws = getSessionWorkspace(sessionId);
  cache.delete(sessionId);
  try { localStorage.removeItem(wsKey(sessionId)); } catch { /* ignore */ }
  if (ws?.isWorktree && projectPath) {
    await runProc('git', ['-C', projectPath, 'worktree', 'remove', '--force', ws.dir]);
    if (ws.branch) await runProc('git', ['-C', projectPath, 'branch', '-D', ws.branch]);
  }
}
