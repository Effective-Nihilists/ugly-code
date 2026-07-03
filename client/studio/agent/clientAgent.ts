/**
 * Phase 4 — the coding agent as a thin ADAPTER over the standardized framework
 * loop (`ugly-app/agent`). Runs CLIENT-SIDE over window.UglyNative; the model
 * call goes to the project's own `/api/agentTurn` (the framework agent handler);
 * tools execute locally over native.fs / native.process.
 *
 * It maps the framework runAgent's callbacks onto the studio chat's existing
 * `codingAgent:event` protocol (unchanged), and additionally:
 *   - establishes per-turn token/cost TELEMETRY in the chat (a `session_state`
 *     snapshot — best-effort, wrapped so a consumer error can't break the loop),
 *   - writes the COMPLETE, uncompacted session history to a local FS JSONL log
 *     (`<project>/.ugly-studio/sessions/<sessionId>.jsonl`) — the debug artifact,
 *     unaffected by compaction.
 */

import {
  runAgent,
  emptyTelemetryTotals,
  type AgentController,
  type AgentMessage,
  type MsgTelemetry,
  type RunAgentSocket,
} from 'ugly-app/agent/client';
import { dispatchTool } from '../../agent/tools';
import { registeredToolSpecs } from '../../agent/tools/registry';
import type { StepFn } from '../../agent/engine';
import {
  AGENT_TOOLS,
  AGENT_TOOL_NAMES,
  AGENT_SYSTEM_PROMPT,
  AGENT_DEFAULT_MODEL,
} from '../../../shared/agent';
import { getActiveProjectPath } from '../projectPath';
import { SessionLog } from './sessionLog';
import {
  sessionApi,
  resolveProjectId,
  planCompaction,
  reconstructResumeContext,
  type ActiveRow,
  type StoredRole,
  type ToolResultPayload,
  type ToolRowPayload,
} from './serverSessionApi';
import { assistantParts, type Part } from './sessionDisplay';
import { ensureSessionWorkspace, getSessionWorkspace } from './sessionWorkspace';
import type { ReasoningEffort, SessionSnapshot } from '../shared/api';
import { composeSessionSnapshot, type PerModelAcc } from './sessionSnapshot';
export { composeSessionSnapshot };
import { startCodebasePoll, stopCodebasePoll, fetchArchitectureDoc } from './codebaseReadiness';

type Emit = (msg: { type: string; [k: string]: unknown }) => void;

/**
 * The user-controlled session axes the chat header surfaces. The client agent
 * runs a single CONCRETE model — it has no auto-router / pattern engine — so
 * `modelMode` and `patternMode` are passthrough state: it must echo the user's
 * picks back in every `session_state` snapshot or the chat header silently
 * resets them each turn (picked deepseek_v4_flash → flipped to sonnet; pattern
 * "none" → flipped to "auto"). Plumbed in from useSocket via the coding task.
 */
export interface AgentSelection {
  model?: string;
  reasoningEffort?: ReasoningEffort;
  permissionMode?: SessionSnapshot['permissionMode'];
  modelMode?: SessionSnapshot['modelMode'];
  patternMode?: SessionSnapshot['patternMode'];
}

const rid = (): string => 'msg_' + Math.random().toString(36).slice(2, 11);

/** A socket shim: the framework loop's requests go to the project's /api/*. */
const fetchSocket: RunAgentSocket = {
  async request(name, input, opts) {
    const res = await fetch('/api/' + name, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ input }),
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
    const json = (await res.json()) as { result?: unknown; error?: string };
    if (json.error) throw new Error(json.error);
    return json.result;
  },
  // No hub/trackDocs over the native bridge — instead we stream the agent's
  // frames over the agentTurn HTTP response (the framework's SSE mode). Each
  // `data:` line is an agent frame; a terminal `__result__`/`__error__` frame
  // carries the authoritative turn. runAgent prefers this when present.
  async requestStream(name, input, onFrame, opts) {
    const res = await fetch('/api/' + name, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      credentials: 'include',
      body: JSON.stringify({ input }),
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
    if (!res.ok || !res.body) {
      // Fall back to the buffered turn if streaming isn't available.
      const json = (await res.json().catch(() => ({}))) as { result?: unknown; error?: string };
      if (json.error) throw new Error(json.error);
      return json.result;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let result: unknown;
    let done = false;
    while (!done) {
      const { value, done: rdone } = await reader.read();
      if (rdone) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trimStart();
        if (!data) continue;
        let frame: { type?: string; result?: unknown; error?: string };
        try {
          frame = JSON.parse(data) as typeof frame;
        } catch {
          continue;
        }
        if (frame.type === '__result__') {
          result = frame.result;
          done = true;
          break;
        }
        if (frame.type === '__error__') {
          throw new Error(frame.error ?? 'agent turn failed');
        }
        onFrame(frame);
      }
    }
    return result;
  },
  trackDocs: () => () => {/* noop */},
};

