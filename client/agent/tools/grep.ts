// `grep` — ported from ugly-studio f5a74c2^:server/coding-agent/tools/grep.ts.
// Exact regex pass via ripgrep (B1.1). LSP modes (B1.2) + auto-supplement (B1.3)
// are layered on in later tasks. Trimmed vs the monolith: `semantic` mode
// (covered by codebase_search) and the `.specs` virtual path are dropped.

import type { TextGenTool } from 'ugly-app/shared';
import type { ToolModule } from './registry';
import type { ToolContext } from '../tools';
import { projectRoot } from './lspForProject';
import { spawnCollect } from './spawn';

export type GrepMode =
  | 'auto'
  | 'exact'
  | 'lsp-defs'
  | 'lsp-refs'
  | 'lsp-impls';

export interface GrepArgs {
  pattern: string;
  path?: string;
  include?: string;
  literal_text?: boolean;
  caseInsensitive?: boolean;
  include_ignored?: boolean;
  mode?: GrepMode;
  output_mode?: 'content' | 'files_with_matches' | 'count';
  head_limit?: number;
  before_lines?: number;
  after_lines?: number;
}

/** Map grep args → ripgrep argv. Pure, exported for test. */
export function buildRgArgs(args: GrepArgs): string[] {
  const a: string[] = [];
  const mode = args.output_mode ?? 'content';
  if (args.caseInsensitive) a.push('-i');
  if (args.include_ignored) a.push('--no-ignore');
  if (args.include) a.push('-g', args.include);
  if (mode === 'files_with_matches') {
    a.push('-l');
  } else if (mode === 'count') {
    a.push('-c');
  } else {
    a.push('-n', '--no-heading');
    if (args.before_lines) a.push('-B', String(args.before_lines));
    if (args.after_lines) a.push('-A', String(args.after_lines));
  }
  if (args.head_limit) a.push('-m', String(args.head_limit));
  if (args.literal_text) a.push('-F');
  a.push('-e', args.pattern);
  if (args.path) a.push(args.path);
  return a;
}

/** The exact ripgrep pass. */
async function runExact(args: GrepArgs, ctx: ToolContext | undefined): Promise<string> {
  const root = projectRoot(ctx) ?? undefined;
  const { stdout, stderr, code } = await spawnCollect('rg', buildRgArgs(args), {
    ...(root ? { cwd: root } : {}),
  });
  // ripgrep: 0 = matches, 1 = no matches, 2 = error.
  if (code === 1) return `(no matches for ${JSON.stringify(args.pattern)})`;
  if (code !== 0 && code !== null) {
    return `(grep error, exit ${code})\n${(stderr || stdout).trim()}`;
  }
  return stdout.trimEnd() || `(no matches for ${JSON.stringify(args.pattern)})`;
}

const SPEC: TextGenTool = {
  name: 'grep',
  description:
    'Search the workspace. mode "exact"/"auto" runs a regex (ripgrep). mode ' +
    '"lsp-defs"/"lsp-refs"/"lsp-impls" takes a SYMBOL NAME and returns its ' +
    'definitions / references / implementations via the language server. Plain ' +
    'identifier searches in auto mode also get an appended LSP DEFINITIONS section.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regex (exact/auto) or symbol name (lsp-* modes).' },
      path: { type: 'string', description: 'Optional file or directory to scope the search.' },
      include: { type: 'string', description: 'Glob filter, e.g. "*.ts".' },
      literal_text: { type: 'boolean', description: 'Treat pattern as a literal string, not a regex.' },
      caseInsensitive: { type: 'boolean', description: 'Case-insensitive match.' },
      include_ignored: { type: 'boolean', description: 'Also search .gitignore-d files.' },
      mode: { type: 'string', enum: ['auto', 'exact', 'lsp-defs', 'lsp-refs', 'lsp-impls'] },
      output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'] },
      head_limit: { type: 'number', description: 'Cap the number of exact-pass matches.' },
      before_lines: { type: 'number', description: 'Context lines before each match (content mode).' },
      after_lines: { type: 'number', description: 'Context lines after each match (content mode).' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
};

export const grepTool: ToolModule = {
  name: 'grep',
  spec: SPEC,
  async run(input, ctx) {
    const args = input as unknown as GrepArgs;
    // LSP modes + auto-supplement are added in B1.2/B1.3.
    return runExact(args, ctx);
  },
};
