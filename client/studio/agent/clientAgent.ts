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
  type AgentController,
  type ContentPart,
  type MsgTelemetry,
  type RunAgentSocket,
} from 'ugly-app/agent/client';
import { dispatchTool } from '../../agent/tools';
import {
  AGENT_TOOLS,
  AGENT_TOOL_NAMES,
  AGENT_SYSTEM_PROMPT,
  AGENT_DEFAULT_MODEL,
} from '../../../shared/agent';
import { getActiveProjectPath } from '../hooks/useSocket';
import { SessionLog } from './sessionLog';

type Emit = (msg: { type: string; [k: string]: unknown }) => void;
type Part = { type: 'text' | 'tool_call' | 'tool_result' | 'finish'; data?: Record<string, unknown> };

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
  // No live-frame channel over the native shim — the authoritative turn result
  // comes from the request response (onTurn).
  trackDocs: () => () => {},
};

const TOOL_HANDLERS: Record<string, (input: unknown) => Promise<string>> =
  Object.fromEntries(AGENT_TOOL_NAMES.map((n) => [n, (input: unknown) => dispatchTool(n, input)]));

interface PerModelAcc {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  cost: number;
  turnCount: number;
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
}

const sessions = new Map<string, SessionAgentState>();

function safeEmit(emit: Emit, msg: { type: string; [k: string]: unknown }): void {
  try {
    emit(msg);
  } catch (e) {
    console.error('[clientAgent] emit failed (ignored)', e);
  }
}

function emitMessage(emit: Emit, sessionId: string, role: string, parts: Part[]): void {
  safeEmit(emit, {
    type: 'codingAgent:event',
    sessionId,
    event: { type: 'message', payload: { type: 'created', payload: { id: rid(), role, parts, created_at: Date.now() } } },
  });
}

/** Build the studio `parts` array for an assistant turn from its content. */
function assistantParts(content: ContentPart[]): Part[] {
  const parts: Part[] = [];
  for (const blk of content) {
    if (blk.type === 'text' && blk.text) {
      parts.push({ type: 'text', data: { text: blk.text } });
    } else if (blk.type === 'tool_use') {
      parts.push({
        type: 'tool_call',
        // The studio renders tool_call.input as a JSON string, not an object.
        data: {
          id: blk.id,
          name: blk.name,
          input: typeof blk.input === 'string' ? blk.input : JSON.stringify(blk.input ?? {}),
          finished: true,
        },
      });
    }
  }
  parts.push({ type: 'finish' });
  return parts;
}

/** Fold one turn's usage into the session accumulators. */
function accrue(s: SessionAgentState, t: MsgTelemetry): void {
  const model = t.model ?? AGENT_DEFAULT_MODEL;
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
  const now = Date.now();
  const snap = {
    compositeId: sessionId,
    workspaceId: sessionId.split(':')[0] ?? '',
    sessionId: sessionId.split(':')[1] ?? sessionId,
    title: '',
    cwd: getActiveProjectPath() ?? '',
    createdAt: s.createdAt,
    updatedAt: now,
    mode: 'yolo' as const,
    model: AGENT_DEFAULT_MODEL,
    reasoningEffort: 'medium',
    supportsReasoning: false,
    permissionMode: 'edit' as const,
    modelMode: { kind: 'auto' as const },
    patternMode: 'auto' as const,
    resolvedPattern: null,
    currentStepId: null,
    currentStepIter: 0,
    currentStepFinished: false,
    worktree: null,
    worktreeBlocked: false,
    worktreeStatus: null,
    cost: s.cost,
    promptTokens: s.promptTokens,
    completionTokens: s.completionTokens,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    perModel: [...s.perModel.values()],
    messageCount: s.messageCount,
  };
  safeEmit(s.emitRef.current, {
    type: 'codingAgent:event',
    sessionId,
    event: { type: 'session_state', payload: { payload: snap } },
  });
}

function getOrCreate(sessionId: string, emit: Emit): SessionAgentState {
  const existing = sessions.get(sessionId);
  if (existing) {
    existing.emitRef.current = emit;
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
  };
  state.log.append({ ts: Date.now(), type: 'session_start', sessionId, model: AGENT_DEFAULT_MODEL });

  state.controller = runAgent({
    socket: fetchSocket,
    sessionId,
    model: AGENT_DEFAULT_MODEL,
    systemPrompt: AGENT_SYSTEM_PROMPT,
    tools: AGENT_TOOLS,
    toolHandlers: TOOL_HANDLERS,
    budget: { maxTurns: 12 },
    compaction: { maxContextTokens: 120_000, keepRecentTurns: 8 },
    onTurn: (turn, telemetry) => {
      const content = Array.isArray(turn.content)
        ? turn.content
        : [{ type: 'text' as const, text: String(turn.content) }];
      emitMessage(emitRef.current, sessionId, 'assistant', assistantParts(content));
      state.messageCount += 1;
      state.log.append({ ts: Date.now(), type: 'assistant', content, ...(telemetry ? { telemetry } : {}) });
      if (telemetry) {
        accrue(state, telemetry);
        state.log.append({ ts: Date.now(), type: 'telemetry', telemetry });
        emitTelemetry(state, sessionId);
      }
    },
    onEvent: (e) => {
      if (e.type === 'tool_result') {
        for (const r of e.results) {
          if (r.type !== 'tool_result') continue;
          const content = r.content;
          const isError = /^Error:/.test(content);
          emitMessage(emitRef.current, sessionId, 'tool', [
            { type: 'tool_result', data: { tool_call_id: r.tool_use_id, content, is_error: isError } },
          ]);
          state.messageCount += 1;
          state.log.append({ ts: Date.now(), type: 'tool_result', tool_use_id: r.tool_use_id, content, is_error: isError });
        }
      } else if (e.type === 'compaction') {
        state.log.append({ ts: Date.now(), type: 'compaction', droppedCount: e.droppedCount, ...(e.summary ? { summary: e.summary } : {}) });
      } else if (e.type === 'error') {
        emitMessage(emitRef.current, sessionId, 'assistant', [
          { type: 'text', data: { text: '⚠ ' + e.message } },
          { type: 'finish' },
        ]);
        state.log.append({ ts: Date.now(), type: 'error', message: e.message });
      }
      if (e.type === 'done' || e.type === 'error' || e.type === 'aborted' || e.type === 'budget_exceeded') {
        state.log.append({ ts: Date.now(), type: 'finish', reason: e.type });
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

/** Run one user turn to completion (model ↔ tools), streaming studio events. */
export async function runClientAgentTurn(
  sessionId: string,
  userText: string,
  emit: Emit,
): Promise<void> {
  const state = getOrCreate(sessionId, emit);
  state.messageCount += 1;
  state.log.append({ ts: Date.now(), type: 'user', text: userText });
  await state.controller.send(userText);
}

/** Cancel the in-flight turn for a session (the chat's Stop button). */
export function abortClientAgent(sessionId: string): void {
  sessions.get(sessionId)?.controller.abort();
}