// Per-session tool handlers. They resolve the session's workspace at CALL time:
// a worktree-isolated session runs its fs ops + run_command in its own worktree
// dir (with its PORT), while the main session falls back to the open project
// (relative paths pass through, unchanged behavior). getSessionWorkspace is sync
// (cached); ensureSessionWorkspace runs once up-front per session (see below).
function makeToolHandlers(sessionId: string): Record<string, (input: unknown) => Promise<string>> {
  // Core tools (legacy inline switch) + every registered tool — both dispatch
  // through dispatchTool, which routes the registry first.
  const names = [...AGENT_TOOL_NAMES, ...registeredToolSpecs().map((s) => s.name)];
  return Object.fromEntries(
    names.map((n) => [
      n,
      (input: unknown) => {
        const ws = getSessionWorkspace(sessionId);
        const dir = ws?.isWorktree ? ws.dir : getActiveProjectPath();
        return dispatchTool(n, input, {
          sessionId,
          projectDir: dir,
          mode: 'edit',
          // Model-call for subagents (delegate/agent): one turn via the same
          // agentStep endpoint the main loop uses.
          step: ((req: unknown) =>
            fetchSocket.request('agentStep', req)) as unknown as StepFn,
          ...(ws?.isWorktree ? { workspaceDir: ws.dir } : {}),
          ...(ws?.port ? { port: ws.port } : {}),
          ...(ws?.databaseUrl ? { databaseUrl: ws.databaseUrl } : {}),
        });
      },
    ]),
  );
}

interface SessionAgentState {
  controller: AgentController;
  emitRef: { current: Emit };
  log: SessionLog;
  // Cumulative telemetry across the session (for the chat header + sidebar).
  cost: number;
  promptTokens: number;
  completionTokens: number;
  messageCount: number;
  perModel: Map<string, PerModelAcc>;
  createdAt: number;
  // Live-streaming state for the in-flight assistant turn: the stable bubble id
  // (null until the first token) + accumulated text, so onText updates one
  // message in place and onTurn finalizes it.
  streamMsgId: string | null;
  streamText: string;
  // ── Server persistence (survive reload) ──
  // Append-only transcript bookkeeping: `seq` is the next row index; `activeRows`
  // is the ordered set of currently-uncompacted rows ({seq,id}) — it MUST mirror
  // runAgent's working-context message order so compaction drops the same window.
  seq: number;
  activeRows: ActiveRow[];
  projectId: string;
  title: string;
  titleSet: boolean;
  resumed: boolean;
  /** The first user message (the task), pinned verbatim into every compaction
   *  summary so the original instruction is never lost to the context window. */
  taskText: string;
  // ── User-selected axes (drive the run + echoed in every session_state) ──
  // `model` is authoritative for the runAgent loop (read live each turn via a
  // getter on its config); the rest are passthrough state the header reads back.
  model: string;
  reasoningEffort: ReasoningEffort;
  permissionMode: SessionSnapshot['permissionMode'];
  modelMode: SessionSnapshot['modelMode'];
  patternMode: SessionSnapshot['patternMode'];
}

// Codebase analysis (semantic index + architecture doc) runs per SESSION, decoupled from the
// agent controller, so the header pill tracks indexing the moment the session task BOOTS — not
// on the first turn (the old coupling left a freshly-opened session's pill stuck on "loading"
// until the user sent a message, which never happens if they're waiting for it to be "ready").
// Keyed by sessionId; lives for the task process. See `ensureCodebaseAnalysis`.
const codebaseReadinessBySession = new Map<string, SessionSnapshot['codebaseReadiness']>();
const architectureDocBySession = new Map<string, string>();

/** Fold a (partial) user selection onto the session state. Called on create and
 *  on every subsequent turn so a mid-session model/mode swap takes effect. */
