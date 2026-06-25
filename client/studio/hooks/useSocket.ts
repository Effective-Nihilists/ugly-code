/**
 * Phase 1 of the Studio-IDE-on-UglyNative rebuild: a drop-in replacement for
 * the renderer's sidecar `/rpc` socket. Instead of a WebSocket to a privileged
 * Node sidecar, `request(name, input)` dispatches to handlers backed by
 * `window.UglyNative` (native.fs / native.process) — the same unified protocol
 * the rest of ugly-code uses. Same export surface as the original
 * `client/hooks/useSocket.ts` (useSocket / onCustomMessage / isConnected) so the
 * vendored IDE components import it unchanged.
 *
 * The file/process subset is wired first; everything else rejects with a clear
 * "not yet wired" error (callers in the shell all `.catch`, so the UI degrades
 * gracefully). Later phases fill in LSP, PTY, dev-server, and the agent.
 */

import { useContext, useMemo } from 'react';
import type { AppSocket } from 'ugly-app/client';
import { native, permissions, taskEntryUrl } from 'ugly-app/native';
import { waitForTaskRunning } from './taskReady';
import { buildId } from '../../../shared/Build';
import type { AppRegistry } from '../shared/api';
import { ProjectScopeContext } from '../state/ProjectScopeContext';
import { firstTurnPrompt, getEvalTask, listEvalTasks } from '../evals/registry';
import { gradeProject, type GradeDeps } from '../evals/grader';
import { getRecentProjects } from '../state/recentProjects';
import { sessionApi, resolveProjectId } from '../agent/serverSessionApi';
import { rowsToDisplayMessages } from '../agent/sessionDisplay';
import { DB_SCRIPT } from '../db/dbScript';

/** Run a shell command through `bash -lc` (so `~` expands + login PATH applies)
 *  and resolve with the LAST stdout line — a trailing `pwd`/`echo` of a path.
 *  Rejects on non-zero exit. Used by initProject + evalCreateProject. */
async function spawnForPath(cmd: string): Promise<string> {
  // Grant fs + process (bash/git/npx/pnpm) before spawning, or the daemon denies
  // it ("requires the process permission" / "not a bundled tool"). Auto-granted
  // for the first-party IDE origin. The facade types `process` as boolean, but
  // the daemon accepts a per-binary allowlist array.
  type GrantReq = Parameters<typeof permissions.request>[0];
  await permissions
    .request({ fs: 'full', process: ['bash', 'node', 'git', 'npm', 'npx', 'pnpm'] } as unknown as GrantReq)
    .catch(() => undefined);
  return new Promise<string>((resolve, reject) => {
    let out = '';
    let err = '';
    try {
      const proc = native.process.spawn('bash', ['-lc', cmd], {});
      proc.onStdout((c) => (out += c));
      proc.onStderr((c) => (err += c));
      proc.onError((e) => reject(new Error(e)));
      proc.onExit((code) => {
        if (code !== 0) {
          reject(new Error(`command failed (exit ${code ?? 'null'})\n${(err || out).trim()}`));
          return;
        }
        const lines = out.trim().split('\n').map((l) => l.trim()).filter(Boolean);
        resolve(lines[lines.length - 1] ?? '');
      });
    } catch (e) {
      reject(e as Error);
    }
  });
}

type Input = Record<string, unknown>;
type Handler = (input: Input) => Promise<unknown>;
type CustomMessageHandler = (msg: { type: string; [key: string]: unknown }) => void;

const customMessageHandlers = new Set<CustomMessageHandler>();
export function onCustomMessage(handler: CustomMessageHandler): () => void {
  customMessageHandlers.add(handler);
  return () => {
    customMessageHandlers.delete(handler);
  };
}
/** Fan a server-style push message out to subscribers — how the client-side
 *  agent streams `codingAgent:event` frames into useCodingAgentChat. */
function emitCustom(msg: { type: string; [k: string]: unknown }): void {
  for (const h of customMessageHandlers) h(msg);
}
/** The native transport is always "connected" (no remote handshake). */
export function isConnected(): boolean {
  return true;
}

// The opened project's absolute path now lives in a React-free module (so the agent loop
// can bundle headless). Re-exported here for existing importers (StudioProjectPage, etc.).
import { getActiveProjectPath, setActiveProjectPath } from '../projectPath';
export { getActiveProjectPath, setActiveProjectPath };

