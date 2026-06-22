import {
  createApp,
  pgQuery,
  emailSend,
  flushPerf,
  pushSend,
  recordFeedback,
  recordPerf,
  uglyBotRequest,
  type AppConfigurator,
  type InboundEmail,
  type RequestHandlers,
} from 'ugly-app';
import { nanoid } from 'nanoid';
import { enableConversations } from 'ugly-app/conversation/server';
import { enableCollab } from 'ugly-app/collab/server';
import type { WorkerHandlers, TextGenModel } from 'ugly-app/shared';
import { dbDefaults } from 'ugly-app/shared';
import { messages, requests } from '../shared/api';
import { AGENT_DEFAULT_MODEL, AGENT_SYSTEM_PROMPT, AGENT_TOOLS, type AgentMessage } from '../shared/agent';
import { agentTurnHandler } from 'ugly-app/agent/server';
import type { Todo, CodingSession, CodingSessionMessage } from '../shared/collections';
import { collections } from '../shared/collections';
import { cronTasks } from '../shared/cron';
import { experiments } from '../shared/experiments';
import en from '../shared/lang/en';
import es from '../shared/lang/es';
import { pages } from '../shared/pages';
import { stringsDef } from '../shared/strings';

const cronHandlers: WorkerHandlers<typeof cronTasks> = {
  dailyCleanup: async () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const result = await pgQuery(
      `DELETE FROM docs_todo WHERE (data->>'done')::boolean = true AND (data->'updated')::bigint < $1`,
      [thirtyDaysAgo.getTime()],
    );
    console.log(`[Cron] dailyCleanup: deleted ${result.rowCount} old completed todos`);
  },
};

