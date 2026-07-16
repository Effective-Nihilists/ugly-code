import { z } from 'zod';
import type { InferDocType } from 'ugly-app/shared';
import { defineCollections, d1 } from 'ugly-app/shared';
import { sessionConfigSchema } from './sessionConfig';

// ─── Coding-agent session collections (own module ON PURPOSE) ────────────────
// The coding chat runs client-side (client/studio/agent/clientAgent.ts); these
// two collections give it a durable, owner-scoped home keyed by
// (userId, projectId, sessionId) so sessions survive reload.
//
// Why a separate file: `defineCollections` runs `z.infer` per field, and adding
// these to shared/collections.ts pushed that module past TypeScript's
// type-instantiation budget — which makes it SILENTLY widen a collection's type
// to the erased base `{}`, breaking `db.setDoc`/`getDocs` type-safety app-wide.
// The budget is per type-resolution, so defining them here (a fresh module) keeps
// both files comfortably under it. shared/collections.ts just spreads the result.
//
// The zod schemas use plain primitives (kind/role/status as `z.string()`) to keep
// `z.infer` cheap; the precise enum types live on the exported TS types (and the
// wire shape is enum-validated in shared/api.ts). The DB column is just a string.

export const CodingSessionSchema = z.object({
  sessionId: z.string(),
  projectId: z.string(),
  userId: z.string(),
  title: z.string(),
  model: z.string(),
  status: z.string(),
  messageCount: z.number(),
  costUsd: z.number(),
  // Cumulative token usage (server-persisted so the session list can show it and it
  // survives reload). Optional for backward-compat with rows written before these
  // columns existed. Accrued per turn in clientAgent (see persistMeta). NOTE: these
  // were previously sent by persistMeta but SILENTLY DROPPED at the codingSessionUpsert
  // zod boundary (shared/api.ts) — so tokens never persisted and reset to 0 on reload.
  promptTokens: z.number().optional(),
  completionTokens: z.number().optional(),
  cacheReadTokens: z.number().optional(),
  cacheCreationTokens: z.number().optional(),
  archived: z.boolean(),
  // The session's run configuration (model + run modes) — strictly typed and
  // server-persisted so every browser opening the session sees the same picks. See
  // shared/sessionConfig.ts. Optional for backward-compat with rows written before.
  config: sessionConfigSchema.optional(),
  // The git branch (or 'main') this session operates on. Server-persisted so
  // every browser sees the correct branch pill. Only set for worktree sessions;
  // main-branch sessions omit it (the sidebar resolves to 'main').
  branch: z.string().optional(),
  // The last turn's failure text, when a turn ended in `status:'error'`. Persisted
  // so a failed session is diagnosable from its id alone (the `⚠` chat bubble is
  // renderer-only and never hit the transcript). Cleared on the next successful
  // turn. See clientAgent.persistMeta.
  lastError: z.string().optional(),
});
export type CodingSessionStatus = 'running' | 'idle' | 'done' | 'error';
export type CodingSession = Omit<InferDocType<typeof CodingSessionSchema>, 'status'> & {
  status: CodingSessionStatus;
};

// One row per message. `content` is JSON (string|ContentPart[]|tool-results),
// serialized — `role`+`kind` say how to parse it (see clientAgent persistence).
// Compaction: the dropped rows are flagged `compacted:true` (kept, never re-sent)
// and one `kind:'summary'` row is inserted at the dropped block's `seq`. The
// "normal" query (compacted:false, sort by seq) is BOTH the display history and
// the resume seed = runAgent's exact post-compaction working context.
export const CodingSessionMessageSchema = z.object({
  sessionId: z.string(),
  userId: z.string(),
  seq: z.number(),
  role: z.string(),
  kind: z.string(),
  compacted: z.boolean(),
  /** JSON.stringify of the raw content (parsed per role/kind on read). */
  content: z.string(),
});
export type CodingSessionMessageRole = 'user' | 'assistant' | 'tool';
export type CodingSessionMessageKind = 'message' | 'summary';
export type CodingSessionMessage = Omit<InferDocType<typeof CodingSessionMessageSchema>, 'role' | 'kind'> & {
  role: CodingSessionMessageRole;
  kind: CodingSessionMessageKind;
};