// ── Background coding-task adoption ──────────────────────────────────────────
// The coding session runs as a background task (Studio desktop, or mobile via the Ugly
// Proxy) — it outlives the window and is drivable from any device — instead of in this
// renderer. The IDE only runs inside Ugly Studio, so there's no in-renderer fallback. The
// task's emitCustom-shaped frames flow back via task.listen → emitCustom, so
// useCodingAgentChat consumes them unchanged.
const sessionTaskIds = new Map<string, string>();
const listenedTaskIds = new Set<string>();
function readAuthTokenCookie(): string {
  try {
    const m = document.cookie.split('; ').find((c) => c.startsWith('auth_token='));
    return m ? m.slice('auth_token='.length) : '';
  } catch {
    return '';
  }
}
/** Start (or re-attach to) the session's coding task + wire its events to emitCustom. */
async function ensureCodingTask(sessionId: string): Promise<string> {
  const have = sessionTaskIds.get(sessionId);
  if (have) return have;
  const id = 'coding:' + sessionId;
  const wanted = taskEntryUrl('coding', buildId);
  // Re-attach to a HEALTHY task from the CURRENT build (renderer reload / another window).
  // A task left over from a prior deploy runs an old bundle that lacks the methods this
  // renderer calls (→ "unknown task method: send"), and an exited/errored task can't serve
  // calls — in those cases stop it and start fresh (the session rebuilds its context from
  // the DB on the next turn). Entry carries the buildId, so a new deploy never reuses old.
  const existing = (await native.task.enum()).find((t) => t.id === id);
  const reusable = existing && existing.status !== 'exited' && existing.status !== 'error' && existing.entry === wanted;
  if (!reusable) {
    if (existing) { try { await native.task.stop(id); } catch { /* already gone */ } }
    await native.task.start({
      entry: wanted,
      kind: 'coding',
      id,
      params: {
        projectPath: getActiveProjectPath(),
        sessionId,
        origin: location.origin,
        authToken: readAuthTokenCookie(),
      },
    });
  }
  // Wait until the child has loaded its bundle (status flips to 'running' on the task's
  // `ready`) before returning. task.start resolves when the child is SPAWNED, but the runner
  // then fetches + imports the bundle over https — calling a method before that races the load
  // and throws "unknown task method". A reused, already-running task passes on the first check.
  await waitForTaskRunning(id, () => native.task.enum() as Promise<{ id: string; status: string }[]>);
  sessionTaskIds.set(sessionId, id);
  if (!listenedTaskIds.has(id)) {
    listenedTaskIds.add(id);
    native.task.listen(id, (_event, data) =>
      emitCustom(data as { type: string; [k: string]: unknown }),
    );
  }
  return id;
}
function emitAgentError(sessionId: string, e: unknown): void {
  console.error('[codingAgentChatSend] turn failed', e);
  emitCustom({
    type: 'codingAgent:event',
    sessionId,
    event: {
      type: 'message',
      payload: {
        type: 'created',
        payload: {
          id: 'err_' + Math.random().toString(36).slice(2, 9),
          role: 'assistant',
          parts: [
            { type: 'text', data: { text: '⚠ ' + (e instanceof Error ? e.message : String(e)) } },
            { type: 'finish' },
          ],
          created_at: Date.now(),
        },
      },
    },
  });
}

// Per-session selected model id, so codingAgentChatSend routes to the right
// runner: the local Claude CLI (claude-code* / claude-cli) vs the in-process
// ugly.bot agent (everything else).
const sessionModels = new Map<string, string>();
const modelKey = (sid: string): string => `ugly-studio:model:${sid}`;
export function setSessionModel(sessionId: string, model: string): void {
  if (!sessionId || !model) return;
  sessionModels.set(sessionId, model);
  try { localStorage.setItem(modelKey(sessionId), model); } catch { /* ignore */ }
}
export function getSessionModel(sessionId: string): string | null {
  const inMem = sessionModels.get(sessionId);
  if (inMem) return inMem;
  // Survive reload: routing (claude-cli vs ugly.bot) must persist per session.
  try {
    const saved = localStorage.getItem(modelKey(sessionId));
    if (saved) { sessionModels.set(sessionId, saved); return saved; }
  } catch { /* ignore */ }
  return null;
}

