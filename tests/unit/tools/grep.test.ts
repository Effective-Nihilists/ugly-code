// Task B1.1 — grep exact-pass arg mapping (pure).
// Task B1.2 — grep LSP modes (mocked LSP client).
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../client/agent/tools/lspForProject', () => ({
  projectRoot: () => '/proj',
  lspForProject: vi.fn(),
}));

import {
  buildRgArgs,
  runLspMode,
  extractIdentSymbols,
  grepTool,
} from '../../../client/agent/tools/grep';
import { lspForProject } from '../../../client/agent/tools/lspForProject';
import { resetMock } from '../../helpers/uglyNativeMock';

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

  it('excludes .git and node_modules even with include_ignored', () => {
    const a = buildRgArgs({ pattern: 'foo', include_ignored: true });
    expect(a).toContain('!.git');
    expect(a).toContain('!node_modules');
  });
});

describe('grep runLspMode', () => {
  it('lsp-defs formats workspaceSymbol hits (cwd-relative)', async () => {
    vi.mocked(lspForProject).mockResolvedValue({
      getState: () => 'ready',
      ensureProjectLoaded: async () => undefined,
      workspaceSymbol: async () => [
        { name: 'foo', uri: 'file:///proj/a.ts', line: 3, character: 5 },
      ],
    } as never);
    const out = await runLspMode(
      'lsp-defs',
      { pattern: 'foo', mode: 'lsp-defs' },
      { projectDir: '/proj' },
    );
    expect(out).toMatch(/a\.ts:3:5/);
    expect(out).not.toMatch(/^\/proj/m); // cwd-stripped
  });

  it('lsp-refs opens each decl site and lists references', async () => {
    const client = {
      getState: () => 'ready',
      ensureProjectLoaded: async () => undefined,
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
    const out = await runLspMode(
      'lsp-refs',
      { pattern: 'foo', mode: 'lsp-refs' },
      { projectDir: '/proj' },
    );
    expect(client.openFile).toHaveBeenCalled();
    expect(out).toMatch(/a\.ts:1:17/);
    expect(out).toMatch(/b\.ts:4:10/);
  });

  it('falls back to a text search when LSP is unavailable (no dead "retry" reply)', async () => {
    vi.mocked(lspForProject).mockResolvedValue(null);
    const out = await runLspMode(
      'lsp-defs',
      { pattern: 'foo', mode: 'lsp-defs' },
      { projectDir: '/proj' },
    );
    // The old behavior returned "(lsp not available … retry shortly)" and burned a round-trip;
    // now it runs a plain ripgrep instead so the agent gets real hits.
    expect(out).not.toMatch(/not available|not yet initialized|retry/i);
  });
});

describe('grep extractIdentSymbols', () => {
  it('pulls bare identifiers and unions', () => {
    expect(extractIdentSymbols('AppTabPicker')).toEqual(['AppTabPicker']);
    expect(extractIdentSymbols('Foo|Bar')).toEqual(['Foo', 'Bar']);
    expect(extractIdentSymbols('Foo|Foo')).toEqual(['Foo']); // deduped
  });
  it('rejects non-bare patterns and short names', () => {
    expect(extractIdentSymbols('foo\\s+bar')).toEqual([]);
    expect(extractIdentSymbols('a.b')).toEqual([]);
    expect(extractIdentSymbols('ab')).toEqual([]); // < 3 chars
  });
});

describe('grep auto-supplement', () => {
  it('appends an LSP DEFINITIONS section for a bare-identifier auto grep', async () => {
    resetMock({
      proc: (cmd) => ({
        stdout: cmd === 'rg' ? 'src/x.ts:5:  AppTabPicker()\n' : '',
        code: 0,
      }),
    });
    vi.mocked(lspForProject).mockResolvedValue({
      getState: () => 'ready',
      workspaceSymbol: async (q: string) =>
        q === 'AppTabPicker'
          ? [
              {
                name: 'AppTabPicker',
                uri: 'file:///proj/comp/AppTabPicker.tsx',
                line: 10,
                character: 14,
              },
            ]
          : [],
    } as never);
    const out = await grepTool.run(
      { pattern: 'AppTabPicker' },
      { projectDir: '/proj' },
    );
    expect(out).toMatch(/src\/x\.ts:5/); // exact hit preserved
    expect(out).toMatch(/LSP DEFINITIONS/);
    expect(out).toMatch(/AppTabPicker\.tsx:10:14/);
  });

  it('does not supplement a literal or non-identifier grep', async () => {
    resetMock({ proc: () => ({ stdout: 'src/x.ts:5:foo\n', code: 0 }) });
    const out = await grepTool.run(
      { pattern: 'foo.*bar' },
      { projectDir: '/proj' },
    );
    expect(out).not.toMatch(/LSP DEFINITIONS/);
  });
});

describe('grep buildRgArgs — search path (the 30s stdin hang)', () => {
  // Regression: with no path argument, ripgrep searches STDIN. Spawned from node, stdin
  // is a pipe, so rg blocked until the 30s timeout and reported "no matches" having
  // searched nothing. Every grep the model issued without an explicit `path` was dead.
  it('always passes a search path, defaulting to "."', () => {
    const a = buildRgArgs({ pattern: 'foo' });
    expect(a[a.length - 1]).toBe('.');
  });
  it('honors an explicit path', () => {
    const a = buildRgArgs({ pattern: 'foo', path: 'src/' });
    expect(a[a.length - 1]).toBe('src/');
  });
  it('the path comes after the -e pattern, never consumed as the pattern', () => {
    const a = buildRgArgs({ pattern: 'foo' });
    expect(a[a.indexOf('-e') + 1]).toBe('foo');
    expect(a.indexOf('-e')).toBeLessThan(a.length - 1);
  });
});
