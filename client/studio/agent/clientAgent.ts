/**
 * Phase 3b — the coding agent, running CLIENT-SIDE over window.UglyNative.
 *
 * The studio chat (useCodingAgentChat) was built for a server that runs the
 * agent loop and streams `codingAgent:event` messages back. With no sidecar, we
 * run the loop in the browser instead and emit the SAME event protocol so the
 * unchanged chat UI renders the conversation + tool activity:
 *   - assistant turns:  { role:'assistant', parts:[{text}|{tool_call}|{finish}] }
 *   - tool results:     { role:'tool', parts:[{tool_result}] }
 *   - turn end:         a peer_event carrying original.type 'agent_finished'
 * (the user message is added optimistically by the hook, so we don't re-emit it).
 *
 * AI comes from ugly.bot via the project's own /api/agentStep endpoint (textGen
 * with the agent tool specs); tools execute over native.fs / native.process via
 * the shared dispatcher.
 */

import { dispatchTool } from '../../agent/tools';
import type { AgentMessage } from '../../../shared/agent';

type Emit = (msg: { type: string; [k: string]: unknown }) => void;

// Per-session conversation history (the model's view), keyed by sessionId.
const histories = new Map<string, AgentMessage[]>();
const rid = (): string => 'msg_' + Math.random().toString(36).slice(2, 11);

interface Part {
  type: 'text' | 'tool_call' | 'tool_result' | 'finish';
  data?: Record<string, unknown>;
}

function emitMessage(emit: Emit, sessionId: string, role: string, parts: Part[]): void {
  emit({
    type: 'codingAgent:event',
    sessionId,
    event: {
      type: 'message',
      payload: { type: 'created', payload: { id: rid(), role, parts, created_at: Date.now() } },
    },
  });
}

async function callModel(messages: AgentMessage[]): Promise<AgentMessage> {
  const res = await fetch('/api/agentStep', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ input: { messages } }),
  });
  const json = (await res.json()) as { result?: { message: AgentMessage }; error?: string };
  if (json.error) throw new Error(json.error);
  if (!json.result?.message) throw new Error('no response from model');
  return json.result.message;
}

const MAX_STEPS = 12;

/** Run one user turn to completion (model ↔ tools), streaming studio events. */
export async function runClientAgentTurn(
  sessionId: string,
  userText: string,
  emit: Emit,
): Promise<void> {
  const history = histories.get(sessionId) ?? [];
  history.push({ role: 'user', content: userText });

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const assistant = await callModel(history);
      const blocks = Array.isArray(assistant.content)
        ? assistant.content
        : [{ type: 'text' as const, text: String(assistant.content) }];

      const parts: Part[] = [];
      const toolUses: { id: string; name: string; input: unknown }[] = [];
      for (const blk of blocks as Array<Record<string, unknown>>) {
        if (blk.type === 'text' && blk.text) {
          parts.push({ type: 'text', data: { text: String(blk.text) } });
        } else if (blk.type === 'tool_use') {
          parts.push({
            type: 'tool_call',
            // The studio renders tool_call.input as a string (JSON args), not an object.
            data: {
              id: blk.id,
              name: blk.name,
              input: typeof blk.input === 'string' ? blk.input : JSON.stringify(blk.input ?? {}),
              finished: true,
            },
          });
          toolUses.push({ id: String(blk.id), name: String(blk.name), input: blk.input });
        }
      }
      parts.push({ type: 'finish' });
      emitMessage(emit, sessionId, 'assistant', parts);
      history.push(assistant);

      if (toolUses.length === 0) break; // text-only turn → done

      const results: AgentMessage['content'] = [];
      for (const tu of toolUses) {
        let content: string;
        let isError = false;
        try {
          content = await dispatchTool(tu.name, tu.input);
        } catch (e) {
          content = 'Error: ' + (e as Error).message;
          isError = true;
        }
        emitMessage(emit, sessionId, 'tool', [
          { type: 'tool_result', data: { tool_call_id: tu.id, content, is_error: isError } },
        ]);
        results.push({ type: 'tool_result', tool_use_id: tu.id, content });
      }
      history.push({ role: 'user', content: results });
    }
  } catch (e) {
    emitMessage(emit, sessionId, 'assistant', [
      { type: 'text', data: { text: '⚠ ' + (e as Error).message } },
      { type: 'finish' },
    ]);
  } finally {
    histories.set(sessionId, history);
    // Turn end → the authoritative "turn complete" signal that stops the spinner:
    // an agent_event with inner type 'agent_finished'.
    emit({
      type: 'codingAgent:event',
      sessionId,
      event: { type: 'agent_event', payload: { payload: { type: 'agent_finished' } } },
    });
  }
}
