// Task B1.5 — lsp_diagnostics.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../client/agent/tools/lspForProject', () => ({
  projectRoot: () => '/proj',
  lspForProject: vi.fn(),
}));

import { lspDiagnosticsTool } from '../../../client/agent/tools/lspDiagnostics';
import { lspForProject } from '../../../client/agent/tools/lspForProject';

describe('lsp_diagnostics', () => {
  it('formats project-wide diagnostics (no path)', async () => {
    vi.mocked(lspForProject).mockResolvedValue({
      ensureProjectLoaded: async () => undefined,
      formatSummary: () => '# Current project diagnostics (1 error, 0 warnings)\nsrc/a.ts:2:1 error: boom',
    } as never);
    const out = await lspDiagnosticsTool.run({}, { projectDir: '/proj' });
    expect(out).toMatch(/1 error/);
    expect(out).toMatch(/src\/a\.ts:2:1/);
  });

  it('formats a single file when path is given', async () => {
    vi.mocked(lspForProject).mockResolvedValue({
      ensureProjectLoaded: async () => undefined,
      getDiagnostics: (p: string) =>
        p.endsWith('a.ts') ? [{ line: 2, column: 1, severity: 'error', message: 'boom' }] : [],
    } as never);
    const out = await lspDiagnosticsTool.run({ path: 'src/a.ts' }, { projectDir: '/proj' });
    expect(out).toMatch(/2:1/);
    expect(out).toMatch(/boom/);
  });

  it('reports when LSP is unavailable', async () => {
    vi.mocked(lspForProject).mockResolvedValue(null);
    const out = await lspDiagnosticsTool.run({}, { projectDir: '/proj' });
    expect(out).toMatch(/lsp|unavailable|no project/i);
  });
});
