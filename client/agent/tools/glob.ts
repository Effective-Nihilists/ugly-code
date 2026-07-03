// `glob` — file-name-pattern finding. Ported from ugly-studio
// f5a74c2^:server/coding-agent/tools/glob.ts; adapted to `rg --files -g`.

import type { TextGenTool } from 'ugly-app/shared';
import type { ToolModule } from './registry';
import type { ToolContext } from '../tools';
import { projectRoot } from './lspForProject';
import { spawnCollect } from './spawn';

export interface GlobArgs {
  pattern: string;
  path?: string;
  include_ignored?: boolean;
}

/** Map glob args → `rg --files` argv. Pure, exported for test. */
export function buildGlobArgs(args: GlobArgs): string[] {
  const a = ['--files', '-g', args.pattern];
  if (args.include_ignored) a.push('--no-ignore');
  if (args.path) a.push(args.path);
  return a;
}

const SPEC: TextGenTool = {
  name: 'glob',
  description:
    'Find files by name pattern (glob), e.g. "**/*.test.ts" or "src/**/*.tsx". ' +
    'Returns matching file paths, one per line.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern, e.g. "**/*.ts".' },
      path: { type: 'string', description: 'Optional directory to scope the search.' },
      include_ignored: { type: 'boolean', description: 'Also include .gitignore-d files.' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
};

export const globTool: ToolModule = {
  name: 'glob',
  spec: SPEC,
  async run(input, ctx) {
    const args = input as unknown as GlobArgs;
    const root = projectRoot(ctx) ?? undefined;
    const { stdout, stderr, code } = await spawnCollect('rg', buildGlobArgs(args), {
      ...(root ? { cwd: root } : {}),
    });
    if (code === 1 || (code === 0 && !stdout.trim())) {
      return `(no files match ${JSON.stringify(args.pattern)})`;
    }
    if (code !== 0 && code !== null) {
      return `(glob error, exit ${code})\n${(stderr || stdout).trim()}`;
    }
    return stdout.trimEnd();
  },
};
