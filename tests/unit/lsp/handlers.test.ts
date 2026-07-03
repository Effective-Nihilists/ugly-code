// Task 5 — the editor lsp* request handlers. They map the api.ts contract
// ({path,line,character,cwd}) onto the registry's per-workspace LspClient,
// convert file:// URIs back to paths, attach a best-effort source preview, and
// degrade to empty results for unknown languages. The registry is mocked to a
// fake client so no real language server is spawned; preview reads go through
// the in-memory native.fs mock.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../client/studio/agent/lsp/registry', () => ({
  languageIdForPath: (p: string) => (p.endsWith('.ts') ? 'typescript' : null),
  getEditorLspClient: vi.fn(),
}));

import {
  lspDefinition,
  lspImplementation,
  lspReferences,
  lspHover,
} from '../../../client/studio/agent/lsp/handlers';
import { getEditorLspClient } from '../../../client/studio/agent/lsp/registry';
import { resetMock } from '../../helpers/uglyNativeMock';

const fakeClient = {
  ensureProjectLoaded: vi.fn(async () => undefined),
  openFile: vi.fn(async () => undefined),
  findDefinition: vi.fn(async () => [
    { uri: 'file:///proj/a.ts', line: 3, character: 5 },
  ]),
  findImplementations: vi.fn(async () => [
    { uri: 'file:///proj/impl.ts', line: 1, character: 0 },
  ]),
  findReferences: vi.fn(async () => [
    { uri: 'file:///proj/a.ts', line: 3, character: 5 },
    { uri: 'file:///proj/b.ts', line: 9, character: 2 },
  ]),
  hover: vi.fn(async () => '```ts\nfunction foo(): void\n```'),
};

beforeEach(() => {
  resetMock({
    files: {
      '/proj/a.ts': 'line1\nline2\n  export function foo() {}\n',
      '/proj/b.ts': 'x\ny\nz\n',
    },
  });
  vi.mocked(getEditorLspClient).mockReset().mockResolvedValue(fakeClient as never);
  Object.values(fakeClient).forEach((f) => vi.mocked(f).mockClear());
});

describe('lspDefinition', () => {
  it('maps client results to {path,line,character,preview} (1-indexed, uri→path)', async () => {
    const out = await lspDefinition(
      { path: '/proj/b.ts', line: 0, character: 2, cwd: '/proj' },
      '/proj',
    );
    expect(out).toEqual({
      results: [
        {
          path: '/proj/a.ts',
          line: 3,
          character: 5,
          preview: 'export function foo() {}',
        },
      ],
    });
    // opens the cursor file before requesting; does not force a full project load
    expect(fakeClient.openFile).toHaveBeenCalledWith('/proj/b.ts', undefined);
    expect(fakeClient.ensureProjectLoaded).not.toHaveBeenCalled();
  });

  it('returns empty results for an unknown language', async () => {
    const out = await lspDefinition(
      { path: '/proj/README.md', line: 0, character: 0 },
      '/proj',
    );
    expect(out).toEqual({ results: [] });
    expect(getEditorLspClient).not.toHaveBeenCalled();
  });
});

describe('lspReferences / lspImplementation', () => {
  it('references force a full project load (cross-file) and map every hit', async () => {
    const out = await lspReferences(
      { path: '/proj/a.ts', line: 2, character: 5 },
      '/proj',
    );
    expect(fakeClient.ensureProjectLoaded).toHaveBeenCalled();
    expect(out.results).toHaveLength(2);
    expect(out.results[0]).toMatchObject({ path: '/proj/a.ts', line: 3 });
    expect(out.results[1]).toMatchObject({ path: '/proj/b.ts', line: 9 });
  });

  it('implementation forces a full project load', async () => {
    const out = await lspImplementation(
      { path: '/proj/a.ts', line: 0, character: 0 },
      '/proj',
    );
    expect(fakeClient.ensureProjectLoaded).toHaveBeenCalled();
    expect(out.results[0]).toMatchObject({ path: '/proj/impl.ts', line: 1 });
  });
});

describe('lspHover', () => {
  it('returns the markdown contents string', async () => {
    const out = await lspHover(
      { path: '/proj/a.ts', line: 2, character: 5, cwd: '/proj' },
      '/proj',
    );
    expect(out).toEqual({ contents: '```ts\nfunction foo(): void\n```' });
  });

  it('returns { contents: null } for an unknown language', async () => {
    const out = await lspHover(
      { path: '/proj/x.md', line: 0, character: 0 },
      '/proj',
    );
    expect(out).toEqual({ contents: null });
  });
});

describe('unsaved-buffer content passthrough', () => {
  it('lspHover syncs the live buffer via openFile(path, content)', async () => {
    const out = await lspHover(
      { path: '/proj/a.ts', line: 2, character: 5, cwd: '/proj', content: 'const edited = 1;' },
      '/proj',
    );
    expect(out).toEqual({ contents: '```ts\nfunction foo(): void\n```' });
    expect(fakeClient.openFile).toHaveBeenCalledWith('/proj/a.ts', 'const edited = 1;');
  });
  it('lspDefinition without content opens from disk (content undefined)', async () => {
    await lspDefinition({ path: '/proj/b.ts', line: 0, character: 2, cwd: '/proj' }, '/proj');
    expect(fakeClient.openFile).toHaveBeenCalledWith('/proj/b.ts', undefined);
  });
});
