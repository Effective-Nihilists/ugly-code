import { describe, it, expect } from 'vitest';
import { resultLabel, snippet, parseGrepHits } from '../../../client/studio/panels/codebaseSearchFormat';

describe('codebaseSearchFormat', () => {
  it('labels a hit with path:line-range', () => {
    expect(resultLabel({ file_path: 'src/a.ts', start_line: 3, end_line: 5 })).toBe('src/a.ts:3-5');
  });

  it('collapses a single-line span', () => {
    expect(resultLabel({ file_path: 'a.ts', start_line: 7, end_line: 7 })).toBe('a.ts:7');
  });

  it('trims a snippet to the first N lines', () => {
    expect(snippet('a\nb\nc\nd\ne', 3)).toBe('a\nb\nc');
  });

  it('parses ripgrep content output into clickable hits', () => {
    const hits = parseGrepHits('src/a.ts:12:const reconnect = 1\nsrc/b.ts:3:foo()');
    expect(hits).toEqual([
      { file_path: 'src/a.ts', start_line: 12, end_line: 12, content: 'const reconnect = 1', mode: 'grep', score: 0 },
      { file_path: 'src/b.ts', start_line: 3, end_line: 3, content: 'foo()', mode: 'grep', score: 0 },
    ]);
  });

  it('ignores non-match lines (headers, blanks, no-match notices)', () => {
    expect(parseGrepHits('(no matches for "x")\n\nsome heading')).toEqual([]);
  });
});
