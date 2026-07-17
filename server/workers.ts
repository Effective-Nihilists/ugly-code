/**
 * Cloudflare Workers entry — built by `npm run build:workers` and
 * uploaded by Studio's `workers-deploy` step.
 *
 * The Worker exposes:
 *   - `fetch`     — Hono router for HTTP + WS upgrades
 *   - `scheduled` — Cloudflare Cron Triggers → cron handlers
 *   - `queue`     — Cloudflare Queues → worker handlers
 *   - `CollectionDO` / `SessionDO` — Durable Object classes referenced
 *     by `wrangler.toml`'s `[[durable_objects.bindings]]`
 *
 * The handlers below mirror `server/index.ts`. If you only deploy to
 * Workers, you can delete `server/index.ts` and the framework will
 * route everything through this entry point.
 */

import {
  CollectionDO,
  SessionDO,
  createTypedDB,
  createWorkersApp,
  getAppContext,
} from 'ugly-app/server/adapter/workers';
import type { RequestHandlers } from 'ugly-app';
import type { TypedDB } from 'ugly-app/server';
import type { WorkerHandlers } from 'ugly-app/shared';

import { dbDefaults } from 'ugly-app/shared';
import { messages, requests } from '../shared/api';
import { collections } from '../shared/collections';
import type { RecentProject } from '../shared/collections';
import { cronTasks } from '../shared/cron';
import { agentTurnHandler } from 'ugly-app/agent/server';
import { makeCodingSessionHandlers } from './codingSessionHandlers';
import {
  DEFAULT_USER_SETTINGS,
  mergeUserSettings,
  parseStoredUserSettings,
} from '../shared/userSettings';
import type { UserSettings } from '../shared/userSettings';
import { makeResolveApiKey } from './byoKey';

// The per-request TypedDB is set on the app context before each fetch handler
// runs (createWorkersApp). The coding-session handlers read it lazily.
const workersDb = (): TypedDB => {
  const db = getAppContext().typedDb;
  if (!db) throw new Error('TypedDB not initialized for this request');
  return db as TypedDB;
};

