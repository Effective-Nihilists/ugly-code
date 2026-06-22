import { z } from 'zod';
import type { InferDocType } from 'ugly-app/shared';
import { defineCollections } from 'ugly-app/shared';
import { codingCollections } from './codingCollections';
import type { CodingSession, CodingSessionMessage } from './codingCollections';

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

// Coding-agent session collections live in their own module (codingCollections)
// to keep this file under TypeScript's type-instantiation budget — see that file
// for the full rationale. Re-export their types for convenience.
export type {
  CodingSession,
  CodingSessionMessage,
  CodingSessionKind,
  CodingSessionStatus,
  CodingSessionMessageRole,
  CodingSessionMessageKind,
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
const baseCollections = defineCollections({
  todo: {
    schema: TodoSchema,
    meta: { cache: false, trackable: true, public: false, cascadeFrom: null, trackKeys: ['userId'] },
  },
  conversation: {
    schema: ConversationSchema,
    meta: { cache: false, trackable: false, public: false, cascadeFrom: null },
  },
  message: {
    schema: MessageSchema,
    meta: { cache: false, trackable: false, public: false, cascadeFrom: 'conversation', trackKeys: ['conversationId'] },
  },
  collabDoc: {
    schema: CollabDocSchema,
    meta: { cache: false, trackable: false, public: false, cascadeFrom: null },
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
type ColDef<T> = Omit<typeof baseCollections.collabDoc, '_type' | 'name' | 'schema' | 'meta'> & {
  _type?: T;
  name: string;
  schema: z.ZodObject<z.ZodRawShape>;
  meta: (typeof baseCollections.collabDoc)['meta'];
};
const cc = codingCollections as Record<'codingSession' | 'codingSessionMessage', unknown>;

export const collections = {
  ...baseCollections,
  codingSession: cc.codingSession as ColDef<CodingSession>,
  codingSessionMessage: cc.codingSessionMessage as ColDef<CodingSessionMessage>,
};

export type AppCollections = typeof collections;
