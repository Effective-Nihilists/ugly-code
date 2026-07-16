import { authReq, defineMessages, defineRequests, frameworkMessages, frameworkRequests, reasoningEffortSchema, z } from 'ugly-app/shared';
import { agentMessageSchema } from './agent';
import { agentTurnRequestSchema, agentTurnResponseSchema } from 'ugly-app/agent/shared';
import { userSettingsSchema, userSettingsPatchSchema } from './userSettings';
import { sessionConfigSchema } from './sessionConfig';

export const requests = defineRequests({
  // Standardized client-driven agent turn (ugly-app/agent). The studio coding
  // chat drives the loop; the server streams one model turn (text + tool_use)
  // and returns the authoritative result + per-turn telemetry. Replaces the
  // bespoke agentStep loop for the studio path.
  agentTurn: authReq({
    input: agentTurnRequestSchema,
    output: agentTurnResponseSchema,
    rateLimit: { max: 120, window: 60 },
  }),

  // Coding agent — one turn of the agentic loop (legacy single-shot; still used
  // by the standalone AgentPanel / CodeEditorPage). The client sends the full
  // message history; the server adds the system prompt + tool specs and returns
  // the model's next assistant message (which may contain tool_use blocks the
  // client then executes against the native fs/process API).
  agentStep: authReq({
    input: z.object({
      messages: z.array(agentMessageSchema),
      model: z.string().optional(),
      // `noTools` → clean completion (no injected system prompt, no tools) for the
      // pattern engine's aux calls (classifier / judge / synthesis / picker).
      noTools: z.boolean().optional(),
      maxTokens: z.number().optional(),
      // Coarse thinking knob forwarded to the provider; `'off'` disables reasoning
      // for cheap aux calls (e.g. the title deriver) that never need a thinking pass.
      reasoning: reasoningEffortSchema.optional(),
    }),
    output: z.object({ message: agentMessageSchema }),
    rateLimit: { max: 60, window: 60 },
  }),

  // Todo demo — CRUD requests
  createTodo: authReq({
    input: z.object({ text: z.string().min(1).max(500) }),
    output: z.object({ id: z.string() }),
  }),

  toggleTodo: authReq({
    input: z.object({ todoId: z.string() }),
    output: z.object({ done: z.boolean() }),
  }),

  deleteTodo: authReq({
    input: z.object({ todoId: z.string() }),
    output: z.object({ ok: z.boolean() }),
  }),

  // Recent projects — synced across the user's devices/sessions. Recorded
  // whenever a project opens on a desktop, stamped with that desktop's stable
  // `deviceId`/`deviceLabel` so a phone can reconnect to the right host. Reads
  // use socket.trackDocs('recentProject', { keys: { userId } }); no list endpoint.
  recordRecentProject: authReq({
    input: z.object({
      deviceId: z.string().min(1),
      deviceLabel: z.string().default(''),
      path: z.string().min(1),
      name: z.string().default(''),
    }),
    output: z.object({ id: z.string() }),
  }),

  removeRecentProject: authReq({
    input: z.object({ id: z.string().min(1) }),
    output: z.object({ ok: z.boolean() }),
  }),

  // Push notification test — send a push via ugly.bot
  sendPush: authReq({
    input: z.object({
      targetUserId: z.string(),
      title: z.string().min(1).max(200),
      body: z.string().max(500),
      page: z.string(),
      query: z.record(z.string(), z.string()).optional(),
      imageUrl: z.string().optional(),
    }),
    output: z.object({ sent: z.boolean() }),
    rateLimit: { max: 10, window: 60 },
  }),

  // Email test — send an email via the app's email sender
  sendTestEmail: authReq({
    input: z.object({
      userId: z.string().min(1),
      subject: z.string().min(1).max(200),
      html: z.string().min(1),
      id: z.string().max(100).optional(),
    }),
    output: z.object({ ok: z.boolean() }),
    rateLimit: { max: 5, window: 60 },
  }),

  // Error test — intentionally throws to test error capture
  triggerTestError: authReq({
    input: z.object({ message: z.string().optional() }),
    output: z.object({ ok: z.boolean() }),
  }),

  // Worker task tests — verify exception, DB mutation, and console.error
  testWorkerThrow: authReq({
    input: z.object({ message: z.string().optional() }),
    output: z.object({ ok: z.boolean() }),
  }),

  testWorkerDbMutation: authReq({
    input: z.object({ text: z.string().min(1).max(500) }),
    output: z.object({ id: z.string(), verified: z.boolean() }),
  }),

  testWorkerConsoleError: authReq({
    input: z.object({ message: z.string().optional() }),
    output: z.object({ logged: z.boolean() }),
  }),

  // Perf test — records a perf entry through the framework's perf API
  triggerTestPerf: authReq({
    input: z.object({
      operation: z.string().min(1).max(200),
      durationMs: z.number().int().min(0).max(60_000),
    }),
    output: z.object({ ok: z.boolean() }),
  }),

  // Feedback test — records a feedback entry through the data-proxy capture
  // path so devTunnelId is stamped from the project's JWT (matches what
  // `ugly-app feedback:dev` filters on).
  triggerTestFeedback: authReq({
    input: z.object({
      type: z.enum(['bug', 'design', 'feature']),
      description: z.string().min(1).max(2000),
    }),
    output: z.object({ ok: z.boolean() }),
  }),

  // ── Coding-agent session persistence (survive reload) ───────────────────
  // The coding chat runs client-side; these owner-scoped endpoints give it a
  // durable home in the project's own Neon backend. See shared/collections.ts
  // (codingSession / codingSessionMessage) + client/studio/agent/clientAgent.ts.
  codingSessionUpsert: authReq({
    input: z.object({
      sessionId: z.string(),
      projectId: z.string(),
      title: z.string().max(300).optional(),
      model: z.string().optional(),
      status: z.enum(['running', 'idle', 'done', 'error']).optional(),
      messageCount: z.number().int().min(0).optional(),
      costUsd: z.number().min(0).optional(),
      // Cumulative token usage. persistMeta already sends these; they were being
      // DROPPED here (zod strips unknown keys) so tokens never persisted — declare
      // them so they reach the DB + the session list.
      promptTokens: z.number().int().min(0).optional(),
      completionTokens: z.number().int().min(0).optional(),
      cacheReadTokens: z.number().int().min(0).optional(),
      cacheCreationTokens: z.number().int().min(0).optional(),
      // The session's strictly-typed run config (see shared/sessionConfig.ts).
      config: sessionConfigSchema.optional(),
      // The git branch the session operates on (server-persisted, cross-browser).
      branch: z.string().optional(),
      // Last-turn failure text. Present-and-non-empty sets it; present-and-empty
      // ('') clears it (a recovered turn); omitted preserves the stored value.
      lastError: z.string().max(2000).optional(),
    }),
    output: z.object({ ok: z.boolean() }),
    rateLimit: { max: 240, window: 60 },
  }),

  // Append one transcript row (idempotent: _id = sessionId:seq).
  codingSessionAppendMessage: authReq({
    input: z.object({
      sessionId: z.string(),
      seq: z.number().int().min(0),
      role: z.enum(['user', 'assistant', 'tool']),
      content: z.string(),
      // When true, this is a STREAMING/transient write: relay the row to
      // trackDocs({includeTransient}) subscribers as an ephemeral frame WITHOUT
      // persisting it (see setDoc({transient})). The final content is committed by a
      // later non-transient append at the same seq. Higher rate limit — streaming
      // fires many per turn (throttled client-side).
      transient: z.boolean().optional(),
    }),
    output: z.object({ ok: z.boolean() }),
    rateLimit: { max: 6000, window: 60 },
  }),

  // Persist a compaction: flag the dropped rows (by _id, since summary rows use a
  // different _id scheme than message rows) + insert one summary row at the
  // dropped block's seq. Idempotent (summaryId is derived from the boundary seq).
  codingSessionCompact: authReq({
    input: z.object({
      sessionId: z.string(),
      droppedIds: z.array(z.string()),
      summaryId: z.string(),
      summarySeq: z.number().min(0),
      summaryText: z.string(),
    }),
    output: z.object({ ok: z.boolean() }),
    rateLimit: { max: 120, window: 60 },
  }),

  // The "normal" transcript (compaction excluded) — display + resume seed.
  // includeCompacted returns the full original history (expand affordance).
  codingSessionListMessages: authReq({
    input: z.object({
      sessionId: z.string(),
      limit: z.number().int().min(1).max(2000).optional(),
      includeCompacted: z.boolean().optional(),
    }),
    output: z.object({
      messages: z.array(
        z.object({
          seq: z.number(),
          role: z.enum(['user', 'assistant', 'tool']),
          kind: z.enum(['message', 'summary']),
          compacted: z.boolean(),
          content: z.string(),
        }),
      ),
    }),
  }),

  codingSessionList: authReq({
    input: z.object({ projectId: z.string() }),
    output: z.object({
      sessions: z.array(
        z.object({
          sessionId: z.string(),
          title: z.string(),
          model: z.string(),
          status: z.enum(['running', 'idle', 'done', 'error']),
          messageCount: z.number(),
          costUsd: z.number(),
          // Cumulative token usage (absent on rows written before these columns).
          promptTokens: z.number().optional(),
          completionTokens: z.number().optional(),
          cacheReadTokens: z.number().optional(),
          cacheCreationTokens: z.number().optional(),
          created: z.number(),
          updated: z.number(),
          // The session's strictly-typed run config; absent on old rows.
          config: sessionConfigSchema.optional(),
          // The git branch (or 'main') this session operates on.
          branch: z.string().optional(),
          // Last-turn failure text, when the session ended in error (diagnostics).
          lastError: z.string().optional(),
        }),
      ),
    }),
  }),

  codingSessionArchive: authReq({
    input: z.object({ sessionId: z.string() }),
    output: z.object({ ok: z.boolean() }),
  }),

  // `/clear`: wipe a session's transcript in place (same session/worktree). Deletes
  // every persisted message row so a reload/resume starts empty, and zeroes the
  // session's running counters.
  codingSessionClearMessages: authReq({
    input: z.object({ sessionId: z.string() }),
    output: z.object({ ok: z.boolean(), deleted: z.number() }),
  }),

  // ── Doc-triggered background task (E) ───────────────────────────────────────
  // The UI writes a run-request (create) instead of poking native.task; the owning
  // desktop host reacts via trackDocs, CAS-claims it, drives the turn, then marks it
  // done/error. `_id` = `run:<sessionId>:<seq>` (idempotent per turn).
  codingRunRequestCreate: authReq({
    input: z.object({
      sessionId: z.string(),
      projectId: z.string(),
      seq: z.number().int().min(0),
      prompt: z.string(),
      selection: z.string().optional(),
    }),
    output: z.object({ id: z.string() }),
    rateLimit: { max: 240, window: 60 },
  }),
  // CAS claim: succeeds (claimed:true) only if the request is still `pending`.
  codingRunRequestClaim: authReq({
    input: z.object({ id: z.string(), host: z.string() }),
    output: z.object({ claimed: z.boolean() }),
    rateLimit: { max: 600, window: 60 },
  }),
  // Terminal status after the host finishes (or fails) driving the turn.
  codingRunRequestComplete: authReq({
    input: z.object({
      id: z.string(),
      status: z.enum(['done', 'error']),
      error: z.string().max(2000).optional(),
    }),
    output: z.object({ ok: z.boolean() }),
    rateLimit: { max: 600, window: 60 },
  }),

  // ── Per-user coding-agent settings (survive reload, sync across devices) ────
  // Formerly a host-local file served by the removed studio sidecar; now a
  // per-user Neon doc read/written via the framework request path (see
  // shared/userSettings.ts + the userSettings collection). The studio chat reads
  // these on mount (serverToFeatures); a future Settings panel writes them.
  getUserSettings: authReq({
    input: z.object({}),
    output: userSettingsSchema,
  }),
  updateUserSettings: authReq({
    input: userSettingsPatchSchema,
    output: userSettingsSchema,
    rateLimit: { max: 120, window: 60 },
  }),
  resetUserSettings: authReq({
    input: z.object({}),
    output: userSettingsSchema,
  }),

  // Example: public request — userId is string | null
  // getPublicData: req({
  //   input: z.object({ id: z.string() }),
  //   output: z.object({ data: z.string() }),
  // }),
});

export const messages = defineMessages({
  // Example fire-and-forget (with Zod):
  // userTyping: msg(z.object({ channelId: z.string() })),
  //
  // Example RPC (with Zod):
  // getOnlineUsers: rpcMsg({
  //   data: z.object({ channelId: z.string() }),
  //   response: z.object({ userIds: z.array(z.string()) }),
  // }),
});

export type { authReq };

export interface AppRegistry {
  requests: typeof frameworkRequests & typeof requests;
  messages: typeof frameworkMessages & typeof messages;
}