function applySelection(s: SessionAgentState, sel?: AgentSelection): void {
  if (!sel) return;
  if (sel.model) s.model = sel.model;
  if (sel.reasoningEffort) s.reasoningEffort = sel.reasoningEffort;
  if (sel.permissionMode) s.permissionMode = sel.permissionMode;
  if (sel.modelMode) s.modelMode = sel.modelMode;
  if (sel.patternMode) s.patternMode = sel.patternMode;
}

// composeSessionSnapshot moved to ./sessionSnapshot (shared with the renderer's
// getCodingAgentSnapshot); re-exported above.

/**
 * Build the compaction summary. Compaction replaces the oldest turns with this
 * text in the model's working context, so it MUST carry forward (a) the original
 * task verbatim and (b) a log of what was already done — otherwise a long session
 * forgets its goal. Structural (no extra AI call): the task + a bulleted trail of
 * the assistant's text + tool calls from the dropped turns.
 */
function buildCompactionSummary(taskText: string, dropped: AgentMessage[]): string {
  const trail: string[] = [];
  for (const m of dropped) {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type === 'text' && b.text?.trim()) {
        trail.push(`• ${b.text.trim().replace(/\s+/g, ' ').slice(0, 200)}`);
      } else if (b.type === 'tool_use') {
        const arg =
          typeof b.input === 'object' && b.input
            ? (Object.values(b.input as Record<string, unknown>).find((v) => typeof v === 'string'))
            : undefined;
        trail.push(`• ran ${b.name}${arg ? `(${arg.slice(0, 80)})` : ''}`);
      }
    }
  }
  const parts = ['[Earlier turns were compacted to stay within the context window.]'];
  if (taskText) parts.push(`\nOriginal task:\n${taskText.slice(0, 1000)}`);
  if (trail.length) parts.push(`\nWork done so far (most recent last):\n${trail.slice(-50).join('\n')}`);
  return parts.join('\n');
}

const sessions = new Map<string, SessionAgentState>();

function safeEmit(emit: Emit, msg: { type: string; [k: string]: unknown }): void {
  try {
    emit(msg);
  } catch (e) {
    console.error('[clientAgent] emit failed (ignored)', e);
  }
}

function emitMessage(
  emit: Emit,
  sessionId: string,
  role: string,
  parts: Part[],
  opts: { id?: string; action?: 'created' | 'updated'; model?: string } = {},
): void {
  safeEmit(emit, {
    type: 'codingAgent:event',
    sessionId,
    event: {
      type: 'message',
      payload: {
        type: opts.action ?? 'created',
        // `model` (when known) drives the per-message model badge in the chat.
        payload: {
          id: opts.id ?? rid(),
          role,
          parts,
          created_at: Date.now(),
          ...(opts.model ? { model: opts.model } : {}),
        },
      },
    },
  });
}


// ── Server persistence helpers (all best-effort; never break the loop) ───────

/** Append one transcript row + track its seq/id for the compaction window. */
function persistRow(s: SessionAgentState, sessionId: string, role: StoredRole, payload: unknown): string {
  const seq = s.seq++;
  const id = `${sessionId}:${seq}`;
  s.activeRows.push({ seq, id });
  void sessionApi.appendMessage({ sessionId, seq, role, content: JSON.stringify(payload) });
  return id;
}

/**
 * Persist a compaction structurally: flag the oldest `droppedCount` active rows
 * compacted + insert one summary row at the dropped block's seq. Mirrors
 * runAgent's in-loop `[summary, ...recent]` exactly, so the server's "normal"
 * query == the model's post-compaction working context (no re-compaction on
 * reload). Summary `_id`/seq reuse the boundary seq → idempotent across reloads.
 */
function persistCompaction(s: SessionAgentState, sessionId: string, droppedCount: number, summaryText: string): void {
  const plan = planCompaction(s.activeRows, droppedCount, sessionId);
  if (!plan) return;
  s.activeRows = plan.newActiveRows;
  void sessionApi.compact({
    sessionId,
    droppedIds: plan.droppedIds,
    summaryId: plan.summaryId,
    summarySeq: plan.summarySeq,
    summaryText,
  });
}

/** Upsert the session metadata row (title/status/tokens/cost). */
function persistMeta(s: SessionAgentState, sessionId: string, status: 'running' | 'idle' | 'done' | 'error'): void {
  if (!s.projectId) return;
  void sessionApi.upsert({
    sessionId,
    projectId: s.projectId,
    title: s.title,
    model: s.model,
    status,
    messageCount: s.messageCount,
    costUsd: s.cost,
  });
}

