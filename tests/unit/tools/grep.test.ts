// Task B1.1 — grep exact-pass arg mapping (pure).
import { describe, it, expect } from 'vitest';
import { buildRgArgs } from '../../../client/agent/tools/grep';

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
