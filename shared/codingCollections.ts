import { z } from 'zod';
import type { InferDocType } from 'ugly-app/shared';
import { defineCollections } from 'ugly-app/shared';
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
  kind: z.string(),
  model: z.string(),
  status: z.string(),
  messageCount: z.number(),
  costUsd: z.number(),
  archived: z.boolean(),
  // The session's run configuration (model + run modes) — strictly typed and
  // server-persisted so every browser opening the session sees the same picks. See
  // shared/sessionConfig.ts. Optional for backward-compat with rows written before.
  config: sessionConfigSchema.optional(),
});
export type CodingSessionKind = 'main' | 'session';
export type CodingSessionStatus = 'running' | 'idle' | 'done' | 'error';
export type CodingSession = Omit<InferDocType<typeof CodingSessionSchema>, 'kind' | 'status'> & {
  kind: CodingSessionKind;
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

export const codingCollections = defineCollections({
  codingSession: {
    schema: CodingSessionSchema,
    meta: { cache: false, trackable: false, public: false, cascadeFrom: null },
    // Composite expression indexes — ugly-app >=0.1.759 emits multi-field btrees
    // over `((data->>'a'), (data->>'b'), …)` matching the handler filter shapes
    // (earlier versions SILENTLY skipped composite defs → prod had only the GIN
    // index). One per query:
    //   userId+projectId+kind     → codingSessionUpsert (find existing 'main')
    //   userId+projectId+archived → codingSessionList (active sessions)
    // (`updated` is a real TIMESTAMPTZ column, not JSONB, so the list's sort can't
    // ride the index — these buy filter locality; the per-field PostgresIndexes
    // check is satisfied because a composite index credits every one of its fields.)
    indexes: [
      { fields: { userId: 1, projectId: 1, kind: 1 } },
      { fields: { userId: 1, projectId: 1, archived: 1 } },
    ],
  },
  codingSessionMessage: {
    schema: CodingSessionMessageSchema,
    // No cascade — sessions are soft-archived (archived:true), never hard-deleted,
    // so the transcript is preserved. (Cascade would key on `codingSessionId`; we
    // use `sessionId`.)
    meta: { cache: false, trackable: false, public: false, cascadeFrom: null },
    // Composite (ugly-app >=0.1.759). Handlers filter sessionId+userId(+compacted);
    // `seq` is a JSONB field, so trailing it lets the transcript read come back
    // index-ordered before the JS numeric re-sort (compareCodingMessages).
    indexes: [
      { fields: { sessionId: 1, userId: 1, compacted: 1, seq: 1 } },
      { fields: { sessionId: 1, userId: 1, seq: 1 } },
    ],
  },
});