/**
 * Lazily reconstruct a prior session into the live controller on the first turn
 * after a reload. Loads the "normal" transcript (compaction excluded) — which is
 * exactly runAgent's post-compaction working context — and seeds it via
 * controller.resume so the next turn continues with full context, no recompaction.
 */
async function ensureResumed(s: SessionAgentState, sessionId: string): Promise<void> {
  if (s.resumed) return;
  s.resumed = true;
  s.projectId = await resolveProjectId(getActiveProjectPath());
  const data = await sessionApi.listMessages({ sessionId, limit: 2000 });
  const rows = data?.messages ?? [];
  if (rows.length === 0) return; // brand-new session — nothing to resume
  // Restore cumulative metadata so the next persistMeta doesn't regress the
  // stored messageCount/costUsd (the in-memory accumulators restart at 0).
  const listed = await sessionApi.list({ projectId: s.projectId });
  const meta = listed?.sessions.find((x) => x.sessionId === sessionId);
  if (meta) {
    s.messageCount = meta.messageCount;
    s.cost = meta.costUsd;
    if (meta.title) {
      s.title = meta.title;
      s.titleSet = true;
    }
  }
  const { messages, activeRows, nextSeq } = reconstructResumeContext(rows, sessionId);
  s.activeRows = activeRows;
  s.seq = nextSeq;
  s.titleSet = true; // a resumed session already has its title
  // Restore the pinned task so post-reload compaction still preserves it: the
  // first user row, or (if already compacted) parsed back out of the summary.
  if (!s.taskText) {
    const firstUser = rows.find((r) => r.role === 'user' && r.kind === 'message');
    if (firstUser) {
      try { s.taskText = String(JSON.parse(firstUser.content)); } catch { /* ignore */ }
    } else {
      const summaryRow = rows.find((r) => r.kind === 'summary');
      if (summaryRow) {
        try {
          const m = /Original task:\n([\s\S]*?)(?:\n\n|$)/.exec(String(JSON.parse(summaryRow.content)));
          if (m) s.taskText = m[1];
        } catch { /* ignore */ }
      }
    }
  }

  // (Row→message mapping + interrupted-ending healing now live in
  // reconstructResumeContext above, so they're unit-tested.)
  try {
    await s.controller.resume({
      sessionId,
      model: s.model,
      messages,
      status: 'idle',
      updatedAt: Date.now(),
      telemetryTotals: emptyTelemetryTotals(),
    });
  } catch (e) {
    // Resume is best-effort context seeding — a failure must NOT swallow the
    // user's turn. Log and continue; the send below still runs.
    console.error('[clientAgent] resume failed (continuing without prior context)', e);
  }
}

/** Fold one turn's usage into the session accumulators. */
function accrue(s: SessionAgentState, t: MsgTelemetry): void {
  const model = t.model ?? s.model;
  const input = t.inputTokens ?? 0;
  const output = t.outputTokens ?? 0;
  const cost = t.costUsd ?? 0;
  s.cost += cost;
  s.promptTokens += input;
  s.completionTokens += output;
  const pm = s.perModel.get(model) ?? {
    model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, cost: 0, turnCount: 0,
  };
  pm.inputTokens += input;
  pm.outputTokens += output;
  pm.cost += cost;
  pm.turnCount += 1;
  s.perModel.set(model, pm);
}

/**
 * Emit a `session_state` snapshot so the chat header + session sidebar show
 * live tokens/cost (today they read 0). Non-token fields mirror the chat hook's
 * initial defaults so we change ONLY the telemetry (no clobbering); the whole
 * thing is best-effort via safeEmit.
 */
function emitTelemetry(s: SessionAgentState, sessionId: string): void {
  const snap = composeSessionSnapshot({
    sessionId,
    cwd: getActiveProjectPath() ?? '',
    createdAt: s.createdAt,
    updatedAt: Date.now(),
    model: s.model,
    reasoningEffort: s.reasoningEffort,
    permissionMode: s.permissionMode,
    modelMode: s.modelMode,
    patternMode: s.patternMode,
    cost: s.cost,
    promptTokens: s.promptTokens,
    completionTokens: s.completionTokens,
    perModel: [...s.perModel.values()],
    messageCount: s.messageCount,
  });
  // Fold in the latest codebase readiness (the indexer poll updates the per-session map and
  // re-emits) so every session_state carries it too — applySnapshot only reads what's present.
  const readiness = codebaseReadinessBySession.get(sessionId);
  if (readiness !== undefined) snap.codebaseReadiness = readiness;
  safeEmit(s.emitRef.current, {
    type: 'codingAgent:event',
    sessionId,
    event: { type: 'session_state', payload: { payload: snap } },
  });
}