const app = createApp(
  { requests, messages },
  {
    // Standardized client-driven agent turn (ugly-app/agent) — the studio path.
    agentTurn: agentTurnHandler({ tools: AGENT_TOOLS, systemPrompt: AGENT_SYSTEM_PROMPT }),

    // Coding agent — forward one turn to ugly.bot's textGen with the system
    // prompt + tool specs, and return the raw assistant message (tool_use
    // blocks included) for the client loop to dispatch.
    agentStep: async (_userId, { messages: history, model }) => {
      const data = await uglyBotRequest('textGen', {
        model: (model as TextGenModel) ?? AGENT_DEFAULT_MODEL,
        messages: [
          { role: 'system', content: AGENT_SYSTEM_PROMPT },
          ...history,
        ],
        tools: AGENT_TOOLS,
        options: { maxTokens: 8192 },
      });
      if (!data?.message) throw new Error('Agent step failed: no response from model');
      return { message: data.message as AgentMessage };
    },

    createTodo: async (userId, { text }) => {
      const _id = nanoid();
      const todo: Todo = { _id, userId, text, done: false, ...dbDefaults() };
      await app.db.setDoc(collections.todo, todo);
      return { id: _id };
    },

    toggleTodo: async (userId, { todoId }) => {
      const todo = await app.db.getDoc(collections.todo, todoId);
      if (!todo?.userId || todo.userId !== userId) throw new Error('Todo not found');
      const updated: Todo = { ...todo, done: !todo.done, ...dbDefaults() };
      await app.db.setDoc(collections.todo, updated);
      return { done: updated.done };
    },

    deleteTodo: async (userId, { todoId }) => {
      const todo = await app.db.getDoc(collections.todo, todoId);
      if (!todo?.userId || todo.userId !== userId) throw new Error('Todo not found');
      await app.db.deleteDoc(collections.todo, todoId);
      return { ok: true };
    },

    sendPush: async (_userId, { targetUserId, title, body, path, query, imageUrl }) => {
      try {
        const result = await pushSend({ targetUserId, title, body, path, ...(query ? { query } : {}), ...(imageUrl ? { imageUrl } : {}) });
        return { sent: result.sent };
      } catch (e) {
        console.error(e);
        return { sent: false };
      }
    },

    triggerTestError: (_userId, { message }) => {
      const msg = message ?? 'Test server error triggered intentionally';
      throw new Error(msg);
    },

    testWorkerThrow: (_userId, { message }) => {
      const msg = message ?? 'Worker task exception test';
      throw new Error(msg);
    },

    testWorkerDbMutation: async (userId, { text }): Promise<{ id: string; verified: boolean }> => {
      const _id = `worker-test-${crypto.randomUUID()}`;
      const todo: Todo = { _id, userId, text, done: false, ...dbDefaults() };
      await app.db.setDoc(collections.todo, todo);
      const readBack = await app.db.getDoc(collections.todo, _id);
      const verified = readBack?._id === _id && readBack.text === text;
      await app.db.deleteDoc(collections.todo, _id);
      return { id: _id, verified };
    },

    // eslint-disable-next-line @typescript-eslint/require-await
    testWorkerConsoleError: async (_userId, { message }) => {
      const msg = message ?? `[WorkerTest] console.error test ${Date.now()}`;
      console.error(msg);
      return { logged: true };
    },

    triggerTestPerf: async (userId, { operation, durationMs }) => {
      recordPerf(operation, durationMs, userId);
      await flushPerf();
      return { ok: true };
    },

    triggerTestFeedback: async (userId, { type, description }) => {
      await recordFeedback({ type, description, userId });
      return { ok: true };
    },

    sendTestEmail: async (_userId, { userId, subject, html, id }) => {
      await emailSend({ userId, subject, html, id });
      return { ok: true };
    },

    // ── Coding-agent session persistence ────────────────────────────────────
    codingSessionUpsert: async (userId, input) => {
      const existing = await app.db.getDoc(collections.codingSession, input.sessionId);
      if (existing && existing.userId !== userId) throw new Error('Session not found');
      // Resolve kind once (on first upsert). The first session in a project with
      // no `main` yet becomes the main session; this needs no client plumbing.
      let kind = input.kind ?? existing?.kind;
      if (!kind) {
        const mains: CodingSession[] = await app.db.getDocs(
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
      await app.db.setDoc(collections.codingSession, doc);
      return { ok: true };
    },

    codingSessionAppendMessage: async (userId, { sessionId, seq, role, content }) => {
      const sess = await app.db.getDoc(collections.codingSession, sessionId);
      if (sess && sess.userId !== userId) throw new Error('Session not found');
      const doc: CodingSessionMessage = {
        _id: `${sessionId}:${seq}`,
        sessionId, userId, seq, role, kind: 'message', compacted: false, content,
        ...dbDefaults(),
      };
      await app.db.setDoc(collections.codingSessionMessage, doc);
      return { ok: true };
    },

    // Persist a compaction structurally: flag the dropped originals out of the
    // normal view (kept for the full history) + insert one summary row at the
    // dropped block's seq, so the normal query == runAgent's compacted context.
    // Mark by _id (summary rows don't follow the sessionId:seq scheme). Then
    // setDoc the summary AFTER marking, so re-summarizing a prior summary (same
    // _id) leaves the row active.
    codingSessionCompact: async (userId, { sessionId, droppedIds, summaryId, summarySeq, summaryText }) => {
      const sess = await app.db.getDoc(collections.codingSession, sessionId);
      if (sess && sess.userId !== userId) throw new Error('Session not found');
      const prefix = `${sessionId}:`;
      for (const id of droppedIds) {
        if (!id.startsWith(prefix)) continue; // scope guard: only this session's rows
        await app.db.setDocFieldsOrIgnore(collections.codingSessionMessage, id, { compacted: true });
      }
      if (!summaryId.startsWith(prefix)) throw new Error('Invalid summary id');
      const summary: CodingSessionMessage = {
        _id: summaryId,
        sessionId, userId, seq: summarySeq, role: 'user', kind: 'summary', compacted: false,
        content: JSON.stringify(summaryText),
        ...dbDefaults(),
      };
      await app.db.setDoc(collections.codingSessionMessage, summary);
      return { ok: true };
    },

    codingSessionListMessages: async (userId, { sessionId, limit, includeCompacted }) => {
      const filter: Record<string, unknown> = { sessionId, userId };
      if (!includeCompacted) filter.compacted = false;
      // Annotate to break the app↔handler circular type inference.
      const docs: CodingSessionMessage[] = await app.db.getDocs(collections.codingSessionMessage, filter, {
        sort: { seq: 1 },
        limit: limit ?? 2000,
      });
      return {
        messages: docs.map((d) => ({
          seq: d.seq, role: d.role, kind: d.kind, compacted: d.compacted, content: d.content,
        })),
      };
    },

    codingSessionList: async (userId, { projectId }) => {
      const docs: CodingSession[] = await app.db.getDocs(
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
      const sess = await app.db.getDoc(collections.codingSession, sessionId);
      if (sess?.userId !== userId) throw new Error('Session not found');
      await app.db.setDocFields(collections.codingSession, sessionId, { archived: true });
      return { ok: true };
    },
  } satisfies RequestHandlers<typeof requests>,
  collections,
  (configurator: AppConfigurator) => {
    configurator.setPages({ pages });
    configurator.setExperiments(experiments);
    const tables: Record<string, Record<string, string>> = {
      en: en as unknown as Record<string, string>,
      es: es as unknown as Record<string, string>,
    };
    configurator.setStrings({
      defaultLang: stringsDef.defaultLang,
      langs: stringsDef.langs,
      criticalKeys: stringsDef.criticalKeys,
      getTable: (lang) => tables[lang] ?? tables[stringsDef.defaultLang]!,
    });
    configurator.setWorkers(cronTasks, cronHandlers);
    configurator.setOnEmail(async (inbound: InboundEmail) => {
      await Promise.resolve();
      console.log('[Email] Received:', { from: inbound.from, id: inbound.id, subject: inbound.subject });
    });

    // ── Conversations (AI chat) ────────────────────────────────────────────
    // Note: ConversationDeps.db is set lazily since `app` isn't assigned yet during createApp.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const convDeps: any = { db: null, collections: {}, userGet: () => null, userPrivateGet: () => null };
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const convServer = enableConversations(configurator, {
      conversationCollection: 'conversation',
      messageCollection: 'message',
      aiChat: {
        async *onMessage(session, userMessage) {
          // `uglyBotRequest` is typed by op name — the result is inferred from
          // the `textGen` op (no generic) and may be null on failure.
          const data = await uglyBotRequest('textGen', {
            model: 'gemini_2_5_flash',
            messages: [
              ...session.messages.map((m) => ({ role: m.role, content: m.text })),
              { role: 'user', content: userMessage },
            ],
            options: { maxTokens: 512 },
          });
          // `content` is a string OR an array of blocks ([{ type:'text', text }, …]).
          const content = data?.message.content;
          yield typeof content === 'string'
            ? content
            : (content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');
        },
      },
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    }, convDeps);

    // ── Collaborative editing ──────────────────────────────────────────────
    enableCollab(configurator, {
      async loadState(docId) {
        try {
          const doc = await app.db.getDoc(collections.collabDoc, docId);
          return doc?.yjsState ?? null;
        } catch { return null; }
      },
      async saveState(docId, state, serialized) {
        await app.db.setDoc(collections.collabDoc, {
          _id: docId,
          yjsState: state.yjsState,
          serialized,
          lastSyncedAt: state.lastSyncedAt,
          ...dbDefaults(),
        });
      },
    });

    // Set db after app is initialized (app isn't available during createApp)
    // eslint-disable-next-line @typescript-eslint/require-await
    configurator.setOnAfterStart(async (db) => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      convDeps.db = db;
      convServer.setDb(db);
    });
  },
);

// eslint-disable-next-line @typescript-eslint/dot-notation
const port = parseInt(process.env['PORT'] ?? '4321');
await app.start(port);
