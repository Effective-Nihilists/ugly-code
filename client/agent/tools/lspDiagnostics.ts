// `lsp_diagnostics` — TypeScript diagnostics for the project or one file, via
// the language server (the same LspClient the editor navigation uses).

import type { TextGenTool } from 'ugly-app/shared';
import type { ToolModule } from './registry';
import { lspForProject } from './lspForProject';

const SPEC: TextGenTool = {
  name: 'lsp_diagnostics',
  description:
    'Get TypeScript diagnostics (errors/warnings) from the language server. ' +
    'With `path`, returns that file\'s diagnostics; without, a project-wide ' +
    'summary. Authoritative for "does this compile" — prefer over running tsc.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Optional file to scope diagnostics to.' },
    },
    required: [],
    additionalProperties: false,
  },
};

export const lspDiagnosticsTool: ToolModule = {
  name: 'lsp_diagnostics',
  spec: SPEC,
  async run(input, ctx) {
    const lsp = await lspForProject(ctx);
    if (!lsp) return '(lsp not available — no project open or the TypeScript server failed to start)';
    await lsp.ensureProjectLoaded();
    const path = typeof input.path === 'string' ? input.path : undefined;
    if (path) {
      const diags = lsp.getDiagnostics(path);
      if (diags.length === 0) return `(no diagnostics for ${path})`;
      return diags
        .map(
          (d) =>
            `${path}:${d.line}:${d.column} ${d.severity}: ${d.message}` +
            (d.code !== undefined ? ` [${d.code}]` : ''),
        )
        .join('\n');
    }
    return lsp.formatSummary() || '(no diagnostics)';
  },
};
