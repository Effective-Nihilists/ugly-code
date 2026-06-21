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
import { native } from 'ugly-app/native';
import type { AppRegistry } from '../shared/api';
import { ProjectScopeContext } from '../state/ProjectScopeContext';
import { firstTurnPrompt, getEvalTask, listEvalTasks } from '../evals/registry';

/** Run a shell command through `bash -lc` (so `~` expands + login PATH applies)
 *  and resolve with the LAST stdout line — a trailing `pwd`/`echo` of a path.
 *  Rejects on non-zero exit. Used by initProject + evalCreateProject. */
function spawnForPath(cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
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

// The opened project's absolute path — set by StudioProjectPage. Used to run
// project-scoped native tools (the DB query script, the `ugly-app` CLI).
let activeProjectPath: string | null = null;
export function setActiveProjectPath(p: string | null): void {
  activeProjectPath = p;
}
/** The opened project's absolute path (for the per-session FS log). */
export function getActiveProjectPath(): string | null {
  return activeProjectPath;
}

// A self-contained Node ESM script (run via native.process in the project) that
// resolves the project's Postgres connection string for both dev (local .env
// DATABASE_URL) and prod (Neon, from the project's publish-state) and runs the
// requested DB op through the project's own ugly-app/server. No backticks/${}
// so it embeds cleanly; inputs arrive via env.
const DB_SCRIPT = [
  "import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';",
  "const mode = process.env.UGLY_DB_MODE, proj = process.env.UGLY_DB_PROJECT, op = process.env.UGLY_DB_OP;",
  "const input = JSON.parse(process.env.UGLY_DB_INPUT || '{}');",
  "function connStr(){",
  "  if (mode === 'prod') {",
  "    const ua = JSON.parse(fs.readFileSync(path.join(proj, '.uglyapp'), 'utf8'));",
  "    const st = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.ugly-studio', 'projects', ua.projectId, 'publish-state.json'), 'utf8'));",
  "    const neon = st.neon || (st.deployTarget && st.deployTarget.neon) || {};",
  "    const cs = neon.connectionString || neon.connStr || (st.deployTarget && st.deployTarget.neonConnectionString);",
  "    if (!cs) throw new Error('No Neon connection string in publish-state for ' + ua.projectId);",
  "    return cs;",
  "  }",
  "  const env = fs.readFileSync(path.join(proj, '.env'), 'utf8');",
  "  const m = /^(?:DATABASE_URL|POSTGRES_URL)=(.+)$/m.exec(env);",
  "  if (!m) throw new Error('No DATABASE_URL/POSTGRES_URL in ' + proj + '/.env');",
  "  return m[1].trim().replace(/^[\"\\']|[\"\\']$/g, '');",
  "}",
  "process.env.DATABASE_URL = connStr();",
  "const mod = await import('ugly-app/server');",
  "mod.createAdapter();",
  "const q = mod.query || mod.pgQuery;",
  "let out = {};",
  "if (op === 'collections') {",
  "  const sql = \"SELECT c.relname AS name, c.reltuples::bigint AS n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace WHERE ns.nspname = 'public' AND c.relkind = 'r' AND c.relname NOT LIKE 'pg_%' ORDER BY c.relname\";",
  "  const r = await q(sql);",
  "  out = { collections: r.rows.map((x) => ({ name: x.name, estimatedCount: Math.max(0, Number(x.n) || 0) })) };",
  "} else if (op === 'getDoc') {",
  "  const r = await q('SELECT data FROM \"' + input.collection + '\" WHERE _id = $1', [input.id]);",
  "  out = { doc: (r.rows[0] && r.rows[0].data) || null };",
  "} else if (op === 'getQuery') {",
  "  const t0 = Date.now();",
  "  const rows = await mod.getQueryRaw(input.collection, input.pipeline || [], { limit: input.limit || 50, skip: input.skip || 0 });",
  "  const columns = rows.length ? Object.keys(rows[0]) : [];",
  "  out = { columns, rows, rowCount: rows.length, durationMs: Date.now() - t0 };",
  "}",
  "process.stdout.write(JSON.stringify(out));",
].join('\n');

/** Spawn the opened project's `ugly-app <cmd> --json` CLI (reads its prod D1
 *  telemetry) and parse the NDJSON output into docs. Resolves [] on any failure
 *  (project not deployed, no CF token, command missing) so panels degrade. */
function runCli(cmd: string): Promise<{ _id: string; created: number; data: Record<string, unknown> }[]> {
  const proj = activeProjectPath;
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
  const proj = activeProjectPath;
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
  listRecentProjects: () => Promise.resolve({ projects: [] }),
  // ── Database panel: run queries against the project's PG (dev) or Neon (prod)
  // via a node+pg script over native.process. ──
  dbCollections: (i) => runDbScript('collections', String(i.mode ?? 'dev'), {}),
  dbGetDoc: (i) =>
    runDbScript('getDoc', String(i.mode ?? 'dev'), { collection: i.collection, id: i.id }),
  dbGetQuery: (i) =>
    runDbScript('getQuery', String(i.mode ?? 'dev'), {
      collection: i.collection,
      pipeline: i.pipeline,
      limit: i.limit,
      skip: i.skip,
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
  workersGetManifest: async () => {
    const docs = await runCli('workers');
    const names = new Map<string, { name: string; schedule?: string }>();
    for (const d of docs) {
      const n = String(d.data.name ?? '');
      if (n && !names.has(n)) names.set(n, { name: n, schedule: d.data.schedule as string | undefined });
    }
    return { available: true, workers: [...names.values()] };
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

  // ── project-page (session sidebar) reads ──
  codingAgentListSessions: () => Promise.resolve({ sessions: [] }),
  gitStatus: () => Promise.resolve({ branch: 'main', remote: null, files: [] }),
  deleteCodingAgentSession: () => Promise.resolve({}),
  // ── coding-agent session protocol (Phase 3 — stubbed; real agent loop next) ──
  codingAgentChatListMessages: () => Promise.resolve({ messages: [], hasMore: false }),
  getCodingAgentSnapshot: () => Promise.resolve(null),
  codingAgentChatCreate: () => Promise.resolve({ sessionId: 'sess-stub:' + Math.random().toString(36).slice(2, 9) }),
  codingAgentChatSend: (i) => {
    const sessionId = String(i.sessionId ?? '');
    const message = String(i.message ?? '');
    // Run the agent loop client-side; it streams codingAgent:event frames back
    // through emitCustom for useCodingAgentChat to render.
    void import('../agent/clientAgent').then((m) =>
      m.runClientAgentTurn(sessionId, message, emitCustom),
    );
    return Promise.resolve({});
  },
  codingAgentChatStop: (i) => {
    void import('../agent/clientAgent').then((m) =>
      m.abortClientAgent(String(i.sessionId ?? '')),
    );
    return Promise.resolve({});
  },
  codingAgentChatClearMessages: () => Promise.resolve({}),
  codingAgentToolStop: () => Promise.resolve({}),
  codingAgentChatSetModel: () => Promise.resolve({}),
  codingAgentSetReasoningEffort: () => Promise.resolve({}),
  codingAgentGrantPermission: () => Promise.resolve({}),
  codingAgentSkipPermissions: () => Promise.resolve({}),
  codingAgentSetPermissionMode: () => Promise.resolve({}),
  codingAgentSetModelMode: () => Promise.resolve({}),
  codingAgentSetPatternMode: () => Promise.resolve({}),
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
