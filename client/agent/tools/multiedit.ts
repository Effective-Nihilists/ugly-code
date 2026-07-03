// `multiedit` — apply a sequence of string-match edits to a single file,
// atomically. Ported from ugly-studio f5a74c2^:server/coding-agent/tools/
// multiedit.ts (string-match form; anchor/range variants omitted for v1).
// Edits apply in order, each seeing the previous result; if any old_string is
// missing the whole set is rejected and the file is left untouched.

import { native } from 'ugly-app/native';
import type { TextGenTool } from 'ugly-app/shared';
import type { ToolModule } from './registry';
import { resolvePath } from '../tools';

interface Edit {
  old_string?: string;
  new_string?: string;
  replace_all?: boolean;
}

interface MultieditArgs {
  path?: string;
  file_path?: string;
  edits: Edit[];
}

const SPEC: TextGenTool = {
  name: 'multiedit',
  description:
    'Apply several edits to ONE file in a single call. Each edit replaces an ' +
    'exact `old_string` with `new_string` (set `replace_all` to replace every ' +
    'occurrence). Edits apply in order; if any `old_string` is not found the ' +
    'whole set is rejected and the file is left unchanged.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to the workspace root.' },
      edits: {
        type: 'array',
        description: 'Edits applied in order.',
        items: {
          type: 'object',
          properties: {
            old_string: { type: 'string', description: 'Exact text to replace.' },
            new_string: { type: 'string', description: 'Replacement text.' },
            replace_all: { type: 'boolean', description: 'Replace every occurrence (default: first only).' },
          },
          required: ['old_string', 'new_string'],
          additionalProperties: false,
        },
      },
    },
    required: ['path', 'edits'],
    additionalProperties: false,
  },
};

export const multieditTool: ToolModule = {
  name: 'multiedit',
  spec: SPEC,
  async run(input, ctx) {
    const args = input as unknown as MultieditArgs;
    const rawPath = String(args.path ?? args.file_path ?? '');
    if (!rawPath) return 'multiedit: `path` is required';
    if (!Array.isArray(args.edits) || args.edits.length === 0) {
      return 'multiedit: `edits` must be a non-empty array';
    }
    const abs = resolvePath(ctx, rawPath);
    let content: string;
    try {
      content = await native.fs.readFile(abs);
    } catch (e) {
      return `multiedit: could not read ${rawPath}: ${(e as Error).message}`;
    }
    // Apply in memory; reject the whole set on the first miss (atomic).
    for (let i = 0; i < args.edits.length; i++) {
      const e = args.edits[i]!;
      const oldStr = e.old_string ?? '';
      const newStr = e.new_string ?? '';
      if (!content.includes(oldStr)) {
        return `multiedit: edit ${i + 1} (index ${i}) \`old_string\` not found in ${rawPath}; file left unchanged`;
      }
      content = e.replace_all
        ? content.split(oldStr).join(newStr)
        : content.replace(oldStr, newStr);
    }
    await native.fs.writeFile(abs, content);
    return `Applied ${args.edits.length} edit(s) to ${rawPath}`;
  },
};
