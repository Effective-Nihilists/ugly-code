// Shared `agentStep` request handler — used by BOTH server entries (Node
// `server/index.ts` and the deployed Cloudflare Worker `server/workers.ts`) so the
// endpoint can't drift or be missing from the deploy (it was previously only in
// the Node entry, so code.ugly.bot never served it — breaking the pattern engine's
// classifier / judge / synthesis / picker aux calls).
//
// Two modes:
//   • tool step (default) — the legacy client-driven agent loop (AgentPanel /
//     delegate sub-agents): prepend AGENT_SYSTEM_PROMPT + offer AGENT_TOOLS so the
//     returned assistant message can carry tool_use blocks the client dispatches.
//   • `noTools: true` — a clean completion for the pattern engine's aux calls
//     (classifier / criteria judge / synthesize-spec / peer insights / picker):
//     forward the caller's own messages verbatim, no injected system prompt, no
//     tools. Cheaper (skips the large AGENT_SYSTEM_PROMPT) and avoids the model
//     emitting a tool_use block where the caller expected JSON/prose.
import { uglyBotRequest } from 'ugly-app';
import type { TextGenModel } from 'ugly-app/shared';
import { AGENT_DEFAULT_MODEL, AGENT_SYSTEM_PROMPT, AGENT_TOOLS, type AgentMessage } from '../shared/agent';

export interface AgentStepInput {
  messages: AgentMessage[];
  model?: string;
  noTools?: boolean;
  maxTokens?: number;
}

export async function agentStepHandler(
  _userId: string,
  { messages: history, model, noTools, maxTokens }: AgentStepInput,
): Promise<{ message: AgentMessage }> {
  const data = await uglyBotRequest('textGen', {
    model: model ? (model as TextGenModel) : AGENT_DEFAULT_MODEL,
    messages: noTools ? history : [{ role: 'system', content: AGENT_SYSTEM_PROMPT }, ...history],
    ...(noTools ? {} : { tools: AGENT_TOOLS }),
    options: { maxTokens: maxTokens ?? 8192 },
  });
  if (!data?.message) throw new Error('Agent step failed: no response from model');
  return { message: data.message as AgentMessage };
}
