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
import { collections, type CodingSession, type CodingSessionMessage, type CodingRunRequest } from '../shared/collections';
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
  | 'codingSessionClearMessages'
  | 'codingRunRequestCreate'
  | 'codingRunRequestClaim'
  | 'codingRunRequestComplete'
>;

// A message's `content` is `JSON.stringify(rawContent)`. A single unbounded tool
// result (e.g. a recursive file listing) can balloon a row past D1's ~1 MB
// per-row limit — the write then fails with SQLITE_TOOBIG. Cap it here, the one
// persistence chokepoint: deep-truncate long string LEAVES (keeping the JSON
// structure + any `tool_use_id`, so the transcript stays parseable and
// resume-safe) and re-stringify. Only kicks in on outliers; typical rows (~8 KB)
// pass through untouched.
const MAX_CONTENT_BYTES = 512 * 1024; // stay well under D1's 1 MB row cap
const MAX_LEAF_BYTES = 100 * 1024;
function truncateLeaf(s: string): string {
  return s.length <= MAX_LEAF_BYTES
    ? s
    : `${s.slice(0, MAX_LEAF_BYTES)}…[truncated ${s.length - MAX_LEAF_BYTES} chars]`;
}
function deepTruncate(v: unknown): unknown {
  if (typeof v === 'string') return truncateLeaf(v);
  if (Array.isArray(v)) return v.map(deepTruncate);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = deepTruncate(val);
    return out;
  }
  return v;
}
export function capMessageContent(content: string): string {
  if (content.length <= MAX_CONTENT_BYTES) return content;
  try {
    return JSON.stringify(deepTruncate(JSON.parse(content)));
  } catch {
    // Non-JSON content (shouldn't happen — it's always stringified) — hard cap to
    // a valid JSON string so reads never choke on a torn value.
    return JSON.stringify(`${content.slice(0, MAX_CONTENT_BYTES)}…[truncated]`);
  }
}

