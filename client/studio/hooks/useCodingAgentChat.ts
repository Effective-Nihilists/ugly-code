import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useAppOptional } from 'ugly-app/client';
import type { ReasoningEffort, SessionSnapshot } from '../shared/api';
import { SessionSnapshotSchema } from '../shared/api';
import { spliceMissingUserRows } from '../agent/messageBackfill';
import { parseCodebaseReadinessEvent } from '../agent/codebaseReadinessEvent';
import { ProjectScopeContext } from '../state/ProjectScopeContext';
import { onCustomMessage, getSessionModel, getSessionAxes, setSessionModel, patchSessionAxes } from './useSocket';
import {
  readServerConfig,
  writeServerConfig,
  completeConfig,
  axesToConfig,
  coerceModelMode,
  type AxisState,
} from '../agent/sessionConfigStore';
import type { SessionConfig, SessionConfigDefaults } from '../../../shared/sessionConfig';
import { subscribeEditorLspStatus } from '../agent/lsp/registry';

export interface ToolUse {
  id: string;
  name: string;
  input: string;
  result?: string;
  /**
   * Parsed tool_result metadata (e.g. BashResponseMetadata,
   * EditResponseMetadata, GrepResponseMetadata). Null when the tool
   * didn't emit any or the payload wasn't valid JSON.
   */
  metadata?: Record<string, unknown> | null;
  /**
   * 'running' — LLM is still streaming the tool call's args.
   * 'executing' — args fully emitted, tool is actually executing server-side (no tool_result yet).
   * 'done' / 'error' — tool_result has arrived.
   */
  status: 'running' | 'executing' | 'done' | 'error';
  /**
   * Partial output streamed from the server while the tool is
   * executing (bash, fetch, python_exec). Populated by `tool_progress`
   * events; replaced by the final `result` once the tool_result message
   * lands. Undefined for tools that don't stream.
   */
  liveOutput?: string;
  /**
   * Effective timeout (ms) for this tool call, surfaced by the
   * server on the first `tool_progress` meta event so the UI can
   * render a countdown. Undefined until the tool emits meta.
   */
  timeoutMs?: number;
  /**
   * Wall-clock `Date.now()` when the tool started, as reported by
   * the server on the meta event. Distinct from client-side
   * `startTime` (which tracks the tool-call handoff from the LLM);
   * this one is authoritative for the remaining-time calculation.
   */
  startedAt?: number;
  /**
   * For `delegate` and `delegate_parallel` calls: the in-progress
   * tree of child agent activity, keyed by child session id. The
   * order is the spawn order — the server stamps each spawn with a
   * monotonic `child_index` so concurrent children don't reshuffle
   * as their events arrive.
   */
  children?: SubagentChild[];
}

/**
 * One child session spawned by a `delegate` / `delegate_parallel`
 * tool call. The hook accumulates these from `subagent_event`
 * envelopes the server fans out.
 */
export interface SubagentChild {
  /** Server-side child session id (also the registry key). */
  sessionId: string;
  /** Stable monotonic order assigned at spawn. */
  index: number;
  /** Recursion depth — 1 for a direct child of the root, 2 for a child of a child. */
  depth: number;
  /** Tool calls the child has made so far. */
  toolUses: ToolUse[];
  /** Latest assistant text the child produced (final summary on close). */
  text: string;
  /** True until the child's underlying turn has finished. */
  isStreaming: boolean;
}

/**
 * Per-workspace coding-agent feature toggles. Read on mount and
 * mirrored from `getUserSettings`. Mutating one of these flips
 * the corresponding flag on disk; the new value takes effect the
 * next time a session is created. The toggles map 1:1 to the server
 * `CodingAgentSettings` interface.
 */
export interface CodingAgentFeatures {
  memory: boolean;
  multiAgent: { enabled: boolean };
  autoLint: boolean;
  checkpoints: boolean;
  specs: { enabled: boolean };
  systemSkills: { enabled: boolean };
  autoTsc: { enabled: boolean };
  codebaseIndex: boolean;
  /**
   * User-curated allowlist for `model: 'auto'` routing (Phase 1 of
   * the auto-mode tournament). Empty array means "no restriction".
   * UI lets the user pick which subscription tiers the auto router
   * is allowed to choose from.
   */
  autoAllowlist: string[];
  /**
   * Pure-judge mode (Phase 3). When on, the deterministic critique
   * pre-checks (unrun-test, sequential-paging, fabricated-audit)
   * surface as evidence to the LLM judge instead of firing critiques
   * on their own. Off by default.
   */
  pureJudgeMode: boolean;
  /**
   * Expensive parallel mode (Phase 2 / §4.10). When on, each user
   * turn fans out N branches across the autoAllowlist; comparator-
   * judge picks the winner; winner merges back. Costs ~3× a
   * baseline turn. Off by default — opt-in with a clear cost
   * banner. The eval harness uses this flag verbatim today; the
   * production session-level fan-out ships in increments.
   */
  expensiveParallel: boolean;
  temperatureOverride?: number;
}

const DEFAULT_FEATURES: CodingAgentFeatures = {
  memory: true,
  multiAgent: { enabled: true },
  autoLint: false,
  checkpoints: false,
  specs: { enabled: true },
  systemSkills: { enabled: true },
  autoTsc: { enabled: false },
  codebaseIndex: true,
  autoAllowlist: ['deepseek_v4_pro', 'deepseek_v4_flash', 'glm_5_1'],
  pureJudgeMode: false,
  expensiveParallel: false,
};

interface ServerCodingAgent {
  memory?: { read?: boolean; write?: boolean };
  multiAgent?: { enabled?: boolean };
  autoLint?: boolean;
  checkpoints?: boolean;
  specs?: { enabled?: boolean };
  systemSkills?: { enabled?: boolean };
  autoTsc?: { enabled?: boolean };
  codebaseIndex?: boolean;
  autoAllowlist?: string[];
  pureJudgeMode?: boolean;
  expensiveParallel?: boolean;
  temperatureOverride?: number;
}

/** Map a `getUserSettings` / `updateUserSettings` response onto the local feature state. */
function serverToFeatures(ca: ServerCodingAgent): CodingAgentFeatures {
  return {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    memory: ca.memory?.read !== false || ca.memory?.write !== false,
    multiAgent: { enabled: !!ca.multiAgent?.enabled },
    autoLint: !!ca.autoLint,
    checkpoints: !!ca.checkpoints,
    specs: { enabled: ca.specs?.enabled !== false },
    systemSkills: { enabled: ca.systemSkills?.enabled !== false },
    autoTsc: { enabled: !!ca.autoTsc?.enabled },
    codebaseIndex: ca.codebaseIndex !== false,
    autoAllowlist: Array.isArray(ca.autoAllowlist)
      ? ca.autoAllowlist
      : DEFAULT_FEATURES.autoAllowlist,
    pureJudgeMode: !!ca.pureJudgeMode,
    expensiveParallel: !!ca.expensiveParallel,
    ...(typeof ca.temperatureOverride === 'number'
      ? { temperatureOverride: ca.temperatureOverride }
      : {}),
  };
}

export interface CodingAgentSessionInfo {
  id: string;
  title?: string;
  /**
   * Server-composed dropdown label for the model axis. Set when the
   * session has been routed (auto resolved or manual pinned); empty/
   * absent on snapshots emitted before this field landed. Consumers
   * (the chat panel's model dropdown) render this verbatim.
   */
  modelDisplayLabel?: string;
  cost: number;
  /**
   * What the upstream billing system actually charged so far, when
   * different from our rate-card `cost`. Set by the Claude Code
   * runner from each turn's `result.total_cost_usd`. Surfaced as a
   * tooltip line on the cost chip so users see the gap between the
   * apples-to-apples estimate and what Anthropic actually billed.
   */
  billedCost?: number;
  promptTokens: number;
  completionTokens: number;
  /** Cache-hit input tokens (for the cost-estimate chip). 0 when the upstream doesn't break out cache usage. */
  cacheReadTokens: number;
  /** Cache-creation input tokens (for the cost-estimate chip). 0 when none. */
  cacheCreationTokens: number;
  /**
   * Per-model token + cost breakdown across the session, folded from
   * on-disk turn telemetry on the server. Populated for auto-mode
   * sessions (which span multiple models per session) so the readout
   * can surface a per-model breakdown instead of multiplying totals
   * by a single model's rate. Sorted by descending cost. Empty for
   * sessions with no recorded turns.
   */
  perModel: {
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    cost: number;
    turnCount: number;
  }[];
  /**
   * Sum of every max-mode peer's cost / tokens / per-model breakdown.
   * Set on max-mode parents only (the parent itself runs no LLM in
   * max-mode, so its own cost / promptTokens are 0); SessionReadout
   * folds these into the displayed totals so the chat header reflects
   * what the run actually spent. Absent on non-parent sessions and on
   * parents that have no peers.
   */
  peerTotals?: {
    cost: number;
    promptTokens: number;
    completionTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    perModel: {
      model: string;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
      cost: number;
      turnCount: number;
    }[];
    peerCount: number;
  };
  messageCount: number;
  createdAt?: number;
  updatedAt?: number;
  /**
   * Session's current working directory — the worktree path for
   * forked sessions, the project root otherwise. Used by chat-panel
   * renderers to display tool-call paths as relative-to-cwd
   * (`client/foo.tsx`) instead of absolute (`/Users/.../worktree/client/foo.tsx`).
   * Empty string when the snapshot hasn't reached the client yet.
   */
  cwd: string;
  /** Estimated tokens in the live history, as it would be sent on the next turn. */
  contextTokens?: number;
  /** Tokens we're willing to send before compacting (= contextWindow * BUDGET_FRACTION). */
  contextBudget?: number;
  /** Raw model context window, shown in the meter tooltip. */
  contextWindow?: number;
  /**
   * Spec id this session is bound to, once `spec_write` has run.
   * Undefined for fresh sessions that haven't authored a spec yet.
   * Piped through from `session.state.specId` on every `session`
   * event so the chat UI can surface per-session spec affordances
   * (e.g. the Build-from-spec button) without depending on the
   * global `activeSpec` state, which is only populated by the
   * Specs tab.
   */
  specId?: string;
  /**
   * When set, this session is a max-mode peer; the value is the
   * parent orchestrator's compositeId. Surfaces from the snapshot so
   * the chat panel can disable orchestrator-owned controls (prompt
   * input, model selector, reasoning chip) and show a "child of
   * <parent>" hint.
   */
  parentSessionId?: string;
  /**
   * Compositeid of the peer the picker selected at the end of this
   * session's most recent max-mode turn. Drives the green winner-
   * pill highlight in the chat header. Only set on parents that
   * ran max-mode at least once.
   */
  maxModeWinnerSessionId?: string;
  /**
   * Eval-mode binding when this session was created from the
   * interactive eval picker. Null for normal sessions. Drives the
   * auto-fire turn loop, the "Grade run" button, and the inline
   * scorecard render.
   */
  eval?: import('../shared/api').SessionEvalState | null;
}

/**
 * Snapshot of a single judge invocation as carried through to the UI.
 * Mirrors `JudgeCallPart['data']` on the server (types.ts) — duplicated
 * here so the client doesn't have to import server types directly.
 */
export interface JudgeCallSnapshot {
  kind: 'iter' | 'post_turn' | 'session_strategist';
  model: string;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  input: {
    systemPrompt?: string;
    memoryIn?: string;
    delta?: string;
    hypothesis?: string;
    userRequest?: string;
    extra?: Record<string, string>;
  };
  output: {
    verdict: 'continue' | 'intervene';
    intervention?: {
      kind: string;
      text: string;
      command?: string;
      files?: string[];
      target?: string;
      options?: string[];
    };
    memoryOut?: string;
    hypothesisCritique?: string;
    rawResponse?: string;
    error?: string;
  };
}

/**
 * Done entry snapshot — mirrors the server's `DoneStatePart.data`
 * shape (see studio/server/coding-agent/types.ts). Carried on
 * `ChatMessage.done` for `role === 'status'` rows so the chat panel
 * can render the inline `DoneCard` (changed-files summary, "Open in
 * git panel" + "Done — merge" actions, persisted finishOutcome).
 */
export interface DoneStateSnapshot {
  capturedAt: number;
  sessionCompositeId: string;
  worktree: {
    branch: string;
    parentBranch: string;
    worktreePath: string;
    changedCount: number;
    aheadCount: number | null;
    changedFiles: readonly {
      path: string;
      status: 'A' | 'M' | 'D' | 'R' | '?';
    }[];
  };
  finishOutcome?: {
    ok: boolean;
    squashSha?: string;
    message?: string;
    stages: readonly {
      name:
        | 'precheck_dirty_main'
        | 'merge_parent'
        | 'tsc'
        | 'lint'
        | 'tests'
        | 'merge_squash'
        | 'cleanup';
      state:
        | 'pending'
        | 'running'
        | 'passed'
        | 'failed'
        | 'skipped'
        | 'stopped';
      exitCode?: number;
      command?: string;
    }[];
  };
}

export interface ChatMessage {
  id: string;
  /**
   * `judge` and `status` are observability-only — both are persisted
   * and rendered inline (the user can scrub a judge's reasoning,
   * inspect a "Done" entry's worktree summary), but they NEVER feed
   * back into the agent's LLM context. The hard filter lives
   * server-side in historyToLlmMessages.
   */
  role: 'user' | 'assistant' | 'judge' | 'status';
  content: string;
  toolUses: ToolUse[];
  thinking?: string;
  isStreaming: boolean;
  /**
   * Set on `role === 'judge'` messages — full snapshot of the judge
   * call's input + output for inspection in the chat panel's JudgeCard.
   */
  judge?: JudgeCallSnapshot;
  /**
   * Set on `role === 'status'` messages carrying a `done_state` part —
   * the per-turn worktree-changes snapshot the chat panel renders as a
   * `DoneCard`. Includes the changed-file summary, sessionCompositeId
   * for git-panel deep-linking, and the persisted `finishOutcome` once
   * the user has run finish on this entry.
   */
  done?: DoneStateSnapshot;
  /**
   * For user messages with attached images: the inline thumbnails to
   * render above/below the text bubble. Base64 stays on the local
   * message only (and on the server's session.messages); the wire is
   * one-shot at send time.
   */
  attachments?: {
    mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
    base64: string;
    filename?: string;
  }[];
  /**
   * Model id that produced this assistant message, when known. Carried
   * from `AgentMessage.model` through to the UI so the chat pane can
   * render a subtle "ran on glm_5_1" badge next to the bubble. Omitted
   * for user messages and for assistant messages that predate the
   * per-message-model plumbing.
   */
  model?: string;
  /**
   * When set, this message originated in a max-mode peer session
   * (multiplexed onto the parent's bus via `peer_event`) — value is
   * the peer's modelId. The chat panel renders a small model badge
   * above the bubble so the user can tell whose voice they're seeing
   * in the interleaved transcript.
   */
  peerModelId?: string;
  /**
   * Server-stamped wall clock for the underlying `AgentMessage`. The
   * panel uses this to merge-sort parent + peer messages into one
   * chronological stream. Optional for legacy projections that
   * predate the field; merge-sort treats absent as `0` (oldest).
   */
  created_at?: number;
}

/**
 * LSP state surfaced from codingAgent's in-process typescript-language-server
 * instance. The hook aggregates `lsp_event` envelopes into a single status
 * object the panel can render as a compact indicator ("2 errors, 1 warning")
 * without needing to subscribe to events itself.
 */
export interface LspStatus {
  state: 'initializing' | 'ready' | 'error' | 'disabled' | 'closed' | 'idle';
  errors: number;
  warnings: number;
  lastUpdatedAt: number | null;
  lastMessage?: string;
}

/**
 * Most recent mid-turn-judge verdict. The server emits a structured
 * `reinforce_verdict` event whenever the judge runs — the chat UI
 * uses this to render a compact status chip so users can tell at a
 * glance whether the judge is nudging or terminating turns.
 */
export interface JudgeVerdict {
  kind: 'critique' | 'terminated' | 'replan_restart';
  text?: string;
  reason?: string;
  at: number;
}

export interface PermissionRequest {
  id: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  description: string;
  action: string;
  path: string;
  params: Record<string, unknown>;
}

export interface AskUserOption {
  label: string;
  description: string;
}

export interface PendingAskUser {
  id: string;
  sessionId: string;
  toolCallId: string;
  question: string;
  header?: string;
  options: AskUserOption[];
}

/**
 * Pending step-review gate (between SPEC/DIAGNOSE and the next step).
 * The chat panel renders an inline approve/iterate strip for each
 * entry; resolving via `codingAgentAnswerStepReview`.
 */
export interface PendingStepReview {
  id: string;
  sessionId: string;
  stepId: string;
  stepLabel: string;
  patternId: string;
  specId?: string;
  createdAt: number;
}

async function rawAgentApi(method: string, input: object): Promise<unknown> {
  // Phase 3b: the coding-agent RPCs route through the native transport shim
  // (window.UglyNative) instead of a sidecar `/api/*` fetch. The shim runs the
  // agent loop client-side for chatSend.
  const { nativeRequest } = await import('./useSocket');
  return nativeRequest(method, input);
}

/**
 * Hook-bound `agentApi` that auto-injects this subtree's `projectPath`
 * from `ProjectScopeContext` into every request body — mirroring what
 * `useSocket` does for socket requests. Required for multi-tab
 * correctness: without it, an HTTP RPC from tab-A while tab-B is the
 * global active project lands at the server with tab-B's cwd because
 * the request body had no `projectPath`. That caused the
 * sess_jos7kwr9mpteac0r "chat history was gone" symptom — the chat
 * panel for tab-A's session was silently fresh-created against tab-B's
 * project store (2026-05-31 post-mortem).
 *
 * Caller-supplied `projectPath` wins via spread order, matching
 * `useSocket`'s contract. `null` from the context = no injection
 * (preserves pre-multi-tab behavior for components above the
 * `ProjectScopeProvider`).
 */
function useScopedAgentApi(): typeof rawAgentApi {
  const projectPath = useContext(ProjectScopeContext);
  return useMemo(() => {
    if (projectPath === null) return rawAgentApi;
    return (method: string, input: object) => {
      const augmented = { projectPath, ...(input as Record<string, unknown>) };
      return rawAgentApi(method, augmented);
    };
  }, [projectPath]);
}

// CodingAgentMode + DEFAULT_MODE removed 2026-04-30. The legacy
// spec/edit/yolo axis is now collapsed into the binary
// `permissionMode` (normal/yolo) which is set at session create time
// and immutable thereafter. The server still ships the legacy `mode`
// field on SessionSnapshot — the client just stops reading it.

// Default main model for a fresh coding-agent session. A strong
// ugly.bot-routed framework model (no BYO key required). A user who
// previously picked a different model (incl. `'auto'`) keeps it via
// localStorage — only first-launch sessions land on this default.
const DEFAULT_MODEL = 'deepseek_v4_pro';

const BACKEND = {
  chatCreate: 'codingAgentChatCreate',
  chatSend: 'codingAgentChatSend',
  chatStop: 'codingAgentChatStop',
  chatClearMessages: 'codingAgentChatClearMessages',
  toolStop: 'codingAgentToolStop',
  chatSetModel: 'codingAgentChatSetModel',
  chatSetReasoningEffort: 'codingAgentSetReasoningEffort',
  chatListMessages: 'codingAgentChatListMessages',
  grantPermission: 'codingAgentGrantPermission',
  skipPermissions: 'codingAgentSkipPermissions',
  setPermissionMode: 'codingAgentSetPermissionMode',
  setModelMode: 'codingAgentSetModelMode',
  setPatternMode: 'codingAgentSetPatternMode',
  finish: 'finishCodingAgentSession',
  merge: 'mergeFinishedCodingAgentSession',
  finishStop: 'codingAgentFinishStop',
  abandon: 'abandonCodingAgentSession',
  archive: 'codingAgentArchiveSession',
  refreshWorktree: 'refreshCodingAgentSession',
  worktreeBehind: 'getCodingAgentWorktreeBehind',
  worktreeAhead: 'getCodingAgentWorktreeAhead',
  markSessionViewed: 'markSessionViewed',
  /**
   * Phase 1 of snapshot migration: pull the full session-state
   * snapshot. Called on mount + after any reconnect to get an
   * authoritative read of mode/model/reasoning/tokens/worktree etc.
   * without depending on having received the granular events.
   */
  getSnapshot: 'getCodingAgentSnapshot',
  // Listen-only attach to a session's live task stream (cross-device sync).
  chatAttach: 'codingAgentChatAttach',
  eventType: 'codingAgent:event',
  exitType: 'codingAgent:exit',
} as const;

