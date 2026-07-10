import {
  createApp,
  pgQuery,
  emailSend,
  flushPerf,
  recordFeedback,
  recordPerf,
  uglyBotRequest,
  type AppConfigurator,
  type InboundEmail,
  type RequestHandlers,
  type TypedDB,
  type TypedPushSendInput,
} from 'ugly-app';
import { nanoid } from 'nanoid';
import { enableConversations } from 'ugly-app/conversation/server';
import { enableCollab } from 'ugly-app/collab/server';
import type { WorkerHandlers } from 'ugly-app/shared';
import { dbDefaults } from 'ugly-app/shared';
import { messages, requests } from '../shared/api';
import { AGENT_SYSTEM_PROMPT, AGENT_TOOLS, type AgentMessage } from '../shared/agent';
import { agentTurnHandler } from 'ugly-app/agent/server';
import { agentStepHandler } from './agentStepHandler';
import { makeResolveApiKey } from './byoKey';
import type { Todo, RecentProject } from '../shared/collections';
import { collections } from '../shared/collections';
import { makeCodingSessionHandlers } from './codingSessionHandlers';
import {
  DEFAULT_USER_SETTINGS,
  mergeUserSettings,
  parseStoredUserSettings,
  type UserSettings,
} from '../shared/userSettings';
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
  // `pages` in the registry lets `app.pushSend` infer the route table for
  // compile-time route/query checking.
  { requests, messages, pages },
  {
    // Standardized client-driven agent turn (ugly-app/agent) — the studio path.
    agentTurn: agentTurnHandler({
      tools: AGENT_TOOLS,
      systemPrompt: AGENT_SYSTEM_PROMPT,
      // Same BYO-key resolution as the Worker entry, so dev matches prod.
      // `getDb` (late-bound, set in setOnAfterStart) rather than `app.db`:
      // reading `app` here cycles back through its own initializer (TS7022).
      resolveApiKey: makeResolveApiKey(getDb),
    }),

    // Coding agent step — tool-enabled loop step (default) OR a clean no-tools
    // completion (`noTools`) for the pattern engine's aux calls. Shared with the
    // Worker entry via agentStepHandler so the deploy can't miss it.
    // Return type annotated explicitly: the body reads `app.db`, so inference
    // would otherwise cycle back through `app`'s own initializer (TS7022/7023).
    agentStep: async (userId, input): Promise<{ message: AgentMessage }> =>
      agentStepHandler(userId, input, {
        // Only invoked for BYO-subscription models (glm_coding_plan); an
        // ordinary metered turn never reads the settings doc.
        loadByoKey: async (uid): Promise<string | undefined> => {
          const doc = await app.db.getDoc(collections.userSettings, uid);
          return parseStoredUserSettings(doc?.data).codingAgent.glmCodingKey;
        },
      }),

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

    // Upsert a recent project for this user. The id is deterministic on
    // (userId, deviceId, path) so re-opening the same project on the same
    // desktop bumps lastOpened in place rather than piling up rows. The
    // collection's trackKeys: ['userId'] makes the write fan out to every other
    // session/device of this user via trackDocs.
    recordRecentProject: async (userId, { deviceId, deviceLabel, path, name }) => {
      const _id = `${userId}:${deviceId}:${path}`;
      const trimmed = name.trim();
      const label = trimmed !== '' ? trimmed : (path.split('/').filter(Boolean).pop() ?? path);
      const doc: RecentProject = {
        _id,
        userId,
        deviceId,
        deviceLabel,
        path,
        name: label,
        lastOpened: Date.now(),
        ...dbDefaults(),
      };
      await app.db.setDoc(collections.recentProject, doc);
      return { id: _id };
    },

    removeRecentProject: async (userId, { id }) => {
      const row = await app.db.getDoc(collections.recentProject, id);
      // Ownership check: only the user who recorded it may remove it. Treat an
      // already-missing row as success (idempotent delete).
      if (row && row.userId !== userId) throw new Error('Recent project not found');
      if (row) await app.db.deleteDoc(collections.recentProject, id);
      return { ok: true };
    },

    sendPush: async (_userId, { targetUserId, title, body, page, query, imageUrl }): Promise<{ sent: boolean }> => {
      try {
        const result = await app.pushSend({
          targetUserId,
          title,
          body,
          page,
          query: query ?? {},
          ...(imageUrl ? { imageUrl } : {}),
        } as TypedPushSendInput<typeof pages, keyof typeof pages>);
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

    // ── Per-user coding-agent settings (Neon-backed; one doc per user) ──────
    getUserSettings: async (userId): Promise<UserSettings> => {
      const doc = await app.db.getDoc(collections.userSettings, userId);
      return parseStoredUserSettings(doc?.data);
    },
    updateUserSettings: async (userId, patch): Promise<UserSettings> => {
      const doc = await app.db.getDoc(collections.userSettings, userId);
      const current = parseStoredUserSettings(doc?.data);
      const next = mergeUserSettings(current, patch);
      await app.db.setDoc(collections.userSettings, {
        _id: userId,
        userId,
        data: JSON.stringify(next),
        ...dbDefaults(),
      });
      return next;
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    resetUserSettings: async (userId): Promise<UserSettings> => {
      // Delete the doc so a fresh read falls back to defaults (best-effort — a
      // missing doc already reads as defaults).
      void app.db.deleteDoc(collections.userSettings, userId).catch(() => {/* noop */});
      return DEFAULT_USER_SETTINGS;
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
      getTable: (lang) => tables[lang] ?? tables[stringsDef.defaultLang],
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
