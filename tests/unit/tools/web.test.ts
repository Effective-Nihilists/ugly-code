// Task B3.1 web_fetch + B3.2 web_search (native.browse mocked).
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('ugly-app/native', () => ({
  native: { browse: { extract: vi.fn() } },
}));

import { webFetchTool } from '../../../client/agent/tools/webFetch';
import { webSearchTool } from '../../../client/agent/tools/webSearch';
import { native } from 'ugly-app/native';

const extract = vi.mocked(
  (native as unknown as { browse: { extract: ReturnType<typeof vi.fn> } })
    .browse.extract,
);

beforeEach(() => extract.mockReset());

describe('web_fetch', () => {
  it('extracts a page and returns title + content', async () => {
    extract.mockResolvedValue({
      url: 'https://ex.com/a',
      title: 'Hello',
      format: 'readability',
      content: 'Article body here',
      length: 17,
    } as never);
    const out = await webFetchTool.run({ url: 'https://ex.com/a' }, undefined);
    expect(out).toContain('Hello');
    expect(out).toContain('Article body here');
  });
  it('rejects non-http URLs', async () => {
    const out = await webFetchTool.run({ url: 'ftp://x' }, undefined);
    expect(out).toMatch(/http/i);
  });
});

describe('web_search', () => {
  it('searches DuckDuckGo and returns results text', async () => {
    extract.mockResolvedValue({
      url: 'https://html.duckduckgo.com/html/',
      title: 'q',
      format: 'text',
      content: 'Result One\nResult Two',
      length: 20,
    } as never);
    const out = await webSearchTool.run({ query: 'typescript lsp' }, undefined);
    expect(out).toContain('Result One');
    const calledUrl = extract.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain('duckduckgo');
    expect(calledUrl).toContain('typescript');
  });
});
