// Token-level unified diff used by the transcript's edit/write tool cards.
import { describe, it, expect } from 'vitest';
import {
  buildDiffRows,
  diffLinePair,
  diffStats,
  tokenize,
  type DiffRow,
  type Part,
} from '../../client/studio/panels/tokenDiff';

const changed = (parts: Part[]): string =>
  parts
    .filter((p) => p.changed)
    .map((p) => p.text)
    .join('');
const whole = (parts: Part[]): string => parts.map((p) => p.text).join('');
const kinds = (rows: DiffRow[]): string[] => rows.map((r) => r.kind);

describe('tokenize', () => {
  it('splits into words, whitespace runs, and single punctuation', () => {
    expect(tokenize('const a = b;')).toEqual([
      'const',
      ' ',
      'a',
      ' ',
      '=',
      ' ',
      'b',
      ';',
    ]);
  });
  it('keeps identifier chars ($, _, digits) inside one token', () => {
    expect(tokenize('$foo_1')).toEqual(['$foo_1']);
  });
});

describe('diffLinePair', () => {
  it('marks only the changed identifier, not the whole line', () => {
    const { del, add } = diffLinePair(
      'const total = price * qty;',
      'const total = price * count;',
    );
    // The point of the whole module: one token differs, so one token is marked.
    expect(changed(del)).toBe('qty');
    expect(changed(add)).toBe('count');
    // Nothing is lost — the parts still reconstruct each line exactly.
    expect(whole(del)).toBe('const total = price * qty;');
    expect(whole(add)).toBe('const total = price * count;');
  });

  it('marks a pure insertion on the add side only', () => {
    const { del, add } = diffLinePair('foo(a)', 'foo(a, b)');
    expect(changed(del)).toBe('');
    expect(changed(add)).toContain('b');
  });

  it('coalesces adjacent changed tokens into one run', () => {
    const { add } = diffLinePair('x', 'hello world');
    expect(add.filter((p) => p.changed).length).toBe(1);
  });

  it('identical lines mark nothing', () => {
    const { del, add } = diffLinePair('same();', 'same();');
    expect(changed(del)).toBe('');
    expect(changed(add)).toBe('');
  });
});

describe('buildDiffRows', () => {
  it('emits a del/add pair for a changed line and context for the rest', () => {
    const rows = buildDiffRows('a\nb\nc', 'a\nB\nc');
    expect(kinds(rows)).toEqual(['context', 'del', 'add', 'context']);
  });

  it('pure addition produces only add rows', () => {
    const rows = buildDiffRows('a\nc', 'a\nb\nc');
    expect(rows.filter((r) => r.kind === 'del')).toHaveLength(0);
    expect(rows.filter((r) => r.kind === 'add')).toHaveLength(1);
  });

  it('pure deletion produces only del rows', () => {
    const rows = buildDiffRows('a\nb\nc', 'a\nc');
    expect(rows.filter((r) => r.kind === 'add')).toHaveLength(0);
    expect(rows.filter((r) => r.kind === 'del')).toHaveLength(1);
  });

  it('collapses far-from-change context into a gap row', () => {
    const old = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    const next = old.replace('line 15', 'line fifteen');
    const rows = buildDiffRows(old, next);
    const gaps = rows.filter((r) => r.kind === 'gap');
    expect(gaps.length).toBeGreaterThan(0);
    // 30 lines collapse to a handful of context rows either side of the one change.
    expect(rows.filter((r) => r.kind === 'context').length).toBeLessThanOrEqual(
      6,
    );
  });

  it('treats a wholly different line as a swap, not a token edit (no 90%-marked noise)', () => {
    const rows = buildDiffRows('const a = 1;', 'throw new Error("boom");');
    const del = rows.find((r) => r.kind === 'del') as
      { parts: Part[] } | undefined;
    // Low similarity → the entire line is marked changed rather than token-interleaved.
    expect(del?.parts).toHaveLength(1);
    expect(del?.parts[0]?.changed).toBe(true);
  });

  it('identical input yields no change rows', () => {
    const rows = buildDiffRows('a\nb', 'a\nb');
    expect(rows.some((r) => r.kind === 'del' || r.kind === 'add')).toBe(false);
  });

  it('handles empty sides', () => {
    expect(buildDiffRows('', 'a').filter((r) => r.kind === 'add')).toHaveLength(
      1,
    );
    expect(buildDiffRows('a', '').filter((r) => r.kind === 'del')).toHaveLength(
      1,
    );
    expect(buildDiffRows('', '')).toEqual([]);
  });

  it('every row reconstructs its source line exactly (no dropped text)', () => {
    const oldStr = 'function f(a) {\n  return a + 1;\n}';
    const newStr = 'function f(a) {\n  return a + 2;\n}';
    const rows = buildDiffRows(oldStr, newStr);
    const rebuilt = rows
      .filter((r) => r.kind === 'context' || r.kind === 'add')
      .map((r) => (r.kind === 'context' ? r.text : whole(r.parts)))
      .join('\n');
    expect(rebuilt).toBe(newStr);
  });
});

describe('diffStats', () => {
  it('counts add/del rows for the card header', () => {
    expect(diffStats(buildDiffRows('a\nb\nc', 'a\nB\nc'))).toEqual({
      added: 1,
      removed: 1,
    });
  });
});
