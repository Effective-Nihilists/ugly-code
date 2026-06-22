/**
 * Coding-agent session persistence handlers (survive reload), shared by BOTH
 * server entries: the Node entry (server/index.ts → app.db) and the Cloudflare
 * Workers entry (server/workers.ts → getAppContext().typedDb). Keeping them in
 * one factory means the deployed Worker and local Node server never drift.
 *
 * See shared/collections.ts (codingSession / codingSessionMessage) and
 * client/studio/agent/clientAgent.ts for the persistence + compaction design.
 */

import type { TypedDB } from 'ugly-app/server';
import type { RequestHandlers } from 'ugly-app';
import { dbDefaults } from 'ugly-app/shared';
import { collections, type CodingSession, type CodingSessionMessage } from '../shared/collections';
import { compareCodingMessages } from '../shared/codingCollections';
import type { requests } from '../shared/api';

type CodingSessionHandlers = Pick<
  RequestHandlers<typeof requests>,
  | 'codingSessionUpsert'
  | 'codingSessionAppendMessage'
  | 'codingSessionCompact'
  | 'codingSessionListMessages'
  | 'codingSessionList'
  | 'codingSessionArchive'
>;

/** `getDb` returns the per-request TypedDB (app.db on Node, typedDb on Workers). */
export function makeCodingSessionHandlers(getDb: () => TypedDB): CodingSessionHandlers {
  return {
    codingSessionUpsert: async (userId, input) => {
      const db = getDb();
      const existing = await db.getDoc(collections.codingSession, input.sessionId);
      if (existing && existing.userId !== userId) throw new Error('Session not found');
      // Resolve kind once (on first upsert). The first session in a project with
      // no `main` yet becomes the main session; this needs no client plumbing.
      let kind = input.kind ?? existing?.kind;
      if (!kind) {
        const mains: CodingSession[] = await db.getDocs(
          collections.codingSession,
          { userId, projectId: input.projectId, kind: 'main' },
          { limit: 1 },
        );
        kind = mains.length > 0 ? 'session' : 'main';
      }
      const doc: CodingSession = {
        _id: input.sessionId,
        sessionId: input.sessionId,
        projectId: input.projectId,
        userId,
        title: input.title ?? existing?.title ?? '',
        kind,
        model: input.model ?? existing?.model ?? '',
        status: input.status ?? existing?.status ?? 'idle',
        messageCount: input.messageCount ?? existing?.messageCount ?? 0,
        costUsd: input.costUsd ?? existing?.costUsd ?? 0,
        archived: existing?.archived ?? false,
        ...dbDefaults(),
        // Preserve the original creation time across updates.
        ...(existing ? { created: existing.created } : {}),
      };
      await db.setDoc(collections.codingSession, doc);
      return { ok: true };
    },

    codingSessionAppendMessage: async (userId, { sessionId, seq, role, content }) => {
      const db = getDb();
      const sess = await db.getDoc(collections.codingSession, sessionId);
      if (sess && sess.userId !== userId) throw new Error('Session not found');
      const doc: CodingSessionMessage = {
        _id: `${sessionId}:${seq}`,
        sessionId, userId, seq, role, kind: 'message', compacted: false, content,
        ...dbDefaults(),
      };
      await db.setDoc(collections.codingSessionMessage, doc);
      return { ok: true };
    },

    // Persist a compaction structurally: flag the dropped originals out of the
    // normal view (kept for the full history) + insert one summary row at the
    // dropped block's seq, so the normal query == runAgent's compacted context.
    // Mark by _id (summary rows don't follow the sessionId:seq scheme). setDoc
    // the summary AFTER marking, so re-summarizing a prior summary (same _id)
    // leaves the row active.
    codingSessionCompact: async (userId, { sessionId, droppedIds, summaryId, summarySeq, summaryText }) => {
      const db = getDb();
      const sess = await db.getDoc(collections.codingSession, sessionId);
      if (sess && sess.userId !== userId) throw new Error('Session not found');
      const prefix = `${sessionId}:`;
      for (const id of droppedIds) {
        if (!id.startsWith(prefix)) continue; // scope guard: only this session's rows
        await db.setDocFieldsOrIgnore(collections.codingSessionMessage, id, { compacted: true });
      }
      if (!summaryId.startsWith(prefix)) throw new Error('Invalid summary id');
      const summary: CodingSessionMessage = {
        _id: summaryId,
        sessionId, userId, seq: summarySeq, role: 'user', kind: 'summary', compacted: false,
        content: JSON.stringify(summaryText),
        ...dbDefaults(),
      };
      await db.setDoc(collections.codingSessionMessage, summary);
      return { ok: true };
    },

    codingSessionListMessages: async (userId, { sessionId, limit, includeCompacted }) => {
      const db = getDb();
      const filter: Record<string, unknown> = { sessionId, userId };
      if (!includeCompacted) filter.compacted = false;
      const docs: CodingSessionMessage[] = await db.getDocs(collections.codingSessionMessage, filter, {
        sort: { seq: 1 },
        limit: limit ?? 2000,
      });
      // The DB sorts `seq` as JSONB text (1,10,11,…,2,20,…) — re-sort NUMERICALLY
      // (with the summary tiebreak) so tool_calls precede their results on replay
      // and the resume seed is chronological. See compareCodingMessages.
      const sorted = [...docs].sort(compareCodingMessages);
      return {
        messages: sorted.map((d) => ({
          seq: d.seq, role: d.role, kind: d.kind, compacted: d.compacted, content: d.content,
        })),
      };
    },

    codingSessionList: async (userId, { projectId }) => {
      const db = getDb();
      const docs: CodingSession[] = await db.getDocs(
        collections.codingSession,
        { userId, projectId, archived: false },
        { sort: { updated: -1 } },
      );
      return {
        sessions: docs.map((d) => ({
          sessionId: d.sessionId, title: d.title, kind: d.kind, model: d.model,
          status: d.status, messageCount: d.messageCount, costUsd: d.costUsd,
          created: new Date(d.created).getTime(),
          updated: new Date(d.updated).getTime(),
        })),
      };
    },

    codingSessionArchive: async (userId, { sessionId }) => {
      const db = getDb();
      const sess = await db.getDoc(collections.codingSession, sessionId);
      if (sess?.userId !== userId) throw new Error('Session not found');
      await db.setDocFields(collections.codingSession, sessionId, { archived: true });
      return { ok: true };
    },
  };
}
