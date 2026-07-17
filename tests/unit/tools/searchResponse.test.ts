import { describe, it, expect } from 'vitest';
import {
  formatSearchResult,
  provenance,
} from '../../../client/agent/tools/searchResponse';

describe('formatSearchResult', () => {
  it('renders ready hits with provenance', () => {
    const out = formatSearchResult({
      status: 'ready',
      results: [
        {
          file_path: 'a.ts',
          start_line: 3,
          end_line: 5,
          content: 'x',
          mode: 'mixed',
          score: 0.87,
          fts_rank: 3,
          semantic_score: 0.71,
          rerank_score: 0.87,
        },
      ],
    });
    expect(out).toContain('a.ts:3-5');
    expect(out).toMatch(/mixed 0\.87/);
    expect(out).toMatch(/fts#3/);
    expect(out).toMatch(/sem 0\.71/);
  });

  it('reports non-ready statuses instead of empty', () => {
    expect(formatSearchResult({ status: 'indexing' })).toMatch(/indexing/i);
    expect(formatSearchResult({ status: 'downloading-model' })).toMatch(
      /download/i,
    );
    expect(
      formatSearchResult({ status: 'unavailable', error: 'boom' }),
    ).toMatch(/boom/);
    expect(formatSearchResult({ status: 'ready', results: [] })).toMatch(
      /no matches/i,
    );
  });

  it('provenance shows only the retrievers that matched', () => {
    expect(
      provenance({
        file_path: 'a',
        start_line: 1,
        end_line: 1,
        content: '',
        mode: 'fts',
        score: 0.5,
        fts_rank: 0,
      }),
    ).toBe('fts 0.50 · fts#0');
  });
});