// Request handlers run inside the Worker for `fetch` requests. The studio coding
// chat (client-driven loop) calls `agentTurn`; session persistence (survive
// reload) is the codingSession* set, shared with the Node entry (server/index.ts).
const requestHandlers: Partial<RequestHandlers<typeof requests>> = {
  agentTurn: agentTurnHandler({
    // Tools + system prompt are the CLIENT's authority here — the studio loop
    // (client/studio/agent/clientAgent.ts) sends the per-session gated tool set
    // (sessionToolSpecs: COMMON + mode + project + feature gates) and the fully
    // rendered prompt (env + skills + memory injected) as req.tools/req.systemPrompt.
    // Do NOT pin them here: streamAgentTurn resolves `deps.tools ?? req.tools`
    // (and likewise systemPrompt), so a static config here would OVERRIDE the
    // client — starving the model to the 6 legacy AGENT_TOOLS and shipping the
    // raw prompt template with literal {{MEMORY}}/{{AVAILABLE_SKILLS}} placeholders.
    // BYO-subscription models (glm_coding_plan) run on the user's own provider
    // key, read server-side. This is the PROD path: agentStep isn't registered
    // here (see the note below), so without this the main turn would reach
    // ugly.bot keyless and be refused.
    resolveApiKey: makeResolveApiKey(workersDb),
  }),
  // NOTE: `agentStep` is intentionally NOT registered here. Its handler calls
  // `uglyBotRequest`, which transitively imports node `fs`/`path` (framework
  // SchemaCheck) that can't bundle for the Cloudflare Workers runtime. The
  // pattern engine's aux calls (classifier / judge / synthesis / picker) that hit
  // /api/agentStep therefore only work against a Node origin (local `pnpm dev` /
  // desktop); against the deployed Worker they degrade gracefully (classifier →
  // plain send, criteria grader → skipped, synthesis/picker → base-pattern
  // fallback). Serving aux completions on Workers needs a workers-safe model call
  // (follow-up) — the tool-enabled agent loop uses `agentTurn` (agentTurnHandler),
  // which IS workers-safe.
  ...makeCodingSessionHandlers(workersDb),

  // ── Per-user coding-agent settings (Neon-backed; one doc per user) ──────
  // Mirrors the Node entry (server/index.ts). These MUST be registered here
  // too: prod serves the studio chat from the Worker, and the chat reads
  // settings on mount via `socket.request('getUserSettings')`. Omitting them
  // surfaced as `[Router] 'getUserSettings' is not registered` in prod. The
  // helpers (shared/userSettings.ts) import only zod, so they bundle cleanly.
  getUserSettings: async (userId): Promise<UserSettings> => {
    const doc = await workersDb().getDoc(collections.userSettings, userId);
    return parseStoredUserSettings(doc?.data);
  },
  updateUserSettings: async (userId, patch): Promise<UserSettings> => {
    const db = workersDb();
    const doc = await db.getDoc(collections.userSettings, userId);
    const current = parseStoredUserSettings(doc?.data);
    const next = mergeUserSettings(current, patch);
    await db.setDoc(collections.userSettings, {
      _id: userId,
      userId,
      data: JSON.stringify(next),
      ...dbDefaults(),
    });
    return next;
  },
  // eslint-disable-next-line @typescript-eslint/require-await
  resetUserSettings: async (userId): Promise<UserSettings> => {
    // Delete the doc so a fresh read falls back to defaults (best-effort — a
    // missing doc already reads as defaults).
    void workersDb()
      .deleteDoc(collections.userSettings, userId)
      .catch(() => {
        /* noop */
      });
    return DEFAULT_USER_SETTINGS;
  },

  // Recent projects — synced across the user's devices/sessions. Mirrors the
  // Node entry (server/index.ts) but reads the per-request TypedDB via workersDb().
  recordRecentProject: async (
    userId,
    { deviceId, deviceLabel, path, name },
  ) => {
    const _id = `${userId}:${deviceId}:${path}`;
    const trimmed = name.trim();
    const label =
      trimmed !== ''
        ? trimmed
        : (path.split('/').filter(Boolean).pop() ?? path);
    const doc: RecentProject = {
      _id,
      userId,
      deviceId,
      deviceLabel,
      path,
      name: label,
      lastOpened: Date.now(),
      ...dbDefaults(),
    };
    await workersDb().setDoc(collections.recentProject, doc);
    return { id: _id };
  },

  removeRecentProject: async (userId, { id }) => {
    const db = workersDb();
    const row = await db.getDoc(collections.recentProject, id);
    if (row && row.userId !== userId)
      throw new Error('Recent project not found');
    if (row) await db.deleteDoc(collections.recentProject, id);
    return { ok: true };
  },
};

// The `scheduled` (cron) handler runs outside a fetch request, so there is no
// per-request `getAppContext().typedDb`. createTypedDB binds to the globally
// installed adapter (set up at boot) and does no I/O until called, so a
// module-level singleton is safe here.
const cronDb = createTypedDB(collections);

// Cron handlers run on Cloudflare Cron Triggers (matches the schedule
// declared in `shared/cron.ts`).
const cronHandlers: WorkerHandlers<typeof cronTasks> = {
  dailyCleanup: async () => {
    // Portable sweep of old completed todos (works on D1 AND Neon). Matches the
    // Node entry (server/index.ts). `updated` is the system column; an epoch
    // number binds correctly on both engines. `done` is indexed on the todo
    // collection so D1 accepts this filtered delete.
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    await cronDb.deleteQuery(collections.todo, {
      done: true,
      updated: { $lt: thirtyDaysAgo },
    });
  },
};

const app = createWorkersApp(
  { requests, messages },
  requestHandlers,
  collections,
  (cfg) => {
    cfg.setWorkers(cronTasks, cronHandlers);
  },
);

export default app;
export { CollectionDO, SessionDO };