const WINDOW_MAX = 100;
const PAGE_SIZE = 20;

/**
 * Pure converter from a raw AgentMessage (as returned by
 * `chatListMessages`) into a `ChatMessage` for the rendering layer.
 * Used by the page loaders (older / newer / jumpToTail) to replace
 * the visible window without going through the streaming-merge
 * branches in `processAssistantMessage`. Returns null for messages
 * the chat doesn't render (e.g. role === 'system', or tool messages
 * which are folded into prior assistant messages by the streaming
 * path and aren't rendered standalone).
 */
interface RawMessagePart {
  type: string;
  data?: unknown;
}
export interface RawAgentMessage {
  id: string;
  role: string;
  parts?: RawMessagePart[];
  created_at?: number;
  /** Model id stamped on assistant messages, when known. */
  model?: string;
}

/**
 * Shape of the `data` blob on a raw message part. Every field is
 * optional because the wire is untyped (the host's coding.js task can
 * lag the SPA build); consumers read defensively and fall back to
 * defaults. One typed cast (`partData()` / `as MessagePartData`) at the
 * boundary lets the rest of the processing functions stay type-safe.
 */
interface MessagePartData {
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: string;
  finished?: boolean;
  /** Persisted tool start (wall-clock ms) so a running tool's timer survives reload. */
  started_at?: number;
  tool_call_id?: string;
  content?: string;
  is_error?: boolean;
  metadata?: unknown;
}

/** A raw wire message with typed parts (parts carry `MessagePartData`). */
interface WireMessage {
  id: string;
  role: string;
  model?: string;
  parts?: { type: string; data?: MessagePartData }[];
  created_at?: number;
}

/**
 * Envelope of a single agent event as it arrives inside
 * `msg.event`. `payload` is deliberately loose — each event `type`
 * carries a different payload shape, narrowed per-branch below.
 */
interface AgentEventEnvelope {
  type?: string;
  payload?: AgentEventPayload;
  /** error/stderr events carry text on the envelope itself. */
  text?: string;
  message?: string;
}

/**
 * Nested `payload` on an `AgentEventEnvelope`. The double-`payload`
 * nesting mirrors the server's event bus wrapping (outer = sub-type,
 * inner = the actual body). Every field optional — narrowed per branch.
 */
interface AgentEventPayload {
  type?: string;
  payload?: unknown;
}

/**
 * Inner event envelope carried on a `subagent_event`. Its
 * `payload.payload` is either a raw message (`role` + `parts`) for a
 * 'message' event, or an agent-event body (`type`) for 'agent_event'.
 * Both shapes are covered loosely and narrowed per branch below.
 */
interface ChildEvent {
  type?: string;
  payload?: {
    type?: string;
    payload?: {
      role?: string;
      parts?: { type: string; data?: MessagePartData }[];
      type?: string;
    };
  };
}

/** Response shape of `chatListMessages`. */
interface ListMessagesResponse {
  messages?: RawAgentMessage[];
  hasMore?: boolean;
}

/** Response shape of `chatCreate` (fresh create or resume). */
interface ChatCreateResponse {
  sessionId: string;
  specId?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
}

/**
 * Tagged peer message captured from a `peer_event` envelope. CodingAgentChat
 * uses these to render the "All" pill view (interleaved chronologically with
 * parent messages, each row badged with the peer's modelId).
 */
export interface PeerMessage {
  peerModelId: string;
  message: RawAgentMessage;
}

/**
 * Latest live `tool_progress` chunk from one peer. Demuxed off
 * `peer_event` envelopes whose `original.type === 'tool_progress'`.
 * The "All" pill view renders this as a small live chip beside the
 * peer's badge so the user sees what each peer is currently doing
 * (e.g. bash output streaming) without waiting for the final
 * tool_result.
 */
export interface PeerToolProgress {
  toolCallId: string;
  /** 'stdout' | 'stderr' | 'meta' (meta carries timing only). */
  stream: 'stdout' | 'stderr' | 'meta';
  text: string;
  /** Server-side wall clock when the chunk landed; drives staleness. */
  updatedAt: number;
}

/**
 * Per-peer LSP rollup. `lsp_event`s arrive frequently while a peer
 * edits — we only keep the latest counts so the banner can render a
 * compact red/yellow chip ("kimi: 3 ts errors").
 */
export interface PeerLspState {
  totalErrors: number;
  totalWarnings: number;
  /** Last file the LSP reported diagnostics for. */
  lastFile?: string;
  updatedAt: number;
}

function agentMessageToChatMessage(
  message: RawAgentMessage,
): ChatMessage | null {
  const parts = message.parts ?? [];
  const partData = (p: RawMessagePart): Record<string, unknown> =>
    (p.data ?? {}) as Record<string, unknown>;
  const ts =
    typeof message.created_at === 'number' && message.created_at > 0
      ? { created_at: message.created_at }
      : {};
  if (message.role === 'user') {
    let text = '';
    for (const p of parts) {
      if (p.type === 'text')
        text += (partData(p).text as string | undefined) ?? '';
    }
    if (!text) return null;
    return {
      id: message.id,
      role: 'user',
      content: text,
      toolUses: [],
      isStreaming: false,
      ...ts,
    };
  }
  if (message.role === 'assistant') {
    let textContent = '';
    let thinkingContent = '';
    const toolUses: ToolUse[] = [];
    let isFinished = false;
    for (const part of parts) {
      const d = partData(part);
      switch (part.type) {
        case 'text':
          textContent += (d.text as string | undefined) ?? '';
          break;
        case 'reasoning':
          thinkingContent += (d.thinking as string | undefined) ?? '';
          break;
        case 'tool_call':
          toolUses.push({
            id:
              (d.id as string | undefined) ??
              Math.random().toString(36).slice(2),
            name: (d.name as string | undefined) ?? 'tool',
            input: (d.input as string | undefined) ?? '',
            status: d.finished ? 'executing' : 'running',
            // Persisted start time (see clientAgent onTurn) so a running tool's
            // duration timer survives reload instead of resetting to zero.
            ...(typeof d.started_at === 'number' ? { startedAt: d.started_at } : {}),
          });
          break;
        case 'finish':
          isFinished = true;
          break;
      }
    }
    return {
      id: message.id,
      role: 'assistant',
      content: textContent,
      toolUses,
      ...(thinkingContent ? { thinking: thinkingContent } : {}),
      isStreaming: !isFinished,
      ...ts,
    };
  }
  if (message.role === 'judge') {
    const judgePart = parts.find((p) => p.type === 'judge_call');
    if (!judgePart?.data) return null;
    const snap = judgePart.data as JudgeCallSnapshot;
    const summaryLine = `${snap.kind} · ${snap.model} · ${snap.output.verdict}${
      snap.output.intervention ? `/${snap.output.intervention.kind}` : ''
    }`;
    return {
      id: message.id,
      role: 'judge',
      content: summaryLine,
      toolUses: [],
      isStreaming: false,
      judge: snap,
      ...ts,
    };
  }
  if (message.role === 'status') {
    const donePart = parts.find((p) => p.type === 'done_state');
    if (!donePart?.data) return null;
    const snap = donePart.data as DoneStateSnapshot;
    const wt = snap.worktree;
    const summary =
      `${wt.changedCount} file${wt.changedCount === 1 ? '' : 's'} changed` +
      (wt.aheadCount && wt.aheadCount > 0
        ? ` · ${wt.aheadCount} commit${
            wt.aheadCount === 1 ? '' : 's'
          } ahead of ${wt.parentBranch}`
        : '');
    return {
      id: message.id,
      role: 'status',
      content: summary,
      toolUses: [],
      isStreaming: false,
      done: snap,
      ...ts,
    };
  }
  return null;
}

/**
 * Display-cap that mirrors the live `processToolMessage` truncation —
 * keeps hydrated results from blowing up the DOM on huge outputs.
 */
const TOOL_RESULT_DISPLAY_CAP = 4000;

/**
 * Walk a list of raw `AgentMessage`s and fold every `tool_result` part
 * into the matching ToolUse on the prior assistant ChatMessage. Mirrors
 * the live `processToolMessage` reducer (line ~1551) so a session that
 * was just opened from disk renders identically to one whose updates
 * arrived as live `tool_result` events.
 *
 * Without this step the page-loader path leaves every ToolUse stuck on
 * `status: 'executing'` with no `result` or `metadata`, so the chat
 * panel renders post-restart sessions with all tool calls "running"
 * forever and judge cards next to invisible tool output. See the
 * regression covered by `studio/tests/coding-agent/restart-state-parity.test.ts`.
 */
function mergeToolResultsIntoChatMessages(
  projected: ChatMessage[],
  raw: RawAgentMessage[],
): ChatMessage[] {
  // Build an id → result map from the raw stream. Latest-wins (matches
  // session-store reverse-pager reconciliation by message id).
  const results = new Map<
    string,
    {
      result: string;
      metadata: Record<string, unknown> | null;
      status: 'done' | 'error';
    }
  >();
  for (const m of raw) {
    if (m.role !== 'tool') continue;
    for (const p of m.parts ?? []) {
      if (p.type !== 'tool_result') continue;
      const d = (p.data ?? {}) as {
        tool_call_id?: string;
        content?: string;
        is_error?: boolean;
        metadata?: unknown;
      };
      const tcid = d.tool_call_id;
      if (!tcid) continue;
      const content = d.content ?? '';
      let metadata: Record<string, unknown> | null = null;
      const metaRaw = d.metadata;
      if (typeof metaRaw === 'string' && metaRaw.length > 0) {
        try {
          metadata = JSON.parse(metaRaw) as Record<string, unknown>;
        } catch {
          /* ignore */
        }
      } else if (metaRaw && typeof metaRaw === 'object') {
        metadata = metaRaw as Record<string, unknown>;
      }
      const display =
        content.length > TOOL_RESULT_DISPLAY_CAP
          ? content.slice(0, TOOL_RESULT_DISPLAY_CAP) + '\n... (truncated)'
          : content;
      results.set(tcid, {
        result: display,
        metadata,
        status: d.is_error ? 'error' : 'done',
      });
    }
  }
  if (results.size === 0) return projected;
  return projected.map((cm) => {
    if (cm.role !== 'assistant') return cm;
    if (cm.toolUses.length === 0) return cm;
    let touched = false;
    const nextTools = cm.toolUses.map((tu) => {
      const r = results.get(tu.id);
      if (!r) return tu;
      touched = true;
      return {
        ...tu,
        result: r.result,
        metadata: r.metadata,
        status: r.status,
      };
    });
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `touched` is mutated inside the .map callback above; TS control-flow can't see the closure write and narrows it to always-false.
    return touched ? { ...cm, toolUses: nextTools } : cm;
  });
}

/**
 * One-shot page projection used by the chat panel's hydration paths.
 * Equivalent to the inline pattern (`map → filter null` plus a tool-
 * result merge) that `loadOlderMessages`, `loadNewerMessages`, and
 * `jumpToTail` all want.
 */
export function projectAgentMessagesToChat(
  raw: RawAgentMessage[],
): ChatMessage[] {
  const projected: ChatMessage[] = [];
  for (const r of raw) {
    const cm = agentMessageToChatMessage(r);
    if (cm) projected.push(cm);
  }
  return mergeToolResultsIntoChatMessages(projected, raw);
}

export interface SessionWorktreeBinding {
  path: string;
  branch: string;
  parentBranch: string;
  parentSha: string;
  mainRepo: string;
  createdAt: number;
}

export type FinishStageState =
  | 'pending'
  | 'running'
  | 'passed'
  | 'failed'
  | 'skipped'
  | 'stopped';

export interface FinishStageInfo {
  name:
    | 'precheck_dirty_main'
    | 'merge_parent'
    | 'tsc'
    | 'lint'
    | 'tests'
    | 'merge_squash'
    | 'cleanup';
  state: FinishStageState;
  command?: string;
  output: string;
  exitCode?: number;
  message?: string;
}

export interface AwaitingReviewInfo {
  proposedCommitMessage: string;
  parentBranch: string;
  sessionBranch: string;
  worktreePath: string;
}

export interface FinishPipelineState {
  running: boolean;
  done: boolean;
  ok: boolean;
  stages: FinishStageInfo[];
  conflicts?: string[];
  conflictStage?: 'merge_parent' | 'merge_squash';
  squashSha?: string;
  message?: string;
  /**
   * Set when the server pipeline pauses after validation gates. The
   * chat UI uses this to render the review modal that gates the
   * squash-merge to parent.
   */
  awaitingReview?: AwaitingReviewInfo;
}

const EMPTY_FINISH: FinishPipelineState = {
  running: false,
  done: false,
  ok: false,
  stages: [],
};

export interface UseCodingAgentChatOptions {
  /**
   * Composite "{workspaceId}:{sessionId}" of an existing agent session.
   * When supplied, the hook re-attaches to that session on mount and
   * backfills the message list from the server-side store.
   */
  initialSessionId?: string;
  initialModel?: string;
  /**
   * When set, creates (or resumes) this session as bound to the given
   * spec. The server injects a spec-context block in the system prompt
   * every turn and removes `spec_create` from the tool catalog.
   */
  specId?: string;
  /**
   * Fired whenever the hook obtains a server-side session ID — both for
   * brand-new sessions and after a successful resume. The parent persists
   * this so the same session can be restored across IDE restarts.
   */
  onSessionCreated?: (sessionId: string) => void;
  /**
   * Fired whenever the user picks a new model from the in-panel selector.
   * The parent persists this on the AgentTabState so the next launch
   * starts the tab with the same model.
   */
  onModelChanged?: (model: string) => void;
  /**
   * Fired whenever the server updates the session title (derived from
   * the first user message). The parent persists this as the tab label.
   */
  onTitleChanged?: (title: string) => void;
  /**
   * Fired when a resume attempt fails because the server can find no
   * open project that owns the supplied `initialSessionId`. The parent
   * (Editor) drops the offending agent tab so the user lands on the
   * new-session hero instead of staring at a permanent error — the
   * usual cause is the owning project folder being deleted out from
   * under the persisted layout (sess_nqn8v8mympu58yvf, 2026-05-31).
   * Receives the missing compositeId so the parent can locate the
   * exact tab to remove.
   */
  onResumeMissing?: (sessionId: string) => void;
}

