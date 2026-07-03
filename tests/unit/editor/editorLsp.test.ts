// Task 2 — editorLsp: language selection + LSP glue (mocked handlers).
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../client/studio/agent/lsp/handlers', () => ({
  lspDefinition: vi.fn(async () => ({
    results: [{ path: '/p/a.ts', line: 3, character: 5, preview: 'export function foo' }],
  })),
  lspImplementation: vi.fn(async () => ({ results: [] })),
  lspReferences: vi.fn(async () => ({ results: [{ path: '/p/b.ts', line: 9, character: 2 }] })),
  lspHover: vi.fn(async () => ({ contents: '```ts\nfoo\n```' })),
}));

import { languageForPath, runDefinition, runHover } from '../../../client/studio/components/editorLsp';
import { lspDefinition, lspHover } from '../../../client/studio/agent/lsp/handlers';

describe('languageForPath', () => {
  it('maps extensions to CM languages', () => {
    expect(languageForPath('a.ts')).toBe('javascript');
    expect(languageForPath('a.tsx')).toBe('javascript');
    expect(languageForPath('a.py')).toBe('python');
    expect(languageForPath('a.css')).toBe('css');
    expect(languageForPath('a.md')).toBe('markdown');
    expect(languageForPath('a.rs')).toBeNull();
  });
});

describe('editorLsp glue', () => {
  it('runDefinition passes content + cwd and returns results', async () => {
    const out = await runDefinition('/p/x.ts', { line: 3, character: 9 }, 'BUF', '/p');
    expect(lspDefinition).toHaveBeenCalledWith(
      { path: '/p/x.ts', line: 3, character: 9, cwd: '/p', content: 'BUF' },
      '/p',
    );
    expect(out[0]).toMatchObject({ path: '/p/a.ts', line: 3 });
  });
  it('runHover returns the contents string', async () => {
    const s = await runHover('/p/x.ts', { line: 1, character: 1 }, 'BUF', '/p');
    expect(s).toMatch(/foo/);
    expect(lspHover).toHaveBeenCalledWith(
      { path: '/p/x.ts', line: 1, character: 1, cwd: '/p', content: 'BUF' },
      '/p',
    );
  });
});