/**
 * Start (idempotently) the host's semantic index + architecture analysis for this session's
 * project and stream readiness to the viewer as a standalone `codebase_readiness` event.
 *
 * Called BOTH at task boot (coding-task) and from getOrCreate, so the header's codebase pill
 * tracks indexing whether or not the user has sent a turn yet. `startCodebasePoll` is keyed by
 * sessionId and no-ops if already running, so the two call sites can't double-poll.
 *
 * The event carries ONLY readiness (never a full session_state snapshot): a boot-time snapshot
 * would zero-out cost/tokens and clobber a resumed session's live telemetry header while the
 * indexer runs. session_state still folds readiness in during turns (emitTelemetry) for the
 * mount-snapshot path.
 */
export function ensureCodebaseAnalysis(sessionId: string, emit: Emit): void {
  const cwd = getActiveProjectPath() ?? '';
  startCodebasePoll(sessionId, cwd, (r) => {
    codebaseReadinessBySession.set(sessionId, r as SessionSnapshot['codebaseReadiness']);
    safeEmit(emit, {
      type: 'codingAgent:event',
      sessionId,
      event: { type: 'codebase_readiness', payload: { payload: r } },
    });
    // Once the architecture doc is ready, fetch it once (injected via the systemPrompt getter).
    if (!architectureDocBySession.has(sessionId) && r.architecture?.status === 'ready') {
      void fetchArchitectureDoc(cwd).then((doc) => {
        if (doc) architectureDocBySession.set(sessionId, doc);
      });
    }
  });
}