// ─── Doc-triggered background task (E) ───────────────────────────────────────
// A run-request is the DECOUPLED trigger: the UI writes one (setDoc via
// codingRunRequestCreate) instead of poking native.task directly; the desktop host
// that OWNS the project reacts to it over trackDocs and drives the turn. Keyed by
// userId (the host subscribes by user, then filters to projects it hosts). `_id` is
// `run:<sessionId>:<seq>` so re-issuing the same turn is idempotent. A host CAS-claims
// a pending request (status pending→claimed) so exactly one host runs it.
export const CodingRunRequestSchema = z.object({
  sessionId: z.string(),
  projectId: z.string(),
  userId: z.string(),
  seq: z.number(),
  prompt: z.string(),
  /** JSON-stringified editor selection carried to the agent turn, when present. */
  selection: z.string().optional(),
  /** The SPA buildId that issued this request — the host forks the MATCHING
   *  `coding.js` bundle (`taskEntryUrl('coding', buildId)`), never a stale one. */
  buildId: z.string(),
  status: z.string(), // 'pending' | 'claimed' | 'done' | 'error'
  /** deviceId of the host that claimed it (set on claim). */
  host: z.string().optional(),
  /** Failure text when status === 'error'. */
  error: z.string().optional(),
  createdAt: z.number(),
});
export type CodingRunRequestStatus = 'pending' | 'claimed' | 'done' | 'error';
export type CodingRunRequest = Omit<InferDocType<typeof CodingRunRequestSchema>, 'status'> & {
  status: CodingRunRequestStatus;
};

// ── Interactive control (F, doc-driven) ──────────────────────────────────────────────
// Proxy-free bridge for the interactive controls a coding turn needs, so a mobile/remote
// client can steer a turn without the WebRTC task tunnel. Two directions in one collection,
// forwarded by the owning desktop host to its local task.call:
//   QUESTIONS  (kind ask_user/step_review): the AGENT writes one when it parks a turn on a
//     gate (so any client renders the card via trackDocs); the CLIENT answers (status
//     answered + response); the HOST forwards the answer to the task; the agent resolves it.
//   COMMANDS   (kind stop/tool_stop): the CLIENT writes one; the HOST forwards it to the
//     task (interrupt / toolStop) and marks it done.
export const CodingInteractionSchema = z.object({
  sessionId: z.string(),
  userId: z.string(),
  kind: z.string(), // 'ask_user' | 'step_review' | 'stop' | 'tool_stop'
  /** ask_user / tool_stop target. */
  toolCallId: z.string().optional(),
  /** step_review target. */
  stepId: z.string().optional(),
  /** JSON question payload the agent parked (ask_user: {question,options}; step_review: {...}). */
  question: z.string().optional(),
  status: z.string(), // 'pending' | 'answered' | 'done'
  /** JSON client answer ({answer} | {action,feedback}). */
  response: z.string().optional(),
  createdAt: z.number(),
});
export type CodingInteractionStatus = 'pending' | 'answered' | 'done';
export type CodingInteraction = Omit<InferDocType<typeof CodingInteractionSchema>, 'status'> & {
  status: CodingInteractionStatus;
};

/**
 * Stable transcript ordering. The DB sorts `seq` as JSONB TEXT
 * (1,10,11,…,2,20), so every transcript read MUST re-sort with this:
 * - numeric `seq` ascending (tool_calls precede their results; resume seed is
 *   chronological);
 * - a `summary` row reuses the seq of the oldest message it subsumes, so when it
 *   ties an original (only in the includeCompacted view) the summary sorts first,
 *   sitting at the head of the block it represents. In the normal view the
 *   originals are compacted out, so the summary is the sole row at that seq.
 */
