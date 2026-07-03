// Task 0.2 — resolve the LSP client for a tool's project context.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../client/studio/agent/lsp/registry', () => ({
  getEditorLspClient: vi.fn(async () => ({ marker: 'fake-client' })),
  languageIdForPath: () => 'typescript',
}));
vi.mock('../../../client/studio/hooks/useSocket', () => ({
  getActiveProjectPath: () => '/proj',
}));

import { projectRoot, lspForProject } from '../../../client/agent/tools/lspForProject';
import { getEditorLspClient } from '../../../client/studio/agent/lsp/registry';

describe('projectRoot', () => {
  it('prefers ctx.projectDir, then workspaceDir, then active project', () => {
    expect(projectRoot({ projectDir: '/a' })).toBe('/a');
    expect(projectRoot({ workspaceDir: '/b' })).toBe('/b');
    expect(projectRoot(undefined)).toBe('/proj');
  });
});

describe('lspForProject', () => {
  it('returns the typescript client for the project root', async () => {
    const c = await lspForProject({ projectDir: '/a' });
    expect(c).toEqual({ marker: 'fake-client' });
    expect(getEditorLspClient).toHaveBeenCalledWith('/a', 'typescript');
  });
  it('returns null when the client fails to start', async () => {
    vi.mocked(getEditorLspClient).mockRejectedValueOnce(new Error('no npx'));
    expect(await lspForProject({ projectDir: '/a' })).toBeNull();
  });
});