function getOrCreate(sessionId: string, emit: Emit, selection?: AgentSelection): SessionAgentState {
  const existing = sessions.get(sessionId);
  if (existing) {
    existing.emitRef.current = emit;
    applySelection(existing, selection);
    return existing;
  }
  const emitRef = { current: emit };
  const state: SessionAgentState = {
    controller: undefined as unknown as AgentController,
    emitRef,
    log: new SessionLog(sessionId, getActiveProjectPath()),
    cost: 0,
    promptTokens: 0,
    completionTokens: 0,
    messageCount: 0,
    perModel: new Map(),
    createdAt: Date.now(),
    streamMsgId: null,
    streamText: '',
    seq: 0,
    activeRows: [],
    projectId: '',
    title: '',
    titleSet: false,
    resumed: false,
    taskText: '',
    // Selection defaults — overwritten by `selection` (and any subsequent
    // turn's selection) via applySelection. Default to the framework model so a
    // session that somehow arrives without a pick still runs.
    model: AGENT_DEFAULT_MODEL,
    reasoningEffort: 'medium',
    permissionMode: 'edit',
    modelMode: { kind: 'auto' },
    patternMode: 'auto',
  };
  applySelection(state, selection);
  state.log.append({ ts: Date.now(), type: 'session_start', sessionId, model: state.model });

  // Kick off (idempotently) the host's semantic index + architecture doc and stream readiness
  // to the header pill. Also runs at task boot (coding-task) so the pill fills in BEFORE the
  // first turn — see ensureCodebaseAnalysis.
  ensureCodebaseAnalysis(sessionId, emitRef.current);

  state.controller = runAgent({
    socket: fetchSocket,
    sessionId,
    // Live getter: runAgent reads `config.model` afresh on every turn request,
    // so a mid-session model swap (applySelection on the next send) takes effect
    // without rebuilding the controller. This is what actually routes the turn
    // to the user's pick (e.g. deepseek_v4_flash) instead of the default.
    get model() {
      return state.model;
    },
    // Live getter (read per turn, like model): once the host's architecture analysis is
    // ready we fetch ARCHITECTURE.md and append it as a codebase map, so the agent gets
    // structural context up front without spending turns reading files.
    get systemPrompt() {
      const architectureDoc = architectureDocBySession.get(sessionId);
      return architectureDoc
        ? `${AGENT_SYSTEM_PROMPT}\n\n# Project architecture (auto-generated map — exports, types, inheritance)\n\n${architectureDoc}`
        : AGENT_SYSTEM_PROMPT;
    },
    tools: [...AGENT_TOOLS, ...registeredToolSpecs()],
    toolHandlers: makeToolHandlers(sessionId),
    budget: { maxTurns: 12 },
    // Pin the task + a work-log into every summary so a long session never loses
    // its original instruction (the system prompt is sent separately and is never
    // compacted; this preserves the user's goal across compactions).
    compaction: {
      maxContextTokens: 120_000,
      keepRecentTurns: 8,
      summarize: (dropped) => Promise.resolve(buildCompactionSummary(state.taskText, dropped)),
    },
    // Live token streaming: create the assistant bubble on the first token, then
    // update it in place as text arrives (onTurn finalizes it authoritatively).
    onText: (_msgId, delta) => {
      state.streamText += delta;
      const parts: Part[] = [{ type: 'text', data: { text: state.streamText } }];
      if (!state.streamMsgId) {
        state.streamMsgId = rid();
        emitMessage(emitRef.current, sessionId, 'assistant', parts, { id: state.streamMsgId, action: 'created' });
      } else {
        emitMessage(emitRef.current, sessionId, 'assistant', parts, { id: state.streamMsgId, action: 'updated' });
      }
    },
    onTurn: (turn, telemetry) => {
      const content = Array.isArray(turn.content)
        ? turn.content
        : [{ type: 'text' as const, text: turn.content }];
      // The model that produced this turn — drives the per-message badge.
      const model = telemetry?.model;
      const modelOpt = model ? { model } : {};
      // Finalize the streamed bubble in place (same id) when we streamed text;
      // otherwise (tool-only turn) emit a fresh bubble.
      if (state.streamMsgId) {
        emitMessage(emitRef.current, sessionId, 'assistant', assistantParts(content), {
          id: state.streamMsgId,
          action: 'updated',
          ...modelOpt,
        });
      } else {
        emitMessage(emitRef.current, sessionId, 'assistant', assistantParts(content), modelOpt);
      }
      state.streamMsgId = null;
      state.streamText = '';
      state.messageCount += 1;
      state.log.append({ ts: Date.now(), type: 'assistant', content, ...(telemetry ? { telemetry } : {}) });
      // Persist the assistant turn verbatim (one row, matches one working-context
      // message) — content + model so the badge survives reload.
      persistRow(state, sessionId, 'assistant', { content, ...modelOpt });
      if (telemetry) {
        accrue(state, telemetry);
        state.log.append({ ts: Date.now(), type: 'telemetry', telemetry });
        emitTelemetry(state, sessionId);
      }
      persistMeta(state, sessionId, 'running');
    },
    onEvent: (e) => {
      if (e.type === 'tool_result') {
        // Emit ONE studio message per result (live UI is unchanged), but persist
        // ALL of a turn's results as ONE row — runAgent folds them into a single
        // working-context message, so the server transcript must too (keeps the
        // compaction seq-mapping exact).
        const bundle: ToolResultPayload[] = [];
        for (const r of e.results) {
          if (r.type !== 'tool_result') continue;
          const content = r.content;
          const isError = content.startsWith('Error:');
          emitMessage(emitRef.current, sessionId, 'tool', [
            { type: 'tool_result', data: { tool_call_id: r.tool_use_id, content, is_error: isError } },
          ]);
          state.messageCount += 1;
          state.log.append({ ts: Date.now(), type: 'tool_result', tool_use_id: r.tool_use_id, content, is_error: isError });
          bundle.push({ tool_use_id: r.tool_use_id, content, is_error: isError });
        }
        if (bundle.length > 0) {
          persistRow(state, sessionId, 'tool', { results: bundle } satisfies ToolRowPayload);
        }
      } else if (e.type === 'compaction') {
        state.log.append({ ts: Date.now(), type: 'compaction', droppedCount: e.droppedCount, ...(e.summary ? { summary: e.summary } : {}) });
        if (e.summary) persistCompaction(state, sessionId, e.droppedCount, e.summary);
      } else if (e.type === 'error') {
        emitMessage(emitRef.current, sessionId, 'assistant', [
          { type: 'text', data: { text: '⚠ ' + e.message } },
          { type: 'finish' },
        ]);
        state.log.append({ ts: Date.now(), type: 'error', message: e.message });
      }
      if (e.type === 'done' || e.type === 'error' || e.type === 'aborted' || e.type === 'budget_exceeded') {
        state.log.append({ ts: Date.now(), type: 'finish', reason: e.type });
        persistMeta(state, sessionId, e.type === 'error' ? 'error' : 'idle');
        safeEmit(emitRef.current, {
          type: 'codingAgent:event',
          sessionId,
          event: { type: 'agent_event', payload: { payload: { type: 'agent_finished' } } },
        });
      }
    },
  });

  sessions.set(sessionId, state);
  return state;
}

