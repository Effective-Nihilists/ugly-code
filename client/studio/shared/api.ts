import {
  defineMessages,
  defineRequests,
  reasoningEffortSchema,
  req,
  z,
  type ReasoningEffort,
} from 'ugly-app/shared';

/**
 * Reasoning-effort axis. Re-exports the canonical enum from
 * `ugly-app/shared/AiProxy.ts` so studio, ugly.bot proxy, and the
 * framework's textGen API all reference the same single source of
 * truth. Per-model translation (Anthropic budget vs OpenAI effort vs
 * Gemini level vs model-id swap) lives in ugly.bot's
 * `getThinkingSupport` / `resolveThinking` (in
 * `server/ai/providers/_reasoning.ts`).
 */
export const REASONING_EFFORTS: readonly ReasoningEffort[] =
  reasoningEffortSchema.options;
export type { ReasoningEffort };
export function isReasoningEffort(s: string): s is ReasoningEffort {
  return (REASONING_EFFORTS as readonly string[]).includes(s);
}

/**
 * Worktree binding for a session. Mirrors the server-side
 * `SessionWorktree` minus internal fields. Surfaced here so the
 * snapshot shape (and the `session_state` broadcast that carries it)
 * are zod-validated end-to-end.
 */
export const SessionWorktreeBindingSchema = z.object({
  path: z.string(),
  branch: z.string(),
  parentBranch: z.string(),
  parentSha: z.string(),
  mainRepo: z.string(),
  createdAt: z.number(),
});

/**
 * Finish-pipeline stage metadata, snapshot-friendly. Mirrors the
 * client's `FinishStageInfo` *minus* the per-stage `output: string`
 * text — output is high-frequency streaming and stays as
 * `finish_event` (kind=stage_output) deltas. Everything else (state
 * transitions, exitCode, command label, skip message) flows through
 * the snapshot so the UI can render the stage cards correctly even
 * if it never saw the granular events.
 */
export const FinishStageSnapshotSchema = z.object({
  name: z.enum([
    'precheck_dirty_main',
    'merge_parent',
    'tsc',
    'lint',
    'tests',
    'merge_squash',
    'cleanup',
  ]),
  state: z.enum([
    'pending',
    'running',
    'passed',
    'failed',
    'skipped',
    'stopped',
  ]),
  command: z.string().optional(),
  exitCode: z.number().optional(),
  message: z.string().optional(),
});

/**
 * Live finish-pipeline state — the subset of the client's
 * `FinishPipelineState` that's pure metadata (no streaming output).
 * `running: false` with an empty stages list represents
 * "not currently finishing." The chat panel reads this to render
 * progress cards; per-stage stdout still appends from stage_output
 * events.
 */
export const FinishPipelineSnapshotSchema = z.object({
  running: z.boolean(),
  done: z.boolean(),
  ok: z.boolean(),
  stages: z.array(FinishStageSnapshotSchema),
  conflicts: z.array(z.string()).optional(),
  conflictStage: z.enum(['merge_parent', 'merge_squash']).optional(),
  squashSha: z.string().optional(),
  message: z.string().optional(),
});

export type FinishStageSnapshot = z.infer<typeof FinishStageSnapshotSchema>;
export type FinishPipelineSnapshot = z.infer<
  typeof FinishPipelineSnapshotSchema
>;

const EMPTY_FINISH_PIPELINE_SNAPSHOT: FinishPipelineSnapshot = {
  running: false,
  done: false,
  ok: false,
  stages: [],
};

export { EMPTY_FINISH_PIPELINE_SNAPSHOT };

/**
 * One pending permission prompt — a mutating-tool call awaiting
 * user approval. Mirrors the wire shape the existing
 * `permission_request` event carries; replicating here lets the
 * snapshot replace the event-driven state.
 */
export const PermissionRequestSnapshotSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  toolCallId: z.string(),
  toolName: z.string(),
  description: z.string(),
  action: z.string(),
  path: z.string(),
  params: z.record(z.string(), z.unknown()),
});
export type PermissionRequestSnapshot = z.infer<
  typeof PermissionRequestSnapshotSchema
>;

/**
 * Pending ask_user question awaiting an answer. Mirrors the
 * client's `PendingAskUser` shape.
 */
export const PendingAskUserSnapshotSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  toolCallId: z.string(),
  question: z.string(),
  header: z.string().optional(),
  options: z.array(
    z.object({
      label: z.string(),
      description: z.string(),
    }),
  ),
});
export type PendingAskUserSnapshot = z.infer<
  typeof PendingAskUserSnapshotSchema
>;

/**
 * Pending step-review gate awaiting the user's approve/iterate reply.
 * Surfaced as an inline strip near the spec/diagnosis tab; the strip
 * shows the step label, an Approve button, and a feedback textarea
 * with an Iterate button. Resolving via `codingAgentAnswerStepReview`.
 */
export const PendingStepReviewSnapshotSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  stepId: z.string(),
  stepLabel: z.string(),
  patternId: z.string(),
  specId: z.string().optional(),
  createdAt: z.number(),
});
export type PendingStepReviewSnapshot = z.infer<
  typeof PendingStepReviewSnapshotSchema
>;

/**
 * Banner-like worktree status surfaced in the chat header. Tracks
 * the most recent `worktree_event` outcome — refresh succeeded,
 * conflict, lost, etc. The `worktree` field on the snapshot carries
 * the binding itself; this carries the transient banner state that
 * the chat header renders alongside it.
 */
export const WorktreeStatusSnapshotSchema = z.object({
  kind: z.enum([
    'created',
    'reattached',
    'refreshed',
    'refresh_conflict',
    'refresh_failed',
    'lost',
    'unavailable',
    'removed',
  ]),
  message: z.string().optional(),
  conflicts: z.array(z.string()).optional(),
});
export type WorktreeStatusSnapshot = z.infer<
  typeof WorktreeStatusSnapshotSchema
>;

/**
 * LSP indicator state. `idle` / `disabled` / `closed` mean the LSP
 * isn't actively reporting; `initializing` shows a spinner;
 * `ready` shows the error/warning counts; `error` shows
 * `lastMessage`.
 */
export const LspStatusSnapshotSchema = z.object({
  state: z.enum([
    'initializing',
    'ready',
    'error',
    'disabled',
    'closed',
    'idle',
  ]),
  errors: z.number(),
  warnings: z.number(),
  lastUpdatedAt: z.number().nullable(),
  lastMessage: z.string().optional(),
});
export type LspStatusSnapshot = z.infer<typeof LspStatusSnapshotSchema>;

/**
 * Result of grading an in-Studio eval run. Returned by `evalGradeSession`
 * and persisted on the session's `eval.json` (also surfaced on the
 * session snapshot's `evalGradeResult` field) so the scorecard survives
 * app restart.
 */
export const EvalGradeResultSchema = z.object({
  taskName: z.string(),
  gradedAt: z.string(),
  /** Present when no checker is registered for the task. */
  skipped: z.string().optional(),
  score: z.number().optional(),
  scoreMax: z.number().optional(),
  /** One-paragraph plain-language explanation of the result. */
  summary: z.string().optional(),
  checks: z
    .array(
      z.object({
        name: z.string(),
        passed: z.boolean(),
        detail: z.string().optional(),
      }),
    )
    .optional(),
  tscExit: z.number().nullable().optional(),
  tscErrors: z.number().optional(),
  tscErrorSample: z.string().optional(),
  judgeResults: z
    .array(
      z.object({
        gateName: z.string(),
        points: z.number(),
        pointsAwarded: z.number(),
        rubricKey: z.string(),
        verdict: z.string(),
      }),
    )
    .optional(),
  runTotals: z.object({
    durationMs: z.number(),
    turns: z.number(),
    cost: z.object({
      total: z.number(),
      input: z.number(),
      output: z.number(),
      cacheRead: z.number(),
    }),
    tokens: z.object({
      input: z.number(),
      output: z.number(),
      cacheRead: z.number(),
      cacheCreate: z.number(),
    }),
  }),
});

export type EvalGradeResult = z.infer<typeof EvalGradeResultSchema>;

/**
 * Per-session eval-mode state. Persisted to `<sessionDir>/eval.json`
 * and surfaced on the snapshot so the chat can drive auto-fire of
 * subsequent task turns and re-render the scorecard on mount.
 */
export const SessionEvalStateSchema = z.object({
  taskName: z.string(),
  /** Zero-based index of the next turn to auto-fire. */
  currentTurnIndex: z.number(),
  /** ISO timestamp captured when the first user turn was sent. */
  runStartedAt: z.string().optional(),
  /** Most recent grade. Cleared on re-grade. */
  evalGradeResult: EvalGradeResultSchema.nullable().optional(),
});

export type SessionEvalState = z.infer<typeof SessionEvalStateSchema>;

/**
 * Codebase-analysis readiness — architecture doc + semantic indexer state for a
 * session's project. Extracted so the standalone `codebase_readiness` event (which
 * updates ONLY the header pill, without a full session_state snapshot) can validate
 * the same shape the snapshot embeds. See `parseCodebaseReadinessEvent`.
 */
export const CodebaseReadinessSchema = z.object({
  architecture: z.object({
    status: z.enum(['idle', 'building', 'ready', 'failed']),
    filesAnalyzed: z.number().optional(),
    filesTotal: z.number().optional(),
    lastWrittenAt: z.number().optional(),
    error: z.string().optional(),
  }),
  indexer: z.object({
    status: z.enum(['idle', 'indexing', 'ready', 'error']),
    indexedChunks: z.number().optional(),
    totalChunks: z.number().optional(),
    totalFiles: z.number().optional(),
  }),
});

/**
 * The single source of truth for a session's UI-visible state.
 * Returned from `getCodingAgentSnapshot` on mount + reconnect, and
 * re-broadcast as a `session_state` event whenever any field
 * changes. Replaces the per-field event spaghetti (`worktree_event`,
 * `session`, `permission_request`, etc.) that previously left the UI
 * with permanently-stale slices when an emission site missed a
 * code path.
 *
 * Phase 1 covered the fields that already live on `AgentSession.state`
 * (mode, model, reasoning, tokens, worktree). Phase 2 added
 * `finishPipeline` (metadata only — per-stage stdout still streams
 * via `finish_event` deltas because snapshotting it would be
 * wasteful). Subsequent phases fold in pendingPermissions /
 * pendingAskUsers / lspStatus / mcpStatus / scratchpad as those
 * subsystems grow snapshot-aware setters. Until then the snapshot
 * is a *strict subset* of what the UI needs — clients still listen
 * to the granular events for the rest. The plan at
 * `~/.claude/plans/session-snapshot-migration.md` is the canonical
 * reference for what's in-scope per phase.
 */
export const SessionSnapshotSchema = z.object({
  compositeId: z.string(),
  workspaceId: z.string(),
  sessionId: z.string(),
  title: z.string(),
  cwd: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),

  // Mode + LLM config
  mode: z.enum(['edit', 'yolo', 'claude-plan']),
  // Wire-level model id — the actual model the harness routed this
  // turn through. Mutates per-turn under auto modes (Hook 1 sets it,
  // resolveStrategy pins it). UI reads `modelDisplayLabel` for human
  // display, NOT this field — `model` may flip between concrete
  // provider ids while the user's intent stays "auto".
  model: z.string(),
  /**
   * Server-composed dropdown label for the model axis. Single source
   * of truth for `auto: <X>` / `Auto` / `<single-model-name>` so the
   * client doesn't reconstruct it from `model + modelMode +
   * resolvedAutoModel` (which is fragile across persistence shape
   * changes). Computed in `AgentSession.computeModelDisplayLabel()`.
   * Optional with empty-string default for backwards compat with
   * snapshots emitted before this field landed.
   */
  modelDisplayLabel: z.string().default(''),
  reasoningEffort: z.enum(REASONING_EFFORTS),
  /**
   * Whether the currently-resolved model accepts a reasoning-effort
   * knob on the wire. Computed server-side from
   * `CODING_AGENT_MODELS.<model>.supportsReasoning` (which derives
   * from the catalog's `thinkingSupport.kind !== 'unsupported'`).
   * The chat header reads this to decide whether to render the
   * reasoning-effort selector — replaces a stale client-side
   * allowlist that had to be hand-maintained per new model.
   *
   * Default `false` so older snapshots (pre-field) don't accidentally
   * show the selector for non-reasoning models on resume.
   */
  supportsReasoning: z.boolean().default(false),
  specId: z.string().optional(),

  // Three-axis user-facing controls. Permission/Model/Pattern are independent
  // and compose freely. Pattern: 'none' bypasses the engine and runs today's
  // flat iteration loop. Defaults: permission derived from legacy `mode`,
  // modelMode = 'auto', patternMode = 'auto' (classifier picks per turn).
  permissionMode: z.enum(['edit', 'yolo', 'claude-plan']).default('edit'),
  modelMode: z
    .union([
      z.object({ kind: z.literal('auto') }),
      z.object({ kind: z.literal('max') }),
      z.object({ kind: z.literal('single'), model: z.string() }),
      // @deprecated 2026-05-04 — superseded by `super-*` patterns
      // (2026-05-05). Kept for resume back-compat for one release;
      // the runtime translator promotes `{kind:'mid', survivor}` →
      // `{kind:'single', model: survivor}` + super-* patternMode +
      // factory `superSpec`.
      z.object({ kind: z.literal('mid'), survivor: z.string() }),
      // @deprecated 2026-05-05 — collapsed into `auto`. Kept readable
      // here so persisted sessions resume; the translator maps it to
      // `{kind:'auto'}` at session-create.
      z.object({ kind: z.literal('auto-cheap') }),
      // Group-assignment mode (CODING.md §17.17) — N peers run
      // concurrently, share blackboard, ask each other questions.
      z.object({
        kind: z.literal('group'),
        models: z.array(z.string()),
        personas: z.record(z.string(), z.string()).optional(),
      }),
    ])
    .default({ kind: 'auto' }),
  /**
   * Super-spec mode (CODING.md §17.13) — orthogonal to modelMode.
   * Optional; activates mid-mode (wide SPEC → synthesize → narrow
   * EDIT) when set. Survivor = the resolved/selected model from
   * modelMode. See SuperSpecConfig in patterns/types.ts.
   */
  superSpec: z
    .object({
      additionalSpecModels: z.array(z.string()),
      synthesisModel: z.string(),
      injectionStyle: z.enum(['advisory', 'imperative']).optional(),
      // freshSurvivor: dropped 2026-05-05 (terrible cache-miss perf;
      // survivor always continues). Kept readable in resume back-compat
      // by accepting and ignoring any persisted value.
      freshSurvivor: z.boolean().optional(),
    })
    .optional(),
  patternMode: z
    .enum([
      'none',
      'auto',
      'spec-build-verify',
      'super-spec-build-verify',
      'quick-edit',
      'investigate-fix',
      'super-investigate-fix',
      'chat-qa',
      'chat-advisory',
    ])
    .default('auto'),
  resolvedPattern: z
    .enum([
      'spec-build-verify',
      'super-spec-build-verify',
      'quick-edit',
      'investigate-fix',
      'super-investigate-fix',
      'chat-qa',
      'chat-advisory',
    ])
    .nullable()
    .default(null),
  currentStepId: z
    .enum([
      'spec',
      'build',
      'verify',
      'edit',
      'verify-touched',
      'repro',
      'diagnose',
      'fix',
      'answer',
      'research',
      'synthesize',
    ])
    .nullable()
    .default(null),
  currentStepIter: z.number().default(0),
  /**
   * True from the moment the pattern's terminal step ends until the
   * next user turn starts. Lets the UI keep `currentStepId` highlighted
   * as a green "done" chip after the run settles, instead of nulling
   * the step and showing the strip with no progress at all. Reset on
   * next-turn dispatch and on `setPatternMode`.
   */
  currentStepFinished: z.boolean().default(false),

  /**
   * When set, this session is a max-mode peer; the value is the
   * orchestrator parent's compositeId. The IDE sidebar uses this to
   * render the row indented under its parent and the chat panel
   * disables its prompt input + model selector + reasoning chip
   * (the parent's max-mode driver owns these for child runs).
   *
   * The parent's children list isn't on the snapshot — clients
   * derive it by filtering `codingAgentListSessions` results on
   * `parentSessionId === <parent>`. Single source of truth.
   */
  parentSessionId: z.string().optional(),
  /**
   * Compositeid of the peer the picker selected at the end of the
   * most recent max-mode turn. Drives the winner-pill highlight in
   * the chat header. Only set on parents that ran max-mode.
   */
  maxModeWinnerSessionId: z.string().optional(),

  // Token / cost rollup
  cost: z.number(),
  /**
   * What the upstream billing system actually charged across all
   * turns so far. Populated by the Claude Code runner from each
   * turn's `result.total_cost_usd` (which reflects Pro/Team
   * subscription or BYO API key billing). `cost` above stays as the
   * apples-to-apples rate-card estimate so the chip matches every
   * other model's chip; `billedCost` is surfaced as a tooltip line
   * so users can see the gap. Absent for in-process coding-agent
   * sessions (whose `cost` already IS the bill).
   */
  billedCost: z.number().optional(),
  promptTokens: z.number(),
  completionTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheCreationTokens: z.number(),
  /**
   * Per-model token + cost breakdown across the whole session, folded
   * from on-disk turn telemetry. Auto-mode sessions span multiple
   * models per session; the chat readout uses this to show one chip
   * per model with its own rate-card cost instead of multiplying the
   * session-wide totals by a single model's rate. Sorted by descending
   * cost. Empty for sessions with no recorded turns.
   */
  perModel: z
    .array(
      z.object({
        model: z.string(),
        inputTokens: z.number(),
        outputTokens: z.number(),
        cacheReadTokens: z.number(),
        cacheCreationTokens: z.number(),
        cost: z.number(),
        turnCount: z.number(),
      }),
    )
    .default([]),
  /**
   * Sum of every max-mode peer session's cost / tokens / per-model
   * breakdown. The parent itself runs no LLM in max-mode, so its own
   * `cost` / `promptTokens` / etc. stay 0; this field carries the
   * actual spend and the chat-header chip folds it into the displayed
   * total. Absent on non-parent sessions and on parents that have no
   * peers (single-mode runs).
   */
  peerTotals: z
    .object({
      cost: z.number(),
      promptTokens: z.number(),
      completionTokens: z.number(),
      cacheReadTokens: z.number(),
      cacheCreationTokens: z.number(),
      perModel: z.array(
        z.object({
          model: z.string(),
          inputTokens: z.number(),
          outputTokens: z.number(),
          cacheReadTokens: z.number(),
          cacheCreationTokens: z.number(),
          cost: z.number(),
          turnCount: z.number(),
        }),
      ),
      peerCount: z.number(),
    })
    .optional(),
  contextTokens: z.number().optional(),
  contextBudget: z.number().optional(),
  contextWindow: z.number().optional(),
  messageCount: z.number(),
  /**
   * Wall-clock timestamp (ms) of when the user last opened or focused
   * this session. Drives the derived "thinking-done" state on the
   * project-tab dot in the top-bar. Optional/defaulted for wire-level
   * back-compat with snapshots from pre-2026-05-31 sidecars.
   */
  lastViewedAt: z.number().default(0),

  // Worktree
  worktree: SessionWorktreeBindingSchema.nullable(),
  worktreeBlocked: z.boolean(),
  /**
   * Most recent `worktree_event` banner state — refresh outcome,
   * conflict marker, lost/unavailable/removed reason. Drives the
   * banner the chat header renders above the message list. Null
   * when there's nothing to show (the common steady state).
   */
  worktreeStatus: WorktreeStatusSnapshotSchema.nullable(),

  // Finish-pipeline state (Phase 2 of the snapshot migration). The
  // chat panel renders a card per stage from this; per-stage stdout
  // still streams via `finish_event` (kind=stage_output) deltas
  // because snapshotting it on every chunk would be wasteful.
  finishPipeline: FinishPipelineSnapshotSchema,

  // Pending interactions (Phase 3 of the snapshot migration). These
  // populate the BLOCKED pill in the session list and the inline
  // permission / ask_user prompt cards in the chat panel. Driven
  // by the permission + ask-user brokers via emitSnapshot
  // triggers in their request listeners.
  // `.default([])` because these Phase-3 projections are absent from snapshots produced by
  // an older host `coding.js` bundle; without a default the wire snapshot omits the key, a
  // consumer reads `undefined`, and `.map` throws. The default keeps the inferred type an
  // honest (non-optional) array while tolerating version skew — validate the wire payload
  // (SessionSnapshotSchema.safeParse) instead of casting, and the field is always present.
  pendingPermissions: z.array(PermissionRequestSnapshotSchema).default([]),
  // List of outstanding ask_user prompts. Each entry carries the
  // originating session's compositeId on `sessionId` — for max-mode
  // parents this includes prompts raised by peer sessions, so the
  // user sees one unified queue. Sorted oldest-first by tool_call
  // arrival; the chat UI shows only the head until it's answered.
  pendingAskUsers: z.array(PendingAskUserSnapshotSchema).default([]),
  // List of outstanding step-review gates (between SPEC/DIAGNOSE and
  // the next step). Each entry is one paused driver. The chat panel
  // renders a small approve/iterate strip per entry; `pendingStepReviews`
  // also drives the BLOCKED pill in session lists.
  pendingStepReviews: z.array(PendingStepReviewSnapshotSchema).default([]),

  // LSP indicator state (Phase 3). Drives the chat-header
  // initializing/ready/error chip and the error-count badge.
  // Updated via the LSP client's lifecycle events; both the
  // event handler and the snapshot projection read from the
  // same per-session LspClient.
  // `.optional()` (not defaulted — there's no meaningful empty LSP status): an older host may
  // omit it, so the inferred type is `LspStatus | undefined` and the COMPILER now forces every
  // reader to guard it — which is exactly the check that was missing when this crashed.
  lspStatus: LspStatusSnapshotSchema.optional(),

  // Codebase-analysis readiness — architecture doc + semantic
  // indexer state for the session's project. Pushed via
  // `session_state` whenever the indexer manager broadcasts a
  // change (and, pre-first-turn, via the standalone
  // `codebase_readiness` event). Replaces the old
  // `getCodebaseReadiness` polling.
  //
  // Optional/nullable: the client agent OMITS this until the first readiness
  // event (clientAgent.ts conditionally assigns snap.codebaseReadiness), and the
  // mount/cast path can send null. It MUST NOT be required — a missing value here
  // failed safeParse and dropped the ENTIRE session_state snapshot, freezing the
  // chat input (agent unusable → project deps never installed → preview/db/publish
  // all fail). The consumer already guards `if (snap.codebaseReadiness !== undefined)`.
  codebaseReadiness: CodebaseReadinessSchema.nullish(),

  /**
   * Eval-mode binding when this session was created from the interactive
   * eval picker. Null/absent for normal sessions. Drives the chat's
   * auto-fire turn loop, the "Grade run" button visibility, and the
   * inline scorecard render.
   */
  eval: SessionEvalStateSchema.nullable().default(null),
});