// Per-session selection of the non-model axes (modelMode / patternMode /
// permissionMode / reasoningEffort). The client-side coding agent runs a single
// concrete model and has no auto-router/pattern engine, but it MUST be told the
// user's picks so it echoes them in every session_state snapshot — otherwise the
// chat header silently resets them to defaults each turn. The set* RPCs (below)
// were previously no-ops, which is exactly why "none"/"max"/etc. reverted.
interface SessionAxes {
  modelMode?: unknown;
  patternMode?: string;
  permissionMode?: string;
  reasoningEffort?: string;
}
const sessionAxes = new Map<string, SessionAxes>();
function patchSessionAxes(sessionId: string, patch: SessionAxes): void {
  if (!sessionId) return;
  sessionAxes.set(sessionId, { ...(sessionAxes.get(sessionId) ?? {}), ...patch });
}
/** Compose the full selection the coding task needs for a turn: the routed
 *  model plus the user-picked axes. Passed verbatim into `runClientAgentTurn`. */
function buildSelection(sessionId: string): Record<string, unknown> {
  const axes = sessionAxes.get(sessionId) ?? {};
  const model = getSessionModel(sessionId);
  return { ...(model ? { model } : {}), ...axes };
}
/** A local Claude Code CLI model id (defined here to avoid a static import cycle
 *  with claudeCliAgent, which imports from this module). */
function isClaudeCliModel(model: string | null | undefined): boolean {
  return !!model && (model === 'claude-cli' || model === 'claude-code' || model.startsWith('claude-code:'));
}

// Grader IO over the native bridge: run tools (tsc/vitest) in the project and
// read its files. Mirrors spawnForPath's spawn shape but with a custom cwd/argv.
const gradeDeps: GradeDeps = {
  run: (cmd, args, cwd) =>
    new Promise((resolve) => {
      let out = '';
      try {
        const proc = native.process.spawn(cmd, args, { cwd });
        proc.onStdout((c) => (out += c));
        proc.onStderr((c) => (out += c));
        proc.onError((e) => resolve({ out: `${out}\n${e}`, code: 1 }));
        proc.onExit((code) => resolve({ out, code }));
      } catch (e) {
        resolve({ out: String((e as Error).message), code: 1 });
      }
    }),
  readFile: (p) => native.fs.readFile(p),
  exists: (p) => native.fs.exists(p),
  // One-shot LLM judge via the agent's textGen endpoint (no tools).
  judge: async (system, user) => {
    const res = await fetch('/api/agentStep', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        input: {
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          options: { maxTokens: 512 },
        },
      }),
    });
    const json = (await res.json()) as { result?: { message?: { content?: unknown } }; error?: string };
    if (json.error) throw new Error(json.error);
    const content = json.result?.message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.map((b) => (b as { type?: string; text?: string }).text ?? '').join('');
    }
    return '';
  },
};
// Run totals (cost/tokens/duration) live on the session snapshot, not here;
// the grader fills the score + gates and the scorecard overlays totals.
const ZERO_RUN_TOTALS = {
  durationMs: 0,
  turns: 0,
  cost: { total: 0, input: 0, output: 0, cacheRead: 0 },
  tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
};

// The Database panel data layer (connection + all DB ops) lives in
// ../db/dbScript — shared with the agent's DB tools.

/** Spawn the opened project's `ugly-app <cmd> --json` CLI (reads its prod D1
 *  telemetry) and parse the NDJSON output into docs. Resolves [] on any failure
 *  (project not deployed, no CF token, command missing) so panels degrade. */
function runCli(cmd: string): Promise<{ _id: string; created: number; data: Record<string, unknown> }[]> {
  const proj = getActiveProjectPath();
  if (!proj) return Promise.resolve([]);
  return new Promise((resolve) => {
    let stdout = '';
    try {
      const proc = native.process.spawn(
        'node',
        ['./node_modules/ugly-app/dist/cli/index.js', cmd, '--json'],
        { cwd: proj },
      );
      proc.onStdout((c) => (stdout += c));
      proc.onError(() => resolve([]));
      proc.onExit(() => {
        const docs = stdout
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => {
            try {
              return JSON.parse(l) as { _id: string; created: number; data: Record<string, unknown> };
            } catch {
              return null;
            }
          })
          .filter((d): d is { _id: string; created: number; data: Record<string, unknown> } => !!d && !!d.data);
        resolve(docs);
      });
    } catch {
      resolve([]);
    }
  });
}

const mapWorkerStatus = (s: unknown): 'completed' | 'failed' =>
  s === 'error' ? 'failed' : 'completed';

