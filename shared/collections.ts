import { z } from 'zod';
import type { InferDocType, IndexDef } from 'ugly-app/shared';
import { defineCollections, d1 } from 'ugly-app/shared';
import { codingCollections } from './codingCollections';
import type { CodingSession, CodingSessionMessage, CodingRunRequest, CodingInteraction } from './codingCollections';

// ─── Schemas & Types ─────────────────────────────────────────────────────────

export const TodoSchema = z.object({
  userId: z.string(),
  text: z.string(),
  done: z.boolean(),
});
export type Todo = InferDocType<typeof TodoSchema>;

export const ConversationSchema = z.object({
  type: z.string().default('ai-chat'),
  title: z.string().default(''),
});
export type Conversation = InferDocType<typeof ConversationSchema>;

export const MessageSchema = z.object({
  conversationId: z.string(),
  userId: z.string(),
  text: z.string(),
});
export type Message = InferDocType<typeof MessageSchema>;

export const CollabDocSchema = z.object({
  yjsState: z.string(),
  serialized: z.string().nullable(),
  lastSyncedAt: z.number(),
});
export type CollabDoc = InferDocType<typeof CollabDocSchema>;

// Recent projects — synced across all of a user's devices/sessions (replaces the
// old localStorage list). Each row is stamped with the desktop (`deviceId` +
// human-readable `deviceLabel`) that physically holds the project files, so a
// phone can reconnect to the right host via the proxy. The doc `_id` is
// deterministic (`${userId}:${deviceId}:${path}`) so re-opening upserts one row.
export const RecentProjectSchema = z.object({
  userId: z.string(),
  deviceId: z.string(),
  deviceLabel: z.string(),
  path: z.string(),
  name: z.string(),
  lastOpened: z.number(),
});
export type RecentProject = InferDocType<typeof RecentProjectSchema>;

// Per-user coding-agent settings (studio getUserSettings/update/reset). The
// settings object is stored as a JSON string blob so this file stays under
// TypeScript's type-instantiation budget — the typed shape + defaults + merge
// live in ./userSettings.ts. Doc `_id` is the userId (one row per user).
export const UserSettingsSchema = z.object({
  userId: z.string(),
  data: z.string(),
});
export type UserSettingsDoc = InferDocType<typeof UserSettingsSchema>;

// Coding-agent session collections live in their own module (codingCollections)
// to keep this file under TypeScript's type-instantiation budget — see that file
// for the full rationale. Re-export their types for convenience.
export type {
  CodingSession,
  CodingSessionMessage,
  CodingSessionStatus,
  CodingSessionMessageRole,
  CodingSessionMessageKind,
  CodingRunRequest,
  CodingRunRequestStatus,
  CodingInteraction,
  CodingInteractionStatus,
} from './codingCollections';

// --- Collections ---
// meta options:
//   cache        – cache docs in memory LRU (good for small, frequently read collections)
//   trackable    – emit change events so clients can subscribe to real-time updates
//   public       – allow unauthenticated reads (use sparingly)
//   cascadeFrom  – name of a parent collection: when that parent is deleted, cascade here
//   trackKeys    – fields whose values are used as NATS routing keys for scoped trackDocs
//                  subscriptions. Example: trackKeys: ['chatId'] enables
//                  socket.trackDocs(collections.message, { keys: { chatId: '...' } }, cb)
//
// After adding a collection, run: npm run db:schema-gen && npm run db:migrate
// INFERENCE-BUDGET NOTE: with `db: d1` on every collection, INLINE `indexes: [...]`
// tuples tip TypeScript's mapped-type inference budget — `defineCollections` then
// bails and EVERY `collections.X` collapses to `... | undefined`, breaking tsc
// across the app. Keep each index list in an already-widened `IndexDef[]`-typed
// module const (below) and reference it — that stays under budget.
const todoIndexes: { fields: Record<string, 1 | -1> }[] = [
  // Every read is getDoc by _id; the only filtered access is the dailyCleanup
  // cron `deleteQuery({ done: true, updated: { $lt } })`. D1 throws on an
  // unindexed filter field, so index `done` (`updated` is a system column and
  // is exempt from the index-coverage check).
  { fields: { done: 1 } },
];
const recentProjectIndexes: { fields: Record<string, 1 | -1> }[] = [
  // Every read filters by userId (a user's recent projects). `trackKeys` does
  // NOT create a btree expression index, so declare one explicitly.
  { fields: { userId: 1 } },
];