export type SessionSnapshot = z.infer<typeof SessionSnapshotSchema>;

/**
 * Snapshot of the resources provisioned for a published app. Matches
 * the `PublishDeployTargetConfig` in studio/server/currentProject.ts —
 * persisted on a successful first deploy into the project's `.uglyapp`
 * config and surfaced via `publishGetDeployTarget` so the PublishTab
 * can render the "Published" status view (Render service URL, Neon
 * project id, Cloudflare bucket, etc.).
 *
 * Custom domain handling is intentionally out of scope for v1 — there
 * is no `domain` field here. When domain support lands, the new field
 * lives alongside this one (not nested inside it).
 */
export const PublishDeployTargetSchema = z.object({
  provider: z.literal('cloudflare-workers'),
  workerName: z.string(),
  workerUrl: z.string(),
  cloudflareSubdomain: z.string(),
  neonProjectId: z.string(),
  cloudflareAccountId: z.string(),
  r2BucketName: z.string(),
  /**
   * User-owned apex (or sub) the app serves at. Same domain backs the
   * Worker custom-domain binding + the email sending domain. Captured
   * by `capture-app-domain`; verified on a CF zone by
   * `cloudflare-zone-verify`. Optional in the schema for backward-
   * compat with older `.uglyapp` files that pre-date custom domains.
   */
  appDomain: z.string().optional(),
  /** CF zone id covering `appDomain`. */
  appDomainZoneId: z.string().optional(),
  /** `https://<appDomain>` — the canonical app URL after attach. */
  customDomainUrl: z.string().optional(),
  /**
   * Per-app sending domain (Cloudflare Email Sending). Populated by the
   * `cloudflare-email-domain` step — the verified FQDN that lands as
   * the `send_email` Worker binding's `destination_address`. Email from
   * the deployed app goes out as `noreply@<sendingDomain>` instead of
   * the legacy shared `noreply@send.ugly.bot`. In the unified flow
   * this matches `appDomain`.
   */
  sendingDomain: z.string(),
  proxyTokenIds: z.object({
    ai: z.string(),
    email: z.string(),
    push: z.string(),
  }),
  lastDeployedAt: z.string(),
});
export type PublishDeployTarget = z.infer<typeof PublishDeployTargetSchema>;

/**
 * Per-step narration entry surfaced by `publishGetStatus`. Mirrors
 * the orchestrator's internal `PublishStepNarration`.
 */
export const PublishStepNarrationSchema = z.object({
  id: z.enum([
    'capture-app-domain',
    'capture-registrar',
    'capture-neon',
    'capture-cloudflare',
    'capture-cloudflare-r2',
    'neon',
    'cloudflare',
    'cloudflare-zone-add',
    'registrar-ns-change',
    'cloudflare-zone-verify',
    'cloudflare-email-domain',
    'ugly-proxy',
    'workers-paid-check',
    'workers-build',
    'workers-migrate',
    'workers-deploy',
    'cloudflare-worker-domain',
    'workers-init',
  ]),
  status: z.enum(['pending', 'running', 'done', 'failed', 'skipped']),
  title: z.string(),
  detail: z.string().optional(),
  error: z.string().optional(),
});
export type PublishStepNarration = z.infer<typeof PublishStepNarrationSchema>;

/**
 * Capture-step payload — the orchestrator surfaces this when a
 * `capture-*` step is blocked waiting on the user. The PublishTab
 * reads it on every status poll, navigates the embedded webview to
 * `dashboardUrl`, polls `selectors.tokenField` until one resolves,
 * reads the value, and feeds it back via `publishProvideManualPaste`.
 * For Synadia `autoCapture` is false — the UI falls through to the
 * manual paste textarea since `.creds` files aren't single-field DOM
 * data.
 */
/**
 * Recipe of DOM actions the PublishTab capture driver runs in the
 * embedded webview after navigating to `dashboardUrl`. Each action
 * soft-fails — manual paste is always the safety net, so a missing
 * button doesn't abort the capture. See publish-orchestrator.ts
 * `buildCaptureRequest` for the per-provider recipes.
 */
export const PublishCaptureActionSchema = z.union([
  z.object({
    kind: z.literal('click'),
    selectors: z.array(z.string()),
    timeoutMs: z.number().optional(),
    label: z.string().optional(),
  }),
  z.object({
    kind: z.literal('click-optional'),
    selectors: z.array(z.string()),
    timeoutMs: z.number().optional(),
    label: z.string().optional(),
  }),
  z.object({
    kind: z.literal('type'),
    selectors: z.array(z.string()),
    value: z.string(),
    timeoutMs: z.number().optional(),
    label: z.string().optional(),
  }),
  z.object({
    kind: z.literal('sleep'),
    ms: z.number(),
  }),
  // Send a real native click via Electron's sendInputEvent at the
  // bounding-rect center of `selector`. react-select options + a few
  // other widgets in Cloudflare/Synadia ignore React synthetic events
  // and only respond to native input. The orchestrator typically pairs
  // this with a preceding `exec` step that marks the target element
  // with a data attribute (because the option's stable identity is
  // text-based, not selector-based).
  z.object({
    kind: z.literal('native-click'),
    selector: z.string(),
    timeoutMs: z.number().optional(),
    label: z.string().optional(),
  }),
  // Run arbitrary JS in the publish webview. The dispatcher wraps the
  // body in `(async () => { ... })()` and awaits the result, so the
  // code can include awaits and return a debug-printable value. Used
  // for Downshift + react-select internals (open dropdown, find
  // option-by-text, mark it for a follow-up native-click) and other
  // primitives that don't fit the declarative `click`/`type` shapes.
  z.object({
    kind: z.literal('exec'),
    code: z.string(),
    timeoutMs: z.number().optional(),
    label: z.string().optional(),
  }),
]);
export type PublishCaptureAction = z.infer<typeof PublishCaptureActionSchema>;

/**
 * Human-gate: every provider's login step is manual. The recipe pauses
 * before its first automated step so the user can sign in (and for some
 * providers — Render in particular — type a name into a form). The
 * narration sidebar shows `prompt` + a button labelled `buttonLabel`;
 * on click the renderer optionally reloads `dashboardUrl` (so we
 * always start the auto-recipe from a known URL post-login) and then
 * dispatches the recipe actions.
 *
 * When unset, the recipe dispatches as soon as the webview is dom-
 * ready (legacy behavior — kept so providers that don't need an
 * explicit gate can omit the field).
 */
export const PublishHumanGateSchema = z.object({
  prompt: z.string(),
  /** Defaults to "I'm ready" in the renderer if omitted. */
  buttonLabel: z.string().optional(),
  /** If true, navigate the webview to `dashboardUrl` again on click. */
  reloadAfter: z.boolean().optional(),
  /**
   * Auto-skip the gate when the webview's current URL (after the
   * initial loadURL) matches this regex. Lets repeat runs that
   * already have a cookie session breeze through without the user
   * having to click. Example for Cloudflare:
   *     "^https://dash\\.cloudflare\\.com/profile/api-tokens"
   * Matching this means we landed at the authenticated dashboard URL
   * directly — the provider didn't redirect us to a /login page.
   *
   * URL-only is fast but can false-positive on SPAs that load the
   * authenticated URL, render it briefly, then JS-redirect to a
   * login page. Render in particular does this. For those providers
   * use `signedInSelector` instead.
   */
  signedInUrlPattern: z.string().optional(),
  /**
   * Auto-skip the gate when a CSS selector resolves to a visible
   * element. Polled for ~2.5s after loadURL, so it survives SPA
   * redirects + late renders that a URL-only check misses. Use a
   * selector that's only present when the user is authenticated —
   * e.g. a workspace-switcher button, a user-menu trigger, a logout
   * link.
   */
  signedInSelector: z.string().optional(),
});
export type PublishHumanGate = z.infer<typeof PublishHumanGateSchema>;

export const PublishCaptureRequestSchema = z.object({
  provider: z.enum([
    'neon',
    'cloudflare',
    'cloudflare-r2',
    'app-domain',
    'registrar',
    'godaddy-ns',
    'namecheap-ns',
  ]),
  dashboardUrl: z.string(),
  selectors: z.object({
    tokenField: z.array(z.string()),
    confirmButton: z.array(z.string()).optional(),
    /**
     * Optional regex the matched-token text must satisfy for the
     * publish:wait-for-selector poll to accept it. Lets the recipe
     * reject stale matches — e.g. an old `.select-all` element from a
     * different page-state that isn't a Cloudflare token.
     */
    tokenValuePattern: z.string().optional(),
  }),
  actions: z.array(PublishCaptureActionSchema).default([]),
  autoCapture: z.boolean(),
  label: z.string(),
  humanGate: PublishHumanGateSchema.optional(),
});
export type PublishCaptureRequest = z.infer<typeof PublishCaptureRequestSchema>;

/**
 * RecipeDoc — the JSON document loaded per-provider from
 * `studio/server/publish/recipes/<provider>.json`. The orchestrator
 * expands the tree (variable substitution + for-each unrolling) into
 * a flat PublishCaptureAction[] before sending across the wire to
 * the Electron dispatcher.
 *
 * The recipe step union is structurally PublishCaptureAction PLUS the
 * `for-each` control-flow kind (which never reaches the dispatcher —
 * it's unrolled by `expandSteps()`).
 *
 * Hot-reload: the loader re-reads the file on every getRecipe() call,
 * so in a dev checkout editing this JSON takes effect on the next
 * Start Publish click — no restart, no env flag. In a packaged build
 * the file lives inside the asar and is sealed; the same logic returns
 * the immutable contents.
 */
type RecipeStepShape = z.infer<typeof PublishCaptureActionSchema> | {
  kind: 'for-each';
  /** Loop-variable name inside sub-step substitutions. Defaults to "item". */
  as?: string;
  /** Each item is a plain object whose fields are referenced as `{<as>.<field>}`. */
  items: Record<string, string | number | boolean>[];
  steps: RecipeStepShape[];
  label?: string;
};
export const RecipeStepSchema: z.ZodType<RecipeStepShape> = z.lazy(() =>
  z.union([
    PublishCaptureActionSchema,
    z.object({
      kind: z.literal('for-each'),
      as: z.string().optional(),
      items: z.array(
        z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
      ),
      steps: z.array(RecipeStepSchema),
      label: z.string().optional(),
    }),
  ]),
);
export type RecipeStep = z.infer<typeof RecipeStepSchema>;

