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
} from 'ugly-app/server/adapter/workers';
import type { RequestHandlers } from 'ugly-app';
import type { WorkerHandlers } from 'ugly-app/shared';

import { messages, requests } from '../shared/api';
import { collections } from '../shared/collections';
import { cronTasks } from '../shared/cron';

// Request handlers run inside the Worker for `fetch` requests. Most
// projects keep these in sync with `server/index.ts`; the framework's
// `app.db` works the same way in both runtimes.
const requestHandlers: Partial<RequestHandlers<typeof requests>> = {};

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