export function useCodingAgentChat(opts: UseCodingAgentChatOptions = {}) {
  const {
    initialSessionId,
    initialModel,
    specId,
    onSessionCreated,
    onModelChanged,
    onTitleChanged,
    onResumeMissing,
  } = opts;
  const backend = BACKEND;
  // Shadow the module-level rawAgentApi with a hook-bound version that
  // injects `projectPath` from `ProjectScopeContext`. See
  // `useScopedAgentApi` docstring for why — without this, multi-tab
  // chat panels race the global active project and silently target the
  // wrong project's session store.
  const agentApi = useScopedAgentApi();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // Per-peer message buffer populated by `peer_event`s — only present
  // when the parent session is mid-turn in cross-pollinated max-mode.
  // Each entry tags a raw `AgentMessage` from a peer with the peer's
  // model id; CodingAgentChat interleaves these into the "All" pill
  // view so the user can watch every peer's chat in one stream.
  // Reset on `sessionId` change (peers belong to one parent).
  const [peerMessages, setPeerMessages] = useState<PeerMessage[]>([]);
  // Latest live tool_progress chunk per peer modelId. Lets the banner
  // surface what each peer is currently doing inside a long-running
  // tool (e.g. bash stdout) before the final tool_result lands.
  const [peerToolProgress, setPeerToolProgress] = useState<
    Record<string, PeerToolProgress>
  >({});
  // Per-peer LSP rollup so the banner can render a compact diagnostic
  // chip when a peer's edits introduce ts/lint errors.
  const [peerLspState, setPeerLspState] = useState<
    Record<string, PeerLspState>
  >({});
  // Per-peer "stuck" watchdog state. Populated from `peer_stuck`
  // events the runner fires when a peer goes >120s with no events
  // (provider hang, rate-limit cascade, parser failure). Cleared
  // when the peer fires any other peer_event after recovery. The
  // chat panel renders an amber chip on that peer's pill.
  const [peerStuckState, setPeerStuckState] = useState<
    Record<string, { stuckMs: number; updatedAt: number }>
  >({});
  // Mirror peerStuckState onto a ref so the websocket event handler
  // (which runs outside React's render scope) can read the latest
  // value without re-subscribing on every state change.
  const peerStuckStateRef = useRef(peerStuckState);
  peerStuckStateRef.current = peerStuckState;
  const [hasMoreOlder, setHasMoreOlder] = useState(false);
  const [hasMoreNewer, setHasMoreNewer] = useState(false);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const [isLoadingNewer, setIsLoadingNewer] = useState(false);
  // Streaming events apply to messages state only when the visible
  // window covers the live tail (hasMoreNewer === false). When the
  // user has paged backwards, ignore live message/tool events — the
  // server has them durably; jumpToTail re-fetches when the user
  // returns to the bottom.
  const tailFollowingRef = useRef(true);
  useEffect(() => {
    tailFollowingRef.current = !hasMoreNewer;
  }, [hasMoreNewer]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);

  // Auto-mark-viewed on running→done while the user is still watching
  // this session. Without this, a turn finishing while the user has
  // the chat panel focused would briefly flip `lastViewedAt <
  // updated_at`, lighting up the top-bar tab dot for a session the
  // user is literally already looking at (and firing the
  // notification sound). Gated on `document.hasFocus()` so a
  // background-window finish DOES still surface the indicator/sound
  // — the user genuinely needs the alert.
  const prevIsStreamingRef = useRef(false);
  useEffect(() => {
    const wasStreaming = prevIsStreamingRef.current;
    prevIsStreamingRef.current = isStreaming;
    if (!wasStreaming || isStreaming) return;
    if (!sessionId) return;
    if (typeof document !== 'undefined' && !document.hasFocus()) return;
    void agentApi(BACKEND.markSessionViewed, { compositeId: sessionId }).catch(
      () => undefined,
    );
  }, [isStreaming, sessionId]);
  // Model + reasoning effort are now per-session: the server
  // persists them on the StoredSession and returns them in the
  // chatCreate response, which seeds these states. The initial
  // values here are placeholders that show until the response lands
  // — `initialModel` (when the parent passes one) takes precedence
  // for the typed pre-render value; otherwise we use the bench
  // default. Project Home owns the global "what model should NEW
  // sessions start with" setting and passes it explicitly to the
  // first chatCreate; subsequent in-session swaps stay local.
  // Restore the per-session axes the user last picked (persisted in localStorage by
  // useSocket) so a RELOAD shows them instead of the global defaults. The worker no
  // longer echoes these back into the header (that caused the session to appear to
  // switch its own model/plan/reasoning), so this mount state IS the UI source of
  // truth until the user changes an axis. Model + reasoning are also confirmed by the
  // chatCreate response below; the others are client-only.
  const seededAxes = initialSessionId ? getSessionAxes(initialSessionId) : {};
  const seededModel = initialSessionId ? getSessionModel(initialSessionId) : null;
  const [model, setModel] = useState<string>(
    () => seededModel ?? initialModel ?? DEFAULT_MODEL,
  );
  // A ref mirror of `model` so synchronous callers (handleHeroSubmit → setModelMode
  // → sendMessage → startNewChat, all in one tick before re-render) read the
  // just-picked model instead of the stale closure value.
  const modelRef = useRef(model);
  useEffect(() => { modelRef.current = model; }, [model]);
  // Default to max thinking for fresh sessions — matches the server
  // env default in `readReasoningEffortEnv()` and ensures the studio
  // requests the heaviest reasoning the provider exposes. Users opt
  // down in the UI when they need latency back. Resumed sessions
  // overwrite this from disk via the chatCreate response.
  const [reasoningEffort, setReasoningEffortState] =
    useState<ReasoningEffort>(() => (seededAxes.reasoningEffort as ReasoningEffort | undefined) ?? 'max');
  // Ref mirror so a same-tick hero pre-pick (handleHeroSubmit → switchReasoningEffort
  // → sendMessage → startNewChat, before any re-render) reaches chatCreate instead of
  // the stale closure default. Mirrors the `modelRef` pattern below.
  const reasoningEffortRef = useRef(reasoningEffort);
  useEffect(() => {
    reasoningEffortRef.current = reasoningEffort;
  }, [reasoningEffort]);
  // Branch mode mirror (same pattern — synchronous so startNewChat reads the hero's pick).
  const branchModeRef = useRef<'worktree' | 'main'>('worktree');
  const setBranchMode = useCallback((next: 'worktree' | 'main') => {
    branchModeRef.current = next;
  }, []);
  const [pendingSkill, setPendingSkill] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingPermissions, setPendingPermissions] = useState<
    PermissionRequest[]
  >([]);
  const [pendingAskUsers, setPendingAskUsers] = useState<PendingAskUser[]>([]);
  const [pendingStepReviews, setPendingStepReviews] = useState<
    PendingStepReview[]
  >([]);
  // Activity tracking — answers "is the agent slow or stuck?" The spinner
  // alone can't distinguish a 30-second tool call from an infinite MCP loop.
  // streamStartedAt: clock starts when isStreaming flips on. lastEventAt:
  // most recent agent event timestamp; long gaps mean the agent has gone
  // silent. The 1Hz tick that animates the elapsed/step labels lives in
  // the leaf label component now — keeping it here re-rendered the whole
  // panel tree once a second.
  const [streamStartedAt, setStreamStartedAt] = useState<number | null>(null);
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);
  // codingAgent runs in-process; healthy is implicitly true while the sidecar is up.
  const serverHealthy = true;
  const [sessionInfo, setSessionInfo] = useState<CodingAgentSessionInfo | null>(
    null,
  );
  // Worktree binding surfaced by the server. Null until the first
  // worktree_event for this session lands (create or refresh). When
  // null AND sessionId is set, the session is running against the
  // main project tree (spec mode / provisioning failure / pre-worktree
  // resumed session).
  const [worktree, setWorktree] = useState<SessionWorktreeBinding | null>(null);
  // True when a resume-time merge-from-parent produced conflicts that
  // must be resolved before new messages can be sent. Cleared on
  // `refresh_resolved` / `refreshed` / `removed`.
  const [worktreeBlocked, setWorktreeBlocked] = useState(false);
  // Last-seen worktree status message (failure reason, conflict list,
  // 'lost' / 'unavailable' banner text). Consumed by the chat header.
  const [worktreeStatus, setWorktreeStatus] = useState<{
    kind:
      | 'created'
      | 'reattached'
      | 'refreshed'
      | 'refresh_conflict'
      | 'refresh_failed'
      | 'lost'
      | 'unavailable'
      | 'removed';
    message?: string;
    conflicts?: string[];
  } | null>(null);
  // Latest read-only probe of whether the worktree is behind its
  // parent branch. Drives the disable state of the "Pull from parent"
  // button. Null = not yet checked (button stays enabled until first
  // probe lands so the click degrades gracefully to a noop).
  const [worktreeBehind, setWorktreeBehind] = useState<
    'up_to_date' | 'behind' | 'in_progress_merge' | 'unknown' | null
  >(null);
  // Latest read-only probe of how many commits the worktree is AHEAD
  // of its parent. Drives the chat panel's Done button visibility —
  // a session can have a clean working tree (every change committed
  // by the agent) but still have unmerged commits sitting on its
  // branch (e.g. the previous Done aborted at squash-merge because
  // main was dirty). `null` = not yet probed; -1 = probe failed
  // (treat as unknown — leave Done visible). Both states are merged
  // with `gitStatus`'s changed-files count downstream.
  const [worktreeAheadCount, setWorktreeAheadCount] = useState<number | null>(
    null,
  );
  // Finish pipeline progress. Reset when the pipeline kicks off; ongoing
  // events append to stages and update state/output. Consumed by the
  // chat panel to render inline progress cards.
  const [finishPipeline, setFinishPipeline] =
    useState<FinishPipelineState>(EMPTY_FINISH);
  const [lspStatus, setLspStatus] = useState<LspStatus>({
    state: 'idle',
    errors: 0,
    warnings: 0,
    lastUpdatedAt: null,
  });
  // The editor language server (registry-owned, spawned on the first
  // go-to-definition/hover) drives this indicator now — the old agent-side
  // diagnostics client was removed with the coding backend. Reflect its
  // lifecycle + error/warning totals on the chat header.
  useEffect(() => {
    return subscribeEditorLspStatus((s) => {
      setLspStatus({
        state: s.state,
        errors: s.errors,
        warnings: s.warnings,
        lastUpdatedAt: s.lastUpdatedAt,
        ...(s.lastMessage !== undefined ? { lastMessage: s.lastMessage } : {}),
      });
    });
  }, []);
  // Codebase-analysis readiness pushed via `session_state`. Updated
  // whenever the server's IndexerWatcher / ArchitectureManager emits
  // a state change, so the chat strip is always live without polling.
  const [codebaseReadiness, setCodebaseReadiness] = useState<
    SessionSnapshot['codebaseReadiness'] | null
  >(null);
  // Three-axis state surfaced to the chat header. The strict types come
  // from the SessionSnapshot zod schema in shared/api.ts. State setters
  // get the *State suffix because the public callbacks (setPermissionMode
  // etc., defined as useCallback below) wrap them with server RPC calls.
  const [permissionMode, setPermissionModeState] =
    useState<SessionSnapshot['permissionMode']>(
      () => (seededAxes.permissionMode as SessionSnapshot['permissionMode'] | undefined) ?? 'edit',
    );
  const [modelMode, setModelModeState] = useState<SessionSnapshot['modelMode']>(
    () => (seededAxes.modelMode as SessionSnapshot['modelMode'] | undefined) ?? { kind: 'auto' },
  );
  const [patternMode, setPatternModeState] =
    useState<SessionSnapshot['patternMode']>(
      () => (seededAxes.patternMode as SessionSnapshot['patternMode'] | undefined) ?? 'auto',
    );
  // Ref mirrors of the three axes so a same-tick new-session hero pre-pick reaches
  // `chatCreate` (see reasoningEffortRef / modelRef). The setters below write these
  // synchronously; `startNewChat` reads `.current` so it never sends a stale default.
  const permissionModeRef = useRef(permissionMode);
  const modelModeRef = useRef(modelMode);
  const patternModeRef = useRef(patternMode);
  useEffect(() => {
    permissionModeRef.current = permissionMode;
  }, [permissionMode]);
  useEffect(() => {
    modelModeRef.current = modelMode;
  }, [modelMode]);
  useEffect(() => {
    patternModeRef.current = patternMode;
  }, [patternMode]);
  // One-shot tracking sentinel: the axes we asked `chatCreate` to seed for a fresh
  // session, checked against that session's FIRST snapshot. If the snapshot doesn't
  // echo them, a downstream drop (create-schema strip, handler default, or snapshot
  // clobber) silently ignored the user's new-session picks — the exact class of bug
  // reported. `console.error` → errorLog (source='browser'), queryable per user.
  // Cleared after the first matching snapshot so steady-state changes never log.
  const intendedCreateAxesRef = useRef<{
    id: string;
    permissionMode: SessionSnapshot['permissionMode'];
    modelMode: SessionSnapshot['modelMode'];
    patternMode: SessionSnapshot['patternMode'];
    reasoningEffort: ReasoningEffort;
    branchMode: "worktree" | "main";
  } | null>(null);
  const [resolvedPattern, setResolvedPattern] =
    useState<SessionSnapshot['resolvedPattern']>(null);
  const [currentStepId, setCurrentStepId] =
    useState<SessionSnapshot['currentStepId']>(null);
  const [currentStepIter, setCurrentStepIter] = useState<number>(0);
  const [currentStepFinished, setCurrentStepFinished] =
    useState<boolean>(false);
  // Tracks the most recent mid-turn-judge verdict emitted by the
  // server via `agent_event: reinforce_verdict`. Lets the chat panel
  // render a compact "judge" chip so users can see whether the judge
  // critiqued or terminated a turn at a glance, even when the judge
  // decided to let the turn through without injecting a nudge.
  const [lastJudgeVerdict, setLastJudgeVerdict] = useState<JudgeVerdict | null>(
    null,
  );
  /**
   * Latest auto-mode routing snapshot emitted by the server via
   * `agent_event: auto_mode_routing` (Phase 0.5 of the auto-mode
   * tournament). The chat header renders the `reason` line so users
   * can see WHY the router picked a given model, instead of just
   * seeing a model id appear and changing without explanation.
   * Cleared on each new user turn (the next turn re-emits if auto
   * routing fires again).
   */
  const [autoModeRouting, setAutoModeRouting] = useState<{
    source:
      | 'manual'
      | 'auto-classified'
      | 'auto-default'
      | 'expensive-parallel';
    modelId: string;
    reason?: string;
    profileSummary?: string;
    nudgeClaimer?: string;
    parallelBranches?: string[];
    at: number;
  } | null>(null);
  // Capture resume-ness at mount, not live. The chat pane is no longer
  // remounted when it creates its OWN session (StudioProjectPage keys the
  // pane on chatKey only), so after a self-create the `initialSessionId`
  // prop flips undefined→newId on the SAME instance. A live `!!initialSessionId`
  // would then turn a brand-new session into a "resumed" one (showing the
  // ResumeBanner). Whether this instance resumed history is fixed at mount.
  const [isResumed] = useState(() => !!initialSessionId);
  // True from mount until the `chatListMessages` backfill completes (or
  // errors) on a resumed session. Lets the panel hold the empty-state
  // UI back while history is still in flight — otherwise the user sees
  // a "start a new chat" splash flash before their prior transcript
  // fills in. Fresh sessions (no initialSessionId) skip the backfill
  // and start with this false.
  const [isLoadingHistory, setIsLoadingHistory] = useState<boolean>(
    !!initialSessionId,
  );
  const onSessionCreatedRef = useRef(onSessionCreated);
  const onModelChangedRef = useRef(onModelChanged);
  const onResumeMissingRef = useRef(onResumeMissing);
  useEffect(() => {
    onSessionCreatedRef.current = onSessionCreated;
  }, [onSessionCreated]);
  useEffect(() => {
    onModelChangedRef.current = onModelChanged;
  }, [onModelChanged]);
  useEffect(() => {
    onResumeMissingRef.current = onResumeMissing;
  }, [onResumeMissing]);

  // Track message IDs we've seen to distinguish create vs update
  const knownMessageIds = useRef(new Set<string>());
  // Map child session id → the parent tool_call_id that spawned it.
  // Populated on the first subagent_event we see for a new child by
  // walking the current message list backwards for a still-running
  // delegate/delegate_parallel tool use.
  const childToParentToolCall = useRef(new Map<string, string>());

  /**
   * Fan a `SessionSnapshot` out into the existing useState slices.
   * Single source of truth: every chat-header field is derived from
   * the most recent snapshot. Granular events (session, worktree_event,
   * etc.) still fire their own setters as defense-in-depth — last
   * write wins per slice and the snapshot + the granular event carry
   * the same data, so order doesn't matter.
   *
   * Snapshot fields not yet covered (mcpStatus, scratchpad,
   * features) keep flowing through their existing event handlers
   * or RPC fetches. Streaming-only event types stay event-driven
   * forever (tool_progress, message append, finish_event
   * stage_output deltas, mid-turn judge toasts).
   */
  const applySnapshot = useCallback(
    (snap: SessionSnapshot) => {
      // One-shot new-session drift check (see intendedCreateAxesRef). The first
      // snapshot for a freshly-created session must echo the axes we seeded on
      // create; if it doesn't, the user's picks were silently dropped downstream.
      const intended = intendedCreateAxesRef.current;
      if (intended && (snap.sessionId === intended.id || snap.compositeId === intended.id)) {
        intendedCreateAxesRef.current = null;
        const drift: string[] = [];
        if (snap.permissionMode !== intended.permissionMode)
          drift.push(`permissionMode ${intended.permissionMode}→${snap.permissionMode}`);
        if (JSON.stringify(snap.modelMode) !== JSON.stringify(intended.modelMode))
          drift.push(`modelMode ${JSON.stringify(intended.modelMode)}→${JSON.stringify(snap.modelMode)}`);
        if (snap.patternMode !== intended.patternMode)
          drift.push(`patternMode ${intended.patternMode}→${snap.patternMode}`);
        if (snap.reasoningEffort !== intended.reasoningEffort)
          drift.push(`reasoningEffort ${intended.reasoningEffort}→${snap.reasoningEffort}`);
        if (drift.length > 0) {
          console.debug(
            '[session-origin] worker echoed axes differing from local picks — keeping local (not adopting)',
            JSON.stringify({ sessionId: intended.id, drift }),
          );
        }
      }
      // The USER-SELECTED axes — model, reasoningEffort, permissionMode (plan/edit),
      // modelMode, patternMode — are CLIENT-owned: seeded on mount (persisted model +
      // localStorage) and changed only via the axis dropdowns, then re-sent to the
      // worker every turn. We deliberately DO NOT adopt them from a session_state
      // snapshot. A worker that just restarted (e.g. after a deploy — task.ensure now
      // restarts it) briefly holds DEFAULT axes and echoes them; adopting that echo
      // clobbered the user's picks — the session appeared to switch itself
      // (flash → auto → pro, plan → edit, reasoning level reset). Worker-COMPUTED
      // fields (resolvedPattern, current step, worktree, …) are still adopted below.
      setResolvedPattern(snap.resolvedPattern);
      setCurrentStepId(snap.currentStepId);
      setCurrentStepIter(snap.currentStepIter);
      setCurrentStepFinished(snap.currentStepFinished);
      setWorktree(snap.worktree);
      setWorktreeBlocked(snap.worktreeBlocked);
      setWorktreeStatus(
        snap.worktreeStatus
          ? {
              kind: snap.worktreeStatus.kind,
              ...(snap.worktreeStatus.message !== undefined && {
                message: snap.worktreeStatus.message,
              }),
              ...(snap.worktreeStatus.conflicts !== undefined && {
                conflicts: snap.worktreeStatus.conflicts,
              }),
            }
          : null,
      );
      setSessionInfo({
        id: snap.sessionId,
        title: snap.title,
        cwd: snap.cwd,
        cost: snap.cost,
        ...(snap.billedCost !== undefined && { billedCost: snap.billedCost }),
        promptTokens: snap.promptTokens,
        completionTokens: snap.completionTokens,
        cacheReadTokens: snap.cacheReadTokens,
        cacheCreationTokens: snap.cacheCreationTokens,
        perModel: snap.perModel,
        ...(snap.peerTotals !== undefined && { peerTotals: snap.peerTotals }),
        messageCount: snap.messageCount,
        createdAt: snap.createdAt,
        updatedAt: snap.updatedAt,
        ...(snap.modelDisplayLabel
          ? { modelDisplayLabel: snap.modelDisplayLabel }
          : {}),
        ...(snap.contextTokens !== undefined && {
          contextTokens: snap.contextTokens,
        }),
        ...(snap.contextBudget !== undefined && {
          contextBudget: snap.contextBudget,
        }),
        ...(snap.contextWindow !== undefined && {
          contextWindow: snap.contextWindow,
        }),
        ...(snap.specId ? { specId: snap.specId } : {}),
        ...(snap.parentSessionId
          ? { parentSessionId: snap.parentSessionId }
          : {}),
        ...(snap.maxModeWinnerSessionId
          ? { maxModeWinnerSessionId: snap.maxModeWinnerSessionId }
          : {}),
        eval: snap.eval ?? null,
      });
      // Phase 2 finishPipeline: snapshot carries every stage's
      // metadata (state, exitCode, command label) plus the
      // pipeline-level flags (running/done/ok, conflicts,
      // squashSha, message). Per-stage stdout text isn't in the
      // snapshot — preserve whatever the granular `stage_output`
      // events have already accumulated by name-matching the
      // existing client stage entries.
      setFinishPipeline((prev) => {
        // A snapshot without a finishPipeline (e.g. the client-side agent, or a
        // legacy projection) must not crash the panel — keep the prior state.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- schema types finishPipeline as required, but the mount-fetch path casts a raw snapshot that may omit it (older host build).
        if (!snap.finishPipeline) return prev;
        const prevByName = new Map(prev.stages.map((s) => [s.name, s]));
        return {
          running: snap.finishPipeline.running,
          done: snap.finishPipeline.done,
          ok: snap.finishPipeline.ok,
          stages: snap.finishPipeline.stages.map((s) => {
            const existing = prevByName.get(s.name);
            return {
              name: s.name,
              state: s.state,
              output: existing?.output ?? '',
              ...(s.command !== undefined && { command: s.command }),
              ...(s.exitCode !== undefined && { exitCode: s.exitCode }),
              ...(s.message !== undefined && { message: s.message }),
            };
          }),
          ...(snap.finishPipeline.conflicts !== undefined && {
            conflicts: snap.finishPipeline.conflicts,
          }),
          ...(snap.finishPipeline.conflictStage !== undefined && {
            conflictStage: snap.finishPipeline.conflictStage,
          }),
          ...(snap.finishPipeline.squashSha !== undefined && {
            squashSha: snap.finishPipeline.squashSha,
          }),
          ...(snap.finishPipeline.message !== undefined && {
            message: snap.finishPipeline.message,
          }),
        };
      });
      // Phase 3 — pending interactions + LSP. The granular
      // `permission_request` / `ask_user_request` / `lsp_event`
      // handlers below still fire for backward compat (defense in
      // depth), but the snapshot is now the authoritative source.
      // pendingPermissions[]: server-side broker.getPending()
      // already dedupes by tool_call_id, so we can replace the
      // local array wholesale.
      setPendingPermissions(
        snap.pendingPermissions.map((p) => ({
          id: p.id,
          sessionId: p.sessionId,
          toolCallId: p.toolCallId,
          toolName: p.toolName,
          description: p.description,
          action: p.action,
          path: p.path,
          params: p.params,
        })),
      );
      setPendingAskUsers(
        snap.pendingAskUsers.map((p) => ({
          id: p.id,
          sessionId: p.sessionId,
          toolCallId: p.toolCallId,
          question: p.question,
          ...(p.header !== undefined && { header: p.header }),
          options: p.options,
        })),
      );
      setPendingStepReviews(
        snap.pendingStepReviews.map((p) => ({
          id: p.id,
          sessionId: p.sessionId,
          stepId: p.stepId,
          stepLabel: p.stepLabel,
          patternId: p.patternId,
          ...(p.specId !== undefined && { specId: p.specId }),
          createdAt: p.createdAt,
        })),
      );
      // Guarded like the pending* fields above: an older host build's snapshot may
      // omit lspStatus entirely — don't let it abort the whole snapshot apply (which
      // would drop the conversation and fall back to granular-events-only).
      if (snap.lspStatus) {
        setLspStatus({
          state: snap.lspStatus.state,
          errors: snap.lspStatus.errors,
          warnings: snap.lspStatus.warnings,
          lastUpdatedAt: snap.lspStatus.lastUpdatedAt,
          ...(snap.lspStatus.lastMessage !== undefined && {
            lastMessage: snap.lspStatus.lastMessage,
          }),
        });
      }
      // Only when present — the mount snapshot omits it, and the indexer poll streams it in
      // separate session_state events; an unconditional set would clobber live readiness.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- schema types codebaseReadiness as required, but the mount snapshot / cast path can omit it.
      if (snap.codebaseReadiness !== undefined) setCodebaseReadiness(snap.codebaseReadiness);
      if (snap.title && snap.title !== 'New session') {
        onTitleChanged?.(snap.title);
      }
    },
    [onTitleChanged],
  );

  // Mount-time snapshot fetch: when the hook learns about a sessionId
  // (fresh create OR a resume), pull the authoritative state in one
  // RPC. This is what fixes the missing-Finish-button bug class —
  // previously the chat header relied on every granular event having
  // fired correctly during the session-create handshake; now a single
  // RPC populates everything regardless of whether worktree_event
  // happened to be emitted on the resume path.
  useEffect(() => {
    if (!sessionId) return;
    // Per-peer message buffer is parent-scoped — wipe it whenever the
    // hook latches onto a new session id so a stale max-mode roster
    // doesn't bleed across resumes / pill swaps.
    setPeerMessages([]);
    setPeerToolProgress({});
    setPeerLspState({});
    setPeerStuckState({});
    let cancelled = false;
    void (async () => {
      try {
        const res = (await agentApi(backend.getSnapshot, {
          compositeId: sessionId,
        })) as { snapshot: SessionSnapshot | null } | null;
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `cancelled` is flipped true in the effect cleanup; TS control-flow can't see the deferred closure write and narrows it to always-false.
        if (cancelled || !res?.snapshot) return;
        // Parse (don't bare-cast) so zod fills `.default()` fields — a snapshot
        // from a lagging coding-task build can omit pending arrays / eval, and
        // applySnapshot maps them directly (undefined.map → crash). safeParse
        // applies defaults; a genuinely malformed snapshot drops to granular events.
        const parsed = SessionSnapshotSchema.safeParse(res.snapshot);
        if (!parsed.success) {
          console.warn(
            '[CodingAgentChat] mount snapshot failed validation; falling back to granular events',
            parsed.error.issues,
          );
          return;
        }
        applySnapshot(parsed.data);
      } catch (err) {
        console.warn(
          '[CodingAgentChat] Snapshot fetch failed; falling back to granular events',
          err,
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, backend.getSnapshot, applySnapshot]);

  // Process agent events
  useEffect(() => {
    const unsub = onCustomMessage((msg) => {
      // Accept events for either the resolved sessionId OR the pending
      // initialSessionId. On resume, server-side broadcasts
      // (session_state, worktree_event) routinely arrive in the ~140ms
      // window between chatCreate fire and chatCreate response landing
      // — `sessionId` state is still null/stale during that window so
      // a strict `!== sessionId` filter dropped these every boot. The
      // dropped session_state event carries `codebaseReadiness`, so
      // losing it left the "Codebase: loading…" pill stuck until the
      // mount-time snapshot fetch ran (and even that races the
      // indexer). Diagnosed in ws_tyf4w1dfmpu5wxzl:sess_bni0hoh5mpu5wxzl,
      // 2026-05-31 — every session boot showed 4× null-local drops in
      // the renderer log.
      const acceptedSessionId =
        msg.sessionId === sessionId ||
        (initialSessionId != null && msg.sessionId === initialSessionId);

      if (msg.type === backend.exitType && acceptedSessionId) {
        console.debug('[CodingAgentChat] Session exited:', msg.sessionId);
        setIsStreaming(false);
        setStreamStartedAt(null);
        // Drop the dead session id so the next sendMessage falls through
        // to startNewChat() instead of posting to a session the server
        // no longer knows about.
        setSessionId(null);
        return;
      }

      if (msg.type !== backend.eventType || !acceptedSessionId) {
        // Diagnostic: worktree_event events are critical for the
        // Finish/Abandon buttons. Log when we drop one on the floor
        // because sessionId state hadn't landed yet (init race).
        const evType = (msg.event as { type?: string } | undefined)?.type;
        if (msg.type === backend.eventType && evType === 'worktree_event') {
          console.warn(
            '[CodingAgentChat] Dropped worktree_event: msgSessionId=%s localSessionId=%s',
            msg.sessionId,
            sessionId,
          );
        }
        // Also log dropped `session_state` when the local UI hasn't yet
        // bound to a session id — these carry `codebaseReadiness`, so
        // when they're dropped the "Codebase: loading…" pill never
        // flips to "ready" and the user thinks the semantic indexer
        // isn't doing anything (it is — server has the chunks; the
        // status push just never reaches the renderer because this
        // event got filtered out). Only log the null-local case so
        // legitimate cross-session traffic isn't noise.
        if (
          msg.type === backend.eventType &&
          evType === 'session_state' &&
          sessionId == null &&
          initialSessionId == null
        ) {
          console.warn(
            '[CodingAgentChat] Dropped session_state with null localSessionId: msgSessionId=%s — codebaseReadiness pill will be stuck on "loading"',
            msg.sessionId,
          );
        }
        return;
      }

      // Stamp every relevant event so the stall detector below knows when
      // activity last happened. A working agent fires tool_call/tool_result
      // every few seconds; a stuck one goes silent.
      setLastEventAt(Date.now());

      const event = msg.event as AgentEventEnvelope | undefined;
      if (!event) return;

      const eventType = event.type;
      const payload = event.payload;

      console.debug('[CodingAgentChat] Event: type=%s', eventType);

      // Handle message events (created/updated)
      if (eventType === 'message') {
        // When the visible window doesn't cover the live tail, ignore
        // streaming message events. The server has them durably in
        // messages.jsonl; jumpToTail re-fetches when the user returns
        // to the bottom.
        if (!tailFollowingRef.current) return;
        const subType = payload?.type ?? ''; // 'created' | 'updated' | 'deleted'
        const message = payload?.payload as WireMessage | undefined;
        if (!message) return;

        console.debug(
          '[CodingAgentChat] Message event: sub=%s role=%s id=%s',
          subType,
          message.role,
          message.id.slice(0, 8),
        );

        // Only process assistant and tool messages
        if (message.role === 'assistant') {
          processAssistantMessage(message, subType);
        } else if (message.role === 'tool') {
          processToolMessage(message);
        } else if (message.role === 'judge') {
          processJudgeMessage(message);
        } else if (message.role === 'status') {
          processStatusMessage(message);
        } else if (message.role === 'user') {
          // User-message echoes from the server arrive when the prompt
          // was fired BEFORE the chat panel mounted (e.g. ProjectHome's
          // flow: chatCreate → chatSend → onOpenSession), so the
          // backfill that ran on mount returned []. Without this branch
          // the message is dropped on the floor and the chat shows
          // empty even though messages.json on disk has the prompt.
          // Dedupe rules (was id-only — id-only let the in-panel send
          // path render twice, since `sendMessage` stamps a client
          // UUID and the server stamps `msg_xxx`, so the two never
          // collide; bug observed in ws_5v3j8c2smou5y3qb):
          //
          //   1. Same id already present → no-op.
          //   2. The most recent user entry has matching content AND
          //      a non-server-format id (i.e. the optimistic UUID we
          //      added in `sendMessage`) → adopt the server's id so
          //      future `updated`/`deleted` events for this message
          //      land on the right row, but don't append a duplicate.
          //   3. Otherwise (panel mounted after the prompt fired, e.g.
          //      ProjectHome flow) → append.
          if (subType === 'deleted') {
            setMessages((prev) => prev.filter((m) => m.id !== message.id));
            return;
          }
          const text = extractUserText(message);
          if (!text) return;
          setMessages((prev) => {
            if (prev.some((m) => m.id === message.id)) return prev;
            for (let i = prev.length - 1; i >= 0; i--) {
              const m = prev[i];
              if (m.role !== 'user') continue;
              const isServerId =
                typeof m.id === 'string' && m.id.startsWith('msg_');
              if (!isServerId && m.content === text) {
                const next = prev.slice();
                next[i] = { ...m, id: message.id };
                return next;
              }
              break;
            }
            return [
              ...prev,
              {
                id: message.id,
                role: 'user',
                content: text,
                toolUses: [],
                isStreaming: false,
              },
            ];
          });
        }
        return;
      }

      // Snapshot is the single source of truth for mode, model,
      // reasoning, tokens, worktree, worktreeStatus, finishPipeline
      // (metadata), pendingPermissions, pendingAskUsers, lspStatus.
      // The server dual-emits a `session_state` envelope whenever
      // any of those change AND on every site that previously
      // emitted a granular `session` / `worktree_event` /
      // `permission_request` / `ask_user_request` / `lsp_event`.
      // The legacy granular events still go out (other consumers
      // may rely on them) — the client just no longer reduces them.
      if (eventType === 'codebase_readiness') {
        // Standalone readiness push (host indexer poll). Updates ONLY the header pill — no full
        // snapshot — so it fills in before the first turn without clobbering telemetry. Reaching
        // here already means the event passed the acceptedSessionId gate above, so it's ours.
        const readiness = parseCodebaseReadinessEvent(payload);
        if (readiness) setCodebaseReadiness(readiness);
        return;
      }

      if (eventType === 'session_state') {
        // VALIDATE, don't cast: this snapshot is untyped wire data primed by the host's
        // coding.js task (whose build can lag the SPA). A bare `as SessionSnapshot` is the
        // lie that let `pendingPermissions.map` crash — parse it so the type is real. safeParse
        // also fills the schema defaults, so an older host's partial snapshot still applies.
        const parsed = SessionSnapshotSchema.safeParse(payload?.payload);
        if (!parsed.success) {
          console.warn('[CodingAgentChat] dropping malformed session_state snapshot', parsed.error.issues);
          return;
        }
        const snap = parsed.data;
        // Accept the snapshot when its compositeId matches either the current
        // sessionId OR the initialSessionId that was used to create/resume it.
        // The outer event filter accepts both (see acceptedSessionId), but during
        // the ~140ms window between chatCreate fire and setSessionId(newId)
        // landing, the snapshot arrives with the server's compositeId while the
        // local sessionId is still null. Dropping it here would lose any
        // pendingAskUsers the snapshot carries — the ask_user card never renders.
        if (snap.compositeId !== sessionId && snap.compositeId !== initialSessionId) return;
        applySnapshot(snap);
        return;
      }

      // Multiplexed peer events from cross-pollinated max-mode. The
      // server forwards each peer's events onto the parent's bus
      // wrapped here. The "All" pill view demuxes by `peerModelId`
      // into three slices: peerMessages (chat transcript per peer),
      // peerToolProgress (live tool stdout/stderr per peer), and
      // peerLspState (rolling diagnostic counts per peer). The
      // per-peer pill view doesn't use any of these — it remounts
      // onto the peer's compositeId directly.
      if (eventType === 'peer_stuck') {
        const stuck = payload?.payload as
          | { peerModelId?: string; peerCompositeId?: string; stuckMs?: number }
          | undefined;
        if (!stuck?.peerModelId || typeof stuck.stuckMs !== 'number') return;
        setPeerStuckState((prev) => ({
          ...prev,
          [stuck.peerModelId!]: {
            stuckMs: stuck.stuckMs!,
            updatedAt: Date.now(),
          },
        }));
        return;
      }

      if (eventType === 'peer_event') {
        const wrapped = payload?.payload as
          | {
              peerModelId?: string;
              peerCompositeId?: string;
              original?: {
                type?: string;
                payload?: { type?: string; payload?: unknown };
              };
            }
          | undefined;
        const peerModelId = wrapped?.peerModelId;
        const original = wrapped?.original;
        if (!peerModelId || !original) return;
        // Any fresh peer event clears the stuck state — the watchdog's
        // re-warn cycle on the server will surface a new event if the
        // peer stalls again.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Record index access is typed non-undefined (noUncheckedIndexedAccess off), but the key may genuinely be absent at runtime.
        if (peerStuckStateRef.current[peerModelId]) {
          setPeerStuckState((prev) => {
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- same: prev[peerModelId] can be absent at runtime despite the non-undefined index type.
            if (!prev[peerModelId]) return prev;
            const { [peerModelId]: _drop, ...rest } = prev;
            return rest;
          });
        }

        // Peer message → append/replace in the per-peer transcript.
        if (original.type === 'message') {
          const subType = original.payload?.type;
          const message = original.payload?.payload as
            | RawAgentMessage
            | undefined;
          if (!message?.id) return;
          setPeerMessages((prev) => {
            if (subType === 'deleted') {
              return prev.filter((p) => p.message.id !== message.id);
            }
            // 'created' or 'updated': replace existing same-id entry,
            // otherwise append. Updates are rare for peer messages
            // (only streaming text edits) but cheap to support.
            const idx = prev.findIndex((p) => p.message.id === message.id);
            if (idx >= 0) {
              const next = prev.slice();
              next[idx] = { peerModelId, message };
              return next;
            }
            return [...prev, { peerModelId, message }];
          });
          return;
        }

        // Peer tool_progress → keep only the latest chunk per peer.
        // High-volume (every bash stdout line) so we don't accumulate.
        if (original.type === 'tool_progress') {
          const tp = original.payload?.payload as
            | {
                tool_call_id?: string;
                stream?: 'stdout' | 'stderr' | 'meta';
                text?: string;
              }
            | undefined;
          if (!tp?.tool_call_id) return;
          setPeerToolProgress((prev) => ({
            ...prev,
            [peerModelId]: {
              toolCallId: tp.tool_call_id ?? '',
              stream: tp.stream ?? 'stdout',
              text: tp.text ?? '',
              updatedAt: Date.now(),
            },
          }));
          return;
        }

        // Peer lsp_event → roll up totals so the banner can render a
        // single chip per peer. We deliberately don't store the full
        // diagnostics list (high-volume during a refactor and the
        // per-peer pill view shows the peer's own LSP state natively).
        if (original.type === 'lsp_event') {
          const ls = original.payload?.payload as
            | {
                totalErrors?: number;
                totalWarnings?: number;
                file?: string;
              }
            | undefined;
          if (!ls) return;
          setPeerLspState((prev) => ({
            ...prev,
            [peerModelId]: {
              totalErrors: ls.totalErrors ?? 0,
              totalWarnings: ls.totalWarnings ?? 0,
              ...(ls.file !== undefined && { lastFile: ls.file }),
              updatedAt: Date.now(),
            },
          }));
          return;
        }

        return;
      }
      if (
        eventType === 'session' ||
        eventType === 'worktree_event' ||
        eventType === 'permission_request' ||
        eventType === 'permission_notification' ||
        eventType === 'ask_user_request' ||
        eventType === 'ask_user_resolved' ||
        eventType === 'step_review_request' ||
        eventType === 'step_review_resolved' ||
        eventType === 'lsp_event'
      ) {
        // Supplanted by `session_state` — see comment above.
        return;
      }

      // Finish-pipeline state transitions (started, stage_start,
      // stage_end, stage_skipped, conflict, merged, done, failed)
      // are now driven by the snapshot's `finishPipeline` field.
      // Only the streaming-only `stage_output` chunks still flow
      // through here — those carry the per-stage stdout text the
      // snapshot intentionally doesn't carry.
      if (eventType === 'finish_event') {
        const p = payload?.payload as
          | {
              kind?: string;
              stage?: FinishStageInfo['name'];
              chunk?: string;
            }
          | undefined;
        if (p?.kind !== 'stage_output') return;
        if (!p.stage || typeof p.chunk !== 'string') return;
        // Hoist the narrowed values into consts so the narrowing survives
        // into the setState callback closure below.
        const stageName = p.stage;
        const chunk = p.chunk;
        setFinishPipeline((prev) => {
          const stages = prev.stages.slice();
          const idx = stages.findIndex((s) => s.name === stageName);
          if (idx === -1) return prev;
          const curr = stages[idx];
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- array index access is typed non-undefined (noUncheckedIndexedAccess off), but idx could be stale.
          if (!curr) return prev;
          stages[idx] = { ...curr, output: curr.output + chunk };
          return { ...prev, stages };
        });
        return;
      }

      // Live stdout/stderr chunk from a running tool (bash today; other
      // long-running tools can opt in later). We append to the matching
      // tool_use's `liveOutput` so BashCard can tail it. The final
      // tool_result still lands via processToolMessage and overwrites
      // `result` — we leave `liveOutput` untouched so a brief flicker
      // between last progress chunk and tool_result doesn't empty the
      // pane.
      if (eventType === 'tool_progress') {
        if (!tailFollowingRef.current) return;
        const p = payload?.payload as
          | {
              tool_call_id?: string;
              stream?: 'stdout' | 'stderr' | 'meta';
              text?: string;
              timeout_ms?: number;
              started_at?: number;
            }
          | undefined;
        const tcid = p?.tool_call_id;
        if (!tcid) return;
        // `meta` events carry timeout + start-time setup; `stdout` /
        // `stderr` carry chunk text. Handle them separately so the
        // countdown info isn't discarded when text is empty.
        if (p.stream === 'meta') {
          setMessages((prev) =>
            prev.map((m) => {
              if (m.role !== 'assistant') return m;
              const idx = m.toolUses.findIndex((tu) => tu.id === tcid);
              if (idx === -1) return m;
              const prevTool = m.toolUses[idx];
              // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- array index access is typed non-undefined (noUncheckedIndexedAccess off), guard is real.
              if (!prevTool) return m;
              const next = m.toolUses.slice();
              next[idx] = {
                ...prevTool,
                ...(typeof p.timeout_ms === 'number'
                  ? { timeoutMs: p.timeout_ms }
                  : {}),
                ...(typeof p.started_at === 'number'
                  ? { startedAt: p.started_at }
                  : {}),
              };
              return { ...m, toolUses: next };
            }),
          );
          setLastEventAt(Date.now());
          return;
        }
        const text = p.text;
        if (typeof text !== 'string' || text.length === 0) return;
        setMessages((prev) =>
          prev.map((m) => {
            if (m.role !== 'assistant') return m;
            const idx = m.toolUses.findIndex((tu) => tu.id === tcid);
            if (idx === -1) return m;
            const prevTool = m.toolUses[idx];
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- array index access is typed non-undefined (noUncheckedIndexedAccess off), guard is real.
            if (!prevTool) return m;
            const next = m.toolUses.slice();
            next[idx] = {
              ...prevTool,
              liveOutput: (prevTool.liveOutput ?? '') + text,
            };
            return { ...m, toolUses: next };
          }),
        );
        setLastEventAt(Date.now());
        return;
      }

      // permission_request, permission_notification, ask_user_request,
      // ask_user_resolved, lsp_event are all supplanted by
      // session_state — handled in the early-out block above. Don't
      // re-add reducers here without first checking the snapshot
      // doesn't already cover the field.

      // Handle errors
      if (eventType === 'error' || eventType === 'stderr') {
        const errMsg = event.text ?? event.message ?? 'Unknown error';
        console.debug('[CodingAgentChat] Error event: %s', errMsg);
        setError(errMsg);
        return;
      }

      // Authoritative "turn complete" signal from the agent. The
      // server emits `agent_event` with type='agent_finished' right
      // before each turn returns. We can't rely only on a `finish`
      // part inside an assistant message because some provider paths
      // (e.g. MiniMax hitting the loop detector) produce an empty
      // final assistant message with no finish part at all — which
      // would leave the spinner hanging forever.
      if (eventType === 'agent_event') {
        const innerBody = payload?.payload as { type?: string; reason?: string; diag?: unknown } | undefined;
        const innerType = innerBody?.type ?? payload?.type;
        // Fold the turn-end diagnostics into the console so bug-report feedback
        // telemetry captures WHY a turn ended (reason + ranMs/tokens) — the task
        // child's own logs don't reach the browser recentLogs.
        if (innerType === 'agent_finished') {
          console.debug(
            '[CodingAgentChat] Agent event: innerType=%s reason=%s diag=%s',
            innerType,
            innerBody?.reason ?? '',
            JSON.stringify(innerBody?.diag ?? {}),
          );
        } else {
          console.debug('[CodingAgentChat] Agent event: innerType=%s', innerType);
        }
        // subagent_event envelopes are produced by the session for
        // every event a delegate child emits. The shape is
        //   { type: 'subagent_event', child_session_id, child_index, depth, event }
        // We fold them into the parent's `delegate` (or
        // `delegate_parallel`) tool use as a `children` tree.
        if (innerType === 'subagent_event') {
          if (!tailFollowingRef.current) return;
          const inner = payload?.payload as {
            child_session_id?: string;
            child_index?: number;
            depth?: number;
            event?: ChildEvent;
          } | undefined;
          if (inner?.child_session_id != null && inner.event) {
            applySubagentEvent({
              childSessionId: inner.child_session_id,
              childIndex:
                typeof inner.child_index === 'number' ? inner.child_index : 0,
              depth: typeof inner.depth === 'number' ? inner.depth : 1,
              childEvent: inner.event,
            });
          }
          return;
        }
        if (innerType === 'auto_mode_routing') {
          // Phase 0.5 — server emits this on every turn that auto
          // routing fires (or whenever a nudge claimer / parallel
          // fan-out is in play). The chat header reads
          // `autoModeRouting.reason` to render an inline route hint.
          const routing = payload?.payload as {
            source?:
              | 'manual'
              | 'auto-classified'
              | 'auto-default'
              | 'expensive-parallel';
            reason?: string;
            profile?: {
              kind?: string;
              breadthNeeded?: string;
              size?: string;
            };
            allowlist?: string[];
            parallelBranches?: string[];
            nudgeClaimer?: string;
          };
          if (routing.source) {
            const profileSummary = routing.profile
              ? `kind=${routing.profile.kind ?? '?'} ${
                  routing.profile.breadthNeeded ?? '?'
                }`
              : undefined;
            setAutoModeRouting({
              source: routing.source,
              modelId: model,
              ...(routing.reason ? { reason: routing.reason } : {}),
              ...(profileSummary ? { profileSummary } : {}),
              ...(routing.nudgeClaimer
                ? { nudgeClaimer: routing.nudgeClaimer }
                : {}),
              ...(routing.parallelBranches
                ? { parallelBranches: routing.parallelBranches }
                : {}),
              at: Date.now(),
            });
          }
          return;
        }
        if (innerType === 'reinforce_verdict') {
          const verdict = payload?.payload as {
            kind?: 'critique' | 'terminated' | 'replan_restart';
            text?: string;
            reason?: string;
          };
          if (
            verdict.kind === 'critique' ||
            verdict.kind === 'terminated' ||
            verdict.kind === 'replan_restart'
          ) {
            setLastJudgeVerdict({
              kind: verdict.kind,
              ...(verdict.text ? { text: verdict.text } : {}),
              ...(verdict.reason ? { reason: verdict.reason } : {}),
              at: Date.now(),
            });
          }
          return;
        }
        if (innerType === 'agent_finished' || innerType === 'error') {
          setIsStreaming(false);
          setStreamStartedAt(null);
          // Close out any still-streaming assistant messages so the UI
          // stops spinning even if no `finish` part ever arrived.
          setMessages((prev) =>
            prev.map((m) => (m.isStreaming ? { ...m, isStreaming: false } : m)),
          );
          // Surface the errorMessage payload (set by the server when a
          // turn ends in stall-escalation / provider error) so the UI
          // error banner picks it up. The per-event top-level `error`
          // emit from runTurn does the same, but defensively handle the
          // case where only the agent_event carries the message.
          if (innerType === 'error') {
            const errMsg = (payload?.payload as { errorMessage?: string })
              .errorMessage;
            if (errMsg) setError(errMsg);
          }
        }
        return;
      }
    });

    return unsub;
  }, [sessionId, initialSessionId, backend.eventType, backend.exitType]);

  /** Pull a plain-text body out of a user message's parts array. */
  function extractUserText(message: WireMessage): string {
    const parts = message.parts;
    if (!parts) return '';
    let text = '';
    for (const p of parts) {
      if (p.type === 'text') text += p.data?.text ?? '';
    }
    return text;
  }

  /**
   * Process an assistant message from the agent.
   * Messages have typed parts: text, reasoning, tool_call, tool_result, finish.
   */
  function processAssistantMessage(message: WireMessage, _subType: string) {
    const parts = message.parts;
    if (!parts) return;

    const isNew = !knownMessageIds.current.has(message.id);

    // Extract content from parts
    let textContent = '';
    let thinkingContent = '';
    const toolUses: ToolUse[] = [];
    let isFinished = false;

    for (const part of parts) {
      switch (part.type) {
        case 'text':
          textContent += part.data?.text ?? '';
          break;
        case 'reasoning':
          thinkingContent += part.data?.thinking ?? '';
          break;
        case 'tool_call':
          // 'running' while the LLM is still streaming args (finished=false).
          // Once finished=true the args are complete but the tool hasn't
          // executed yet — the tool_result arrives as a separate message. That
          // gap is 'executing'. processToolMessage overwrites to 'done'/'error'
          // when the tool_result lands.
          toolUses.push({
            id: part.data?.id ?? crypto.randomUUID(),
            name: part.data?.name ?? 'tool',
            input: part.data?.input ?? '',
            status: part.data?.finished ? 'executing' : 'running',
            // Persisted start time (see clientAgent onTurn) so a running tool's
            // duration timer survives reload instead of resetting to zero.
            ...(typeof part.data?.started_at === 'number' ? { startedAt: part.data.started_at } : {}),
          });
          break;
        case 'tool_result':
          // Tool results come as separate messages, handled in processToolMessage
          break;
        case 'finish':
          isFinished = true;
          break;
      }
    }

    if (isNew) {
      // New assistant message
      knownMessageIds.current.add(message.id);
      console.debug(
        '[CodingAgentChat] New assistant message: id=%s text=%d chars, tools=%d',
        message.id.slice(0, 8),
        textContent.length,
        toolUses.length,
      );
      setMessages((prev) => [
        ...prev,
        {
          id: message.id,
          role: 'assistant',
          content: textContent,
          toolUses,
          thinking: thinkingContent || undefined,
          isStreaming: !isFinished,
          ...(message.model ? { model: message.model } : {}),
        },
      ]);
      // Don't flip isStreaming off when an assistant message finishes —
      // multi-iteration turns emit a `finish` part between iterations
      // (tool_calls → execute → next iteration). `agent_finished` is
      // the authoritative turn-end signal; only it turns the spinner off.
      if (!isFinished) setIsStreaming(true);
    } else {
      // Update existing message
      console.debug(
        '[CodingAgentChat] Updating assistant message: id=%s text=%d chars, tools=%d, finished=%s',
        message.id.slice(0, 8),
        textContent.length,
        toolUses.length,
        isFinished,
      );
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== message.id) return m;
          // Merge tool uses: preserve results from existing, update status from new.
          // If the existing entry already has a result (tool_result landed), it
          // owns the terminal 'done'/'error' status. Otherwise take the new
          // status — which is now 'running' (args streaming) or 'executing'
          // (args done, waiting on tool_result).
          const mergedTools = toolUses.map((tu) => {
            const existing = m.toolUses.find((e) => e.id === tu.id);
            if (!existing) return tu;
            const keepTerminal =
              existing.result != null ||
              existing.status === 'done' ||
              existing.status === 'error';
            return {
              ...tu,
              result: existing.result,
              metadata: existing.metadata,
              liveOutput: existing.liveOutput,
              status: keepTerminal ? existing.status : tu.status,
            };
          });
          return {
            ...m,
            content: textContent,
            toolUses: mergedTools,
            thinking: thinkingContent || m.thinking,
            isStreaming: !isFinished,
            ...(message.model ? { model: message.model } : {}),
          };
        }),
      );
    }
  }

  /**
   * Fold one `subagent_event` envelope into the parent delegate's
   * `children` tree. The first time we see a given child session id
   * we walk the message list backwards to find the still-running
   * delegate/delegate_parallel tool use that spawned it (the server
   * doesn't echo the parent tool_call_id in the envelope, so this
   * back-walk is the only correlation we have). Subsequent events
   * for the same child use the cached mapping.
   */
  function applySubagentEvent(args: {
    childSessionId: string;
    childIndex: number;
    depth: number;
    childEvent: ChildEvent;
  }) {
    const { childSessionId, childIndex, depth, childEvent } = args;
    setMessages((prev) => {
      // Locate the parent tool_call_id, either from cache or by
      // walking the messages for a delegate tool use whose RESULT
      // hasn't come back yet.
      //
      // Critical detail: we filter on `!tu.result`, NOT on
      // `tu.status === 'running'`. The parent's delegate tool_call
      // part is marked `finished: true` (status='done') as soon as
      // the assistant message stops STREAMING — which happens
      // BEFORE the delegate execution starts. So by the time the
      // child's first event arrives, the parent's delegate tool_use
      // already has status='done'. Filtering on running would skip
      // it and the children would silently fall on the floor.
      //
      // The result, on the other hand, arrives in processToolMessage
      // only when the delegate's tool_result message lands — which
      // IS the moment the delegate execution completes. So
      // `!tu.result` correctly identifies the in-flight delegate.
      let parentToolCallId = childToParentToolCall.current.get(childSessionId);
      if (!parentToolCallId) {
        for (let i = prev.length - 1; i >= 0; i--) {
          const m = prev[i];
          if (m.role !== 'assistant') continue;
          for (const tu of m.toolUses) {
            const spawnsChildren =
              tu.name === 'delegate' || tu.name === 'delegate_parallel';
            if (!spawnsChildren) continue;
            if (tu.result !== undefined) continue;
            const taken = (tu.children ?? []).some(
              (c) => c.index === childIndex,
            );
            if (taken) continue;
            parentToolCallId = tu.id;
            childToParentToolCall.current.set(childSessionId, tu.id);
            break;
          }
          if (parentToolCallId) break;
        }
      }
      if (!parentToolCallId) return prev;

      // Build a mutator that updates one tool use within the messages
      // array, returning a fresh array. Most delegate calls have a
      // single child so this stays cheap.
      return prev.map((m) => {
        if (m.role !== 'assistant') return m;
        let touched = false;
        const nextTools = m.toolUses.map((tu) => {
          if (tu.id !== parentToolCallId) return tu;
          touched = true;
          const existing = (tu.children ?? []).slice();
          let child = existing.find((c) => c.sessionId === childSessionId);
          if (!child) {
            child = {
              sessionId: childSessionId,
              index: childIndex,
              depth,
              toolUses: [],
              text: '',
              isStreaming: true,
            };
            existing.push(child);
            existing.sort((a, b) => a.index - b.index);
          }
          // Apply the inner event onto the child's state.
          const inner = childEvent;
          const innerType = inner.type;
          if (innerType === 'message') {
            const sub = inner.payload?.payload;
            if (sub?.role === 'assistant' && Array.isArray(sub.parts)) {
              let text = '';
              const tools: ToolUse[] = [];
              for (const p of sub.parts) {
                if (p.type === 'text') text += p.data?.text ?? '';
                else if (p.type === 'tool_call') {
                  tools.push({
                    id: p.data?.id ?? crypto.randomUUID(),
                    name: p.data?.name ?? 'tool',
                    input: p.data?.input ?? '',
                    status: p.data?.finished ? 'executing' : 'running',
                  });
                }
              }
              // Merge with existing child tool uses by id (preserves
              // results from earlier tool messages).
              const merged = tools.map((t) => {
                const old = child!.toolUses.find((e) => e.id === t.id);
                if (!old) return t;
                const keepTerminal =
                  old.result != null ||
                  old.status === 'done' ||
                  old.status === 'error';
                return {
                  ...t,
                  result: old.result,
                  metadata: old.metadata,
                  liveOutput: old.liveOutput,
                  status: keepTerminal ? old.status : t.status,
                };
              });
              child = { ...child, text: text || child.text, toolUses: merged };
            } else if (sub?.role === 'tool' && Array.isArray(sub.parts)) {
              const newToolUses = child.toolUses.slice();
              for (const p of sub.parts) {
                if (p.type !== 'tool_result') continue;
                const tcid = p.data?.tool_call_id;
                if (!tcid) continue;
                const idx = newToolUses.findIndex((tu2) => tu2.id === tcid);
                if (idx === -1) continue;
                let metadata: Record<string, unknown> | null = null;
                const raw = p.data?.metadata;
                if (typeof raw === 'string' && raw.length > 0) {
                  try {
                    metadata = JSON.parse(raw) as Record<string, unknown>;
                  } catch {
                    /* ignore */
                  }
                } else if (raw && typeof raw === 'object') {
                  metadata = raw as Record<string, unknown>;
                }
                const prevTool = newToolUses[idx];
                // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- array index access is typed non-undefined (noUncheckedIndexedAccess off), guard is real.
                if (!prevTool) continue;
                newToolUses[idx] = {
                  ...prevTool,
                  result: p.data?.content ?? '',
                  metadata,
                  status: p.data?.is_error ? 'error' : 'done',
                };
              }
              child = { ...child, toolUses: newToolUses };
            }
          } else if (innerType === 'agent_event') {
            const at = inner.payload?.payload?.type ?? inner.payload?.type;
            if (at === 'agent_finished' || at === 'error') {
              child = { ...child, isStreaming: false };
            }
          }
          // Replace the child in the existing array (sort already
          // applied above for new entries).
          const childIdx = existing.findIndex(
            (c) => c.sessionId === childSessionId,
          );
          if (childIdx >= 0) existing[childIdx] = child;
          return { ...tu, children: existing };
        });
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `touched` is mutated inside the .map callback above; TS control-flow can't see the closure write.
        return touched ? { ...m, toolUses: nextTools } : m;
      });
    });
  }

  /**
   * Process tool result messages — update the matching tool use in the last assistant message.
   */
  function processToolMessage(message: WireMessage) {
    const parts = message.parts;
    if (!parts) return;

    for (const part of parts) {
      if (part.type !== 'tool_result') continue;

      const toolCallId = part.data?.tool_call_id;
      const content = part.data?.content ?? '';
      const isError = part.data?.is_error ?? false;
      const metadataRaw = part.data?.metadata;

      if (!toolCallId) continue;

      console.debug(
        '[CodingAgentChat] Tool result: callId=%s isError=%s content=%d chars',
        toolCallId.slice(0, 8),
        isError,
        content.length,
      );

      // The agent ships tool metadata as a JSON-encoded string. Parse
      // eagerly so renderers don't all have to re-parse.
      let metadata: Record<string, unknown> | null = null;
      if (typeof metadataRaw === 'string' && metadataRaw.length > 0) {
        try {
          metadata = JSON.parse(metadataRaw) as Record<string, unknown>;
        } catch {
          /* ignore */
        }
      } else if (metadataRaw && typeof metadataRaw === 'object') {
        metadata = metadataRaw as Record<string, unknown>;
      }

      // Truncate very long results for display
      const displayContent =
        content.length > 4000
          ? content.slice(0, 4000) + '\n... (truncated)'
          : content;

      setMessages((prev) => {
        const updated = [...prev];
        for (let i = updated.length - 1; i >= 0; i--) {
          const m = updated[i];
          if (m.role !== 'assistant') continue;
          const idx = m.toolUses.findIndex((tu) => tu.id === toolCallId);
          if (idx !== -1) {
            const toolUses = [...m.toolUses];
            toolUses[idx] = {
              ...toolUses[idx],
              result: displayContent,
              metadata,
              status: isError ? 'error' : 'done',
            };
            updated[i] = { ...m, toolUses };
            break;
          }
        }
        return updated;
      });
    }
  }

  /**
   * Append a server-emitted judge message to the chat stream so the
   * UI can render it inline. Idempotent — repeated calls with the same
   * message id are no-ops (replay during history backfill is safe).
   */
  function processJudgeMessage(message: WireMessage) {
    const parts = message.parts;
    if (!parts) return;
    const judgePart = parts.find((p) => p.type === 'judge_call');
    if (!judgePart?.data) return;
    const snap = judgePart.data as unknown as JudgeCallSnapshot;
    setMessages((prev) => {
      if (prev.some((m) => m.id === message.id)) return prev;
      const summaryLine = `${snap.kind} · ${snap.model} · ${
        snap.output.verdict
      }${snap.output.intervention ? `/${snap.output.intervention.kind}` : ''}`;
      return [
        ...prev,
        {
          id: message.id,
          role: 'judge',
          content: summaryLine,
          toolUses: [],
          isStreaming: false,
          judge: snap,
        },
      ];
    });
  }

  /**
   * Append (or update) a server-emitted status message — currently the
   * "Done entry" snapshot summarising worktree changes after a turn.
   * Insert is idempotent on first sight; an `updated` event for the
   * same id (sent when the finish pipeline completes and patches
   * `finishOutcome`) replaces the existing entry in place so the chat
   * panel re-renders the persisted outcome line without scrolling.
   */
  function processStatusMessage(message: WireMessage) {
    const parts = message.parts;
    if (!parts) return;
    const donePart = parts.find((p) => p.type === 'done_state');
    if (!donePart?.data) return;
    const snap = donePart.data as unknown as DoneStateSnapshot;
    const wt = snap.worktree;
    const summary =
      `${wt.changedCount} file${wt.changedCount === 1 ? '' : 's'} changed` +
      (wt.aheadCount && wt.aheadCount > 0
        ? ` · ${wt.aheadCount} commit${
            wt.aheadCount === 1 ? '' : 's'
          } ahead of ${wt.parentBranch}`
        : '');
    const ts =
      typeof message.created_at === 'number' && message.created_at > 0
        ? { created_at: message.created_at }
        : {};
    const next: ChatMessage = {
      id: message.id,
      role: 'status',
      content: summary,
      toolUses: [],
      isStreaming: false,
      done: snap,
      ...ts,
    };
    setMessages((prev) => {
      const idx = prev.findIndex((m) => m.id === message.id);
      if (idx === -1) return [...prev, next];
      const updated = prev.slice();
      updated[idx] = next;
      return updated;
    });
  }

  /**
   * Clear chat history *in place* — same sessionId, same worktree,
   * same indexes. Backs the `/clear` slash command. The whole point
   * is to skip the new-session re-init cost (worktree provisioning,
   * indexer warm-up banner, dev-server reset) the user pays from
   * `startNewChat`.
   */
  const clearMessages = useCallback(async () => {
    if (!sessionId) return false;
    try {
      const { ok } = (await agentApi(backend.chatClearMessages, {
        sessionId,
      })) as { ok?: boolean };
      if (!ok) return false;
      setMessages([]);
      setError(null);
      setIsStreaming(false);
      setPendingPermissions([]);
      setFinishPipeline(EMPTY_FINISH);
      knownMessageIds.current.clear();
      return true;
    } catch (err) {
      console.error('[useCodingAgentChat:clearMessages]', JSON.stringify({ sessionId, error: err instanceof Error ? err.message : String(err) }), err instanceof Error ? err.stack : undefined);
      const errMsg = `Failed to clear chat: ${(err as Error).message}`;
      console.debug('[CodingAgentChat] %s', errMsg);
      setError(errMsg);
      return false;
    }
  }, [sessionId, backend]);

  const startNewChat = useCallback(async () => {
    // Stop existing session
    if (sessionId) {
      agentApi(backend.chatStop, { sessionId }).catch(() => {/* noop */});
    }
    setMessages([]);
    setError(null);
    setIsStreaming(false);
    setPendingPermissions([]);
    setSessionInfo(null);
    setWorktree(null);
    setWorktreeBlocked(false);
    setWorktreeStatus(null);
    setFinishPipeline(EMPTY_FINISH);
    setLspStatus({
      state: 'idle',
      errors: 0,
      warnings: 0,
      lastUpdatedAt: null,
    });
    knownMessageIds.current.clear();

    console.debug('[CodingAgentChat] Starting new chat with model: %s', model);

    try {
      // Resolve EVERY create axis from its ref, not the closed-over React state.
      // `handleHeroSubmit` applies the hero's picks via the axis setters, then
      // synchronously calls sendMessage → startNewChat in the SAME tick, before a
      // re-render commits the new state — so the closure still holds the hook's
      // defaults. The setters write these refs synchronously, so they carry the
      // user's actual picks. (This is the "new session ignored my model/plan
      // settings" bug — previously only `model` read a ref.)
      const createModel = modelRef.current;
      const createModelMode = modelModeRef.current;
      const createPatternMode = patternModeRef.current;
      const createReasoningEffort = reasoningEffortRef.current;
      const createBranchMode = branchModeRef.current;
      // Send the permission axis from the ref, not the stale closure. In-process
      // (ugly.bot) sessions only ever carry 'edit' | 'yolo' (the selector hides
      // 'claude-plan' for them), and 'yolo' now takes effect at runtime via the
      // daemon SandboxMode. We send the value RAW (no yolo?→edit collapse) so a
      // Claude-CLI session's own native 'claude-plan' mode also round-trips.
      const serverMode = permissionModeRef.current;
      console.log(
        `[session-origin] useCodingAgentChat.startNewChat chatCreate model=${createModel} mode=${serverMode}`,
      );
      // Carry the mode axes too: the per-axis set* RPCs return early while
      // there's no sessionId, so a new-session hero pre-pick (e.g. patternMode
      // "none" or a modelMode set before the first message) would otherwise be
      // lost until the session existed. chatCreate seeds them up-front.
      const { sessionId: newId } = (await agentApi(backend.chatCreate, {
        model: createModel,
        mode: serverMode,
        patternMode: createPatternMode,
        modelMode: createModelMode,
        // Seed reasoning effort ON CREATE too (like patternMode/modelMode). The
        // post-create chatSetReasoningEffort below is fire-and-forget, so a first
        // turn that starts before it lands would otherwise run at the default —
        // the "new session ignored my reasoning setting" bug.
        reasoningEffort: createReasoningEffort,
        branchMode: createBranchMode,
      })) as ChatCreateResponse;
      console.debug('[CodingAgentChat] Session created: %s', newId);
      // Arm the one-shot drift sentinel: the first snapshot for `newId` must echo
      // these seeded axes; applySnapshot logs to errorLog if it doesn't.
      intendedCreateAxesRef.current = {
        id: newId,
        permissionMode: serverMode,
        modelMode: createModelMode,
        patternMode: createPatternMode,
        reasoningEffort: createReasoningEffort,
        branchMode: createBranchMode,
      };
      setSessionId(newId);
      onSessionCreatedRef.current?.(newId);
      // Skip-permissions piggy-backed on legacy spec-mode; with the
      // mode axis collapsed, simply enable skip for every fresh session
      // (matches today's behavior for non-spec sessions, which is what
      // every new session is now).
      agentApi(backend.skipPermissions, {
        sessionId: newId,
        skip: true,
      }).catch(() => {/* noop */});
      if (createReasoningEffort !== 'off') {
        agentApi(backend.chatSetReasoningEffort, {
          sessionId: newId,
          effort: createReasoningEffort,
        }).catch(() => {/* noop */});
      }
      return newId;
    } catch (err) {
      console.error('[useCodingAgentChat:startNewChat]', JSON.stringify({ model: modelRef.current, permissionMode, patternMode, reasoningEffort, error: err instanceof Error ? err.message : String(err) }), err instanceof Error ? err.stack : undefined);
      const errMsg = `Failed to start chat: ${(err as Error).message}`;
      console.debug('[CodingAgentChat] %s', errMsg);
      setError(errMsg);
      return null;
    }
  }, [sessionId, model, permissionMode, patternMode, modelMode, reasoningEffort, backend]);

  // Splice in any USER prompts we're missing — a viewer that attached AFTER the sender
  // emitted the prompt at turn start (common right after the host task is (re)started).
  // Idempotent + dedups on the stable `${sessionId}:${seq}` user id (same live + persisted).
  // Assistant rows use a random live id and stream fine, so we do NOT replay them here (that
  // would double-render). Each missing prompt is positioned by history order relative to
  // what's rendered; a rendered row absent from history (a live-streaming reply) counts as
  // newer, so the prompt lands just before the in-flight reply.
  const backfillMissingUserMessages = useCallback(
    async (sid: string): Promise<void> => {
      let history: RawAgentMessage[];
      try {
        const res = (await agentApi(backend.chatListMessages, {
          sessionId: sid,
          limit: PAGE_SIZE,
        })) as ListMessagesResponse | null;
        if (!Array.isArray(res?.messages)) return;
        history = res.messages;
      } catch (err) {
        console.error('[useCodingAgentChat:backfillMissingUserMessages]', JSON.stringify({ sessionId: sid, error: err instanceof Error ? err.message : String(err) }), err instanceof Error ? err.stack : undefined);
        return;
      }
      const rows = history.map((m) => ({
        id: m.id,
        role: m.role,
        text: (m.parts ?? [])
          .filter((p) => p.type === 'text')
          .map((p) => (p.data as MessagePartData | undefined)?.text ?? '')
          .join(''),
      }));
      setMessages((prev) =>
        spliceMissingUserRows(prev, rows, (id, content) => ({
          id,
          role: 'user',
          content,
          toolUses: [],
          isStreaming: false,
        })),
      );
    },
    [backend],
  );

  // Resume the agent session on mount when `initialSessionId` is set:
  // attach to the existing composite ID and backfill the rendered
  // message array via codingAgentChatListMessages. History is replayed
  // through the same processAssistant/Tool helpers used for live events
  // so the output matches.
  //
  // When `initialSessionId` is NOT set, this effect is inert. Sessions
  // are only created via NewSessionHero's submit handler (or the legacy
  // `startNewChat` exported below) — never as a side effect of mounting
  // the chat panel with no session bound. This guard closes the
  // 2026-05-31 ghost-session leak where an empty-sessionId placeholder
  // tab from a prior auto-seed would mount this hook and silently
  // create a session at the default model (`z-ai:glm-5.1`). See the
  // `ws_rua1zyh0mpu3e58o:sess_vf20ctadmpu3e58o` postmortem.
  // Guard the mount/resume effect below so it runs once per initialSessionId value.
  // Without this, a temporarily-empty sessionId placeholder from a prior auto-seed
  // would mount this hook and silently create a session at the default model. BUT when
  // the USER switches sessions (initialSessionId changes), the guard must let the new
  // session through — otherwise the UI stays on the dead session and never re-attaches.
  const lastInitSessionRef = useRef<string | null>(null);
  useEffect(() => {
    // Skip when no session to resume, or when we already initialized this id.
    if (!initialSessionId) return;
    if (lastInitSessionRef.current === initialSessionId) return;
    lastInitSessionRef.current = initialSessionId;
    // Clear stale state from a prior session so the user doesn't see old messages
    // flash before the new session's history loads in.
    setMessages([]);
    setPeerMessages([]);
    setPeerToolProgress({});
    setPeerLspState({});
    setPeerStuckState({});
    console.log(
      `[session-origin] useCodingAgentChat.mountEffect chatCreate initialSessionId=${initialSessionId}`,
    );
    let cancelled = false;
    void (async () => {
      try {
        // Send the permission axis RAW (edit | yolo | claude-plan) — no longer
        // collapsed to edit/yolo, so plan mode round-trips. On this mount/resume
        // path the closure value is the initial/persisted mode (no same-tick hero
        // pre-pick), so reading state directly is correct here.
        const serverMode = permissionMode;
        console.log(
          `[session-origin] useCodingAgentChat.mountEffect chatCreate initialSessionId=${initialSessionId} model=${model} mode=${serverMode}`,
        );
        const {
          sessionId: newId,
          specId: resolvedSpecId,
          model: resolvedModel,
          reasoningEffort: resolvedReasoningEffort,
        } = (await agentApi(backend.chatCreate, {
          model,
          mode: serverMode,
          ...(initialSessionId ? { resumeSessionId: initialSessionId } : {}),
          ...(specId ? { specId } : {}),
        })) as ChatCreateResponse;
        console.log(
          `[session-origin] useCodingAgentChat.mountEffect chatCreate → ${newId.slice(
            0,
            24,
          )} (initialSessionId was ${initialSessionId})`,
        );
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `cancelled` is flipped true in the effect cleanup; TS control-flow can't see the deferred closure write.
        if (cancelled) return;
        // Resume sanity check (defense-in-depth). The server-side
        // codingAgentChatCreate now refuses to silently fresh-create
        // when a `resumeSessionId` it can't find anywhere is supplied,
        // so this branch should be unreachable in practice. Keep the
        // assertion to catch future regressions or edge cases (e.g. the
        // owning project was closed between the listSessions call and
        // this chatCreate). Without it, the chat panel would adopt the
        // server's substitute session id and render as empty — same
        // symptom as the sess_jos7kwr9mpteac0r 2026-05-31 report.
        if (initialSessionId && newId !== initialSessionId) {
          const msg =
            `Resume mismatch: asked to resume ${initialSessionId} but server returned ${newId}. ` +
            `The owning project may not be open. Refusing to adopt the substitute session.`;
          console.error(`[session-origin] ${msg}`);
          setError(msg);
          setIsLoadingHistory(false);
          return;
        }
        setSessionId(newId);
        // Cross-device live sync: attach (listen-only) to this session's live
        // task stream so a message sent on ANOTHER device streams here live.
        // Never starts a task. Keep retrying for as long as this session is open
        // (until `cancelled` on unmount): the host may not have spun the task up
        // yet (the SENDER's first turn creates it, which can be long after this
        // viewer opened) AND on mobile the desktop proxy may still be connecting.
        // A bounded poll gave up after ~10s, so a message later sent on the
        // desktop never streamed in — the "mobile doesn't update" report. Back
        // off after the initial fast attempts. `knownMessageIds` dedup +
        // `acceptedSessionId` filter prevent any double-render vs the backfill.
        void (async () => {
          let attempt = 0;
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `cancelled` is flipped true in the effect cleanup; TS control-flow can't see the deferred closure write.
          while (!cancelled) {
            const res = await agentApi(backend.chatAttach, {
              sessionId: newId,
            }).catch(() => ({ attached: false }));
            if ((res as { attached?: boolean }).attached) {
              // We attached, but the sender emits the USER prompt at turn start — a viewer
              // that attaches a beat later (esp. right after the task is (re)started) misses
              // it, and the task snapshot carries no messages, so the reply shows with no
              // prompt above it. Re-pull history and splice in any user rows we don't have.
              // User rows have stable `${sessionId}:${seq}` ids (live + persisted), so this
              // dedups; assistant rows use a random live id and stream fine, so we DON'T
              // replay them here (that would double-render).
              await backfillMissingUserMessages(newId);
              break;
            }
            attempt += 1;
            await new Promise((r) => setTimeout(r, attempt < 10 ? 1000 : 3000));
          }
        })();
        // Adopt the per-session model + reasoning effort from disk.
        // The client's initial state was seeded from the global
        // localStorage default (or `initialModel` prop) — that's only
        // meaningful for fresh sessions. On resume the server's
        // persisted values are authoritative.
        if (resolvedModel && resolvedModel !== model) {
          setModel(resolvedModel);
          onModelChangedRef.current?.(resolvedModel);
        }
        if (resolvedReasoningEffort) {
          setReasoningEffortState(resolvedReasoningEffort);
        }
        // Seed the per-session spec binding into local state atomically
        // on mount so the Build-from-spec button can render immediately
        // — no dependency on the next `session` event (which only fires
        // on turn boundaries). Live events still overwrite as usual.
        if (resolvedSpecId) {
          setSessionInfo(
            (prev) =>
              ({
                id: newId.split(':')[1] ?? newId,
                cost: prev?.cost ?? 0,
                promptTokens: prev?.promptTokens ?? 0,
                completionTokens: prev?.completionTokens ?? 0,
                cacheReadTokens: prev?.cacheReadTokens ?? 0,
                cacheCreationTokens: prev?.cacheCreationTokens ?? 0,
                perModel: prev?.perModel ?? [],
                messageCount: prev?.messageCount ?? 0,
                ...(prev ?? {}),
                specId: resolvedSpecId,
              }) as CodingAgentSessionInfo,
          );
        }
        // Mode is no longer surfaced client-side; the server still
        // emits `mode` on the snapshot but we don't read it. The
        // session's permissionMode is set from snapshot via the
        // session_state event handler.
        onSessionCreatedRef.current?.(newId);
        // Skip-permissions is now unconditional for fresh sessions —
        // the legacy spec-mode branch is gone (no read-only sessions
        // at the OS level; pattern engine handles read-only via
        // prompt tail).
        agentApi(backend.skipPermissions, {
          sessionId: newId,
          skip: true,
        }).catch(() => {/* noop */});

        if (initialSessionId) {
          try {
            // Load history up to WINDOW_MAX messages on mount — don't make the user
            // click "load older" after every reload just to see more than 20 messages.
            let allHistory: WireMessage[] = [];
            let beforeId: string | undefined;
            let hasMore = false;
            let exhausted = false;
            while (!exhausted && allHistory.length < WINDOW_MAX) {
              const page = (await agentApi(backend.chatListMessages, {
                sessionId: newId,
                limit: PAGE_SIZE,
                ...(beforeId ? { beforeId } : {}),
              })) as { messages?: WireMessage[]; hasMore?: boolean };
              // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `cancelled` is flipped true in the effect cleanup; TS control-flow can't see the deferred closure write.
              if (cancelled) return;
              const msgs = page.messages ?? [];
              if (msgs.length === 0) break;
              allHistory = [...msgs, ...allHistory];
              hasMore = Boolean(page.hasMore);
              beforeId = msgs[0].id;
              exhausted = !hasMore;
            }
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `cancelled` is flipped true in the effect cleanup; TS control-flow can't see the deferred closure write.
            if (cancelled || allHistory.length === 0) return;
            setHasMoreOlder(exhausted ? false : hasMore);
            setHasMoreNewer(false);
            console.log(
              '[session-origin] resume backfill: loaded=%d hasMoreOlder=%s',
              allHistory.length, !exhausted,
            );
            // Replay history through the same handlers used for live
            // streaming events. We don't preserve a `firstTurnSent` flag
            // here — the server already tracks it.
            for (const m of allHistory) {
              if (m.role === 'assistant') processAssistantMessage(m, 'created');
              else if (m.role === 'tool') processToolMessage(m);
              else if (m.role === 'judge') processJudgeMessage(m);
              else if (m.role === 'status') processStatusMessage(m);
              else if (m.role === 'user') {
                const text = extractUserText(m);
                if (text) {
                  setMessages((prev) => [
                    ...prev,
                    {
                      id: m.id,
                      role: 'user',
                      content: text,
                      toolUses: [],
                      isStreaming: false,
                    },
                  ]);
                }
              }
            }
            // Any tool_use still 'running'/'executing' after a full replay was
            // INTERRUPTED — the session stopped before the tool finished (or its
            // result was never persisted). Mark it terminal so the card doesn't
            // spin forever ("stuck"). This is display-only: a real resume
            // re-derives the pending tool from the persisted content and runs it.
            setMessages((prev) =>
              prev.map((m) =>
                m.role === 'assistant' &&
                m.toolUses.some((t) => t.status === 'running' || t.status === 'executing')
                  ? {
                      ...m,
                      toolUses: m.toolUses.map((t) =>
                        t.status === 'running' || t.status === 'executing'
                          ? { ...t, status: 'error' as const }
                          : t,
                      ),
                    }
                  : m,
              ),
            );
            setIsStreaming(false);
          } catch (err) {
            console.error('[useCodingAgentChat:historyBackfill]', JSON.stringify({ sessionId: newId, error: err instanceof Error ? err.message : String(err) }), err instanceof Error ? err.stack : undefined);
            console.debug(
              '[CodingAgentChat] History backfill failed: %s',
              (err as Error).message,
            );
          } finally {
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `cancelled` is flipped true in the effect cleanup; TS control-flow can't see the deferred closure write.
            if (!cancelled) setIsLoadingHistory(false);
          }
        }
      } catch (err) {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `cancelled` is flipped true in the effect cleanup; TS control-flow can't see the deferred closure write.
        if (!cancelled) {
          const message = (err as Error).message;
          // Recovery path: when the server rejects a resume because no
          // open project owns the session, the persisted layout points
          // at a deleted session (typical trigger: user deleted the
          // project folder externally and recreated one). Let the
          // parent drop the orphan tab and don't surface the error —
          // the user lands on the new-session hero instead of a
          // permanent "Failed to start chat" message.
          if (
            initialSessionId &&
            message.includes('not found in any open project') &&
            onResumeMissingRef.current
          ) {
            console.warn(
              `[session-origin] Resume target ${initialSessionId} is gone — asking parent to drop the orphan tab`,
            );
            onResumeMissingRef.current(initialSessionId);
          } else {
            console.error('[useCodingAgentChat:resumeSession]', JSON.stringify({ initialSessionId, model, error: message }), err instanceof Error ? err.stack : undefined);
            setError(`Failed to start chat: ${message}`);
          }
          // Outer catch fires before the backfill block runs, so the
          // loading flag would otherwise stay true forever and hide
          // the empty state permanently on a failed resume.
          setIsLoadingHistory(false);
        }
      }
    })();
    return () => {
      cancelled = true;
      if (initialSessionId) {
        console.log(
          '[session-origin] useCodingAgentChat.unmount sessionId=%s',
          initialSessionId,
        );
      }
    };
    // Intentionally mount-only — we don't want to re-create the session on
    // every prop change.
  }, []);

  const loadOlderMessages = useCallback(async () => {
    if (!sessionId) return;
    if (isLoadingOlder || !hasMoreOlder) return;
    const oldest = messages[0];
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- array index access is typed non-undefined (noUncheckedIndexedAccess off), but messages can be empty.
    if (!oldest) return;
    setIsLoadingOlder(true);
    try {
      const { messages: older, hasMore } = (await agentApi(
        backend.chatListMessages,
        { sessionId, limit: PAGE_SIZE, beforeId: oldest.id },
      )) as ListMessagesResponse;
      if (!Array.isArray(older)) return;
      setMessages((prev) => {
        const seen = new Set(prev.map((m) => m.id));
        const unseenRaw = older.filter((r) => !seen.has(r.id));
        const fresh = projectAgentMessagesToChat(unseenRaw);
        let next = [...fresh, ...prev];
        if (next.length > WINDOW_MAX) {
          const drop = next.length - WINDOW_MAX;
          next = next.slice(0, next.length - drop);
          setHasMoreNewer(true);
        }
        knownMessageIds.current = new Set(next.map((m) => m.id));
        return next;
      });
      setHasMoreOlder(Boolean(hasMore));
    } catch (err) {
      console.error('[useCodingAgentChat:loadOlderMessages]', JSON.stringify({ sessionId, beforeId: oldest.id, error: err instanceof Error ? err.message : String(err) }), err instanceof Error ? err.stack : undefined);
      console.debug(
        '[CodingAgentChat] loadOlderMessages failed: %s',
        (err as Error).message,
      );
    } finally {
      setIsLoadingOlder(false);
    }
  }, [
    sessionId,
    isLoadingOlder,
    hasMoreOlder,
    messages,
    backend.chatListMessages,
  ]);

  const loadNewerMessages = useCallback(async () => {
    if (!sessionId) return;
    if (isLoadingNewer || !hasMoreNewer) return;
    const newest = messages[messages.length - 1];
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- array index access is typed non-undefined (noUncheckedIndexedAccess off), but messages can be empty.
    if (!newest) return;
    setIsLoadingNewer(true);
    try {
      const { messages: newer, hasMore } = (await agentApi(
        backend.chatListMessages,
        { sessionId, limit: PAGE_SIZE, afterId: newest.id },
      )) as ListMessagesResponse;
      if (!Array.isArray(newer)) return;
      setMessages((prev) => {
        const seen = new Set(prev.map((m) => m.id));
        const unseenRaw = newer.filter((r) => !seen.has(r.id));
        const fresh = projectAgentMessagesToChat(unseenRaw);
        let next = [...prev, ...fresh];
        if (next.length > WINDOW_MAX) {
          const drop = next.length - WINDOW_MAX;
          next = next.slice(drop);
          setHasMoreOlder(true);
        }
        knownMessageIds.current = new Set(next.map((m) => m.id));
        return next;
      });
      setHasMoreNewer(Boolean(hasMore));
    } catch (err) {
      console.error('[useCodingAgentChat:loadNewerMessages]', JSON.stringify({ sessionId, afterId: newest.id, error: err instanceof Error ? err.message : String(err) }), err instanceof Error ? err.stack : undefined);
      console.debug(
        '[CodingAgentChat] loadNewerMessages failed: %s',
        (err as Error).message,
      );
    } finally {
      setIsLoadingNewer(false);
    }
  }, [
    sessionId,
    isLoadingNewer,
    hasMoreNewer,
    messages,
    backend.chatListMessages,
  ]);

  const jumpToTail = useCallback(async () => {
    if (!sessionId) return;
    try {
      const { messages: tail, hasMore } = (await agentApi(
        backend.chatListMessages,
        { sessionId, limit: PAGE_SIZE },
      )) as ListMessagesResponse;
      if (!Array.isArray(tail)) return;
      const fresh = projectAgentMessagesToChat(tail);
      setMessages(fresh);
      setHasMoreOlder(Boolean(hasMore));
      setHasMoreNewer(false);
      knownMessageIds.current = new Set(fresh.map((m) => m.id));
    } catch (err) {
      console.error('[useCodingAgentChat:jumpToTail]', JSON.stringify({ sessionId, error: err instanceof Error ? err.message : String(err) }), err instanceof Error ? err.stack : undefined);
      console.debug(
        '[CodingAgentChat] jumpToTail failed: %s',
        (err as Error).message,
      );
    }
  }, [sessionId, backend.chatListMessages]);

  /**
   * Three-axis setters. Optimistic local update + server RPC. The
   * snapshot stream re-confirms server state shortly after.
   */
  const setPermissionMode = useCallback(
    async (next: SessionSnapshot['permissionMode']) => {
      permissionModeRef.current = next; // synchronous — startNewChat reads this
      setPermissionModeState(next);
      if (!sessionId) return;
      try {
        await agentApi(backend.setPermissionMode, {
          sessionId,
          permissionMode: next,
        });
      } catch (err) {
        console.error('[useCodingAgentChat:setPermissionMode]', JSON.stringify({ sessionId, permissionMode: next, error: err instanceof Error ? err.message : String(err) }), err instanceof Error ? err.stack : undefined);
        setError(`Failed to set permission: ${(err as Error).message}`);
      }
    },
    [sessionId, backend.setPermissionMode],
  );

  // Local mirror of a server-side family convert: the session keeps its
  // compositeId + worktree, but its backend was swapped and history/telemetry
  // wiped. Drop the orphaned transcript + in-flight state and reflect the new
  // model so the panel doesn't show a stale conversation against a fresh
  // backend.
  const applyFamilyConvertLocally = useCallback((nextModel: string) => {
    setMessages([]);
    setError(null);
    setIsStreaming(false);
    setPendingPermissions([]);
    setFinishPipeline(EMPTY_FINISH);
    knownMessageIds.current.clear();
    setModel(nextModel);
  }, []);

  const setModelMode = useCallback(
    async (next: SessionSnapshot['modelMode']) => {
      // The SERVER is the authority on backend/model consistency: it knows
      // which runtime a session is on (the client `model` string can lag a
      // snapshot) and whether the session has history. So just send the
      // change and react to its verdict:
      //   • needsFamilySwitchConfirm → confirm + retry via chatSetModel(reset)
      //   • ok (+ maybe a silent empty-session convert) → mirror locally
      modelModeRef.current = next; // synchronous — startNewChat reads this
      setModelModeState(next);
      // Keep the `model` string in sync with a single pick — it drives both the
      // displayed model and what startNewChat sends to chatCreate. (Without this
      // a new-session claude-cli pick was lost: the string stayed at the default
      // 'auto', so the session showed auto and routed to the ugly.bot agent.)
      if (next.kind === 'single') {
        modelRef.current = next.model; // synchronous — startNewChat reads this
        setModel(next.model);
        onModelChangedRef.current?.(next.model);
      }
      if (!sessionId) return;
      try {
        const res = (await agentApi(backend.setModelMode, {
          sessionId,
          modelMode: next,
        })) as { needsFamilySwitchConfirm?: boolean; ok?: boolean; sessionId?: string };
        if (res.needsFamilySwitchConfirm && next.kind === 'single') {
          const confirmed =
            typeof window !== 'undefined' &&
            window.confirm(
              "Switching between Claude Code and ugly.bot models resets this chat's history and telemetry. Your worktree and files are kept. Continue?",
            );
          if (!confirmed) return; // leave the model as-is on the server
          const conv = (await agentApi(backend.chatSetModel, {
            sessionId,
            model: next.model,
            resetForFamilySwitch: true,
          })) as { ok?: boolean };
          if (conv.ok) applyFamilyConvertLocally(next.model);
          return;
        }
        // The server echoes `sessionId` ONLY when it actually converted the
        // backend (a silent empty-session family switch). Within-family
        // changes return `{ ok }` with no sessionId — never wipe history for
        // those. Mirror locally only on a real convert.
        if (res.ok && res.sessionId && next.kind === 'single') {
          applyFamilyConvertLocally(next.model);
        }
      } catch (err) {
        console.error('[useCodingAgentChat:setModelMode]', JSON.stringify({ sessionId, modelMode: next, error: err instanceof Error ? err.message : String(err) }), err instanceof Error ? err.stack : undefined);
        setError(`Failed to set model mode: ${(err as Error).message}`);
      }
    },
    [sessionId, backend.setModelMode, backend.chatSetModel, applyFamilyConvertLocally],
  );

  const setPatternMode = useCallback(
    async (next: SessionSnapshot['patternMode']) => {
      patternModeRef.current = next; // synchronous — startNewChat reads this
      setPatternModeState(next);
      if (!sessionId) return;
      try {
        await agentApi(backend.setPatternMode, {
          sessionId,
          patternMode: next,
        });
      } catch (err) {
        console.error('[useCodingAgentChat:setPatternMode]', JSON.stringify({ sessionId, patternMode: next, error: err instanceof Error ? err.message : String(err) }), err instanceof Error ? err.stack : undefined);
        setError(`Failed to set pattern mode: ${(err as Error).message}`);
      }
    },
    [sessionId, backend.setPatternMode],
  );

  const sendMessage = useCallback(
    async (
      text: string,
      attachments?: {
        kind: 'image';
        mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
        base64: string;
        filename?: string;
      }[],
    ) => {
      const hasAttachments = (attachments?.length ?? 0) > 0;
      if (!text.trim() && !pendingSkill && !hasAttachments) return;

      let sid = sessionId;
      if (!sid) {
        sid = await startNewChat();
        if (!sid) return;
      }

      // Prepend the skill invocation to the outgoing message only; the UI
      // shows the user's typed text (or `/skill-name` when the turn is
      // skill-only).
      const outgoing = pendingSkill
        ? `Use the \`${pendingSkill}\` skill.${
            text.trim() ? `\n\n${text}` : ''
          }`
        : text;
      const displayText =
        text.trim() ||
        (pendingSkill
          ? `/${pendingSkill}`
          : hasAttachments
          ? `📎 ${attachments!.length} image(s)`
          : '');

      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'user',
          content: displayText,
          toolUses: [],
          isStreaming: false,
          ...(hasAttachments
            ? {
                attachments: attachments!.map((a) => ({
                  mediaType: a.mediaType,
                  base64: a.base64,
                  ...(a.filename ? { filename: a.filename } : {}),
                })),
              }
            : {}),
        },
      ]);
      setIsStreaming(true);
      setStreamStartedAt(Date.now());
      setLastEventAt(Date.now());
      setError(null);
      setLastJudgeVerdict(null);
      setAutoModeRouting(null);
      setPendingSkill(null);
      // New user turn — clear any dangling ask_user card from a prior
      // turn. Shouldn't normally have one, but being defensive.
      setPendingAskUsers([]);
      setPendingStepReviews([]);

      console.debug(
        '[CodingAgentChat] Sending message: session=%s length=%d attachments=%d',
        sid.slice(0, 16),
        outgoing.length,
        attachments?.length ?? 0,
      );

      try {
        await agentApi(backend.chatSend, {
          sessionId: sid,
          message: outgoing,
          ...(hasAttachments ? { attachments } : {}),
        });
      } catch (err) {
        console.error('[useCodingAgentChat:sendMessage]', JSON.stringify({ sessionId: sid, hasAttachments, error: err instanceof Error ? err.message : String(err) }), err instanceof Error ? err.stack : undefined);
        setError(`Failed to send message: ${(err as Error).message}`);
        setIsStreaming(false);
        setStreamStartedAt(null);
      }
    },
    [sessionId, startNewChat, pendingSkill, backend.chatSend],
  );

  const stopGeneration = useCallback(() => {
    if (sessionId) {
      console.debug(
        '[CodingAgentChat] Stopping generation: %s',
        sessionId.slice(0, 16),
      );
      agentApi(backend.chatStop, { sessionId }).catch(() => {/* noop */});
    }
    setIsStreaming(false);
    setStreamStartedAt(null);
    // Server-side stop() rejects the broker's pending promise which
    // frees the tool executor, but no ask_user_resolved event fires
    // on the reject path — clear the local cards ourselves so the UI
    // doesn't leave stale pending questions after the abort. The
    // server's next snapshot will overwrite this with the authoritative
    // list (e.g. surviving peer orphans from a max-mode parent that
    // stopped its peers) — this is purely the optimistic clear so the
    // composer unblocks immediately.
    setPendingAskUsers([]);
    setPendingStepReviews([]);
  }, [sessionId, backend.chatStop]);

  /**
   * Abort one tool call by id. Unlike `stopGeneration`, this leaves
   * the turn running — the tool resolves with a "stopped by user"
   * result and the model continues to reason over it.
   */
  const stopTool = useCallback(
    (toolCallId: string) => {
      if (!sessionId) return;
      console.debug(
        '[CodingAgentChat] Stopping tool: session=%s toolCall=%s',
        sessionId.slice(0, 16),
        toolCallId.slice(0, 16),
      );
      agentApi(backend.toolStop, { sessionId, toolCallId }).catch(() => {/* noop */});
    },
    [sessionId, backend.toolStop],
  );

  // Per-workspace coding-agent feature toggles. The system Settings
  // page (`CodingAgentSettingsSection`) owns the editor UI; this hook
  // only reads the current values to surface a few derived flags
  // (e.g. `features.checkpoints` controls the in-message Restore
  // button). Loaded once on mount.
  const [features, setFeatures] = useState<CodingAgentFeatures>(
    () => DEFAULT_FEATURES,
  );

  // getUserSettings is a per-user Neon read via the ugly-app framework socket
  // (app.socket.request), NOT the window.UglyNative shim — settings persist in
  // the project's backend and sync across the user's devices. See shared/api.ts
  // + server/index.ts. The socket is typed to framework requests only, so reach
  // the app-specific request through a narrow structural interface.
  const app = useAppOptional();
  useEffect(() => {
    if (!app) return;
    let cancelled = false;
    void (async () => {
      try {
        const socket = app.socket as unknown as { request(name: string, input: unknown): Promise<unknown> };
        const settings = (await socket.request('getUserSettings', {})) as {
          codingAgent?: ServerCodingAgent;
        } | null;
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `cancelled` is flipped true in the effect cleanup; TS control-flow can't see the deferred closure write.
        if (cancelled) return;
        if (settings?.codingAgent) {
          setFeatures(serverToFeatures(settings.codingAgent));
        }
      } catch (err) {
        console.error('[useCodingAgentChat:getUserSettings]', JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), err instanceof Error ? err.stack : undefined);
        console.debug(
          '[CodingAgentChat] getUserSettings (features) failed: %s',
          (err as Error).message,
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [app]);

  // ── Per-session config (server-persisted) ──────────────────────────────────
  // The header axes (model/mode/plan/reasoning/pattern) are a PER-SESSION setting
  // stored on the CodingSession doc, so any browser that opens the session sees the
  // same values (localStorage is only an instant-render cache, corrected here). A
  // brand-new session is seeded from the user's remembered `sessionDefaults` and
  // persisted; changing an axis writes back to THIS session (never others) and
  // updates the user default so the next new session starts there. See
  // shared/sessionConfig.ts.
  const configSeededRef = useRef<string | null>(null);
  const lastPersistedConfigRef = useRef<string>('');
  useEffect(() => {
    if (!sessionId || !app || configSeededRef.current === sessionId) return;
    configSeededRef.current = sessionId;
    let cancelled = false;
    const applyConfig = (c: SessionConfig): void => {
      setModel(c.model);
      setModelModeState(c.mode);
      setPermissionModeState(c.perm);
      setReasoningEffortState(c.reasoning);
      setPatternModeState(c.pattern);
      // Hydrate the buildSelection cache so the next turn runs with these values.
      setSessionModel(sessionId, c.model);
      patchSessionAxes(sessionId, {
        modelMode: c.mode,
        permissionMode: c.perm,
        reasoningEffort: c.reasoning,
        patternMode: c.pattern,
      });
    };
    void (async () => {
      const fallback: AxisState = { model, modelMode: coerceModelMode(modelMode), permissionMode, reasoningEffort, patternMode };
      try {
        const stored = await readServerConfig(sessionId);
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- flipped true in the effect cleanup; TS can't see the deferred write.
        if (cancelled) return;
        let config: SessionConfig;
        if (stored) {
          config = stored; // resume/open → the session's authoritative server value
        } else {
          // New session → seed from the user's remembered defaults, then persist.
          const socket = app.socket as unknown as { request(n: string, i: unknown): Promise<unknown> };
          const settings = (await socket
            .request('getUserSettings', {})
            .catch(() => null)) as { codingAgent?: { sessionDefaults?: SessionConfigDefaults } } | null;
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- flipped true in the effect cleanup; TS can't see the deferred write.
          if (cancelled) return;
          // New session → seed the header + cache from the user's defaults. Do NOT
          // persist yet (that would create an empty session doc / sidebar spam); the
          // worker's persistMeta writes the config on the session's first turn.
          config = completeConfig(settings?.codingAgent?.sessionDefaults, fallback);
        }
        applyConfig(config);
        lastPersistedConfigRef.current = JSON.stringify(config);
      } catch {
        /* keep the local instant-render values */
      }
    })();
    return () => { cancelled = true; };
    // Seed ONCE per session — axis values are read via closure, not deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, app]);

  // Persist header axis CHANGES to THIS session (server) and remember them as the
  // user's default for new sessions. Guarded so the initial seed above doesn't
  // re-persist or overwrite the user default.
  const sessionStarted = messages.length > 0;
  useEffect(() => {
    if (!sessionId || configSeededRef.current !== sessionId) return;
    const config = axesToConfig({ model, modelMode: coerceModelMode(modelMode), permissionMode, reasoningEffort, patternMode });
    const json = JSON.stringify(config);
    if (json === lastPersistedConfigRef.current) return;
    lastPersistedConfigRef.current = json;
    // Persist to THIS session only if its doc already exists (has turns) — a
    // not-yet-started session gets its config from the worker's first persistMeta,
    // so writing here would create an empty doc. Always remember the pick as the
    // user default for new sessions.
    if (sessionStarted) void writeServerConfig(sessionId, config);
    if (app) {
      const socket = app.socket as unknown as { request(n: string, i: unknown): Promise<unknown> };
      void socket.request('updateUserSettings', { codingAgent: { sessionDefaults: config } }).catch(() => {/* best-effort */});
    }
  }, [model, modelMode, permissionMode, reasoningEffort, patternMode, sessionId, app, sessionStarted]);

  const switchReasoningEffort = useCallback(
    (next: ReasoningEffort) => {
      reasoningEffortRef.current = next; // synchronous — startNewChat reads this
      if (next === reasoningEffort) return;
      console.debug(
        '[CodingAgentChat] Switching reasoning effort: %s → %s',
        reasoningEffort,
        next,
      );
      setReasoningEffortState(next);
      // No global write — reasoning effort is per-session. The
      // server persists `state.reasoningEffort` on every change via
      // `chatSetReasoningEffort` below.
      if (sessionId) {
        agentApi(backend.chatSetReasoningEffort, {
          sessionId,
          effort: next,
        }).catch((err: unknown) => {
          console.debug(
            '[CodingAgentChat] Reasoning effort switch failed: %s',
            (err as Error).message,
          );
        });
      }
    },
    [reasoningEffort, sessionId, backend.chatSetReasoningEffort],
  );

  const switchModel = useCallback(
    (newModel: string) => {
      console.debug(
        '[CodingAgentChat] Switching model: %s → %s',
        model,
        newModel,
      );
      setModel(newModel);
      // No global write — model is per-session. The server persists
      // `state.model` on every change via `chatSetModel` below. Only
      // the Project Home picker writes the global default, which is
      // what every NEW session inherits.
      onModelChangedRef.current?.(newModel);
      // If a session is already running, rebind the model on the server
      // — otherwise the change only takes effect on the next new session.
      if (sessionId) {
        agentApi(backend.chatSetModel, { sessionId, model: newModel }).catch(
          (err: unknown) => {
            console.debug(
              '[CodingAgentChat] Model switch failed: %s',
              (err as Error).message,
            );
          },
        );
      }
    },
    [model, sessionId, backend.chatSetModel],
  );

  const approvePermission = useCallback(
    async (perm: PermissionRequest, allowAll?: boolean) => {
      if (!sessionId) return;
      const action = allowAll ? 'allow_session' : 'allow';
      console.debug(
        '[CodingAgentChat] Approving permission: tool=%s action=%s',
        perm.toolName,
        action,
      );
      try {
        await agentApi(backend.grantPermission, {
          sessionId,
          permission: {
            id: perm.id,
            session_id: perm.sessionId,
            tool_call_id: perm.toolCallId,
            tool_name: perm.toolName,
            description: perm.description,
            action: perm.action,
            path: perm.path,
            params: perm.params,
          },
          action,
        });
        setPendingPermissions((prev) => prev.filter((p) => p.id !== perm.id));
      } catch (err) {
        console.error('[useCodingAgentChat:approvePermission]', JSON.stringify({ sessionId, toolName: perm.toolName, action, error: err instanceof Error ? err.message : String(err) }), err instanceof Error ? err.stack : undefined);
        console.debug(
          '[CodingAgentChat] Permission grant failed: %s',
          (err as Error).message,
        );
      }
    },
    [sessionId, backend.grantPermission],
  );

  /**
   * Send the user's answer to a pending ask_user tool call. The server
   * broker resolves the tool's awaited promise so the turn loop can
   * continue with the answer as a normal tool_result. Local state
   * clears optimistically; the ask_user_resolved event is a no-op by
   * the time it arrives (state already null), which is the intended
   * race-safe behavior.
   */
  const answerAskUser = useCallback(
    async (
      toolCallId: string,
      value: string,
      targetSessionId?: string,
    ): Promise<boolean> => {
      // Default to the active session, but allow callers to override —
      // peer cards in a max-mode parent's queue carry their own
      // sessionId so the answer routes to the peer's own broker.
      const sid = targetSessionId ?? sessionId;
      if (!sid) return false;
      console.debug(
        '[CodingAgentChat] answerAskUser: toolCall=%s session=%s',
        toolCallId.slice(0, 12),
        sid.slice(0, 16),
      );
      const dropEntry = (prev: PendingAskUser[]): PendingAskUser[] =>
        prev.filter((p) => p.toolCallId !== toolCallId);
      try {
        const res = (await agentApi('codingAgentAnswerAskUser', {
          sessionId: sid,
          toolCallId,
          value,
        })) as { ok?: boolean; error?: string };
        if (res.ok === false) {
          // Phantom card — the broker no longer has a pending entry
          // for this toolCallId. Most likely the sidecar restarted
          // since the card was rendered, so the underlying ask_user
          // promise is gone. Clear the card so the user isn't stuck
          // looking at a stale question, and surface a brief banner
          // explaining what happened.
          setPendingAskUsers(dropEntry);
          if (res.error) {
            setError(`Answer failed: ${res.error}`);
          } else {
            setError(
              'That question is no longer pending — likely the agent or session restarted. Send a new message to continue.',
            );
          }
          return false;
        }
        setPendingAskUsers(dropEntry);
        return true;
      } catch (err) {
        // Network or RPC failure — clear the card so the user has a
        // way out and surface the error.
        console.error('[useCodingAgentChat:answerAskUser]', JSON.stringify({ sessionId: sid, toolCallId, error: err instanceof Error ? err.message : String(err) }), err instanceof Error ? err.stack : undefined);
        setPendingAskUsers(dropEntry);
        setError(`Answer failed: ${(err as Error).message}`);
        return false;
      }
    },
    [sessionId],
  );

  /**
   * Resolve a pending step-review gate — `action: 'continue'` advances
   * the driver to the next step; `action: 'iterate'` re-runs the
   * current step (SPEC or DIAGNOSE) with `feedback` injected as a
   * synthetic user message.
   *
   * The server returns a precise `outcome` tag so we can branch:
   *   - 'ok'               → happy path, drop the card.
   *   - 'already_answered' → benign duplicate click; drop the card silently.
   *   - 'aborted'          → session stopped between prompt and reply; clear silently.
   *   - 'unknown'          → sidecar restarted; surface a banner because the
   *                          user needs to send a fresh message.
   *   - 'no_session'       → session torn down; surface a banner.
   * Anything else (network failure, throw) falls back to the generic
   * "answer failed" path.
   */
  const answerStepReview = useCallback(
    async (
      id: string,
      action: 'continue' | 'iterate',
      feedback?: string,
      targetSessionId?: string,
    ): Promise<boolean> => {
      const sid = targetSessionId ?? sessionId;
      if (!sid) return false;
      console.debug(
        '[CodingAgentChat] answerStepReview: id=%s action=%s session=%s',
        id.slice(0, 12),
        action,
        sid.slice(0, 16),
      );
      const dropEntry = (prev: PendingStepReview[]): PendingStepReview[] =>
        prev.filter((p) => p.id !== id);
      try {
        const res = (await agentApi('codingAgentAnswerStepReview', {
          sessionId: sid,
          id,
          action,
          ...(feedback !== undefined ? { feedback } : {}),
        })) as { ok?: boolean; outcome?: string; error?: string };
        // Always drop the local card — the server's snapshot will
        // re-add it if the broker still has a live entry (it won't
        // for any non-ok outcome).
        setPendingStepReviews(dropEntry);
        if (res.ok === true) return true;
        const outcome = res.outcome;
        // Benign duplicates / abort races: clear the card without
        // pestering the user. The agent already moved on.
        if (outcome === 'already_answered' || outcome === 'aborted') {
          console.warn(
            '[CodingAgentChat] step_review %s for id=%s — silent dismiss',
            outcome,
            id.slice(0, 12),
          );
          return false;
        }
        // unknown / no_session / other: the user needs to know they
        // have to send a fresh message.
        const message =
          // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- an empty-string error must fall through to the default message, which `??` (nullish-only) would not do.
          (typeof res.error === 'string' && res.error) ||
          'No pending review found — the agent sidecar may have restarted. Send a new message to continue.';
        setError(message);
        console.warn(
          '[CodingAgentChat] step_review answer failed outcome=%s id=%s',
          outcome ?? '<none>',
          id.slice(0, 12),
        );
        return false;
      } catch (err) {
        setPendingStepReviews(dropEntry);
        setError(`Answer failed: ${(err as Error).message}`);
        console.error(
          '[CodingAgentChat] step_review answer threw id=%s: %s',
          id.slice(0, 12),
          (err as Error).message,
        );
        return false;
      }
    },
    [sessionId],
  );

  const skipAllPermissions = useCallback(async () => {
    if (!sessionId) return;
    console.debug('[CodingAgentChat] Skipping all permissions');
    try {
      await agentApi(backend.skipPermissions, { sessionId, skip: true });
      setPendingPermissions([]);
    } catch (err) {
      console.error('[useCodingAgentChat:skipAllPermissions]', JSON.stringify({ sessionId, error: err instanceof Error ? err.message : String(err) }), err instanceof Error ? err.stack : undefined);
      console.debug(
        '[CodingAgentChat] Skip permissions failed: %s',
        (err as Error).message,
      );
    }
  }, [sessionId, backend.skipPermissions]);

  /**
   * User-triggered "compact now". Hits codingAgentCompactNow, which
   * drops middle messages down to ~50% of the model's window. Ignored
   * while a turn is streaming — the server would throw and mutating
   * live history mid-stream would desync the event consumer anyway.
   * Errors are surfaced through the same `error` banner the rest of
   * the hook uses.
   */
  const compactNow = useCallback(async () => {
    if (!sessionId || isStreaming) return;
    console.debug('[CodingAgentChat] Force-compact requested');
    try {
      const res = (await agentApi('codingAgentCompactNow', { sessionId })) as {
        ok?: boolean;
        error?: string;
      };
      if (res.ok === false && res.error) {
        setError(`Compact failed: ${res.error}`);
      }
    } catch (err) {
      console.error('[useCodingAgentChat:compactNow]', JSON.stringify({ sessionId, error: err instanceof Error ? err.message : String(err) }), err instanceof Error ? err.stack : undefined);
      setError(`Compact failed: ${(err as Error).message}`);
    }
  }, [sessionId, isStreaming]);

  /**
   * Phase 4 — roll back the shadow-git checkpoint to the state it
   * was in after a specific assistant turn. The action is rejected
   * while a turn is streaming because reverting files under a live
   * edit loop would confuse the model. Only meaningful when the
   * `checkpoints` feature is enabled; the server side returns
   * `{ ok: false }` for sessions that have no tracker.
   */
  const restoreCheckpoint = useCallback(
    async (msgId: string): Promise<boolean> => {
      if (!sessionId || isStreaming) return false;
      try {
        const res = (await agentApi('codingAgentRestoreCheckpoint', {
          sessionId,
          msgId,
        })) as { ok?: boolean; error?: string };
        if (res.ok === false && res.error) {
          setError(`Restore failed: ${res.error}`);
        }
        return !!res.ok;
      } catch (err) {
        console.error('[useCodingAgentChat:restoreCheckpoint]', JSON.stringify({ sessionId, msgId, error: err instanceof Error ? err.message : String(err) }), err instanceof Error ? err.stack : undefined);
        setError(`Restore failed: ${(err as Error).message}`);
        return false;
      }
    },
    [sessionId, isStreaming],
  );

  /**
   * Kick off the Finish-session pipeline. Returns the server's final
   * FinishResult. UI renders progress inline via `finishPipeline` state
   * which is updated from streamed `finish_event` envelopes.
   */
  const finishSession = useCallback(
    async (opts: {
      runTypecheck: boolean;
      runLint: boolean;
      runTests: boolean;
      /**
       * When the main repo has uncommitted local changes at Done
       * time, the squash-merge stage refuses with "your local
       * changes would be overwritten by merge." Default false; the
       * first call returns a `precheck_dirty_main` result with the
       * file list so the chat UI can ask the user; the second call
       * (after they confirm) sets this true so the pipeline auto-
       * commits the dirty files before squashing.
       */
      commitDirtyMainBeforeMerge?: boolean;
      /**
       * When true, the server pauses after validation gates pass and
       * returns `stage: 'awaiting_review'` with a proposed commit
       * message + scoping fields so the chat UI can render the review
       * modal that gates the squash-merge.
       */
      pauseBeforeSquash?: boolean;
    }): Promise<{
      ok: boolean;
      stage?: string;
      squashSha?: string;
      message?: string;
      conflicts?: string[];
      dirtyFiles?: string[];
      proposedCommitMessage?: string;
      parentBranch?: string;
      sessionBranch?: string;
      worktreePath?: string;
    }> => {
      if (!sessionId) return { ok: false, message: 'No session' };
      setFinishPipeline({ ...EMPTY_FINISH, running: true });
      try {
        const res = (await agentApi(backend.finish, {
          sessionId,
          runTypecheck: opts.runTypecheck,
          runLint: opts.runLint,
          runTests: opts.runTests,
          ...(opts.commitDirtyMainBeforeMerge
            ? { commitDirtyMainBeforeMerge: true }
            : {}),
          ...(opts.pauseBeforeSquash ? { pauseBeforeSquash: true } : {}),
        })) as {
          ok: boolean;
          stage?: string;
          squashSha?: string;
          message?: string;
          conflicts?: string[];
          dirtyFiles?: string[];
          proposedCommitMessage?: string;
          parentBranch?: string;
          sessionBranch?: string;
          worktreePath?: string;
        };
        return res;
      } catch (err) {
        console.error('[useCodingAgentChat:finishSession]', JSON.stringify({ sessionId, runTypecheck: opts.runTypecheck, runLint: opts.runLint, runTests: opts.runTests, error: err instanceof Error ? err.message : String(err) }), err instanceof Error ? err.stack : undefined);
        setFinishPipeline((prev) => ({
          ...prev,
          running: false,
          done: true,
          ok: false,
          message: (err as Error).message,
        }));
        return { ok: false, message: (err as Error).message };
      }
    },
    [sessionId, backend.finish],
  );

  /**
   * Run the squash-merge tail of the Finish pipeline. Called after the
   * user accepts the review modal that follows a `finishSession` call
   * with `pauseBeforeSquash: true`. `commitMessage` is the (optionally
   * edited) squash subject — empty string falls back to the auto-
   * derived message on the server.
   */
  const mergeFinishedSession = useCallback(
    async (
      commitMessage?: string,
    ): Promise<{
      ok: boolean;
      stage?: string;
      squashSha?: string;
      message?: string;
      conflicts?: string[];
    }> => {
      if (!sessionId) return { ok: false, message: 'No session' };
      try {
        const res = (await agentApi(backend.merge, {
          sessionId,
          ...(commitMessage !== undefined ? { commitMessage } : {}),
        })) as {
          ok: boolean;
          stage?: string;
          squashSha?: string;
          message?: string;
          conflicts?: string[];
        };
        return res;
      } catch (err) {
        console.error('[useCodingAgentChat:mergeFinishedSession]', JSON.stringify({ sessionId, error: err instanceof Error ? err.message : String(err) }), err instanceof Error ? err.stack : undefined);
        return { ok: false, message: (err as Error).message };
      }
    },
    [sessionId, backend.merge],
  );

  /**
   * Stop an in-flight validation gate inside the Finish pipeline.
   */
  const stopFinishStage = useCallback(
    async (stage: 'tsc' | 'lint' | 'tests'): Promise<boolean> => {
      if (!sessionId) return false;
      try {
        const res = (await agentApi(backend.finishStop, {
          sessionId,
          stage,
        })) as { ok: boolean };
        return res.ok;
      } catch (err) {
        console.error('[useCodingAgentChat:stopFinishStage]', JSON.stringify({ sessionId, stage, error: err instanceof Error ? err.message : String(err) }), err instanceof Error ? err.stack : undefined);
        return false;
      }
    },
    [sessionId, backend.finishStop],
  );

  /**
   * Abandon this session: delete the worktree + branch without merging,
   * mark the session finished, and tear it down.
   */
  const abandonSession = useCallback(async (): Promise<boolean> => {
    if (!sessionId) return false;
    try {
      const res = (await agentApi(backend.abandon, { sessionId })) as {
        ok: boolean;
        error?: string;
      };
      if (!res.ok && res.error) setError(`Abandon failed: ${res.error}`);
      return res.ok;
    } catch (err) {
      console.error('[useCodingAgentChat:abandonSession]', JSON.stringify({ sessionId, error: err instanceof Error ? err.message : String(err) }), err instanceof Error ? err.stack : undefined);
      setError(`Abandon failed: ${(err as Error).message}`);
      return false;
    }
  }, [sessionId, backend.abandon]);

  /**
   * Archive this session: send it to the archived drawer on Project
   * Home. Reversible — the user can unarchive later. Unlike Abandon,
   * the worktree + branch are preserved so the session can be
   * resumed if the user un-archives.
   */
  const archiveSession = useCallback(async (): Promise<boolean> => {
    if (!sessionId) return false;
    try {
      const res = (await agentApi(backend.archive, {
        compositeId: sessionId,
      })) as { ok: boolean };
      return res.ok;
    } catch (err) {
      console.error('[useCodingAgentChat:archiveSession]', JSON.stringify({ sessionId, error: err instanceof Error ? err.message : String(err) }), err instanceof Error ? err.stack : undefined);
      setError(`Archive failed: ${(err as Error).message}`);
      return false;
    }
  }, [sessionId, backend.archive]);

  /**
   * Explicitly re-run the parent-into-worktree merge for this session.
   * Useful when the user knows they just pulled on the main tree, or
   * for the "Pull from parent" button. Returns the full server
   * response so callers can react to conflicts (e.g. auto-trigger AI
   * resolution); legacy callers that only need success can read `ok`.
   */
  const refreshWorktreeNow = useCallback(async (): Promise<{
    ok: boolean;
    blocked?: boolean;
    conflicts?: string[];
    conflictKind?: 'merge' | 'stash_apply';
    error?: string;
  }> => {
    if (!sessionId) return { ok: false, error: 'No session' };
    try {
      const res = (await agentApi(backend.refreshWorktree, { sessionId })) as {
        ok: boolean;
        blocked?: boolean;
        conflicts?: string[];
        conflictKind?: 'merge' | 'stash_apply';
        error?: string;
      };
      if (!res.ok && res.error)
        setError(`Worktree refresh failed: ${res.error}`);
      return res;
    } catch (err) {
      const msg = (err as Error).message;
      console.error('[useCodingAgentChat:refreshWorktreeNow]', JSON.stringify({ sessionId, error: msg }), err instanceof Error ? err.stack : undefined);
      setError(`Worktree refresh failed: ${msg}`);
      return { ok: false, error: msg };
    }
  }, [sessionId, backend.refreshWorktree]);

  /**
   * Read-only probe of whether this session's worktree is behind its
   * parent branch. Drives the "Pull from parent" button's disabled
   * state. Null result = leave the previous probe in place (best-effort).
   */
  const checkWorktreeBehind = useCallback(async (): Promise<void> => {
    if (!sessionId) return;
    try {
      const res = (await agentApi(backend.worktreeBehind, { sessionId })) as {
        ok: boolean;
        kind?: 'up_to_date' | 'behind' | 'in_progress_merge' | 'unknown';
        reason?: string;
        error?: string;
      };
      if (res.ok && res.kind) setWorktreeBehind(res.kind);
    } catch {
      /* swallow — the button just stays in its previous state */
    }
  }, [sessionId, backend.worktreeBehind]);

  /**
   * Read-only probe of how many commits the worktree's branch is
   * AHEAD of its parent. Drives the chat panel's Done button
   * visibility on resume — gitStatus's changed-files count alone
   * misses sessions that committed everything but failed to merge.
   * `null` and `-1` are both "unknown — leave Done visible".
   */
  const checkWorktreeAhead = useCallback(async (): Promise<void> => {
    if (!sessionId) return;
    try {
      const res = (await agentApi(backend.worktreeAhead, { sessionId })) as {
        ok: boolean;
        count?: number;
        error?: string;
      };
      if (res.ok && typeof res.count === 'number') {
        setWorktreeAheadCount(res.count);
      }
    } catch {
      /* swallow — leave previous probe value in place */
    }
  }, [sessionId, backend.worktreeAhead]);

  // Probe the parent branch on initial load + after every turn ends +
  // whenever a worktree_event lands. The probe involves a network
  // fetch so we skip while streaming (the answer would be stale by
  // the time the user could click anyway). `worktreeStatus` in the
  // dep list catches refreshed / refresh_conflict / refresh_failed.
  useEffect(() => {
    if (!sessionId || !worktree || isStreaming) return;
    void checkWorktreeBehind();
    // Also re-probe ahead count — a turn may have committed work, or
    // a previous Done may have already merged so the count drops to 0.
    void checkWorktreeAhead();
  }, [
    sessionId,
    worktree,
    isStreaming,
    worktreeStatus,
    checkWorktreeBehind,
    checkWorktreeAhead,
  ]);

  return {
    messages,
    /**
     * Captured peer-message events when the parent session is in
     * max-mode. Empty otherwise. CodingAgentChat consumes this to
     * render the "All" pill view (interleaved by created_at, badged).
     */
    peerMessages,
    /**
     * Latest live `tool_progress` chunk per peer. Drives the
     * per-peer "currently running" chip in the All view.
     */
    peerToolProgress,
    /**
     * Per-peer LSP rollup (error/warning totals + last file).
     * Drives a compact diagnostic chip in the All view.
     */
    peerLspState,
    /**
     * Per-peer stuck watchdog state. Set by `peer_stuck` events when
     * a peer hasn't fired any event in >120s; cleared the moment any
     * fresh peer_event arrives. Drives an amber pill on that peer's
     * row so the user sees a silent block (e.g. provider hang) instead
     * of waiting indefinitely without feedback.
     */
    peerStuckState,
    isStreaming,
    sendMessage,
    stopGeneration,
    stopTool,
    startNewChat,
    clearMessages,
    model,
    switchModel,
    reasoningEffort,
    switchReasoningEffort,
    pendingSkill,
    setPendingSkill,
    error,
    sessionId,
    pendingPermissions,
    approvePermission,
    pendingAskUsers,
    answerAskUser,
    pendingStepReviews,
    answerStepReview,
    skipAllPermissions,
    compactNow,
    restoreCheckpoint,
    // Activity / health surface — leaf labels self-tick from these.
    streamStartedAt,
    lastEventAt,
    serverHealthy,
    // Read-only view of project-level coding-agent features. The
    // editor UI lives in the system Settings page; we expose the
    // current values here so a handful of in-chat surfaces (e.g.
    // `features.checkpoints` gating the Restore button) can branch
    // on them.
    features,
    // Session metadata surface (cost/tokens/resume)
    sessionInfo,
    isResumed,
    // True while the initial `chatListMessages` backfill is still in
    // flight on a resumed session. Panel uses this to defer showing
    // the empty-state splash until we know whether the session really
    // has no messages.
    isLoadingHistory,
    // LSP status surface — only populated for codingAgent sessions,
    // where the sidecar drives a per-session typescript-language-server.
    lspStatus,
    // Codebase-analysis readiness pushed via `session_state`. Replaces
    // the legacy `useCodebaseReadiness` polling hook for session views.
    codebaseReadiness,
    // Most recent mid-turn-judge verdict for the current turn. Null
    // when the judge hasn't run on this turn, or cleared on next
    // user send. Panel consumes this to render a compact chip.
    lastJudgeVerdict,
    // Phase 0.5 — auto-mode routing snapshot for the current turn.
    // Populated on each `auto_mode_routing` event from the server.
    // Null on manual single-model turns (most users, most of the
    // time). Chat header reads `.reason` to render an inline hint.
    autoModeRouting,
    // Git-worktree surface. `worktree` is null for spec-mode sessions,
    // for sessions where provisioning failed, and before the first
    // worktree_event lands. `worktreeBlocked` gates Send when a
    // resume-time merge surfaced conflicts.
    worktree,
    worktreeBlocked,
    worktreeStatus,
    // Latest read-only probe of whether the worktree is behind its
    // parent branch. Drives the "Pull from parent" button's disable
    // state. Null = not yet probed; treat as enabled to allow a
    // first-click that self-corrects.
    worktreeBehind,
    checkWorktreeBehind,
    // Read-only probe of how many commits the worktree branch has
    // beyond its parent. Used to gate the Done button — null/-1 are
    // both treated as "leave the button visible" so a probe that
    // hasn't returned yet doesn't hide the affordance.
    worktreeAheadCount,
    checkWorktreeAhead,
    // Finish pipeline progress — reduced from streaming finish_event
    // envelopes. Panel renders one card per stage with the Stop button
    // while running, conflict buttons on a conflict, and result buttons
    // on failure.
    finishPipeline,
    finishSession,
    mergeFinishedSession,
    stopFinishStage,
    abandonSession,
    archiveSession,
    refreshWorktreeNow,
    // Pagination over the durable UI history. The visible `messages`
    // array is a bounded sliding window (WINDOW_MAX entries); the
    // server keeps the full transcript on disk.
    hasMoreOlder,
    hasMoreNewer,
    isLoadingOlder,
    isLoadingNewer,
    loadOlderMessages,
    loadNewerMessages,
    jumpToTail,
    // Three-axis state surfaced for the AgentAxisSelector dropdowns
    // and the PatternStrip overlay. All driven off SessionSnapshot, so
    // these are read-only mirrors of server state — there is no
    // optimistic-update path on the client.
    permissionMode,
    modelMode,
    patternMode,
    resolvedPattern,
    currentStepId,
    currentStepIter,
    currentStepFinished,
    setPermissionMode,
    setModelMode,
    setPatternMode,
    setBranchMode,
  };
}