export const RecipeDocSchema = z.object({
  schemaVersion: z.literal(1),
  provider: z.enum([
    'neon',
    'cloudflare',
    'cloudflare-r2',
    'app-domain',
    'registrar',
    'godaddy-ns',
    'namecheap-ns',
  ]),
  /** ISO date — bumped on every change; used by cache-vs-bundled wins comparison. */
  version: z.string(),
  dashboardUrl: z.string(),
  label: z.string(),
  /** Recipe-local string vars; values may contain `{ts}` substitutions. */
  vars: z.record(z.string(), z.string()).optional(),
  tokenExtract: z.object({
    selectors: z.array(z.string()),
    /** Regex the matched-token text must satisfy. */
    valuePattern: z.string().optional(),
    timeoutMs: z.number().optional(),
  }),
  /**
   * Manual sign-in gate. Always present in practice — every provider's
   * login is human-driven. Omit only for synthetic test recipes that
   * have no auth requirement.
   */
  humanGate: PublishHumanGateSchema.optional(),
  steps: z.array(RecipeStepSchema),
});
export type RecipeDoc = z.infer<typeof RecipeDocSchema>;

/**
 * In-flight publish state — the snapshot the orchestrator persists to
 * `~/.ugly-studio/projects/<projectId>/publish-state.json` between
 * steps. Polled by the PublishTab via `publishGetStatus` while the
 * wizard is active.
 */
export const PublishStateSchema = z.object({
  step: z.enum([
    'capture-neon',
    'capture-cloudflare',
    'capture-cloudflare-r2',
    'capture-app-domain',
    'neon',
    'cloudflare',
    'cloudflare-zone-verify',
    'cloudflare-email-domain',
    'ugly-proxy',
    'workers-paid-check',
    'workers-build',
    'workers-migrate',
    'workers-deploy',
    'cloudflare-worker-domain',
    'workers-init',
    'done',
  ]),
  progress: z.number(),
  sidebarMessage: z.string(),
  steps: z.array(PublishStepNarrationSchema),
  error: z.string().optional(),
  manualPasteRequired: z
    .object({
      provider: z.enum([
        'neon',
        'cloudflare',
        'cloudflare-r2',
        'app-domain',
        'registrar',
        'godaddy-ns',
        'namecheap-ns',
      ]),
      label: z.string(),
    })
    .optional(),
  captureRequest: PublishCaptureRequestSchema.optional(),
  running: z.boolean(),
  cancelled: z.boolean().optional(),
  updatedAt: z.number(),
});
export type PublishState = z.infer<typeof PublishStateSchema>;

