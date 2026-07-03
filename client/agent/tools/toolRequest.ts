// `tool_request` — activate a tool into this session's active catalog. Ported
// from ugly-studio f5a74c2^:server/coding-agent/tools/tool-request.ts.

import type { TextGenTool } from 'ugly-app/shared';
import type { ToolModule } from './registry';
import { activateTool } from './catalog';

const SPEC: TextGenTool = {
  name: 'tool_request',
  description:
    'Activate a tool (found via tool_search) so it becomes available on your ' +
    'next turn. Give the exact tool name and why you need it.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Exact tool name to activate.' },
      purpose: { type: 'string', description: 'Why you need it.' },
    },
    required: ['name'],
    additionalProperties: false,
  },
};

export const toolRequestTool: ToolModule = {
  name: 'tool_request',
  spec: SPEC,
  async run(input, ctx) {
    const name = String(input.name ?? '').trim();
    if (!name) return 'tool_request: `name` is required';
    const ok = activateTool(ctx?.sessionId ?? 'default', name);
    return ok
      ? `Activated ${JSON.stringify(name)} — it will be available on your next turn.`
      : `(no tool named ${JSON.stringify(name)}; use tool_search to find the right name)`;
  },
};