function runDbScript(op: string, mode: string, input: unknown): Promise<unknown> {
  const proj = getActiveProjectPath();
  if (!proj) return Promise.reject(new Error('No active project'));
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    try {
      const proc = native.process.spawn('node', ['--input-type=module', '-e', DB_SCRIPT], {
        cwd: proj,
        env: {
          UGLY_DB_MODE: mode,
          UGLY_DB_PROJECT: proj,
          UGLY_DB_OP: op,
          UGLY_DB_INPUT: JSON.stringify(input ?? {}),
        },
      });
      proc.onStdout((c) => (stdout += c));
      proc.onStderr((c) => (stderr += c));
      proc.onError((e) => reject(new Error(e)));
      proc.onExit((code) => {
        if (code === 0) {
          try {
            resolve(JSON.parse(stdout || '{}'));
          } catch {
            reject(new Error('DB query: unparseable output: ' + stdout.slice(0, 200)));
          }
        } else {
          reject(new Error(stderr.trim() || 'node exited ' + code));
        }
      });
    } catch (e) {
      reject(e as Error);
    }
  });
}

// Studio user settings persist locally in the browser for now (later: a native
// settings file under the app's scoped dir).
const SETTINGS_KEY = 'ugly-studio:settings';
function loadSettings(): Record<string, unknown> {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as Record<string, unknown>;
  } catch {
    return {};
  }
}
function saveSetting(key: string, value: unknown): void {
  const s = loadSettings();
  s[key] = value;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

const handlers: Record<string, Handler> = {
  // ── mount reads — safe empties so the shell renders without a sidecar ──
  listOpenProjects: () =>
    Promise.resolve({ projects: [], activePath: null, activeLayoutContent: null }),
  getOpenProjectAggregates: () => Promise.resolve({ aggregates: {} }),
  getStudioUserSettings: () => Promise.resolve({ entries: loadSettings() }),
  setStudioUserSetting: (i) => {
    saveSetting(String(i.key), i.value);
    return Promise.resolve({});
  },
  listRecentProjects: () => Promise.resolve({ projects: getRecentProjects() }),
  // ── Database panel: run queries against the project's PG (dev) or Neon (prod)
  // via a node+pg script over native.process. ──
  dbCollections: (i) => runDbScript('collections', String(i.mode ?? 'dev'), {}),
  dbGetDoc: (i) =>
    runDbScript('getDoc', String(i.mode ?? 'dev'), { collection: i.collection, id: i.id }),
  dbGetQuery: (i) =>
    runDbScript('getQuery', String(i.mode ?? 'dev'), {
      collection: i.collection,
      filters: i.filters,
      sort: i.sort,
      limit: i.limit,
      skip: i.skip,
    }),
  dbCount: (i) => runDbScript('count', String(i.mode ?? 'dev'), { collection: i.collection }),
  dbSchema: (i) => runDbScript('schema', String(i.mode ?? 'dev'), { collection: i.collection }),
  // Raw SQL console. Writes require allowWrite; DROP/TRUNCATE/ALTER + WHERE-less
  // UPDATE/DELETE require force; UPDATE/DELETE support dryRun (txn + ROLLBACK).
  dbExec: (i) =>
    runDbScript('exec', String(i.mode ?? 'dev'), {
      sql: i.sql,
      params: i.params,
      allowWrite: i.allowWrite,
      force: i.force,
      dryRun: i.dryRun,
    }),
  // Structured insert/update/delete of a single doc (via the doc's JSONB).
  dbMutate: (i) =>
    runDbScript('mutate', String(i.mode ?? 'dev'), {
      collection: i.collection,
      action: i.action,
      id: i.id,
      doc: i.doc,
      allowWrite: i.allowWrite,
    }),
  // ── telemetry panels: read the project's prod D1 via `ugly-app <cmd> --json` ──
  errorLogGetList: async () => {
    const docs = await runCli('errors');
    return {
      errors: docs.map((d) => ({
        id: d._id,
        created: d.created,
        source: String(d.data.source ?? ''),
        type: String(d.data.type ?? ''),
        level: String(d.data.level ?? 'error'),
        message: String(d.data.message ?? ''),
        stack: d.data.stack as string | undefined,
        userId: (d.data.userId ?? null) as string | null,
        hash: '',
        isExpected: false,
      })),
    };
  },
  errorLogGetSummary: async () => {
    const docs = await runCli('errors');
    const map = new Map<string, { message: string; count: number; lastSeen: number; latestErrorId: string }>();
    for (const d of docs) {
      const msg = String(d.data.message ?? '');
      const e = map.get(msg);
      if (e) {
        e.count++;
        if (d.created > e.lastSeen) {
          e.lastSeen = d.created;
          e.latestErrorId = d._id;
        }
      } else {
        map.set(msg, { message: msg, count: 1, lastSeen: d.created, latestErrorId: d._id });
      }
    }
    return { aggregations: [...map.values()].sort((a, b) => b.count - a.count) };
  },
  eventList: async () => {
    const docs = await runCli('events');
    return {
      events: docs.map((d) => ({
        id: d._id,
        created: d.created,
        eventName: String(d.data.eventName ?? ''),
        userId: (d.data.userId ?? null) as string | null,
        sessionId: String(d.data.sessionId ?? ''),
        properties: (d.data.properties ?? {}) as Record<string, unknown>,
      })),
    };
  },
  eventTopEvents: async () => {
    const docs = await runCli('events');
    const counts = new Map<string, number>();
    for (const d of docs) {
      const n = String(d.data.eventName ?? '');
      counts.set(n, (counts.get(n) ?? 0) + 1);
    }
    return {
      events: [...counts.entries()]
        .map(([eventName, count]) => ({ eventName, count }))
        .sort((a, b) => b.count - a.count),
    };
  },
  // List the project's cron tasks (the workers that run on Cloudflare) by
  // parsing shared/cron.ts — `defineWorkers({ name: defineWorker({ schedule,
  // description }) })`. The runs list (below) still comes from prod telemetry.
  workersGetManifest: async () => {
    const proj = getActiveProjectPath();
    if (!proj) return { available: false, reason: 'No project open.', workers: [] };
    let src = '';
    for (const rel of ['/shared/cron.ts', '/src/shared/cron.ts']) {
      try { src = await native.fs.readFile(proj + rel); break; } catch { /* try next */ }
    }
    if (!src) return { available: false, reason: 'No shared/cron.ts in this project.', workers: [] };
    const workers: { name: string; schedule?: string; description?: string; defaultInput: unknown }[] = [];
    const re = /(\w+)\s*:\s*defineWorker\(\s*\{([\s\S]*?)\}\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const name = m[1];
      const body = m[2] ?? '';
      const schedule = /schedule\s*:\s*['"]([^'"]*)['"]/.exec(body)?.[1];
      const description = /description\s*:\s*['"]([^'"]*)['"]/.exec(body)?.[1];
      workers.push({ name, ...(schedule ? { schedule } : {}), ...(description ? { description } : {}), defaultInput: {} });
    }
    return {
      available: workers.length > 0,
      ...(workers.length === 0 ? { reason: 'No cron tasks defined in shared/cron.ts.' } : {}),
      workers,
    };
  },
  workersListRuns: async (i) => {
    const docs = await runCli('workers');
    const filtered = i.name ? docs.filter((d) => d.data.name === i.name) : docs;
    return {
      runs: filtered.map((d) => ({
        runId: d._id,
        name: String(d.data.name ?? ''),
        startedAt: d.created,
        status: mapWorkerStatus(d.data.status),
        durationMs: (d.data.durationMs ?? null) as number | null,
        source: String(d.data.source ?? ''),
        error: d.data.error as string | undefined,
      })),
    };
  },
  workersGetRun: async (i) => {
    const docs = await runCli('workers');
    const d = docs.find((x) => x._id === i.runId);
    return {
      run: d
        ? {
            runId: d._id,
            name: String(d.data.name ?? ''),
            startedAt: d.created,
            status: mapWorkerStatus(d.data.status),
            durationMs: (d.data.durationMs ?? null) as number | null,
            source: String(d.data.source ?? ''),
            error: d.data.error as string | undefined,
            logs: [],
          }
        : null,
    };
  },
  workersRun: () =>
    Promise.resolve({ runId: 'manual-' + Math.random().toString(36).slice(2, 9) }),

  // ── project-page (session sidebar) reads — server-backed (survive reload) ──
  codingAgentListSessions: async () => {
    const projectId = await resolveProjectId(getActiveProjectPath());
    const data = await sessionApi.list({ projectId });
    const sessions = (data?.sessions ?? []).map((s) => ({
      compositeId: s.sessionId,
      workspaceId: s.sessionId.split(':')[0] ?? '',
      sessionId: s.sessionId.split(':')[1] ?? s.sessionId,
      title: s.title,
      mode: 'yolo' as const,
      created_at: s.created,
      updated_at: s.updated,
      message_count: s.messageCount,
      running: s.status === 'running',
      blocked: false,
      archived: false,
      live: false,
      finished: s.status === 'done' || s.status === 'idle',
      model: s.model || 'auto',
      totalTokens: 0,
      totalCost: s.costUsd,
      // Surface the main-session flag so the sidebar can pin/label it.
      kind: s.kind,
    }));
    return { sessions };
  },
  gitStatus: () => Promise.resolve({ branch: 'main', remote: null, files: [] }),
  deleteCodingAgentSession: async (i) => {
    await sessionApi.archive({ sessionId: String(i.sessionId ?? '') });
    return {};
  },
  // ── coding-agent session protocol — server-backed persistence ──
  codingAgentChatListMessages: async (i) => {
    const sessionId = String(i.sessionId ?? '');
    const limit = typeof i.limit === 'number' ? i.limit : 200;
    const data = await sessionApi.listMessages({ sessionId, limit });
    const rows = data?.messages ?? [];
    return { messages: rowsToDisplayMessages(sessionId, rows), hasMore: false };
  },
  getCodingAgentSnapshot: () => Promise.resolve(null),
  // Honor resumeSessionId (return it unchanged → no "resume mismatch"); mint a
  // fresh compositeId for a new session. Persistence is deferred to the first
  // turn (clientAgent upserts), so we don't create empty session rows.
  codingAgentChatCreate: (i) => {
    const sessionId = i.resumeSessionId
      ? String(i.resumeSessionId)
      : 'cs:' + Math.random().toString(36).slice(2, 11);
    if (i.model) setSessionModel(sessionId, String(i.model));
    // Seed the session's axes from create-time picks so the first turn's
    // snapshot echoes them (the per-axis set* RPCs no-op while sessionId is
    // null, so a new-session hero pre-pick only arrives here). `mode` is the
    // legacy permission axis ('edit' | 'yolo').
    if (i.mode) patchSessionAxes(sessionId, { permissionMode: String(i.mode) });
    if (i.patternMode) patchSessionAxes(sessionId, { patternMode: String(i.patternMode) });
    if (i.modelMode) {
      patchSessionAxes(sessionId, { modelMode: i.modelMode });
      const mm = i.modelMode as { kind?: string; model?: string };
      if (mm.kind === 'single' && mm.model) setSessionModel(sessionId, mm.model);
    }
    return Promise.resolve({ sessionId });
  },
  codingAgentChatSend: (i) => {
    const sessionId = String(i.sessionId ?? '');
    const message = String(i.message ?? '');
    const model = getSessionModel(sessionId);
    // 1. Local Claude CLI model → in-renderer CLI runner (unchanged).
    if (isClaudeCliModel(model)) {
      void import('../agent/claudeCliAgent')
        .then((m) => m.runClaudeCliTurn(sessionId, message, model!, emitCustom))
        .catch((e) => emitAgentError(sessionId, e));
      return Promise.resolve({});
    }
    // 2. Run the session as a background task (Studio desktop, or mobile via the Ugly
    //    Proxy); its frames stream back via task.listen. The IDE only runs inside Ugly
    //    Studio, so there's no in-renderer fallback.
    void (async () => {
      try {
        const id = await ensureCodingTask(sessionId);
        await native.task.call(id, 'send', { text: message, selection: buildSelection(sessionId) });
      } catch (e) {
        emitAgentError(sessionId, e);
      }
    })();
    return Promise.resolve({});
  },
  codingAgentChatStop: (i) => {
    const sessionId = String(i.sessionId ?? '');
    if (isClaudeCliModel(getSessionModel(sessionId))) {
      void import('../agent/claudeCliAgent').then((m) => m.abortClaudeCli(sessionId));
      return Promise.resolve({});
    }
    const taskId = sessionTaskIds.get(sessionId);
    // We run the session as a task → interrupt it there (no-op if no turn is in flight).
    if (taskId) void native.task.call(taskId, 'interrupt').catch(() => {});
    return Promise.resolve({});
  },
  // `/clear`: wipe the conversation in place. Reset the running task's in-memory
  // agent context (so the model forgets) + delete the persisted transcript (so a
  // resume starts empty) — both best-effort — and return `{ ok: true }` so the
  // hook's clearMessages proceeds to empty the UI. Previously this returned `{}`,
  // so clearMessages bailed on `!ok` and `/clear` did nothing.
  codingAgentChatClearMessages: (i) => {
    const sessionId = String(i.sessionId ?? '');
    const taskId = sessionTaskIds.get(sessionId);
    if (taskId) void native.task.call(taskId, 'clear').catch(() => {});
    void sessionApi.clearMessages({ sessionId }).catch(() => {});
    return Promise.resolve({ ok: true });
  },
  codingAgentToolStop: () => Promise.resolve({}),
  codingAgentChatSetModel: (i) => {
    setSessionModel(String(i.sessionId ?? ''), String(i.model ?? ''));
    return Promise.resolve({});
  },
  // The four set* RPCs below record the user's pick per session so the next
  // turn's snapshot echoes it (they were no-ops, which is why picks reverted).
  codingAgentSetReasoningEffort: (i) => {
    patchSessionAxes(String(i.sessionId ?? ''), { reasoningEffort: String(i.effort ?? '') });
    return Promise.resolve({});
  },
  codingAgentGrantPermission: () => Promise.resolve({}),
  codingAgentSkipPermissions: () => Promise.resolve({}),
  codingAgentSetPermissionMode: (i) => {
    patchSessionAxes(String(i.sessionId ?? ''), { permissionMode: String(i.permissionMode ?? '') });
    return Promise.resolve({});
  },
  codingAgentSetModelMode: (i) => {
    const sessionId = String(i.sessionId ?? '');
    patchSessionAxes(sessionId, { modelMode: i.modelMode });
    // A concrete single-model pick must also update the routed model (the run +
    // the CLI-vs-ugly.bot routing both read getSessionModel) — without this a
    // mid-session swap kept running the old model.
    const mm = i.modelMode as { kind?: string; model?: string } | undefined;
    if (mm?.kind === 'single' && mm.model) setSessionModel(sessionId, mm.model);
    return Promise.resolve({});
  },
  codingAgentSetPatternMode: (i) => {
    patchSessionAxes(String(i.sessionId ?? ''), { patternMode: String(i.patternMode ?? '') });
    return Promise.resolve({});
  },
  markSessionViewed: () => Promise.resolve({}),
  getCodingAgentWorktreeBehind: () => Promise.resolve({ behind: 0 }),
  getCodingAgentWorktreeAhead: () => Promise.resolve({ ahead: 0 }),
  // The eval picker: all 59 task defs (ported from app/studio/evals/tasks) with
  // derived difficulty + "why interesting". See client/studio/evals/registry.ts.
  evalListTasks: () => Promise.resolve(listEvalTasks()),
  evalListHistory: () => Promise.resolve({ runs: [] }),
  evalDeleteRun: () => Promise.resolve({}),
  // Scaffold an eval run under ~/.ugly-studio/eval-projects, open it, and seed
  // the task's first-turn prompt. When the task has a `repoUrl` (57/59 tasks —
  // each fixture is published as a public github.com/Effective-Nihilists/
  // ugly-evals-<task> repo), git-clone it so the agent works against the REAL
  // buggy code + tests; then re-init git for a clean baseline diff. The few
  // fixture-less tasks (write-from-scratch) get an empty seeded project.
  evalCreateProject: async (i) => {
    const taskName = String(i.taskName ?? '');
    const task = getEvalTask(taskName);
    if (!task) throw new Error(`Unknown eval task: ${taskName}`);
    const safe = taskName.replace(/[^a-zA-Z0-9_.-]/g, '_');
    const stamp = String(i.taskId ?? Date.now()).replace(/[^a-zA-Z0-9_.-]/g, '_');
    // `$HOME` (not `~`) — a leading `~` is NOT expanded inside the double quotes.
    const base = `$HOME/.ugly-studio/eval-projects/${safe}-${stamp}`;
    const seedGit =
      `rm -rf .git && git init -b main -q && git add -A && ` +
      `git -c user.email=eval@ugly.bot -c user.name=eval commit -q -m "eval: seed ${safe}"`;
    const cmd = task.repoUrl
      ? `mkdir -p "$HOME/.ugly-studio/eval-projects" && ` +
        `git clone --depth 1 "${task.repoUrl.replace(/"/g, '\\"')}" "${base}" && cd "${base}" && ` +
        `${seedGit} && pwd`
      : `mkdir -p "${base}" && cd "${base}" && ` +
        `printf '{"name":"%s","version":"0.0.0","private":true}\\n' "${safe}" > package.json && ` +
        `${seedGit} && pwd`;
    const projectPath = await spawnForPath(cmd);
    const projectName = projectPath.split('/').pop() || safe;
    return { projectPath, projectName, firstTurnPrompt: firstTurnPrompt(task) };
  },
  // Grade the eval run against the project on disk: runs the task's gates
  // (tsc/vitest/fileExists/fileMatches deterministically; judge/custom surfaced
  // for manual review) and returns the scorecard. taskName comes from the
  // session (the client passes it); the project is the open one.
  evalGradeSession: async (i) => {
    const projectPath = getActiveProjectPath();
    if (!projectPath) throw new Error('No project open to grade');
    const taskName = String((i as { taskName?: string }).taskName ?? '');
    const task = taskName ? getEvalTask(taskName) : null;
    return gradeProject(
      {
        taskName: taskName || 'unknown',
        projectPath,
        ...(task?.gates ? { gates: task.gates } : {}),
        ...(task?.successCriteria ? { successCriteria: task.successCriteria } : {}),
        runTotals: ZERO_RUN_TOTALS,
      },
      gradeDeps,
    );
  },
  // Scaffold a new ugly-app project on disk, then resolve its absolute path so
  // the caller can open it. Mirrors the monolith's `npx -y ugly-app@latest init`
  // but over native.process. Runs through `bash -lc` so `~` expands and `npx`
  // resolves on the login PATH (the desktop daemon bundles bash). The trailing
  // `pwd` prints the created project's absolute path as the last stdout line.
  initProject: async (i) => {
    const name = String(i.name ?? '').trim();
    // A leading `~` is NOT expanded inside the double quotes below — map it to
    // `$HOME`, which is.
    const parentDir = (String(i.parentDir ?? '').trim() || '~').replace(/^~(?=$|\/)/, '$HOME');
    if (!name) throw new Error('Project name is required');
    const q = (s: string): string => s.replace(/"/g, '\\"');
    const cmd =
      `mkdir -p "${q(parentDir)}" && cd "${q(parentDir)}" && ` +
      `npx -y ugly-app@latest init "${q(name)}" && cd "${q(name)}" && pwd`;
    const path = await spawnForPath(cmd);
    return { name, path: path || `${parentDir}/${name}` };
  },
  openProject: (i) => {
    const path = String(i.path ?? '').replace(/\/+$/, '');
    const name = path.split('/').pop() || path || 'project';
    return Promise.resolve({ name, path });
  },
  closeProject: () => Promise.resolve({}),
  setActiveProject: () => Promise.resolve({}),
  cancelTask: () => Promise.resolve({}),

  // ── filesystem subset over window.UglyNative (the Phase-1 keystone) ──
  readFile: async (i) => ({ content: await native.fs.readFile(String(i.path)) }),
  writeFile: async (i) => {
    await native.fs.writeFile(String(i.path), String(i.content ?? ''));
    return {};
  },
  deleteFile: async (i) => {
    await native.fs.rm(String(i.path), { recursive: true, force: true });
    return {};
  },
  renameFile: async (i) => {
    await native.fs.rename(String(i.from ?? i.oldPath), String(i.to ?? i.newPath));
    return {};
  },
  listDirectory: async (i) => {
    const entries = await native.fs.readdir(String(i.path));
    return {
      entries: entries.map((e) => ({
        name: e.name,
        isDirectory: e.isDirectory,
        isFile: e.isFile,
      })),
    };
  },
};

/** Bare request dispatch — used by both the socket shim and components that
 *  fetched `/api/*` directly (e.g. ProjectOnboarding's `apiRequest`). */
export function nativeRequest(name: string, input?: unknown): Promise<unknown> {
  const h = handlers[name];
  if (h) return h((input ?? {}) as Input);
  return Promise.reject(
    new Error(`[studio] '${name}' is not yet wired to window.UglyNative (Phase 1)`),
  );
}

const nativeSocket = {
  request: (name: string, input?: unknown) => nativeRequest(name, input),
  connect: (_token?: string) => Promise.resolve(),
  send: () => {},
  emit: () => {},
};

export function useSocket(): AppSocket<AppRegistry> {
  // projectPath scoping is a no-op here (native handlers take explicit paths).
  useContext(ProjectScopeContext);
  return useMemo(() => nativeSocket as unknown as AppSocket<AppRegistry>, []);
}