export const requests = defineRequests({
  // Filesystem
  //
  // Every FS RPC accepts an optional `cwd` that the server confines to a
  // subpath of the current project (via `resolveWorktreeCwd`). When set,
  // `path` is resolved against that cwd instead of the main project root.
  // The Files tab inside a session view passes the session's worktree
  // path so the tree, reads, and writes all hit the session's branch
  // checkout rather than main.
  readFile: req({
    input: z.object({ path: z.string(), cwd: z.string().optional() }),
    output: z.object({ content: z.string(), encoding: z.string() }),
  }),

  readFileBinary: req({
    input: z.object({ path: z.string(), cwd: z.string().optional() }),
    output: z.object({ data: z.string(), mimeType: z.string() }),
  }),

  // Resolve a project file to a URL that can be loaded directly by the
  // browser (e.g. as the `src` of an HTML preview iframe). The URL is
  // anchored at the project (or worktree) root so relative resource
  // refs inside the served HTML resolve correctly.
  resolveFileUrl: req({
    input: z.object({
      projectPath: z.string().optional(),
      path: z.string(),
      cwd: z.string().optional(),
    }),
    output: z.object({ url: z.string() }),
  }),

  writeFile: req({
    input: z.object({
      path: z.string(),
      content: z.string(),
      cwd: z.string().optional(),
    }),
    output: z.object({ ok: z.boolean() }),
  }),

  // LSP — used by the editor's right-click context menu for go-to-definition,
  // go-to-implementation, find references, hover, and rename. Positions are
  // 0-indexed (LSP convention) on input; navigation results return 1-indexed
  // lines for the editor's reveal API.
  lspDefinition: req({
    input: z.object({
      path: z.string(),
      line: z.number().int().nonnegative(),
      character: z.number().int().nonnegative(),
      cwd: z.string().optional(),
      content: z.string().optional(),
    }),
    output: z.object({
      results: z.array(
        z.object({
          path: z.string(),
          line: z.number().int(),
          character: z.number().int(),
          preview: z.string().optional(),
        }),
      ),
    }),
  }),

  lspImplementation: req({
    input: z.object({
      path: z.string(),
      line: z.number().int().nonnegative(),
      character: z.number().int().nonnegative(),
      cwd: z.string().optional(),
      content: z.string().optional(),
    }),
    output: z.object({
      results: z.array(
        z.object({
          path: z.string(),
          line: z.number().int(),
          character: z.number().int(),
          preview: z.string().optional(),
        }),
      ),
    }),
  }),

  lspReferences: req({
    input: z.object({
      path: z.string(),
      line: z.number().int().nonnegative(),
      character: z.number().int().nonnegative(),
      cwd: z.string().optional(),
      content: z.string().optional(),
    }),
    output: z.object({
      results: z.array(
        z.object({
          path: z.string(),
          line: z.number().int(),
          character: z.number().int(),
          preview: z.string().optional(),
        }),
      ),
    }),
  }),

  lspHover: req({
    input: z.object({
      path: z.string(),
      line: z.number().int().nonnegative(),
      character: z.number().int().nonnegative(),
      cwd: z.string().optional(),
      content: z.string().optional(),
    }),
    output: z.object({ contents: z.string().nullable() }),
  }),

  lspRename: req({
    input: z.object({
      path: z.string(),
      line: z.number().int().nonnegative(),
      character: z.number().int().nonnegative(),
      newName: z.string().min(1),
      cwd: z.string().optional(),
    }),
    output: z.object({
      edits: z.array(
        z.object({
          path: z.string(),
          startLine: z.number().int().nonnegative(),
          startCharacter: z.number().int().nonnegative(),
          endLine: z.number().int().nonnegative(),
          endCharacter: z.number().int().nonnegative(),
          newText: z.string(),
        }),
      ),
    }),
  }),

  // Per-project layout state, stored globally in ~/.ugly-studio/projects/<hash>/
  // keyed by absolute project path. Kept out of the project folder itself so
  // layout preferences don't pollute user repos.
  readLayout: req({
    input: z.object({
      projectPath: z.string().optional(),
    }),
    output: z.object({ content: z.string().nullable() }),
  }),

  writeLayout: req({
    input: z.object({
      projectPath: z.string().optional(),
      content: z.string(),
    }),
    output: z.object({ ok: z.boolean() }),
  }),

  deleteFile: req({
    input: z.object({ path: z.string(), cwd: z.string().optional() }),
    output: z.object({ ok: z.boolean() }),
  }),

  renameFile: req({
    input: z.object({
      from: z.string(),
      to: z.string(),
      cwd: z.string().optional(),
    }),
    output: z.object({ ok: z.boolean() }),
  }),

  listDirectory: req({
    input: z.object({ path: z.string(), cwd: z.string().optional() }),
    output: z.object({
      entries: z.array(
        z.object({
          name: z.string(),
          type: z.enum(['file', 'directory']),
          size: z.number(),
          modified: z.number(),
        }),
      ),
    }),
  }),

  // Unified search — same engine the coding-agent `grep` tool uses
  // ([studio/server/search/grep-engine.ts](studio/server/search/grep-engine.ts)).
  // `mode=auto` (default) runs both an exact-literal walk AND a
  // semantic pass when the pattern looks like prose; runs only the
  // exact pass when the pattern contains regex metacharacters. The
  // Files tab calls this directly so it sees the same hits a session
  // user gets from `grep` in their coding-agent chat.
  //
  // `cwd` (optional) targets a session worktree; the server confines
  // it to a subpath of the project and threads it as `worktreeRoot`
  // to the indexer so the per-session overlay DB
  // (`<worktreeRoot>/.ugly-studio/session-index.db`) layers on top
  // of the base index. Omitted → searches the main project tree.
  grep: req({
    input: z.object({
      projectPath: z.string().optional(),
      pattern: z.string(),
      scope: z.string().optional(),
      include: z.string().optional(),
      mode: z.enum(['auto', 'exact', 'semantic']).optional(),
      literalText: z.boolean().optional(),
      caseInsensitive: z.boolean().optional(),
      limit: z.number().optional(),
      cwd: z.string().optional(),
    }),
    output: z.object({
      runExact: z.boolean(),
      runSemantic: z.boolean(),
      exactHits: z.array(
        z.object({
          file: z.string(),
          line: z.number(),
          char: z.number(),
          text: z.string(),
        }),
      ),
      // Discriminated union mirroring the engine's `SemanticSearchOutcome`.
      // `null` when the semantic pass didn't run (mode=exact).
      semantic: z
        .union([
          z.object({
            kind: z.literal('results'),
            results: z.array(
              z.object({
                file: z.string(),
                startLine: z.number(),
                endLine: z.number(),
                content: z.string(),
                score: z.number(),
              }),
            ),
          }),
          z.object({ kind: z.literal('initializing') }),
          z.object({
            kind: z.literal('indexing'),
            pct: z.number(),
            indexed: z.number(),
            total: z.number(),
          }),
          z.object({ kind: z.literal('error'), reason: z.string() }),
        ])
        .nullable(),
    }),
  }),

  /**
   * @deprecated Use `grep` with `mode='exact'` instead. Kept as a thin
   * shim around the merged engine for backward compat.
   */
  searchFiles: req({
    input: z.object({
      projectPath: z.string().optional(),
      query: z.string(),
      path: z.string().optional(),
      scope: z.string().optional(),
      extensions: z.array(z.string()).optional(),
      cwd: z.string().optional(),
    }),
    output: z.object({
      results: z.array(
        z.object({
          file: z.string(),
          line: z.number(),
          content: z.string(),
        }),
      ),
    }),
  }),

  searchFileNames: req({
    input: z.object({
      query: z.string(),
      limit: z.number().optional(),
      cwd: z.string().optional(),
    }),
    output: z.object({ files: z.array(z.string()) }),
  }),

  /**
   * @deprecated Use `grep` with `mode='semantic'` instead. Kept as a
   * thin shim around the merged engine for backward compat.
   */
  semanticSearch: req({
    input: z.object({
      projectPath: z.string().optional(),
      query: z.string(),
      limit: z.number().optional(),
      scope: z.string().optional(),
      extensions: z.array(z.string()).optional(),
      cwd: z.string().optional(),
    }),
    output: z.object({
      indexing: z.boolean(),
      progress: z
        .object({
          indexedChunks: z.number(),
          totalChunks: z.number(),
          totalFiles: z.number(),
        })
        .nullable(),
      results: z.array(
        z.object({
          file: z.string(),
          startLine: z.number(),
          endLine: z.number(),
          content: z.string(),
          score: z.number(),
        }),
      ),
    }),
  }),

  semanticIndexStatus: req({
    input: z.object({
      projectPath: z.string().optional(),
      cwd: z.string().optional(),
    }),
    output: z.object({
      indexing: z.boolean(),
      progress: z
        .object({
          indexedChunks: z.number(),
          totalChunks: z.number(),
          totalFiles: z.number(),
        })
        .nullable(),
    }),
  }),

  // Aggregate readiness of the project-level analysis pipelines that
  // power the coding agent: ARCHITECTURE.md regen + the semantic
  // indexer. The banner in the studio UI polls this so the user knows
  // when the agent is running with full vs degraded codebase context.
  getCodebaseReadiness: req({
    input: z.object({
      projectPath: z.string().optional(),
      cwd: z.string().optional(),
    }),
    output: z.object({
      architecture: z.object({
        status: z.enum(['idle', 'building', 'ready', 'failed']),
        filesAnalyzed: z.number().optional(),
        filesTotal: z.number().optional(),
        lastWrittenAt: z.number().optional(),
        error: z.string().optional(),
      }),
      indexer: z.object({
        status: z.enum(['idle', 'indexing', 'ready', 'error']),
        indexedChunks: z.number().optional(),
        totalChunks: z.number().optional(),
        totalFiles: z.number().optional(),
      }),
    }),
  }),

  openInSystem: req({
    input: z.object({ path: z.string(), cwd: z.string().optional() }),
    output: z.object({ ok: z.boolean() }),
  }),

  // Git
  //
  // Every git RPC accepts an optional `cwd` that the server resolves
  // against the current project path (must live under it). When
  // present, the op runs in that dir — used by the Git panel inside
  // a session view to scope every read/write at the session's
  // worktree instead of the main tree. Omitted → falls back to
  // the current project path (main repo).
  gitStatus: req({
    input: z.object({
      projectPath: z.string().optional(),
      cwd: z.string().optional(),
    }),
    output: z.object({
      branch: z.string(),
      remote: z.string().optional(),
      files: z.array(
        z.object({
          path: z.string(),
          status: z.string(),
        }),
      ),
    }),
  }),

  gitLog: req({
    input: z.object({
      projectPath: z.string().optional(),
      limit: z.number().optional(),
      cwd: z.string().optional(),
      path: z.string().optional(),
    }),
    output: z.object({
      commits: z.array(
        z.object({
          hash: z.string(),
          message: z.string(),
          author: z.string(),
          date: z.number(),
        }),
      ),
    }),
  }),

  gitDiff: req({
    input: z.object({
      projectPath: z.string().optional(),
      ref: z.string().optional(),
      file: z.string().optional(),
      cwd: z.string().optional(),
    }),
    output: z.object({ diff: z.string() }),
  }),

  gitCommitShow: req({
    input: z.object({
      projectPath: z.string().optional(),
      hash: z.string(),
      cwd: z.string().optional(),
    }),
    output: z.object({ diff: z.string() }),
  }),

  // Compare-mode diff used by the Git panel's worktree-compare UI.
  // Two forms:
  //   1. Three-dot range (`from`+`to` set, `cwd` omitted): runs `git diff
  //      from...to` from the project dir — the "what commits are on `to`
  //      since the merge-base with `from`" view, used for parent-branch
  //      rows.
  //   2. Worktree-vs-parent (`from` set, `to` omitted, `cwd` set to the
  //      worktree path): runs `git diff from` from inside the worktree,
  //      which includes both committed branch commits AND uncommitted
  //      edits — the "everything this session changed vs its parent"
  //      view, used for worktree rows. The server enforces that `cwd`
  //      lives under the current project path.
  gitDiffRange: req({
    input: z.object({
      projectPath: z.string().optional(),
      from: z.string(),
      to: z.string().optional(),
      file: z.string().optional(),
      cwd: z.string().optional(),
    }),
    output: z.object({ diff: z.string() }),
  }),

  // Name-status listing for the same compare mode as gitDiffRange.
  // Feeds the Git panel's left-pane file list when a branch/worktree
  // row is selected.
  gitDiffRangeFiles: req({
    input: z.object({
      projectPath: z.string().optional(),
      from: z.string(),
      to: z.string().optional(),
      cwd: z.string().optional(),
    }),
    output: z.object({
      files: z.array(
        z.object({
          path: z.string(),
          status: z.string(),
        }),
      ),
    }),
  }),

  gitShowFile: req({
    input: z.object({
      projectPath: z.string().optional(),
      ref: z.string(),
      file: z.string(),
      cwd: z.string().optional(),
    }),
    output: z.object({ data: z.string(), exists: z.boolean() }),
  }),

  gitCommit: req({
    input: z.object({
      projectPath: z.string().optional(),
      message: z.string(),
      files: z.array(z.string()),
      cwd: z.string().optional(),
    }),
    output: z.object({ hash: z.string() }),
  }),

  gitAdd: req({
    input: z.object({
      projectPath: z.string().optional(),
      files: z.array(z.string()),
      cwd: z.string().optional(),
    }),
    output: z.object({ ok: z.boolean() }),
  }),

  gitCheckout: req({
    input: z.object({
      projectPath: z.string().optional(),
      ref: z.string(),
      cwd: z.string().optional(),
    }),
    output: z.object({ ok: z.boolean() }),
  }),

  gitRevertFile: req({
    input: z.object({
      projectPath: z.string().optional(),
      file: z.string(),
      cwd: z.string().optional(),
    }),
    output: z.object({ ok: z.boolean() }),
  }),

  gitPull: req({
    input: z.object({
      projectPath: z.string().optional(),
      cwd: z.string().optional(),
    }),
    output: z.object({ ok: z.boolean(), summary: z.string() }),
  }),

  gitPush: req({
    input: z.object({
      projectPath: z.string().optional(),
      cwd: z.string().optional(),
    }),
    output: z.object({
      ok: z.boolean(),
      summary: z.string(),
      error: z
        .object({
          kind: z.enum([
            'org-restriction',
            'no-token',
            'invalid-token',
            'no-access',
            'unknown',
          ]),
          message: z.string(),
          org: z.string().optional(),
          repo: z.string().optional(),
          approvalUrl: z.string().optional(),
        })
        .optional(),
    }),
  }),

  gitBranchList: req({
    input: z.object({
      projectPath: z.string().optional(),
      cwd: z.string().optional(),
    }),
    output: z.object({
      branches: z.array(
        z.object({
          name: z.string(),
          current: z.boolean(),
        }),
      ),
    }),
  }),

  gitBranchCreate: req({
    input: z.object({
      projectPath: z.string().optional(),
      name: z.string(),
      checkout: z.boolean().optional(),
      cwd: z.string().optional(),
    }),
    output: z.object({ ok: z.boolean() }),
  }),

  gitBranchDelete: req({
    input: z.object({
      projectPath: z.string().optional(),
      name: z.string(),
      force: z.boolean().optional(),
      cwd: z.string().optional(),
    }),
    output: z.object({ ok: z.boolean() }),
  }),

  gitBranchRename: req({
    input: z.object({
      projectPath: z.string().optional(),
      oldName: z.string(),
      newName: z.string(),
      cwd: z.string().optional(),
    }),
    output: z.object({ ok: z.boolean() }),
  }),

  gitFetch: req({
    input: z.object({
      projectPath: z.string().optional(),
      cwd: z.string().optional(),
    }),
    output: z.object({ ok: z.boolean(), summary: z.string() }),
  }),

  gitAmend: req({
    input: z.object({
      projectPath: z.string().optional(),
      message: z.string().optional(),
      cwd: z.string().optional(),
    }),
    output: z.object({ hash: z.string() }),
  }),

  gitUndoCommit: req({
    input: z.object({
      projectPath: z.string().optional(),
      cwd: z.string().optional(),
    }),
    output: z.object({ ok: z.boolean(), summary: z.string() }),
  }),

  gitStash: req({
    input: z.object({
      projectPath: z.string().optional(),
      message: z.string().optional(),
      cwd: z.string().optional(),
    }),
    output: z.object({ ok: z.boolean(), summary: z.string() }),
  }),

  gitStashPop: req({
    input: z.object({
      projectPath: z.string().optional(),
      cwd: z.string().optional(),
    }),
    output: z.object({ ok: z.boolean(), summary: z.string() }),
  }),

  gitStashList: req({
    input: z.object({
      projectPath: z.string().optional(),
      cwd: z.string().optional(),
    }),
    output: z.object({
      entries: z.array(
        z.object({
          index: z.number(),
          message: z.string(),
        }),
      ),
    }),
  }),

  gitMerge: req({
    input: z.object({
      projectPath: z.string().optional(),
      branch: z.string(),
      cwd: z.string().optional(),
    }),
    output: z.object({
      ok: z.boolean(),
      summary: z.string(),
      conflicts: z.array(z.string()),
    }),
  }),

  gitMergeAbort: req({
    input: z.object({
      projectPath: z.string().optional(),
      cwd: z.string().optional(),
    }),
    output: z.object({ ok: z.boolean() }),
  }),

  gitRemoteSet: req({
    input: z.object({
      projectPath: z.string().optional(),
      url: z.string(),
      cwd: z.string().optional(),
    }),
    output: z.object({ ok: z.boolean() }),
  }),

  // Agent management
  spawnAgent: req({
    input: z.object({
      projectPath: z.string().optional(),
      type: z.string(),
      args: z.array(z.string()).optional(),
    }),
    output: z.object({ agentId: z.string() }),
  }),

  killAgent: req({
    input: z.object({ agentId: z.string() }),
    output: z.object({ ok: z.boolean() }),
  }),

  listAgents: req({
    input: z.object({}),
    output: z.object({
      agents: z.array(
        z.object({
          id: z.string(),
          type: z.string(),
          running: z.boolean(),
        }),
      ),
    }),
  }),

  // PTY terminal
  ptyCreate: req({
    input: z.object({
      projectPath: z.string().optional(),
      agentType: z.string(),
      args: z.array(z.string()).optional(),
    }),
    output: z.object({ sessionId: z.string() }),
  }),

  ptyWrite: req({
    input: z.object({ sessionId: z.string(), data: z.string() }),
    output: z.object({ ok: z.boolean() }),
  }),

  ptyResize: req({
    input: z.object({
      sessionId: z.string(),
      cols: z.number().int().positive(),
      rows: z.number().int().positive(),
    }),
    output: z.object({ ok: z.boolean() }),
  }),

  ptyKill: req({
    input: z.object({ sessionId: z.string() }),
    output: z.object({ ok: z.boolean() }),
  }),

  ptyList: req({
    input: z.object({}),
    output: z.object({
      sessions: z.array(
        z.object({
          id: z.string(),
          agentType: z.string(),
          running: z.boolean(),
        }),
      ),
    }),
  }),

  ptyBuffer: req({
    input: z.object({ sessionId: z.string() }),
    output: z.object({ data: z.string(), cursor: z.number() }),
  }),

  // Dev server
  startDevServer: req({
    input: z.object({
      // Absolute project path to spawn the dev server for. Required
      // once the renderer is multi-project aware (one path per tab);
      // optional during the single-tab transition, in which case the
      // sidecar falls back to the currently-open project.
      projectPath: z.string().optional(),
      // Optional subpath of the project to spawn the dev server in.
      // Used to preview a session's in-progress work from its worktree
      // (`<project>/.ugly-studio/users/<u>/sessions/<s>/worktree`)
      // without disturbing the main checkout. Omit to run in the
      // project root. Must resolve inside the project path; otherwise
      // the request is rejected (path-traversal guard).
      worktreePath: z.string().optional(),
      // Session compositeId (`ws_x:sess_y`). When present, the start
      // routes to the per-session dev-server pool so N sessions can
      // coexist on distinct ports instead of fighting over the legacy
      // singleton. Omit for project-root dev server.
      compositeId: z.string().optional(),
    }),
    output: z.object({
      port: z.number(),
      pid: z.number(),
      // True when the wait loop confirmed the port is bound. False
      // when the wait timed out but the child is still alive — caller
      // should expect a brief ECONNREFUSED window while the first
      // compile finishes.
      portBound: z.boolean().optional(),
      // Last ~20 lines of stdio captured during boot. Useful for
      // logging the "vite ready in 412ms" line, or showing slow-boot
      // progress when `portBound=false`.
      recentOutput: z.string().optional(),
    }),
  }),

  stopDevServer: req({
    input: z.object({
      // When set, stops the per-session dev server for that
      // compositeId. Omit (and pass `projectPath`) to stop a
      // project-root dev server.
      compositeId: z.string().optional(),
      // Absolute project path. Required by multi-project callers to
      // disambiguate which project's root dev server to stop; falls
      // back to the most-recently-started project for legacy callers.
      projectPath: z.string().optional(),
    }),
    output: z.object({ ok: z.boolean() }),
  }),

  devServerStatus: req({
    input: z.object({
      // When set, returns the per-session dev server's status;
      // otherwise returns the project-root dev server's status.
      compositeId: z.string().optional(),
      // Absolute project path for the multi-project root case;
      // falls back to the most-recently-started project for legacy.
      projectPath: z.string().optional(),
    }),
    output: z.object({
      running: z.boolean(),
      port: z.number().nullable(),
      // Populated when the last spawn exited non-zero / failed to
      // become ready. Cleared on a successful start or explicit stop.
      lastError: z.string().nullable(),
      lastErrorAt: z.number().nullable(),
      // The cwd the dev server is (or was most recently) running
      // against. Same as the current project path for a normal start;
      // a session-worktree subpath when the preview was targeted at
      // an agent session. Null before the first start this session.
      cwd: z.string().nullable(),
    }),
  }),

  // Push the running dev URL (the public tunnel URL emitted by
  // `ugly-app dev`'s `ensureInfra` boot) to every Ugly Browser shell
  // signed in as the same ugly.bot user. Implicit pairing — no device
  // picker; the server-side handler broadcasts via the existing
  // BrowserSocket fan-out and emits a push notification as a fallback
  // for devices whose WS isn't currently connected. Used by Preview's
  // "Open in Ugly Browser" button.
  openCurrentDevInBrowserApp: req({
    input: z.object({
      // Per-session dev instance; when omitted, falls back to the
      // project-root instance (mirrors the existing dev-server
      // endpoints' compositeId/projectPath fallback shape).
      compositeId: z.string().optional(),
      projectPath: z.string().optional(),
    }),
    output: z.object({
      // The public tunnel URL the studio asked ugly.bot to navigate
      // to. Surfaced so the UI can show the user what was sent.
      tunnelUrl: z.string(),
      // How many live Ugly Browser sockets received the navigate.
      deviceCount: z.number(),
      // Whether a push notification was emitted as a fallback (always
      // true in the current implementation — fires regardless of
      // socket state so a backgrounded device can still pick it up).
      pushFallback: z.boolean(),
    }),
  }),

  // List every dev server currently running (singleton + per-session
  // instances). Used by the UI to show a compact overview so the user
  // sees all active ports at a glance and doesn't accidentally kill
  // the wrong one when switching sessions.
  listDevServers: req({
    input: z.object({}),
    output: z.object({
      servers: z.array(
        z.object({
          // compositeId for session instances, null for the singleton.
          compositeId: z.string().nullable(),
          port: z.number(),
          status: z.enum([
            'starting',
            'running',
            'stopping',
            'stopped',
            'failed',
          ]),
          cwd: z.string().nullable(),
        }),
      ),
    }),
  }),

  // npm
  npmInstall: req({
    input: z.object({
      projectPath: z.string().optional(),
    }),
    output: z.object({ ok: z.boolean(), output: z.string() }),
  }),

  npmRunScript: req({
    input: z.object({
      projectPath: z.string().optional(),
      script: z.string(),
    }),
    output: z.object({ ok: z.boolean(), output: z.string() }),
  }),

  // Tests — unified vitest + playwright test explorer
  listTests: req({
    input: z.object({
      projectPath: z.string().optional(),
    }),
    output: z.object({
      tests: z.array(
        z.object({
          id: z.string(),
          kind: z.enum(['vitest', 'playwright']),
          file: z.string(),
          name: z.string(),
        }),
      ),
    }),
  }),

  runAllTests: req({
    input: z.object({
      projectPath: z.string().optional(),
    }),
    output: z.object({ ok: z.boolean() }),
  }),

  runTest: req({
    input: z.object({
      projectPath: z.string().optional(),
      testId: z.string(),
    }),
    output: z.object({ ok: z.boolean() }),
  }),

  // Preview capture
  capturePreview: req({
    input: z.object({}),
    output: z.object({
      imageBase64: z.string(),
      width: z.number(),
      height: z.number(),
      timestamp: z.number(),
    }),
  }),

  // Project
  openProject: req({
    input: z.object({ path: z.string() }),
    output: z.object({ name: z.string(), path: z.string() }),
  }),

  getProjectInfo: req({
    // `projectPath` is optional so legacy single-project callers
    // (and tests) keep working; multi-tab callers pass it explicitly
    // (or rely on the ProjectScopeProvider via useSocket() injection)
    // so each tab gets its own project's info instead of whichever
    // project happens to be the active one server-side.
    input: z.object({
      projectPath: z.string().optional(),
    }),
    output: z.object({
      name: z.string().nullable(),
      path: z.string().nullable(),
      hasGit: z.boolean(),
      hasPackageJson: z.boolean(),
      projectId: z.string().nullable(),
    }),
  }),

  // Recent projects are now synced via the ugly-app `recentProject` collection
  // (see client/studio/state/recentProjects.ts) rather than this native shim.

  initProject: req({
    input: z.object({
      name: z.string(),
      parentDir: z.string().optional(),
      /**
       * Optional client-supplied id for the long-running task. When set,
       * the sidecar registers an AbortController under this id and the
       * `project:init:progress` events echo it back as `taskId` so the
       * UI can wire its Stop button to `cancelTask({ taskId })`. The
       * client is expected to generate a fresh id per call (uuid /
       * crypto.randomUUID); the server treats it opaquely.
       */
      taskId: z.string().optional(),
    }),
    output: z.object({ name: z.string(), path: z.string() }),
  }),

  cloneProject: req({
    input: z.object({
      url: z.string(),
      parentDir: z.string().optional(),
      taskId: z.string().optional(),
    }),
    output: z.object({ name: z.string(), path: z.string() }),
  }),

  /**
   * Abort an in-flight long-running task. Looks up the AbortController
   * registered under `taskId` (by `initProject`, `cloneProject`, or
   * `codingAgentChatCreate` when given a `taskId` input) and calls
   * `.abort()`. Returns `{ ok: false }` when the task isn't registered
   * (already finished, never started, or the id doesn't match) — that's
   * not surfaced as an error since the user-visible effect (the
   * operation stops) is the same either way.
   */
  cancelTask: req({
    input: z.object({ taskId: z.string() }),
    output: z.object({ ok: z.boolean() }),
  }),

  closeProject: req({
    input: z.object({
      // When set, closes just that project tab from the registry,
      // leaving other open tabs untouched. Omit to close the
      // currently-active project (legacy single-project behavior;
      // tears down dev server, PTYs, and the semantic indexer).
      projectPath: z.string().optional(),
    }),
    output: z.object({ ok: z.boolean() }),
  }),

  // Enumerate every project currently in the open-tabs registry.
  // Used by the tab bar on mount + after open/close so the strip
  // reflects what the sidecar believes is open. `activePath` is what
  // the legacy single-project handlers route to when an explicit
  // `projectPath` isn't supplied in their input.
  listOpenProjects: req({
    input: z.object({}),
    output: z.object({
      projects: z.array(
        z.object({
          path: z.string(),
          name: z.string(),
          addedAt: z.number(),
          lastActivityAt: z.number(),
          // True when the hibernation loop stopped this project's
          // root dev server (idle for 15min while not active, or
          // force-evicted under memory pressure). The renderer
          // surfaces this as a sleep badge on the tab; clears
          // automatically the next time the user interacts with
          // the project.
          hibernated: z.boolean(),
        }),
      ),
      activePath: z.string().nullable(),
      // `layout.json` content for `activePath` at the time of this
      // call. Bundled here so the renderer can hydrate its workspace
      // layout synchronously on warm starts instead of doing a second
      // round-trip to `readLayout` (which used to flash the
      // new-session hero for ~400ms while in flight). Null when no
      // active project or no layout file yet.
      activeLayoutContent: z.string().nullable(),
    }),
  }),

  // Move the legacy "active project" pointer to a different already-open
  // tab without re-running the openProject lifecycle. Called when the
  // user clicks a tab in the tab bar.
  setActiveProject: req({
    input: z.object({ projectPath: z.string() }),
    output: z.object({ ok: z.boolean() }),
  }),

  /**
   * Per-open-project aggregate of session activity. Drives the
   * status dot on each project tab in the top-bar. The dot picks
   * the highest-priority state in order
   *   thinkingDone > thinking > blocked > idle.
   * Initial state on mount; subsequent updates arrive via the
   * `project:aggregate-changed` push broadcast.
   */
  getOpenProjectAggregates: req({
    input: z.object({
      projectPath: z.string().optional(),
    }),
    output: z.object({
      aggregates: z.record(
        z.string(),
        z.object({
          thinkingDone: z.boolean(),
          thinking: z.boolean(),
          blocked: z.boolean(),
        }),
      ),
    }),
  }),

  /**
   * Stamp the session as viewed-just-now so its "thinking-done"
   * indicator clears. Fired from the client when the user clicks
   * the session row in the sidebar, and from the chat hook when a
   * turn finishes while the user already has the session in view.
   * Routes to the right runner (claude-cli or in-process coding-agent)
   * based on the session's compositeId.
   */
  markSessionViewed: req({
    input: z.object({ compositeId: z.string() }),
    output: z.object({ ok: z.boolean() }),
  }),

  // Claude Code CLI status
  checkClaudeStatus: req({
    input: z.object({}),
    output: z.object({
      installed: z.boolean(),
      version: z.string().nullable(),
      authenticated: z.boolean(),
    }),
  }),

  // Claude Chat (structured JSON subprocess, not PTY)
  claudeChatCreate: req({
    input: z.object({
      projectPath: z.string().optional(),
      mode: z.enum(['edit', 'yolo', 'claude-plan']).optional(),
      // When supplied, reuse this session UUID instead of generating a new
      // one. The next send uses `--resume <id>` so the Claude CLI rehydrates
      // its on-disk conversation history.
      resumeSessionId: z.string().optional(),
    }),
    output: z.object({ sessionId: z.string() }),
  }),

  claudeChatSend: req({
    input: z.object({ sessionId: z.string(), message: z.string() }),
    output: z.object({ ok: z.boolean() }),
  }),

  claudeChatStop: req({
    input: z.object({ sessionId: z.string() }),
    output: z.object({ ok: z.boolean() }),
  }),

  // Shared agent controls.
  // (The legacy `agentSetMode` and `codingAgentSetMode` endpoints were
  // removed 2026-04-30 — agent permission mode is fixed at session
  // create time. Use the `permissionMode` field in
  // `codingAgentCreateSession` / `claudeCodeCreateSession` instead.)

  listSkills: req({
    input: z.object({
      projectPath: z.string().optional(),
    }),
    output: z.object({
      skills: z.array(
        z.object({
          name: z.string(),
          description: z.string(),
          scope: z.enum(['system', 'user', 'project', 'plugin']),
        }),
      ),
    }),
  }),

  // Spec CRUD
  specList: req({
    input: z.object({}),
    output: z.object({
      specs: z.array(
        z.object({
          id: z.string(),
          title: z.string().optional(),
          content: z.string().optional(),
        }),
      ),
    }),
  }),

  specCreate: req({
    input: z.object({ title: z.string(), content: z.string() }),
    output: z.object({ id: z.string() }),
  }),

  specGet: req({
    input: z.object({ id: z.string() }),
    output: z.object({
      id: z.string(),
      title: z.string().optional(),
      content: z.string().optional(),
    }),
  }),

  specUpdate: req({
    input: z.object({ id: z.string(), content: z.string() }),
    output: z.object({ ok: z.boolean() }),
  }),

  setActiveSpec: req({
    input: z.object({
      specId: z.string().nullable(),
      title: z.string().optional(),
    }),
    output: z.object({ ok: z.boolean() }),
  }),

  getActiveSpec: req({
    input: z.object({}),
    output: z.object({
      spec: z.object({ id: z.string(), title: z.string() }).nullable(),
    }),
  }),

  /**
   * Bulk read of every studio UI preference persisted on disk under
   * `~/.ugly-studio/settings.json`. Replaces the previous
   * `localStorage` storage layer — the client calls this once on
   * socket connect, hydrates an in-memory cache, and serves
   * subsequent reads synchronously from there. Values are arbitrary
   * JSON, so the entire payload comes back as a string-keyed object.
   */
  getStudioUserSettings: req({
    input: z.object({}),
    output: z.object({
      entries: z.record(z.string(), z.unknown()),
    }),
  }),

  /**
   * Persist (or delete) a single studio UI preference. Pass `value:
   * null` to delete a key — folded into the setter so the wire
   * protocol stays one verb.
   */
  setStudioUserSetting: req({
    input: z.object({
      key: z.string(),
      value: z.unknown(),
    }),
    output: z.object({ ok: z.boolean() }),
  }),

  // codingAgent — the in-process TypeScript coding agent.

  /**
   * Snapshot the full UI-visible state of a coding-agent session in a
   * single response. The client calls this on mount + after reconnect
   * to populate every chat-header field (mode, model, reasoning,
   * tokens, worktree, banners, …) without depending on having been
   * present for the granular event stream that emits each field
   * piecewise.
   *
   * Wraps the same `SessionSnapshot` payload that the server now
   * broadcasts as a `session_state` event whenever any field changes,
   * so first-load + every-change use one consistent shape. See the
   * snapshot migration plan at session-snapshot-migration.md for the
   * broader rationale.
   *
   * Returns null when the compositeId doesn't match a live session
   * (already terminated, never created in this process).
   */
  getCodingAgentSnapshot: req({
    input: z.object({ compositeId: z.string() }),
    output: z.object({
      snapshot: SessionSnapshotSchema.nullable(),
    }),
  }),

  codingAgentChatCreate: req({
    input: z.object({
      projectPath: z.string().optional(),
      model: z.string().optional(),
      mode: z.enum(['edit', 'yolo', 'claude-plan']).optional(),
      resumeSessionId: z.string().optional(),
      /**
       * When set, binds this session to the given spec. Spec-bound sessions
       * get a spec-context block injected into the system prompt and cannot
       * create further specs (spec_create is removed from the tool catalog).
       */
      specId: z.string().optional(),
      /**
       * Initial reasoning-effort for the session. Currently only the
       * Claude Code runner reads this on create — it's plumbed onto
       * `--effort` for the first turn so the chip's pre-create value
       * survives without an extra round-trip. The in-process coding
       * agent ignores it (it sets effort separately via
       * `codingAgentSetReasoningEffort` after create).
       */
      reasoningEffort: z
        .enum(['off', 'low', 'medium', 'high', 'max'])
        .optional(),
      /**
       * Optional client-supplied id for this create call. When set, the
       * sidecar registers an AbortController under it and echoes it back
       * via `session:create:progress` events (`taskId`) so the UI's Stop
       * button can call `cancelTask({ taskId })` to abort the in-flight
       * pnpm install.
       */
      taskId: z.string().optional(),
      /**
       * Whether to register the studio's MCP server with the underlying
       * Claude Code CLI session. Defaults to true (parity with prior
       * behavior). Set false for eval-mode sessions: the MCP surface
       * mostly exposes studio-specific tools (skills, ask_user, etc.)
       * that would distract the agent from the upstream task and
       * pollute the model's tool catalog with affordances the eval's
       * grader doesn't account for. In-process coding-agent sessions
       * ignore this flag — they have their own MCP wiring.
       */
      exposeMcp: z.boolean().optional(),
      /**
       * Initial Model axis for the session. `startNewChat` sends this so a
       * new-session hero pre-pick (single model vs auto strategy) is seeded
       * on create — the per-axis `codingAgentSetModelMode` RPC no-ops while
       * there's no sessionId yet. Undeclared previously, which let a
       * validated transport strip it and drop the pick. Shape mirrors
       * `codingAgentSetModelMode` + `SessionSnapshot.modelMode`.
       */
      modelMode: z
        .union([
          z.object({ kind: z.literal('auto') }),
          z.object({ kind: z.literal('max') }),
          z.object({ kind: z.literal('single'), model: z.string() }),
          z.object({ kind: z.literal('mid'), survivor: z.string() }),
          z.object({ kind: z.literal('auto-cheap') }),
          z.object({
            kind: z.literal('group'),
            models: z.array(z.string()),
            personas: z.record(z.string(), z.string()).optional(),
          }),
        ])
        .optional(),
      /**
       * Initial Pattern axis for the session — seeded on create for the same
       * reason as `modelMode`. Mirrors `codingAgentSetPatternMode`.
       */
      patternMode: z
        .enum([
          'none',
          'auto',
          'spec-build-verify',
          'super-spec-build-verify',
          'quick-edit',
          'investigate-fix',
          'super-investigate-fix',
          'chat-qa',
          'chat-advisory',
        ])
        .optional(),
    }),
    output: z.object({
      sessionId: z.string(),
      /**
       * Current spec binding of the returned session, if any. Populated
       * on resume so the chat UI can gate per-session spec affordances
       * (e.g. the Build-from-spec button) atomically at mount rather
       * than waiting for the next `session` event to propagate the
       * spec-id. On fresh (no-resume) create this is always undefined.
       */
      specId: z.string().optional(),
      /**
       * Current mode of the returned session. On resume this reflects
       * the persisted mode (session may have been left in `edit` or
       * `yolo`); the client seeds its `mode` state from this so
       * switching sessions doesn't silently reset the mode chip
       * back to `spec`.
       */
      mode: z.enum(['edit', 'yolo', 'claude-plan']).optional(),
      /**
       * Current model id of the returned session. Persisted per-session
       * so a model picked inside the chat survives an app restart — the
       * client's global `localStorage` model is for fresh sessions only.
       */
      model: z.string().optional(),
      /**
       * Current reasoning effort of the returned session. Persisted
       * per-session for the same reason as `model` above.
       */
      reasoningEffort: z
        .enum(['off', 'low', 'medium', 'high', 'max'])
        .optional(),
    }),
  }),

  codingAgentChatSend: req({
    input: z.object({
      sessionId: z.string(),
      message: z.string(),
      /**
       * Optional inline image attachments. Each is base64-encoded
       * (no `data:` prefix). The server inlines these as Anthropic
       * image content blocks for vision-capable models, or stores
       * them under stable imageIds and exposes them via the
       * `analyze_image` tool for non-vision models.
       */
      attachments: z
        .array(
          z.object({
            kind: z.literal('image'),
            mediaType: z.enum([
              'image/png',
              'image/jpeg',
              'image/webp',
              'image/gif',
            ]),
            base64: z.string(),
            filename: z.string().optional(),
          }),
        )
        .optional(),
    }),
    output: z.object({ ok: z.boolean() }),
  }),

  codingAgentChatStop: req({
    input: z.object({ sessionId: z.string() }),
    output: z.object({ ok: z.boolean() }),
  }),

  /**
   * Clear the chat message history in place — same sessionId,
   * same worktree, same indexes. Used by the `/clear` slash command
   * so the user keeps their session affordances (worktree, indexer
   * warmup, dev server) without paying the new-session re-init cost.
   */
  codingAgentChatClearMessages: req({
    input: z.object({ sessionId: z.string() }),
    output: z.object({ ok: z.boolean() }),
  }),

  /**
   * Abort a single in-flight tool call without stopping the whole
   * session. Used by the per-tool stop button on long-running cards
   * (bash today). Returns `ok: false` when the tool_call has already
   * settled or the session doesn't exist.
   */
  codingAgentToolStop: req({
    input: z.object({ sessionId: z.string(), toolCallId: z.string() }),
    output: z.object({ ok: z.boolean() }),
  }),

  codingAgentChatSetModel: req({
    input: z.object({
      sessionId: z.string(),
      model: z.string(),
      // Multi-tab scope: which open project this session belongs to. Auto-
      // injected by the client wrappers; falls back to the global project.
      projectPath: z.string().nullish(),
      // Set true to confirm a Claude-CLI <-> ugly.bot switch, which converts
      // the session in place (same worktree) and WIPES chat history + telemetry.
      resetForFamilySwitch: z.boolean().optional(),
    }),
    output: z.object({
      ok: z.boolean(),
      // The server is asking the client to confirm the destructive family
      // switch before it runs (returned when no flag was set).
      needsFamilySwitchConfirm: z.boolean().optional(),
      // New compositeId after a family convert (same worktree); the client
      // should re-point to it.
      sessionId: z.string().optional(),
    }),
  }),

  codingAgentSetReasoningEffort: req({
    input: z.object({
      sessionId: z.string(),
      effort: z.enum(['off', 'low', 'medium', 'high']),
    }),
    output: z.object({ ok: z.boolean() }),
  }),

  /**
   * Three-axis controls. Each setter is independent — patches only the
   * named axis on the session, leaves the others untouched. Changes
   * apply on the next user turn; in-flight turns finish on existing
   * settings.
   */
  codingAgentSetPermissionMode: req({
    input: z.object({
      sessionId: z.string(),
      permissionMode: z.enum(['edit', 'yolo', 'claude-plan']),
    }),
    output: z.object({ ok: z.boolean() }),
  }),
  codingAgentSetModelMode: req({
    input: z.object({
      sessionId: z.string(),
      // Multi-tab scope; auto-injected by the client wrappers. Needed so the
      // server can locate the project when a single-model pick crosses the
      // Claude-CLI boundary and the session has to be converted in place.
      projectPath: z.string().nullish(),
      modelMode: z.union([
        z.object({ kind: z.literal('auto') }),
        z.object({ kind: z.literal('max') }),
        z.object({ kind: z.literal('single'), model: z.string() }),
        // Deprecated; kept for back-compat translation.
        z.object({ kind: z.literal('mid'), survivor: z.string() }),
        z.object({ kind: z.literal('auto-cheap') }),
        z.object({
          kind: z.literal('group'),
          models: z.array(z.string()),
          personas: z.record(z.string(), z.string()).optional(),
        }),
      ]),
    }),
    // `sessionId` echoes the (same) compositeId after a family convert so the
    // client can re-point if it ever changes. `needsFamilySwitchConfirm` asks
    // the client to confirm a destructive Claude-CLI <-> ugly.bot switch (the
    // session has history) before retrying via chatSetModel.
    output: z.object({
      ok: z.boolean(),
      sessionId: z.string().optional(),
      needsFamilySwitchConfirm: z.boolean().optional(),
    }),
  }),
  codingAgentSetPatternMode: req({
    input: z.object({
      sessionId: z.string(),
      patternMode: z.enum([
        'none',
        'auto',
        'spec-build-verify',
        'super-spec-build-verify',
        'quick-edit',
        'investigate-fix',
        'super-investigate-fix',
        'chat-qa',
        'chat-advisory',
      ]),
    }),
    output: z.object({ ok: z.boolean() }),
  }),

  codingAgentCompactNow: req({
    input: z.object({ sessionId: z.string() }),
    output: z.object({
      ok: z.boolean(),
      dropped: z.number().optional(),
      tokens: z.number().optional(),
      budget: z.number().optional(),
      error: z.string().optional(),
    }),
  }),

  codingAgentRestoreCheckpoint: req({
    input: z.object({ sessionId: z.string(), msgId: z.string() }),
    output: z.object({
      ok: z.boolean(),
      error: z.string().optional(),
    }),
  }),

  codingAgentChatListMessages: req({
    input: z
      .object({
        projectPath: z.string().optional(),
        sessionId: z.string(),
        limit: z.number().int().positive().max(200).optional(),
        beforeId: z.string().optional(),
        afterId: z.string().optional(),
      })
      .refine((v) => !(v.beforeId && v.afterId), {
        message: 'beforeId and afterId are mutually exclusive',
      }),
    output: z.object({
      messages: z.array(
        z.object({
          id: z.string(),
          role: z.enum([
            'user',
            'assistant',
            'system',
            'tool',
            'judge',
            'status',
          ]),
          parts: z.array(
            z.object({
              type: z.string(),
              data: z.unknown(),
            }),
          ),
          created_at: z.number().optional(),
          /** Model that produced an assistant message — drives the badge on replay. */
          model: z.string().optional(),
        }),
      ),
      hasMore: z.boolean(),
    }),
  }),

  /**
   * TEST-ONLY — push a synthetic `message` event onto a coding-agent
   * session's bus. Used by `tests/e2e-chat-scroll.test.ts` to flood the
   * chat with arbitrary text payloads of varying sizes so we can assert
   * the message list stays bottom-aligned. Server-side this RPC is a
   * no-op unless `STUDIO_E2E_TEST=1` is set on the sidecar process.
   */
  e2eAppendCodingAgentMessage: req({
    input: z.object({
      projectPath: z.string().optional(),
      sessionId: z.string(),
      role: z.enum(['user', 'assistant']),
      text: z.string(),
    }),
    output: z.object({ ok: z.boolean(), messageId: z.string().optional() }),
  }),

  /**
   * TEST-ONLY — read out every LLM request captured by the active
   * `SimulatedProvider`. Returns `{ ok: false }` unless
   * `UGLY_STUDIO_FORCE_SIMULATED_LLM` is set on the sidecar process
   * (which is also the env var that installs the simulated provider).
   * Used by the Playwright done-entry e2e suite to assert that
   * status-role messages are filtered out of the LLM context.
   */
  e2eGetCapturedLlmRequests: req({
    input: z.object({}),
    output: z.object({
      ok: z.boolean(),
      requests: z
        .array(
          z.object({
            seq: z.number(),
            model: z.string(),
            messages: z.array(z.unknown()),
            tools: z.array(z.unknown()).optional(),
          }),
        )
        .optional(),
    }),
  }),

  codingAgentGrantPermission: req({
    input: z.object({
      sessionId: z.string(),
      permission: z.object({
        id: z.string(),
        session_id: z.string(),
        tool_call_id: z.string(),
        tool_name: z.string(),
        description: z.string(),
        action: z.string(),
        path: z.string(),
        params: z.record(z.string(), z.unknown()),
      }),
      action: z.enum(['allow', 'allow_session', 'deny']),
    }),
    output: z.object({ ok: z.boolean() }),
  }),

  codingAgentAnswerAskUser: req({
    input: z.object({
      sessionId: z.string(),
      toolCallId: z.string(),
      value: z.string(),
    }),
    output: z.object({
      ok: z.boolean(),
      error: z.string().optional(),
    }),
  }),

  /**
   * Resolve a pending step-review gate (between SPEC/DIAGNOSE and the
   * next step in `spec-build-verify` / `investigate-fix`). The IDE
   * posts approve (`{ action: 'continue' }`) or iterate
   * (`{ action: 'iterate', feedback }`) — on iterate the agent
   * re-runs the same step with `feedback` injected as a synthetic
   * user message before BUILD/FIX runs.
   */
  codingAgentAnswerStepReview: req({
    input: z.object({
      sessionId: z.string(),
      id: z.string(),
      action: z.enum(['continue', 'iterate']),
      feedback: z.string().optional(),
    }),
    output: z.object({
      ok: z.boolean(),
      /**
       * Precise outcome tag from the broker. `ok` only for happy-path
       * resolves; the others let the IDE branch on the failure mode
       * (e.g. `already_answered` is a benign duplicate click and
       * doesn't deserve a banner; `unknown` indicates a sidecar
       * restart and the user needs to send a fresh message).
       */
      outcome: z
        .enum(['ok', 'already_answered', 'aborted', 'unknown', 'no_session'])
        .optional(),
      error: z.string().optional(),
    }),
  }),

  codingAgentSkipPermissions: req({
    input: z.object({
      sessionId: z.string(),
      skip: z.boolean(),
    }),
    output: z.object({ ok: z.boolean() }),
  }),

  // (`codingAgentSetMode` removed 2026-04-30 — see note on
  // `agentSetMode` above. Permission mode is set once at create time.)

  /**
   * Begin the "Finish session" pipeline for a worktree-backed session:
   * stage-and-commit in the worktree, pull parent in, run validation
   * gates (tsc/lint/tests — each individually skippable), then squash-
   * merge into the parent branch on the main tree. Streams progress
   * through `finish_event` envelopes over the WS bus. Returns the
   * final pipeline result.
   */
  finishCodingAgentSession: req({
    input: z.object({
      sessionId: z.string(),
      runTypecheck: z.boolean().default(true),
      runLint: z.boolean().default(true),
      runTests: z.boolean().default(true),
      /**
       * When true, the pipeline auto-commits any uncommitted changes
       * in the main repo before squash-merging the session branch.
       * Default false — the first call returns a precheck_dirty_main
       * result so the chat UI can ask the user; the second call
       * (after the user confirms) sets this true.
       */
      commitDirtyMainBeforeMerge: z.boolean().optional(),
      /**
       * When true, the pipeline pauses after the validation gates
       * pass and returns `stage: 'awaiting_review'` with a proposed
       * commit message + scoping fields so the chat UI can render a
       * review modal. The caller follows up with
       * `mergeFinishedCodingAgentSession` to land the squash.
       */
      pauseBeforeSquash: z.boolean().optional(),
    }),
    output: z.object({
      ok: z.boolean(),
      stage: z
        .enum([
          'precheck_dirty_main',
          'merge_parent',
          'tsc',
          'lint',
          'tests',
          'awaiting_review',
          'merge_squash',
          'cleanup',
          'conflict',
          'done',
        ])
        .optional(),
      squashSha: z.string().optional(),
      conflicts: z.array(z.string()).optional(),
      /**
       * Set when the pipeline aborted at the dirty-main precheck.
       * Each entry is a path inside the main repo that has
       * uncommitted edits / staged changes / is untracked. The chat
       * UI lists these in the confirmation dialog.
       */
      dirtyFiles: z.array(z.string()).optional(),
      /**
       * Set when `stage === 'awaiting_review'`. The chat UI prefills
       * the review modal's commit-message field with this and lets
       * the user edit before accepting.
       */
      proposedCommitMessage: z.string().optional(),
      /** Set on awaiting_review; lets the modal scope diff RPCs. */
      parentBranch: z.string().optional(),
      sessionBranch: z.string().optional(),
      worktreePath: z.string().optional(),
      message: z.string().optional(),
    }),
  }),

  /**
   * Run the squash-merge + cleanup tail of the Finish pipeline. Called
   * after the user accepts the review modal that follows a
   * `finishCodingAgentSession` call with `pauseBeforeSquash: true`.
   * `commitMessage` is the (optionally edited) squash commit subject;
   * when empty/absent the server falls back to the auto-derived
   * message used by the unpaused path.
   */
  mergeFinishedCodingAgentSession: req({
    input: z.object({
      sessionId: z.string(),
      commitMessage: z.string().optional(),
    }),
    output: z.object({
      ok: z.boolean(),
      stage: z.enum(['merge_squash', 'cleanup', 'conflict', 'done']).optional(),
      squashSha: z.string().optional(),
      conflicts: z.array(z.string()).optional(),
      message: z.string().optional(),
    }),
  }),

  /**
   * Stop an in-flight validation gate inside the Finish pipeline. Only
   * gates (tsc / lint / tests) are interruptible; merge + cleanup run
   * to completion.
   */
  codingAgentFinishStop: req({
    input: z.object({
      sessionId: z.string(),
      stage: z.enum(['tsc', 'lint', 'tests']),
    }),
    output: z.object({ ok: z.boolean() }),
  }),

  /**
   * Abandon a session's worktree + branch without merging. Marks the
   * session finished. Safe to call on orphan branches whose live
   * sessions have already been stopped.
   */
  abandonCodingAgentSession: req({
    input: z.object({
      projectPath: z.string().optional(),
      sessionId: z.string(),
    }),
    output: z.object({ ok: z.boolean(), error: z.string().optional() }),
  }),

  /**
   * Permanently delete a coding session: tears down the worktree +
   * branch AND wipes the on-disk session directory (transcript,
   * telemetry, checkpoints). Caller is responsible for confirming
   * with the user — this is irreversible.
   */
  deleteCodingAgentSession: req({
    input: z.object({
      projectPath: z.string().optional(),
      sessionId: z.string(),
    }),
    output: z.object({ ok: z.boolean(), error: z.string().optional() }),
  }),

  /**
   * Re-run the parent-into-worktree merge for a resumed or running
   * session. Fires `worktree_event` envelopes with the outcome.
   */
  refreshCodingAgentSession: req({
    input: z.object({ sessionId: z.string() }),
    output: z.object({
      ok: z.boolean(),
      blocked: z.boolean().optional(),
      conflicts: z.array(z.string()).optional(),
      /**
       * Distinguishes a conflict in `git merge` from a conflict that
       * surfaced when re-applying the pull's autostash. Drives the
       * AI conflict-resolution prompt — the two states need different
       * follow-up commands (commit-the-merge vs. drop-the-stash).
       */
      conflictKind: z.enum(['merge', 'stash_apply']).optional(),
      error: z.string().optional(),
    }),
  }),

  /**
   * Read-only probe: is this session's worktree behind its parent
   * branch? Drives the disabled state of the "Pull from parent"
   * button. Does not merge and does not emit events.
   */
  getCodingAgentWorktreeBehind: req({
    input: z.object({ sessionId: z.string() }),
    output: z.object({
      ok: z.boolean(),
      kind: z
        .enum(['up_to_date', 'behind', 'in_progress_merge', 'unknown'])
        .optional(),
      reason: z.string().optional(),
      error: z.string().optional(),
    }),
  }),

  /**
   * Read-only probe: how many commits is the session's worktree
   * branch AHEAD of its parent branch? Used by the chat panel's Done
   * button visibility — without this, a session that committed all
   * its work but failed at the final squash-merge (e.g. previous
   * Done aborted because main was dirty) shows up with a clean
   * `gitStatus` and the Done button gets hidden, even though there
   * are unmerged commits sitting on the session branch.
   *
   * `count` is the rev-list count of commits between parent..HEAD;
   * 0 = up to date with parent; -1 = probe couldn't run (treat as
   * unknown). On the wire, the server returns -1 for the "unknown"
   * case to keep the shape simple — the client gates the button on
   * `count > 0` and treats -1 as "leave the button visible".
   */
  getCodingAgentWorktreeAhead: req({
    input: z.object({ sessionId: z.string() }),
    output: z.object({
      ok: z.boolean(),
      count: z.number().optional(),
      error: z.string().optional(),
    }),
  }),

  /**
   * Enumerate the session-owned worktrees attached to the current
   * project. Joins `git worktree list` against live + persisted
   * sessions. Orphan worktrees (branch exists, session record gone)
   * still appear with `live: false`.
   */
  listSessionWorktrees: req({
    input: z.object({
      projectPath: z.string().optional(),
    }),
    output: z.object({
      worktrees: z.array(
        z.object({
          compositeId: z.string(),
          title: z.string(),
          branch: z.string(),
          parentBranch: z.string(),
          path: z.string(),
          live: z.boolean(),
          finished: z.boolean(),
          running: z.boolean(),
          finishing: z.boolean(),
          blocked: z.boolean(),
        }),
      ),
    }),
  }),

  /**
   * All coding-agent sessions for the current project — live + persisted,
   * merged. Drives the Project Home cards (active list) and the archived
   * drawer (pass `includeArchived: true`).
   */
  codingAgentListSessions: req({
    input: z.object({
      projectPath: z.string().optional(),
      includeArchived: z.boolean().optional(),
    }),
    output: z.object({
      sessions: z.array(
        z.object({
          compositeId: z.string(),
          workspaceId: z.string(),
          sessionId: z.string(),
          title: z.string(),
          mode: z.enum(['edit', 'yolo', 'claude-plan']),
          specId: z.string().optional(),
          created_at: z.number(),
          updated_at: z.number(),
          message_count: z.number(),
          running: z.boolean(),
          /**
           * True when the session is stuck waiting on a user answer
           * — either a permission prompt or an `ask_user` question
           * from the agent. Surfaced as a BLOCKED pill in the
           * Project Home cards + session-list sidebar.
           */
          blocked: z.boolean(),
          /**
           * Short human-readable reason for `blocked` — surfaced as
           * the tooltip on the BLOCKED pill so users don't have to
           * open the session to see what the agent is waiting on.
           * Omitted when `blocked` is false.
           */
          blockedReason: z.string().optional(),
          archived: z.boolean(),
          archived_at: z.number().optional(),
          live: z.boolean(),
          finished: z.boolean(),
          worktree: z
            .object({
              branch: z.string(),
              path: z.string(),
              parentBranch: z.string(),
            })
            .optional(),
          /**
           * Model id for the row. `'auto'` for auto-mode sessions
           * regardless of the per-turn routed concrete id.
           */
          model: z.string(),
          /**
           * Sum of input + output + cache-create + cache-read tokens
           * read straight from in-memory `info` (cumulative since
           * session start). Cheap — no telemetry file read.
           */
          totalTokens: z.number(),
          /** Cumulative USD cost read from in-memory `info`. */
          totalCost: z.number(),
          /**
           * Wall-clock timestamp (ms) of when the user last opened or
           * focused this session. Drives the derived "thinking-done"
           * state on the project-tab dot in the top-bar:
           * `!running && !blocked && message_count > 0 && updated_at >
           * lastViewedAt`. Optional for wire-level compat with
           * pre-2026-05-31 sidecars; clients should fall back to
           * `updated_at` when absent.
           */
          lastViewedAt: z.number().optional(),
          /**
           * Parent orchestrator's compositeId when this session is a
           * max-mode peer. The sidebar groups peers indented under
           * their parent rather than showing them as top-level rows.
           */
          parentSessionId: z.string().optional(),
          /**
           * Discriminator for the always-present "main" session per
           * project. `'main'` runs on the parent branch with no
           * worktree and is the canonical surface for git push/pull.
           */
          kind: z.literal('main').optional(),
        }),
      ),
    }),
  }),

  /**
   * Resolve or provision the project's always-present "main" session.
   * Returns the compositeId of the active main session — looking it up
   * from memory/disk first, falling back to fresh creation. Disallows
   * auto on the main model axis (sub-models keep auto).
   */
  codingAgentGetOrCreateMain: req({
    input: z.object({
      projectPath: z.string().optional(),
      /**
       * Explicit model id for fresh main sessions. Auto sentinels
       * ('auto', 'auto:cheap', 'auto:max', '', 'same-as-coding') are
       * rejected. Ignored when an existing main session is already on
       * disk — its persisted model wins.
       */
      model: z.string(),
    }),
    output: z.object({
      sessionId: z.string(),
      model: z.string(),
      mode: z.enum(['edit', 'yolo', 'claude-plan']),
    }),
  }),

  /** Archive a session — hides it from Project Home's active list. */
  codingAgentArchiveSession: req({
    input: z.object({
      projectPath: z.string().optional(),
      compositeId: z.string(),
    }),
    output: z.object({ ok: z.boolean() }),
  }),

  /** Unarchive — restore to the active list. */
  codingAgentUnarchiveSession: req({
    input: z.object({
      projectPath: z.string().optional(),
      compositeId: z.string(),
    }),
    output: z.object({ ok: z.boolean() }),
  }),

  codingAgentGetScratchpad: req({
    input: z.object({ sessionId: z.string() }),
    output: z.object({
      entries: z.array(
        z.object({
          key: z.string(),
          value: z.string(),
          mergeToMemory: z.boolean(),
          createdAt: z.number(),
          updatedAt: z.number(),
        }),
      ),
    }),
  }),

  // Feedback analysis (screenshot + text → plan tasks)
  analyzeFeedback: req({
    input: z.object({
      feedback: z.string(),
      model: z.string().optional(),
    }),
    output: z.object({
      summary: z.string(),
      issues: z.array(
        z.object({
          description: z.string(),
          location: z.string(),
          severity: z.enum(['high', 'medium', 'low']),
          suggestion: z.string(),
          file: z.string(),
          lines: z.array(z.number()),
        }),
      ),
      specId: z.string().nullable(),
    }),
  }),

  // AI proxy status
  aiProxyStatus: req({
    input: z.object({}),
    output: z.object({
      connected: z.boolean(),
      port: z.number(),
    }),
  }),

  // Global user settings (lives in ~/.ugly-studio/coding-agent.json).
  // Holds the reinforcement toggle plus the coding-agent feature
  // toggles. The codingAgent schema mirrors `CodingAgentSettings` from
  // server/user-settings.ts; keep them in sync when adding new fields.
  // Updates post deep-partial patches, so every nested field is
  // `.optional()` on input and required on output.
  getUserSettings: req({
    input: z.object({}),
    output: z.object({
      reinforcement: z.object({ enabled: z.boolean() }),
      codingAgent: z.object({
        memory: z.object({ read: z.boolean(), write: z.boolean() }),
        multiAgent: z.object({ enabled: z.boolean() }),
        autoLint: z.boolean(),
        checkpoints: z.boolean(),
        specs: z.object({ enabled: z.boolean() }),
        systemSkills: z.object({ enabled: z.boolean() }),
        autoTsc: z.object({ enabled: z.boolean() }),
        codebaseIndex: z.boolean(),
        autoAllowlist: z.array(z.string()),
        pureJudgeMode: z.boolean(),
        expensiveParallel: z.boolean(),
        temperatureOverride: z.number().optional(),
        auxModel: z.string().optional(),
        judgeModel: z.string().optional(),
        pickerModel: z.string().optional(),
        pollinator: z.string().nullable().optional(),
        pollinatorEnabled: z.boolean().optional(),
        phaseTimeoutMs: z.number().nullable().optional(),
        hangFallbackMs: z.number().nullable().optional(),
        superSpecModels: z.array(z.string()).optional(),
        superSynthesisModel: z.string().optional(),
        superInjectionStyle: z.enum(['advisory', 'imperative']).optional(),
      }),
    }),
  }),

  updateUserSettings: req({
    input: z.object({
      reinforcement: z.object({ enabled: z.boolean().optional() }).optional(),
      codingAgent: z
        .object({
          memory: z
            .object({
              read: z.boolean().optional(),
              write: z.boolean().optional(),
            })
            .optional(),
          multiAgent: z.object({ enabled: z.boolean().optional() }).optional(),
          autoLint: z.boolean().optional(),
          checkpoints: z.boolean().optional(),
          specs: z.object({ enabled: z.boolean().optional() }).optional(),
          systemSkills: z
            .object({ enabled: z.boolean().optional() })
            .optional(),
          autoTsc: z.object({ enabled: z.boolean().optional() }).optional(),
          codebaseIndex: z.boolean().optional(),
          autoAllowlist: z.array(z.string()).optional(),
          pureJudgeMode: z.boolean().optional(),
          expensiveParallel: z.boolean().optional(),
          temperatureOverride: z.number().optional(),
          // Aux-model override: judge / classifier / picker. Concrete
          // model id, the literal 'same-as-coding', or null to clear.
          auxModel: z.string().nullable().optional(),
          judgeModel: z.string().nullable().optional(),
          pickerModel: z.string().nullable().optional(),
          pollinator: z.string().nullable().optional(),
          /**
           * Master toggle for cross-pollination. Replaces the old
           * `pollinator: 'none'` sentinel — cleaner separation between
           * "which model to pollinate with" and "whether to pollinate
           * at all". Defaults true; settings load migrates legacy
           * `pollinator === 'none'` into `pollinatorEnabled = false`.
           */
          pollinatorEnabled: z.boolean().optional(),
          phaseTimeoutMs: z.number().nullable().optional(),
          hangFallbackMs: z.number().nullable().optional(),
          // Super-spec defaults (CODING.md §17.13). null clears.
          superSpecModels: z.array(z.string()).optional(),
          superSynthesisModel: z.string().nullable().optional(),
          superInjectionStyle: z
            .enum(['advisory', 'imperative'])
            .nullable()
            .optional(),
        })
        .optional(),
    }),
    output: z.object({
      reinforcement: z.object({ enabled: z.boolean() }),
      codingAgent: z.object({
        memory: z.object({ read: z.boolean(), write: z.boolean() }),
        multiAgent: z.object({ enabled: z.boolean() }),
        autoLint: z.boolean(),
        checkpoints: z.boolean(),
        specs: z.object({ enabled: z.boolean() }),
        systemSkills: z.object({ enabled: z.boolean() }),
        autoTsc: z.object({ enabled: z.boolean() }),
        codebaseIndex: z.boolean(),
        autoAllowlist: z.array(z.string()),
        pureJudgeMode: z.boolean(),
        expensiveParallel: z.boolean(),
        temperatureOverride: z.number().optional(),
        auxModel: z.string().optional(),
        judgeModel: z.string().optional(),
        pickerModel: z.string().optional(),
        pollinator: z.string().nullable().optional(),
        pollinatorEnabled: z.boolean().optional(),
        phaseTimeoutMs: z.number().nullable().optional(),
        hangFallbackMs: z.number().nullable().optional(),
        superSpecModels: z.array(z.string()).optional(),
        superSynthesisModel: z.string().optional(),
        superInjectionStyle: z.enum(['advisory', 'imperative']).optional(),
      }),
    }),
  }),

  // Reset both settings stores to factory defaults: the coding-agent
  // store (`~/.ugly-studio/coding-agent.json`) and the editor-pref
  // store (`~/.ugly-studio/settings.json` — theme, UI scale, panel
  // dev/prod toggles, input history, etc.). Credentials (BYO keys,
  // ugly.bot login, GitHub) are NOT touched. Returns the reset
  // UserSettings so the caller can render fresh values immediately.
  resetUserSettings: req({
    input: z.object({}),
    output: z.object({
      reinforcement: z.object({ enabled: z.boolean() }),
      codingAgent: z.object({
        memory: z.object({ read: z.boolean(), write: z.boolean() }),
        multiAgent: z.object({ enabled: z.boolean() }),
        autoLint: z.boolean(),
        checkpoints: z.boolean(),
        specs: z.object({ enabled: z.boolean() }),
        systemSkills: z.object({ enabled: z.boolean() }),
        autoTsc: z.object({ enabled: z.boolean() }),
        codebaseIndex: z.boolean(),
        autoAllowlist: z.array(z.string()),
        pureJudgeMode: z.boolean(),
        expensiveParallel: z.boolean(),
        temperatureOverride: z.number().optional(),
        auxModel: z.string().optional(),
        judgeModel: z.string().optional(),
        pickerModel: z.string().optional(),
        pollinator: z.string().nullable().optional(),
        pollinatorEnabled: z.boolean().optional(),
        phaseTimeoutMs: z.number().nullable().optional(),
        hangFallbackMs: z.number().nullable().optional(),
        superSpecModels: z.array(z.string()).optional(),
        superSynthesisModel: z.string().optional(),
        superInjectionStyle: z.enum(['advisory', 'imperative']).optional(),
      }),
    }),
  }),

  // ugly.bot auth (default-browser CLI flow via local callback server)
  uglyAuthStatus: req({
    input: z.object({}),
    output: z.object({
      authenticated: z.boolean(),
      userId: z.string().nullable(),
      name: z.string().nullable(),
      avatarUri: z.string().nullable(),
    }),
  }),

  uglyAuthLogin: req({
    input: z.object({}),
    output: z.object({ url: z.string() }),
  }),

  // ugly.bot billing — proxies for the toolbar widget + settings detail
  // + popup. Daily/weekly cap, credit balance, and Stripe checkout/portal
  // URLs are sourced from ugly.bot's HTTP /request endpoint via the JWT
  // in ~/.ugly-bot/auth.json (callUglyBotAppRequest).
  getBillingUsage: req({
    input: z.object({}),
    output: z.object({
      authenticated: z.boolean(),
      // Present only when authenticated AND the upstream call succeeded.
      usage: z
        .object({
          dailySpendUsd: z.number(),
          dailyLimitUsd: z.number(),
          dailyResetTime: z.number(),
          weeklySpendUsd: z.number(),
          weeklyLimitUsd: z.number(),
          weeklyResetTime: z.number(),
          creditBalanceUsd: z.number(),
          subscriptionLevel: z.number(),
          billingState: z.string(),
        })
        .nullable(),
      // Set when the user is authenticated but the upstream call
      // failed — surfaces the real cause instead of pretending the
      // user is signed out. UI shows this verbatim.
      error: z.string().nullable(),
    }),
  }),

  getBillingCheckoutUrl: req({
    input: z.object({
      amountUsd: z.union([z.literal(10), z.literal(25), z.literal(100)]),
    }),
    output: z.object({ url: z.string() }),
  }),

  getBillingPortalUrl: req({
    input: z.object({}),
    output: z.object({ url: z.string() }),
  }),

  uglyAuthLogout: req({
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
  }),

  // GitHub auth (Device Flow — legacy: opens github.com/login/device in
  // the OS browser, only yields an API token).
  githubAuthStart: req({
    input: z.object({}),
    output: z.object({
      user_code: z.string(),
      verification_uri: z.string(),
      interval: z.number(),
    }),
  }),

  // GitHub auth (Web Flow — preferred: runs in an Electron BrowserWindow
  // bound to the `persist:publish` partition, so the resulting
  // github.com `user_session` cookie is shared with the Prod-tab
  // webview. The OAuth callback is brokered by ugly.bot
  // (`https://ugly.bot/githubCallback`) — see
  // `server/backend/GitHubOAuth.ts` and `studio/server/github-auth.ts`
  // `githubAuthStartWeb`. The renderer opens `authorize_url` in a
  // window and polls `githubAuthStatus` until `connected: true`; the
  // sidecar polls ugly.bot in the background to fetch the resulting
  // token and write it to disk.
  githubAuthStartWeb: req({
    input: z.object({}),
    output: z.object({
      authorize_url: z.string(),
    }),
  }),

  githubAuthPoll: req({
    input: z.object({}),
    output: z.object({
      status: z.enum(['pending', 'complete', 'expired', 'error']),
      username: z.string().optional(),
      error: z.string().optional(),
    }),
  }),

  githubAuthStatus: req({
    input: z.object({}),
    output: z.object({
      connected: z.boolean(),
      username: z.string().nullable(),
    }),
  }),

  githubDisconnect: req({
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
  }),

  // Collection browsing (via data proxy)
  dbCollections: req({
    input: z.object({
      projectPath: z.string().optional(),
      mode: z.enum(['dev', 'prod']),
    }),
    output: z.object({
      collections: z.array(
        z.object({
          name: z.string(),
          estimatedCount: z.number(),
        }),
      ),
    }),
  }),

  dbGetDoc: req({
    input: z.object({
      projectPath: z.string().optional(),
      mode: z.enum(['dev', 'prod']),
      collection: z.string(),
      id: z.string(),
    }),
    output: z.object({
      doc: z.record(z.string(), z.unknown()).nullable(),
    }),
  }),

  dbGetQuery: req({
    input: z.object({
      projectPath: z.string().optional(),
      mode: z.enum(['dev', 'prod']),
      collection: z.string(),
      // Structured filter builder (compiled to parameterized JSONB SQL).
      filters: z
        .array(
          z.object({
            field: z.string(),
            op: z.enum(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'exists']),
            value: z.string().optional(),
          }),
        )
        .optional(),
      sort: z.object({ field: z.string(), dir: z.enum(['asc', 'desc']) }).optional(),
      limit: z.number().optional(),
      skip: z.number().optional(),
    }),
    output: z.object({
      columns: z.array(z.string()),
      rows: z.array(z.record(z.string(), z.unknown())),
      rowCount: z.number(),
      total: z.number(),
      durationMs: z.number(),
    }),
  }),

  // Exact row count for a collection (vs the estimate in dbCollections).
  dbCount: req({
    input: z.object({
      mode: z.enum(['dev', 'prod']),
      collection: z.string(),
    }),
    output: z.object({ count: z.number() }),
  }),

  // Collection schema: real columns, indexes, exact count (+ best-effort TS type
  // is resolved client-side from shared/collections.ts).
  dbSchema: req({
    input: z.object({
      mode: z.enum(['dev', 'prod']),
      collection: z.string(),
    }),
    output: z.object({
      columns: z.array(z.object({ name: z.string(), type: z.string() })),
      indexes: z.array(z.object({ name: z.string(), def: z.string() })),
      count: z.number(),
    }),
  }),

  // Raw SQL console. Writes require allowWrite; DROP/TRUNCATE/ALTER and WHERE-less
  // UPDATE/DELETE require force; UPDATE/DELETE support a dry-run (txn + ROLLBACK).
  dbExec: req({
    input: z.object({
      mode: z.enum(['dev', 'prod']),
      sql: z.string(),
      params: z.array(z.unknown()).optional(),
      allowWrite: z.boolean().optional(),
      force: z.boolean().optional(),
      dryRun: z.boolean().optional(),
    }),
    output: z.object({
      kind: z.enum(['read', 'write']),
      columns: z.array(z.string()).optional(),
      rows: z.array(z.record(z.string(), z.unknown())).optional(),
      rowCount: z.number().optional(),
      affected: z.number().optional(),
      dryRun: z.boolean().optional(),
      durationMs: z.number(),
    }),
  }),

  // Structured single-doc insert / update / delete (gated by allowWrite).
  dbMutate: req({
    input: z.object({
      mode: z.enum(['dev', 'prod']),
      collection: z.string(),
      action: z.enum(['insert', 'update', 'delete']),
      id: z.string().optional(),
      doc: z.record(z.string(), z.unknown()).optional(),
      allowWrite: z.boolean().optional(),
    }),
    output: z.object({
      ok: z.boolean(),
      _id: z.string(),
      affected: z.number().optional(),
    }),
  }),

  // Server / Deploy management (proxied to ugly.bot)
  deployStatus: req({
    input: z.object({}),
    output: z.object({
      versions: z.array(
        z.object({
          buildId: z.string(),
          state: z.string(),
          previewUrl: z.string(),
          deployedAt: z.string(),
          isProduction: z.boolean(),
          failReason: z.string().optional(),
        }),
      ),
      productionBuildId: z.string().nullable(),
      projectName: z.string().optional(),
    }),
  }),

  deployProd: req({
    input: z.object({ buildId: z.string() }),
    output: z.object({ productionUrl: z.string() }),
  }),

  deployPrune: req({
    input: z.object({}),
    output: z.object({ pruned: z.array(z.string()) }),
  }),

  deployDestroy: req({
    input: z.object({ buildId: z.string().optional() }),
    output: z.object({ destroyed: z.array(z.string()) }),
  }),

  deployTrigger: req({
    input: z.object({
      projectPath: z.string().optional(),
    }),
    output: z.object({ ok: z.boolean(), output: z.string() }),
  }),

  // Error log browsing (proxied to ugly.bot)
  errorLogGetSummary: req({
    input: z.object({}),
    output: z.object({
      aggregations: z.array(
        z.object({
          message: z.string(),
          count: z.number(),
          lastSeen: z.number(),
          latestErrorId: z.string(),
        }),
      ),
    }),
  }),

  errorLogGetList: req({
    input: z.object({
      limit: z.number().optional(),
      cursor: z.number().optional(),
    }),
    output: z.object({
      errors: z.array(
        z.object({
          id: z.string(),
          created: z.number(),
          userId: z.string().nullable(),
          source: z.string(),
          type: z.string(),
          level: z.string(),
          message: z.string(),
          stack: z.string().optional(),
          hash: z.string(),
          isExpected: z.boolean(),
        }),
      ),
      nextCursor: z.number().nullable(),
    }),
  }),

  // Submit feedback from the studio toolbar. Relays to ugly-app's
  // `recordFeedback` server-side (→ db.captureFeedback RPC), which is the
  // only path the prod data-proxy still allows on the `feedbackReport`
  // collection — the legacy `feedbackReportCreateNoAuth` on ugly.bot
  // returns 500 because it uses db.setDoc, which the proxy rejects
  // (see node_modules/ugly-app/dist/cli/feedbackSubmit.js for the
  // framework's own writeup of the switchover). The sidecar's
  // data-proxy connection stamps projectId='ugly-studio' and the
  // tunnel's devTunnelId from its JWT, so we keep central
  // ingestion + per-studio filtering without exposing tokens to the
  // browser.
  submitFeedback: req({
    input: z.object({
      type: z.enum(['bug', 'feature', 'design']),
      description: z.string().min(1).max(5000),
      url: z.string().optional(),
      page: z.string().optional(),
      query: z.record(z.string(), z.string()).optional(),
      userAgent: z.string().optional(),
      screenWidth: z.number().optional(),
      screenHeight: z.number().optional(),
      // Recent console logs from the studio shell. Stored in `context`
      // on the feedbackReport row so fix-feedback-studio can read them.
      logs: z
        .array(
          z.object({
            timestamp: z.number(),
            level: z.string(),
            message: z.string(),
          }),
        )
        .optional(),
      // Map of [data-id] -> bounding rect captured at submit time.
      elementMap: z.record(z.string(), z.unknown()).optional(),
      // Anything else the framework's getFeedbackContext() bag returns
      // (devTunnelId hints, studioSessionId for the active coding-agent
      // session, etc.). Merged into the row's `context` field.
      contextExtras: z.record(z.string(), z.unknown()).optional(),
    }),
    output: z.object({ ok: z.boolean() }),
  }),

  // ── Session issue report ─────────────────────────────────────────
  // Bundles the current coding-agent session's on-disk artifacts
  // (messages, telemetry, finish events, ai-proxy debug, electron
  // log tail, env fingerprint), redacts secrets, uploads the gzipped
  // tar to R2's temp bucket (7-day TTL), and emails a Claude-Code-
  // ready markdown report with the bundle URL to the studio
  // maintainer. No DB row written — email is the only sink.
  submitSessionIssueReport: req({
    input: z.object({
      projectPath: z.string().optional(),
      compositeId: z.string().min(1),
      description: z.string().min(1).max(5000),
      type: z.enum(['bug', 'feature', 'design']),
    }),
    output: z.object({
      ok: z.literal(true),
      reportId: z.string(),
    }),
  }),

  // Feedback (proxied to ugly.bot)
  feedbackList: req({
    input: z.object({
      limit: z.number().optional(),
      cursor: z.number().optional(),
    }),
    output: z.object({
      items: z.array(z.record(z.string(), z.unknown())),
      nextCursor: z.number().nullable(),
    }),
  }),

  feedbackResolve: req({
    input: z.object({
      feedbackReportId: z.string(),
      status: z.enum(['resolved', 'declined']),
      resolution: z.string(),
    }),
    output: z.object({}),
  }),

  feedbackDelete: req({
    input: z.object({ feedbackReportId: z.string() }),
    output: z.object({}),
  }),

  feedbackReply: req({
    input: z.object({ feedbackReportId: z.string(), reply: z.string() }),
    output: z.object({}),
  }),

  // Performance logs (proxied to ugly.bot)
  perfLogGetList: req({
    input: z.object({
      limit: z.number().optional(),
      cursor: z.number().optional(),
    }),
    output: z.object({
      items: z.array(z.record(z.string(), z.unknown())),
      nextCursor: z.number().nullable(),
    }),
  }),

  // Users (proxied to ugly.bot)
  userList: req({
    input: z.object({
      limit: z.number().optional(),
      search: z.string().optional(),
    }),
    output: z.object({
      users: z.array(
        z.object({
          userId: z.string(),
          name: z.string(),
          email: z.string().nullable(),
          avatar: z.string().nullable(),
          installedAt: z.string(),
        }),
      ),
    }),
  }),

  userDetail: req({
    input: z.object({ userId: z.string() }),
    output: z.object({
      user: z.object({
        userId: z.string(),
        name: z.string(),
        email: z.string().nullable(),
        avatar: z.string().nullable(),
        installedAt: z.string(),
      }),
      recentEvents: z.array(z.record(z.string(), z.unknown())),
      recentErrors: z.array(z.record(z.string(), z.unknown())),
      recentFeedback: z.array(z.record(z.string(), z.unknown())),
    }),
  }),

  userCounts: req({
    input: z.object({ granularity: z.enum(['days']), intervals: z.number() }),
    output: z.object({ counts: z.array(z.object({ count: z.number() })) }),
  }),

  // Events (proxied to ugly.bot)
  eventTopEvents: req({
    input: z.object({ limit: z.number().optional() }),
    output: z.object({
      events: z.array(z.object({ eventName: z.string(), count: z.number() })),
    }),
  }),

  eventList: req({
    input: z.object({
      limit: z.number().optional(),
      cursor: z.number().optional(),
    }),
    output: z.object({
      events: z.array(
        z.object({
          id: z.string(),
          eventName: z.string(),
          userId: z.string().nullable(),
          sessionId: z.string(),
          created: z.number(),
          properties: z.record(z.string(), z.unknown()),
        }),
      ),
    }),
  }),

  // Labs / Experiments (proxied to ugly.bot)
  experimentGetMetrics: req({
    input: z.object({ experimentId: z.string() }),
    output: z.record(z.string(), z.unknown()),
  }),

  // Studio context (tab awareness for MCP)
  updateActiveTab: req({
    input: z.object({
      tab: z.enum([
        'code',
        'preview',
        'specs',
        'dashboard',
        'database',
        'errors',
        'feedback',
        'perf',
        'users',
        'events',
        'labs',
        'server',
        'git',
        'tests',
        'settings',
      ]),
    }),
    output: z.object({ ok: z.boolean() }),
  }),

  getSessionLogs: req({
    input: z.object({
      // Filter to one coding-agent session's events:
      //   - undefined → no filter (studio-wide view)
      //   - string `ws_x:sess_y` → entries captured for that session
      //   - null → entries captured outside any session (legacy
      //            project-root preview)
      compositeId: z.string().nullable().optional(),
      since: z.number().optional(),
      limit: z.number().optional(),
    }),
    output: z.object({
      entries: z.array(
        z.object({
          id: z.number(),
          type: z.enum(['console', 'error', 'network']),
          data: z.record(z.string(), z.unknown()),
          timestamp: z.number(),
          compositeId: z.string().nullable(),
        }),
      ),
    }),
  }),

  getStudioState: req({
    input: z.object({}),
    output: z.object({
      activeTab: z.enum([
        'code',
        'preview',
        'specs',
        'dashboard',
        'database',
        'errors',
        'feedback',
        'perf',
        'users',
        'events',
        'labs',
        'server',
        'git',
        'tests',
        'workers',
        'settings',
      ]),
      logCount: z.number(),
    }),
  }),

  // ─── Workers panel ──────────────────────────────────────────────────────
  // Ugly-app projects only. Studio reads `worker-definitions.json` from the
  // project root for the manifest. Dev runs go to the local dev server via
  // POST /_workers/run; prod runs enqueue a row into the `scheduled`
  // collection via the data proxy.
  workersGetManifest: req({
    input: z.object({
      projectPath: z.string().optional(),
    }),
    output: z.object({
      available: z.boolean(),
      reason: z.string().optional(),
      workers: z.array(
        z.object({
          name: z.string(),
          description: z.string().optional(),
          schedule: z.string().optional(),
          timeout: z.number().optional(),
          inputSchema: z.unknown().optional(),
          defaultInput: z.unknown(),
        }),
      ),
    }),
  }),

  workersRun: req({
    input: z.object({
      name: z.string(),
      input: z.unknown(),
      mode: z.enum(['dev', 'prod']),
      projectPath: z.string().optional(),
    }),
    output: z.object({
      runId: z.string(),
      status: z.enum(['running', 'completed', 'failed', 'queued']),
      durationMs: z.number().optional(),
      error: z.string().nullable().optional(),
      result: z.unknown().optional(),
      logs: z.array(z.string()).optional(),
    }),
  }),

  workersListRuns: req({
    input: z.object({
      name: z.string().optional(),
      mode: z.enum(['dev', 'prod']),
      limit: z.number().optional(),
      projectPath: z.string().optional(),
    }),
    output: z.object({
      runs: z.array(
        z.object({
          runId: z.string(),
          name: z.string(),
          input: z.unknown(),
          startedAt: z.number(),
          finishedAt: z.number().nullable(),
          status: z.enum(['running', 'completed', 'failed', 'queued']),
          error: z.string().nullable(),
          durationMs: z.number().nullable(),
        }),
      ),
    }),
  }),

  workersGetRun: req({
    input: z.object({
      runId: z.string(),
      mode: z.enum(['dev', 'prod']),
      projectPath: z.string().optional(),
    }),
    output: z.object({
      run: z
        .object({
          runId: z.string(),
          name: z.string(),
          input: z.unknown(),
          startedAt: z.number(),
          finishedAt: z.number().nullable(),
          status: z.enum(['running', 'completed', 'failed', 'queued']),
          error: z.string().nullable(),
          result: z.unknown().nullable(),
          logs: z.array(z.string()),
        })
        .nullable(),
    }),
  }),

  // Subscription-backed coding-agent model catalog. Returns whatever
  // the server's `subscriptionModels()` produces (gated on on-disk
  // credentials per subscription: z.ai / Claude Code / Copilot /
  // Codex). Client renders these alongside the framework-catalog
  // `getCodingAgentModels()` result in ModelSelector. Single source
  // of truth so adding a new subscription model is a one-file edit.
  getCodingAgentSubscriptionModels: req({
    input: z.object({}),
    output: z.object({
      models: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          provider: z.string(),
          contextWindow: z.number(),
          speed: z.string(),
          vision: z.boolean(),
          reasoning: z.string(),
          smartness: z.number(),
          costPerM: z.number(),
          supportsCacheControl: z.boolean().optional(),
        }),
      ),
    }),
  }),

  // Generic Anthropic endpoint. Configured via env (`ANTHROPIC_BASE_URL` +
  // `ANTHROPIC_API_KEY` + optional `ANTHROPIC_MODEL`/`ANTHROPIC_MAX_TOKENS`)
  // or persisted to ~/.anthropic/credentials.json by `setAnthropicProvider`.
  // The coding-agent provider reads it on every request. Status never
  // returns the API key itself. Replaces the removed z.ai / Kimi / MiniMax /
  // DeepSeek-BYO key + usage endpoints (DeepSeek now routes via ugly.bot's
  // `deepseek_v4_*` ids).
  getAnthropicProviderStatus: req({
    input: z.object({}),
    output: z.object({
      source: z.enum(['env', 'file', 'none']),
      hasKey: z.boolean(),
      maxTokens: z.number(),
      baseUrl: z.string().optional(),
      model: z.string().optional(),
    }),
  }),

  // Writes the credentials file. Rejects (`ok: false`) when the endpoint is
  // managed by env vars (read-only).
  setAnthropicProvider: req({
    input: z.object({
      baseUrl: z.url().max(2048),
      apiKey: z.string().min(1).max(2048),
      model: z.string().max(256).optional(),
      maxTokens: z.number().int().positive().max(2_000_000).optional(),
    }),
    output: z.object({ ok: z.boolean(), error: z.string().optional() }),
  }),

  clearAnthropicProvider: req({
    input: z.object({}),
    output: z.object({ ok: z.boolean(), error: z.string().optional() }),
  }),

  // Per-project security-mode sandbox (phases 4-7 of the 2026-04-21
  // security-mode rework). Status is queried at project-open time;
  // initialize/teardown run privileged platform tooling under an OS
  // password prompt. The `supported` flag tells the UI whether the
  // current platform backend can actually do anything — false on
  // stubbed platforms (currently Linux + Windows); the UI should
  // hide the initialize button entirely in that case.
  getSandboxStatus: req({
    input: z.object({ projectId: z.string() }),
    output: z.object({
      supported: z.boolean(),
      initialized: z.boolean(),
      platform: z.enum(['macos', 'linux', 'windows', 'unsupported']),
      username: z.string().nullable(),
    }),
  }),

  initializeSandbox: req({
    input: z.object({ projectId: z.string(), projectDir: z.string() }),
    output: z.object({
      ok: z.boolean(),
      error: z.string().optional(),
    }),
  }),

  teardownSandbox: req({
    input: z.object({ projectId: z.string(), projectDir: z.string() }),
    output: z.object({
      ok: z.boolean(),
      error: z.string().optional(),
    }),
  }),

  // List every sandbox user the current platform knows about. Used by
  // the orphan-cleanup CLI to surface ugs-<id> users whose project
  // dir no longer exists. Returns just projectIds (the `ugs-` prefix
  // is stripped).
  listSandboxProjects: req({
    input: z.object({}),
    output: z.object({
      projectIds: z.array(z.string()),
      platform: z.enum(['macos', 'linux', 'windows', 'unsupported']),
    }),
  }),

  // ──────────────────────────────────────────────────────────────────
  // Interactive eval runner (studio/evals). Surfaces the offline eval
  // matrix as an in-Studio flow: pick a task → seed a session worktree
  // from the task fixture → watch the agent run in the live chat → click
  // Grade → render a scorecard. See the per-endpoint comments.
  // ──────────────────────────────────────────────────────────────────

  /**
   * Returns every loadable eval task suitable for the in-Studio runner.
   * SWE-bench Pro tasks (`tags` contains `swe-bench-pro`) are filtered
   * out — they require running the agent inside a Docker container so
   * its bash/python_exec calls hit the same env the grader uses, which
   * is incompatible with the in-process Studio coding-agent.
   */
  evalListTasks: req({
    input: z.object({}),
    output: z.object({
      tasks: z.array(
        z.object({
          name: z.string(),
          kind: z.enum(['bug-fix', 'feature', 'planning']),
          turns: z.array(z.string()),
          ticketPath: z.string().optional(),
          successCriteria: z.string(),
          hasFixture: z.boolean(),
          hasSetup: z.boolean(),
          hasChecker: z.boolean(),
          gates: z
            .array(
              z.object({
                name: z.string(),
                points: z.number(),
                kind: z.string(),
                description: z.string().optional(),
              }),
            )
            .optional(),
          tags: z.array(z.string()).optional(),
          /**
           * Heuristic difficulty 1-5 derived from budget + tags + turn
           * count. Used by the picker to sort easy → hard and to show
           * a star rating per row. 1 = smoke, 5 = boss-level / agentic.
           */
          difficulty: z.number().int().min(1).max(5),
          /**
           * One-line "why this test is interesting" blurb derived from
           * tags. Renders beneath the task name in the picker — gives
           * the user a reason to pick a specific eval rather than a
           * preview of the prompt body.
           */
          whyInteresting: z.string(),
        }),
      ),
      /**
       * Count of tasks excluded from the list (sbpro Docker-only).
       * Surfaced so the UI can show "12 SWE-bench Pro tasks hidden — run
       * via CLI" without re-fetching.
       */
      dockerOnlyHidden: z.number(),
    }),
  }),

  /**
   * Create a Studio coding-agent session bound to an eval task. Creates
   * the session via the normal path (worktree + provisioning), then
   * overlays the task's fixture into the worktree and runs the task's
   * `reproSetup` if any. Persists `{ taskName, currentTurnIndex: 0 }`
   * to the session's `eval.json` so the chat can drive the auto-fire
   * turn sequence and route grading later.
   */
  evalCreateSession: req({
    input: z.object({
      projectPath: z.string().optional(),
      taskName: z.string(),
      /** Mirror of `codingAgentChatCreate.taskId` — abort handle. */
      taskId: z.string().optional(),
    }),
    output: z.object({
      sessionId: z.string(),
      /**
       * The text the client should pre-fill into the chat textarea.
       * Equal to `task.turns[0]` when no ticket, or a ticket pointer
       * ("Read TICKET.md, then ...") when `task.ticketPath` is set.
       */
      firstTurnPrompt: z.string(),
    }),
  }),

  /**
   * From-scratch eval flow used by the ProjectOnboarding picker: there's
   * no project open yet, so this RPC carves a fresh tmpdir under
   * `~/.ugly-studio/eval-projects/<taskName>-<ts>/`, initializes it as
   * a git repo, and sets it as the open project. The session itself is
   * NOT created here — ProjectHome creates it once the user picks a
   * model and clicks Start, calling `evalSeedSession` to bind + seed
   * the resulting session.
   */
  evalCreateProject: req({
    input: z.object({
      taskName: z.string(),
      taskId: z.string().optional(),
    }),
    output: z.object({
      projectPath: z.string(),
      projectName: z.string(),
      firstTurnPrompt: z.string(),
    }),
  }),

  /**
   * Bind a freshly-created coding-agent session to an eval task: copy
   * the task fixture into the session's worktree, run reproSetup, and
   * persist `{ taskName, currentTurnIndex: 0 }` to `eval.json`. Called
   * by ProjectHome's Start handler right after `codingAgentChatCreate`
   * resolves, so the session inherits the user-picked model/reasoning.
   */
  evalSeedSession: req({
    input: z.object({
      projectPath: z.string().optional(),
      sessionId: z.string(),
      taskName: z.string(),
    }),
    output: z.object({
      ok: z.boolean(),
      firstTurnPrompt: z.string(),
    }),
  }),

  /**
   * Run the task's registered deterministic checker plus any LLM judge
   * gates against the session's current worktree state. The result is
   * persisted to the session's `eval.json` so the scorecard survives
   * app restart, and surfaced on the session snapshot via
   * `evalGradeResult` so the chat can render it on mount.
   */
  evalGradeSession: req({
    input: z.object({ sessionId: z.string(), taskName: z.string().optional() }),
    output: EvalGradeResultSchema,
  }),

  /**
   * Bump the session's `currentTurnIndex` after the chat has dispatched
   * a turn message. Stamps `runStartedAt` on the first turn so the
   * scorecard's wall-clock starts ticking from the user's Send, not
   * from session create (which includes pnpm install + worktree
   * provisioning). Idempotent — passing the same index twice is safe.
   */
  evalAdvanceTurn: req({
    input: z.object({
      sessionId: z.string(),
      nextTurnIndex: z.number().int().nonnegative(),
    }),
    output: z.object({ ok: z.boolean() }),
  }),

  /**
   * Fetch a single task's turn sequence for the chat's auto-fire path.
   * Lighter than `evalListTasks` for the common case of "I just need
   * turns[i+1] for this session's bound task".
   */
  evalGetTask: req({
    input: z.object({ taskName: z.string() }),
    output: z.object({
      name: z.string(),
      turns: z.array(z.string()),
      ticketPath: z.string().optional(),
    }),
  }),

  /**
   * Every prior eval run on this machine, sorted newest-first. Read
   * from the global ledger at `~/.ugly-studio/eval-history.json`,
   * which `evalCreateProjectAndSession` appends to and
   * `evalGradeSession` updates with the final score. The picker uses
   * this to surface prior runs under each task row so the user can
   * re-open a session, copy its id, or delete it.
   */
  evalListHistory: req({
    input: z.object({}),
    output: z.object({
      runs: z.array(
        z.object({
          taskName: z.string(),
          projectName: z.string(),
          projectPath: z.string(),
          sessionId: z.string(),
          createdAt: z.string(),
          gradedAt: z.string().optional(),
          score: z.number().optional(),
          scoreMax: z.number().optional(),
        }),
      ),
    }),
  }),

  /**
   * Hard-delete a prior eval run: removes the throwaway project
   * tmpdir at `~/.ugly-studio/eval-projects/<projectName>/` AND the
   * history-ledger entry. Used by the picker's per-run delete button.
   */
  evalDeleteRun: req({
    input: z.object({ projectName: z.string() }),
    output: z.object({ ok: z.boolean() }),
  }),

  // ---------------------------------------------------------------------------
  // Publish flow — drives the seven-step Studio publish state machine
  // (Neon → Cloudflare → Render-create → Synadia → ugly-proxy → GitHub
  // push → first deploy). All endpoints are project-scoped via `projectId`
  // (the `.uglyapp.projectId` of the target project). The orchestrator
  // lives at studio/server/publish/publish-orchestrator.ts; these
  // endpoints are the thin wire surface the PublishTab + SettingsPage
  // call into.
  //
  // Custom-domain support is intentionally OUT of scope for v1 — there
  // is no publishDomain* endpoint here. When domain support lands it
  // ships as a separate set of endpoints alongside these, not nested
  // inside them.
  // ---------------------------------------------------------------------------
  publishGetDeployTarget: req({
    input: z.object({ projectId: z.string() }),
    output: z.object({
      deployTarget: PublishDeployTargetSchema.nullable(),
    }),
  }),

  publishGetStatus: req({
    input: z.object({ projectId: z.string() }),
    output: z.object({
      state: PublishStateSchema.nullable(),
    }),
  }),

  publishStart: req({
    input: z.object({
      projectId: z.string(),
      // `domainSkipped` is hard-coded `true` by the UI today since
      // custom-domain support is out of scope. The field is here so
      // when domain support lands we can flip it to a discriminated
      // union without breaking the call shape.
      options: z.object({ domainSkipped: z.literal(true) }),
    }),
    output: z.object({ ok: z.boolean() }),
    rateLimit: { max: 10, window: 3600 },
  }),

  /**
   * Rotate a single captured secret + clear the matching slice of
   * publish-state. After this, the next publishStart re-prompts that
   * provider's capture step but reuses every other cached step.
   *
   * Replaces the all-or-nothing `publishResetSession` for the common
   * case of "my Neon token rotated" / "I want to point at a different
   * R2 bucket" / "I'm switching app domain" — without nuking the
   * Worker + DB connection that already work.
   */
  publishClearSecret: req({
    input: z.object({
      projectId: z.string(),
      provider: z.enum([
        'neon',
        'cloudflare',
        'cloudflare-r2',
        'app-domain',
        'registrar',
        'ugly-proxy',
        'workers',
      ]),
    }),
    output: z.object({ ok: z.boolean() }),
  }),

  publishCancel: req({
    input: z.object({ projectId: z.string() }),
    output: z.object({ ok: z.boolean() }),
  }),

  publishProvideManualPaste: req({
    input: z.object({
      projectId: z.string(),
      provider: z.enum([
        'neon',
        'cloudflare',
        'cloudflare-r2',
        'app-domain',
        'registrar',
        'godaddy-ns',
        'namecheap-ns',
      ]),
      value: z.string().min(1),
    }),
    output: z.object({ ok: z.boolean() }),
  }),

  publishResetSession: req({
    input: z.object({ projectId: z.string() }),
    output: z.object({ ok: z.boolean() }),
  }),
});

export const messages = defineMessages({});

export interface AppRegistry {
  requests: typeof requests;
  messages: typeof messages;
}