export function compareCodingMessages(
  a: { seq: number; kind: string },
  b: { seq: number; kind: string },
): number {
  return a.seq - b.seq || (a.kind === 'summary' ? -1 : 0) - (b.kind === 'summary' ? -1 : 0);
}

// INFERENCE-BUDGET NOTE: with `db: d1` on the meta, INLINE `indexes: [...]` tuples
// tip TypeScript's mapped-type inference budget — `defineCollections` then bails
// and collapses the collection type. Keep each index list in an already-widened
// `IndexDef[]`-typed module const and reference it (mirrors shared/collections.ts).
const codingSessionIndexes: { fields: Record<string, 1 | -1> }[] = [
  // Composite expression index matching the list handler's filter shape:
  //   userId+projectId+archived → codingSessionList (active sessions)
  // (`updated` is a system column, so codingSessionList's sort{updated:-1} is
  // exempt from the index-coverage check; this buys filter locality and credits
  // every filtered field.) Upsert is a getDoc by _id, covered by the primary key.
  { fields: { userId: 1, projectId: 1, archived: 1 } },
];
const codingSessionMessageIndexes: { fields: Record<string, 1 | -1> }[] = [
  // Handlers filter sessionId+userId(+compacted) and sort by `seq` (a JSONB field,
  // so it MUST be indexed on D1). Trailing `seq` lets the transcript read come back
  // index-ordered before the JS numeric re-sort (compareCodingMessages).
  { fields: { sessionId: 1, userId: 1, compacted: 1, seq: 1 } },
  { fields: { sessionId: 1, userId: 1, seq: 1 } },
];
const codingRunRequestIndexes: { fields: Record<string, 1 | -1> }[] = [
  // Host subscribes trackDocs by userId; also scans pending by userId on connect.
  { fields: { userId: 1, status: 1 } },
];
const codingInteractionIndexes: { fields: Record<string, 1 | -1> }[] = [
  // Client tracks by sessionId (cards for the open session); host tracks by userId.
  { fields: { userId: 1, sessionId: 1, status: 1 } },
];

export const codingCollections = defineCollections({
  codingSession: {
    schema: CodingSessionSchema,
    // Live-synced to the session list (StudioProjectPage) via trackDocs. `userId`
    // MUST be a trackKey so the Workers path owner-scopes the subscription (it injects
    // the authenticated userId for owner-scoped collections); `projectId` is the list
    // routing key the client subscribes on. Query filter {userId,projectId,archived}
    // stays covered by codingSessionIndexes.
    meta: { cache: false, trackable: true, trackKeys: ['userId', 'projectId'], public: false, cascadeFrom: null, db: d1 },
    indexes: codingSessionIndexes,
  },
  codingSessionMessage: {
    schema: CodingSessionMessageSchema,
    // No cascade — sessions are soft-archived (archived:true), never hard-deleted,
    // so the transcript is preserved. (Cascade would key on `codingSessionId`; we
    // use `sessionId`.) Live-synced to the transcript via trackDocs keyed by
    // `sessionId`; `userId` owner-scopes it (Workers injects the authed userId).
    meta: { cache: false, trackable: true, trackKeys: ['userId', 'sessionId'], public: false, cascadeFrom: null, db: d1 },
    indexes: codingSessionMessageIndexes,
  },
  codingRunRequest: {
    schema: CodingRunRequestSchema,
    // Live-synced to the OWNING desktop host via trackDocs keyed by userId (the host
    // filters to projects it hosts). No cascade — short-lived control docs.
    meta: { cache: false, trackable: true, trackKeys: ['userId'], public: false, cascadeFrom: null, db: d1 },
    indexes: codingRunRequestIndexes,
  },
  codingInteraction: {
    schema: CodingInteractionSchema,
    // Client tracks by sessionId (render cards for the open session); host tracks by
    // userId (forward answers/commands for owned sessions). No cascade — short-lived.
    meta: { cache: false, trackable: true, trackKeys: ['userId', 'sessionId'], public: false, cascadeFrom: null, db: d1 },
    indexes: codingInteractionIndexes,
  },
});
