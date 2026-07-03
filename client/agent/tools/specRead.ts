// `spec_read` — read a project spec from ugly.bot. Ported from ugly-studio
// f5a74c2^:server/coding-agent/tools/spec-tools.ts + spec-vfs.ts. Degrades
// cleanly when the spec service isn't reachable / no specs exist.

import { native } from 'ugly-app/native';
import type { TextGenTool } from 'ugly-app/shared';
import type { ToolModule } from './registry';

const SPEC: TextGenTool = {
  name: 'spec_read',
  description:
    'Read a project spec (design/requirements doc) hosted on ugly.bot. Omit ' +
    '`id` to list available specs.',
  parameters: {
    type: 'object',
    properties: { id: { type: 'string', description: 'Spec id/path; omit to list.' } },
    required: [],
    additionalProperties: false,
  },
};

export const specReadTool: ToolModule = {
  name: 'spec_read',
  spec: SPEC,
  async run(input) {
    const id = typeof input.id === 'string' ? input.id : '';
    try {
      const res = (await native.uglybot.request('specRead', id ? { id } : {})) as
        | { content?: string; specs?: { id: string; title?: string }[]; error?: string }
        | string;
      if (typeof res === 'string') return res;
      if (res?.error) return `spec_read unavailable: ${res.error}`;
      if (res.content) return res.content;
      if (res.specs) {
        return res.specs.length
          ? res.specs.map((s) => `- ${s.id}${s.title ? `: ${s.title}` : ''}`).join('\n')
          : '(no specs for this project)';
      }
      return '(no spec content)';
    } catch (e) {
      return `spec_read unavailable: ${(e as Error).message}`;
    }
  },
};
