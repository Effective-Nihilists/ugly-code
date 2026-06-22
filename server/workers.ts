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
  createWorkersApp,
  getAppContext,
} from 'ugly-app/server/adapter/workers';
import type { RequestHandlers } from 'ugly-app';
import type { TypedDB } from 'ugly-app/server';
import type { WorkerHandlers } from 'ugly-app/shared';

import { messages, requests } from '../shared/api';
import { collections } from '../shared/collections';
import { cronTasks } from '../shared/cron';
import { agentTurnHandler } from 'ugly-app/agent/server';
import { AGENT_TOOLS, AGENT_SYSTEM_PROMPT } from '../shared/agent';
import { makeCodingSessionHandlers } from './codingSessionHandlers';

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
  agentTurn: agentTurnHandler({ tools: AGENT_TOOLS, systemPrompt: AGENT_SYSTEM_PROMPT }),
  ...makeCodingSessionHandlers(workersDb),
};

// Cron handlers run on Cloudflare Cron Triggers (matches the schedule
// declared in `shared/cron.ts`).
const cronHandlers: WorkerHandlers<typeof cronTasks> = {
  // eslint-disable-next-line @typescript-eslint/require-await
  dailyCleanup: async () => {
    // Implement in your Worker: e.g. prune old rows via Hyperdrive or D1.
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