/**
 * Provision the session's isolated workspace before its first turn, streaming
 * worktree-create + dependency-install progress into the chat as one updating
 * bubble. Resolves immediately for the main session (no worktree) or once cached.
 */
async function ensureWorkspaceStep(sessionId: string, emit: Emit): Promise<void> {
  if (getSessionWorkspace(sessionId)) return; // already provisioned
  const progressId = rid();
  let created = false;
  const label: Record<string, string> = {
    creating: 'Setting up isolated workspace',
    installing: 'Installing dependencies',
    ready: 'Workspace ready',
    error: 'Workspace',
  };
  await ensureSessionWorkspace(sessionId, getActiveProjectPath(), (stage, text) => {
    emitMessage(
      emit,
      sessionId,
      'assistant',
      [{ type: 'text', data: { text: `${label[stage] ?? 'Workspace'}\n\n${text}` } }, { type: 'finish' }],
      { id: progressId, action: created ? 'updated' : 'created' },
    );
    created = true;
  });
}

/** Run one user turn to completion (model ↔ tools), streaming studio events. */
export async function runClientAgentTurn(
  sessionId: string,
  userText: string,
  emit: Emit,
  selection?: AgentSelection,
): Promise<void> {
  const state = getOrCreate(sessionId, emit, selection);
  // Provision the session's isolated workspace (worktree + deps install) before
  // the first turn so the agent's tools operate in it. Streams progress into the
  // chat; a no-op for the main session (runs on the project) or once cached.
  await ensureWorkspaceStep(sessionId, emit);
  // On the first turn after a reload, rebuild the prior context into the live
  // controller before sending (no-op for a brand-new session).
  await ensureResumed(state, sessionId);
  state.messageCount += 1;
  state.log.append({ ts: Date.now(), type: 'user', text: userText });
  if (!state.taskText) state.taskText = userText; // pin the original task for summaries
  if (!state.titleSet) {
    state.title = userText.slice(0, 120);
    state.titleSet = true;
  }
  const userMsgId = persistRow(state, sessionId, 'user', userText);
  // Emit the user prompt as a task event so OTHER devices viewing this session render it
  // live. Only assistant + tool messages were emitted, so a remote viewer saw the replies
  // with no prompt above them. Uses the persisted row id, so a later history reload dedupes;
  // the sender already shows an optimistic bubble and its reconciliation adopts this id.
  emitMessage(emit, sessionId, 'user', [{ type: 'text', data: { text: userText } }], {
    id: userMsgId,
    action: 'created',
  });
  persistMeta(state, sessionId, 'running');
  await state.controller.send(userText);
}

/** Cancel the in-flight turn for a session (the chat's Stop button). */
export function abortClientAgent(sessionId: string): void {
  sessions.get(sessionId)?.controller.abort();
}

/**
 * `/clear`: discard this session's in-memory agent context so the conversation
 * starts fresh WITHOUT tearing down the worktree. We abort any in-flight turn,
 * dispose the runAgent controller, and drop the session entry — the next turn
 * rebuilds it via getOrCreate (seq back to 0, empty history) and `ensureResumed`
 * re-reads the persisted transcript, which the caller wipes server-side in the
 * same `/clear`. The provisioned workspace (separate map) is untouched, so no
 * worktree re-provision on the next message.
 */
export function clearClientAgentSession(sessionId: string): void {
  // Stop the poll first — it can be running from a boot-time ensureCodebaseAnalysis even when
  // no turn (and so no session state) exists yet. The readiness/architecture maps are kept:
  // the project is unchanged, so the pill stays accurate and the next turn reuses them.
  stopCodebasePoll(sessionId);
  const s = sessions.get(sessionId);
  if (!s) return;
  try { s.controller.abort(); } catch { /* no in-flight turn */ }
  try { s.controller.dispose(); } catch { /* already torn down */ }
  sessions.delete(sessionId);
}