/** `getDb` returns the per-request TypedDB (app.db on Node, typedDb on Workers). */
export function makeCodingSessionHandlers(getDb: () => TypedDB): CodingSessionHandlers {
  return {
    codingSessionUpsert: async (userId, input) => {
      const db = getDb();
      const existing = await db.getDoc(collections.codingSession, input.sessionId);
      if (existing && existing.userId !== userId) throw new Error('Session not found');
      const doc: CodingSession = {
        _id: input.sessionId,
        sessionId: input.sessionId,
        projectId: input.projectId,
        userId,
        title: input.title ?? existing?.title ?? '',
        model: input.model ?? existing?.model ?? '',
        status: input.status ?? existing?.status ?? 'idle',
        messageCount: input.messageCount ?? existing?.messageCount ?? 0,
        costUsd: input.costUsd ?? existing?.costUsd ?? 0,
        // Token usage: preserve the stored value when a given upsert omits it (e.g. a
        // branch-only or chatCreate upsert), like costUsd. persistMeta sends all four
        // every turn.
        ...(() => {
          const t: Partial<Pick<CodingSession, 'promptTokens' | 'completionTokens' | 'cacheReadTokens' | 'cacheCreationTokens'>> = {};
          for (const k of ['promptTokens', 'completionTokens', 'cacheReadTokens', 'cacheCreationTokens'] as const) {
            const v = input[k] ?? existing?.[k];
            if (v !== undefined) t[k] = v;
          }
          return t;
        })(),
        archived: existing?.archived ?? false,
        // The session config is written by chatCreate + the axis set* RPCs; a plain
        // persistMeta (worker turn) omits it, so preserve the stored value.
        ...((input.config ?? existing?.config) ? { config: input.config ?? existing?.config } : {}),
        ...((input.branch ?? existing?.branch) ? { branch: input.branch ?? existing?.branch } : {}),
        // lastError: omitted (undefined) preserves; '' clears (recovered turn); a
        // non-empty string sets the new failure text.
        ...(() => {
          const lastError = input.lastError === undefined ? existing?.lastError : input.lastError || undefined;
          return lastError ? { lastError } : {};
        })(),
        ...dbDefaults(),
        // Preserve the original creation time across updates.
        ...(existing ? { created: existing.created } : {}),
      };
      await db.setDoc(collections.codingSession, doc);
      return { ok: true };
    },

    codingSessionAppendMessage: async (userId, { sessionId, seq, role, content, transient }) => {
      const db = getDb();
      const sess = await db.getDoc(collections.codingSession, sessionId);
      if (sess && sess.userId !== userId) throw new Error('Session not found');
      const doc: CodingSessionMessage = {
        _id: `${sessionId}:${seq}`,
        sessionId, userId, seq, role, kind: 'message', compacted: false,
        content: capMessageContent(content),
        ...dbDefaults(),
      };
      // Streaming write: relay the in-progress row to trackDocs({includeTransient})
      // subscribers WITHOUT persisting (setDoc({transient}), ugly-app>=0.1.857). A later
      // non-transient append at the same seq commits the final content durably.
      await db.setDoc(collections.codingSessionMessage, doc, transient ? { transient: true } : {});
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
        content: capMessageContent(JSON.stringify(summaryText)),
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
        // Sort newest-CREATED first (stable order: a session stays put as it
        // gains activity, instead of jumping to the top on every turn under the
        // old `updated: -1`). A v0.1.124 feedback report asked for exactly this
        // — created-time order so the list doesn't reshuffle while you work.
        { sort: { created: -1 } },
      );
      return {
        sessions: docs.map((d) => ({
          sessionId: d.sessionId, title: d.title, model: d.model,
          status: d.status, messageCount: d.messageCount, costUsd: d.costUsd,
          ...(d.promptTokens !== undefined ? { promptTokens: d.promptTokens } : {}),
          ...(d.completionTokens !== undefined ? { completionTokens: d.completionTokens } : {}),
          ...(d.cacheReadTokens !== undefined ? { cacheReadTokens: d.cacheReadTokens } : {}),
          ...(d.cacheCreationTokens !== undefined ? { cacheCreationTokens: d.cacheCreationTokens } : {}),
          created: new Date(d.created).getTime(),
          updated: new Date(d.updated).getTime(),
          ...(d.config ? { config: d.config } : {}),
          ...(d.branch ? { branch: d.branch } : {}),
          ...(d.lastError ? { lastError: d.lastError } : {}),
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

    // `/clear`: delete every message row for the session (compacted ones too) so a
    // reload/resume starts from an empty transcript, and zero the session counters.
    // The session doc + its worktree binding are kept — same session, fresh history.
    codingSessionClearMessages: async (userId, { sessionId }) => {
      const db = getDb();
      const sess = await db.getDoc(collections.codingSession, sessionId);
      if (sess && sess.userId !== userId) throw new Error('Session not found');
      const docs: CodingSessionMessage[] = await db.getDocs(
        collections.codingSessionMessage,
        { sessionId, userId },
        { limit: 5000 },
      );
      for (const d of docs) {
        await db.deleteDoc(collections.codingSessionMessage, d._id);
      }
      if (sess) {
        await db.setDocFields(collections.codingSession, sessionId, { messageCount: 0, costUsd: 0 });
      }
      return { ok: true, deleted: docs.length };
    },

    // ── Doc-triggered background task (E) ────────────────────────────────────
    // The UI writes a run-request instead of poking native.task; the owning desktop
    // host reacts over trackDocs, CAS-claims it, drives the turn, then completes it.
    codingRunRequestCreate: async (userId, { sessionId, projectId, seq, prompt, selection }) => {
      const db = getDb();
      const id = `run:${sessionId}:${seq}`;
      const doc: CodingRunRequest = {
        _id: id,
        sessionId, projectId, userId, seq, prompt,
        ...(selection ? { selection } : {}),
        status: 'pending',
        createdAt: Date.now(),
        ...dbDefaults(),
      };
      await db.setDoc(collections.codingRunRequest, doc);
      return { id };
    },
    // CAS claim: succeeds only if still `pending`. The task the host then drives is
    // keyed by `coding:<sessionId>` (native.task.ensure dedups), so a double-claim on
    // ONE machine can't double-run; this guards the (rare) multi-host-same-project case.
    codingRunRequestClaim: async (userId, { id, host }) => {
      const db = getDb();
      const req = await db.getDoc(collections.codingRunRequest, id);
      if (req?.userId !== userId) return { claimed: false }; // missing or wrong user
      if (req.status !== 'pending') return { claimed: false }; // already claimed/terminal
      await db.setDocFields(collections.codingRunRequest, id, { status: 'claimed', host });
      return { claimed: true };
    },
    codingRunRequestComplete: async (userId, { id, status, error }) => {
      const db = getDb();
      const req = await db.getDoc(collections.codingRunRequest, id);
      if (req?.userId !== userId) return { ok: false }; // missing or wrong user
      await db.setDocFields(collections.codingRunRequest, id, {
        status,
        ...(error ? { error } : {}),
      });
      return { ok: true };
    },
  };
}