const baseCollections = defineCollections({
  todo: {
    schema: TodoSchema,
    meta: { cache: false, trackable: true, public: false, cascadeFrom: null, trackKeys: ['userId'], db: d1 },
    indexes: todoIndexes,
  },
  conversation: {
    schema: ConversationSchema,
    meta: { cache: false, trackable: false, public: false, cascadeFrom: null, db: d1 },
  },
  message: {
    schema: MessageSchema,
    meta: { cache: false, trackable: false, public: false, cascadeFrom: 'conversation', trackKeys: ['conversationId'], db: d1 },
  },
  collabDoc: {
    schema: CollabDocSchema,
    meta: { cache: false, trackable: false, public: false, cascadeFrom: null, db: d1 },
  },
  recentProject: {
    schema: RecentProjectSchema,
    meta: { cache: false, trackable: true, public: false, cascadeFrom: null, trackKeys: ['userId'], db: d1 },
    indexes: recentProjectIndexes,
  },
  userSettings: {
    schema: UserSettingsSchema,
    // Trackable + userId key so a settings change fans out to the user's other
    // devices/sessions via trackDocs. Reads are getDoc by _id (=userId), so the
    // primary key covers lookups — no extra btree index needed.
    meta: { cache: false, trackable: true, public: false, cascadeFrom: null, trackKeys: ['userId'], db: d1 },
  },
});

// `CollectionDef<T>` isn't exported from ugly-app, and letting `defineCollections`
// infer the coding collections' types via `InferDocType` tips this module past
// TypeScript's type-instantiation budget — which silently erases a collection's
// type to `{}` and breaks `db.setDoc`/`getDocs` type-safety app-wide (even for
// unrelated collections). So we borrow the framework's CollectionDef *shape* from
// a base collection (always precisely typed, cheap) and re-parameterize it over
// an explicit doc type. The runtime values come from `codingCollections`
// (correct: { schema, meta, indexes, name }); only the static type is asserted.
// `_idx` is the phantom tuple that ugly-app's compile-time index-safety reads to
// know which fields a collection may be filtered/sorted on (CollectionIndexedFields).
// The cast must carry it, or `getDocs` would only allow the top-level columns.
type ColDef<T, Idx extends readonly IndexDef[] = readonly IndexDef[]> = Omit<
  typeof baseCollections.collabDoc,
  '_type' | '_idx' | 'name' | 'schema' | 'meta'
> & {
  _type?: T;
  _idx?: Idx;
  name: string;
  schema: z.ZodObject<z.ZodRawShape>;
  meta: (typeof baseCollections.collabDoc)['meta'];
};
const cc = codingCollections as Record<'codingSession' | 'codingSessionMessage' | 'codingRunRequest' | 'codingInteraction', unknown>;

// Literal index tuples used ONLY as the `_idx` phantom on the cast below, so the
// 0.1.843 index-safety check knows the indexed fields. These are types, never fed
// to `defineCollections`, so they don't tip its inference budget (see the note in
// codingCollections.ts). MUST mirror codingSession*Indexes in codingCollections.ts.
type CodingSessionIdx = readonly [
  { fields: { userId: 1; projectId: 1; archived: 1 } },
];
type CodingSessionMessageIdx = readonly [
  { fields: { sessionId: 1; userId: 1; compacted: 1; seq: 1 } },
  { fields: { sessionId: 1; userId: 1; seq: 1 } },
];
type CodingRunRequestIdx = readonly [
  { fields: { userId: 1; status: 1 } },
];
type CodingInteractionIdx = readonly [
  { fields: { userId: 1; sessionId: 1; status: 1 } },
];

export const collections = {
  ...baseCollections,
  codingSession: cc.codingSession as ColDef<CodingSession, CodingSessionIdx>,
  codingSessionMessage: cc.codingSessionMessage as ColDef<CodingSessionMessage, CodingSessionMessageIdx>,
  codingRunRequest: cc.codingRunRequest as ColDef<CodingRunRequest, CodingRunRequestIdx>,
  codingInteraction: cc.codingInteraction as ColDef<CodingInteraction, CodingInteractionIdx>,
};

export type AppCollections = typeof collections;
