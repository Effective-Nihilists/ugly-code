// Task B1.1 — grep exact-pass arg mapping (pure).
// Task B1.2 — grep LSP modes (mocked LSP client).
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../client/agent/tools/lspForProject', () => ({
  projectRoot: () => '/proj',
  lspForProject: vi.fn(),
}));

import { buildRgArgs, runLspMode } from '../../../client/agent/tools/grep';
import { lspForProject } from '../../../client/agent/tools/lspForProject';

describe('grep buildRgArgs', () => {
  it('content mode with context + case-insensitive', () => {
    const a = buildRgArgs({
      pattern: 'foo',
      caseInsensitive: true,
      before_lines: 2,
      after_lines: 1,
      output_mode: 'content',
    });
    expect(a).toContain('-i');
    expect(a).toContain('-B');
    expect(a).toContain('2');
    expect(a).toContain('-A');
    expect(a).toContain('1');
    expect(a).toContain('foo');
  });

  it('literal + files_with_matches + include glob', () => {
    const a = buildRgArgs({
      pattern: 'a.b',
      literal_text: true,
      output_mode: 'files_with_matches',
      include: '*.ts',
    });
    expect(a).toContain('-F');
    expect(a).toContain('-l');
    expect(a).toContain('-g');
    expect(a).toContain('*.ts');
  });

  it('count mode + head_limit + include_ignored', () => {
    const a = buildRgArgs({
      pattern: 'x',
      output_mode: 'count',
      head_limit: 5,
      include_ignored: true,
    });
    expect(a).toContain('-c');
    expect(a).toContain('-m');
    expect(a).toContain('5');
    expect(a).toContain('--no-ignore');
  });
});

describe('grep runLspMode', () => {
  it('lsp-defs formats workspaceSymbol hits (cwd-relative)', async () => {
    vi.mocked(lspForProject).mockResolvedValue({
      getState: () => 'ready',
      workspaceSymbol: async () => [
        { name: 'foo', uri: 'file:///proj/a.ts', line: 3, character: 5 },
      ],
    } as never);
    const out = await runLspMode('lsp-defs', 'foo', { projectDir: '/proj' });
    expect(out).toMatch(/a\.ts:3:5/);
    expect(out).not.toMatch(/^\/proj/m); // cwd-stripped
  });

  it('lsp-refs opens each decl site and lists references', async () => {
    const client = {
      getState: () => 'ready',
      workspaceSymbol: async () => [
        { name: 'foo', uri: 'file:///proj/a.ts', line: 1, character: 17 },
      ],
      openFile: vi.fn(async () => undefined),
      findReferences: async () => [
        { uri: 'file:///proj/a.ts', line: 1, character: 17 },
        { uri: 'file:///proj/b.ts', line: 4, character: 10 },
      ],
      findImplementations: async () => [],
    };
    vi.mocked(lspForProject).mockResolvedValue(client as never);
    const out = await runLspMode('lsp-refs', 'foo', { projectDir: '/proj' });
    expect(client.openFile).toHaveBeenCalled();
    expect(out).toMatch(/a\.ts:1:17/);
    expect(out).toMatch(/b\.ts:4:10/);
  });

  it('reports when LSP is unavailable', async () => {
    vi.mocked(lspForProject).mockResolvedValue(null);
    const out = await runLspMode('lsp-defs', 'foo', { projectDir: '/proj' });
    expect(out).toMatch(/lsp|not available|unavailable/i);
  });
});
