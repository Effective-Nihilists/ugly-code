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
  type TypedDB,
} from 'ugly-app';
import { nanoid } from 'nanoid';
import { enableConversations } from 'ugly-app/conversation/server';
import { enableCollab } from 'ugly-app/collab/server';
import type { WorkerHandlers, TextGenModel } from 'ugly-app/shared';
import { dbDefaults } from 'ugly-app/shared';
import { messages, requests } from '../shared/api';
import { AGENT_DEFAULT_MODEL, AGENT_SYSTEM_PROMPT, AGENT_TOOLS, type AgentMessage } from '../shared/agent';
import { agentTurnHandler } from 'ugly-app/agent/server';
import type { Todo } from '../shared/collections';
import { collections } from '../shared/collections';
import { makeCodingSessionHandlers } from './codingSessionHandlers';
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

// Late-bound TypedDB (set in setOnAfterStart) so the shared coding-session
// handler factory can read `app.db` without a circular `app`-type reference.
let typedDbRef: TypedDB | null = null;
const getDb = (): TypedDB => {
  if (!typedDbRef) throw new Error('TypedDB not initialized yet');
  return typedDbRef;
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

    // ── Coding-agent session persistence (shared factory — see workers.ts) ──
    ...makeCodingSessionHandlers(getDb),
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

// app.db is available synchronously after createApp; bind it for the shared
// coding-session handler factory (see getDb above).
typedDbRef = app.db;

// eslint-disable-next-line @typescript-eslint/dot-notation
const port = parseInt(process.env['PORT'] ?? '4321');
await app.start(port);
