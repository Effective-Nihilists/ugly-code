// Task A — hashline: line-hash anchors + apply ops (pure). Ported from
// ugly-studio f5a74c2^:server/coding-agent/tools/hashline.ts.
import { describe, it, expect } from 'vitest';
import {
  computeLineHash,
  annotateLines,
  parseAnchor,
  parseAnchorRange,
  verifyAnchor,
  applyHashlineOp,
  formatHashlineRead,
} from '../../../client/agent/tools/hashline';

describe('computeLineHash', () => {
  it('is deterministic and 2 hex chars', () => {
    expect(computeLineHash('foo', 0)).toMatch(/^[0-9a-f]{2}$/);
    expect(computeLineHash('foo', 0)).toBe(computeLineHash('foo', 0));
  });
});

describe('annotateLines', () => {
  it('annotates each line with a line-number:hash anchor', () => {
    const a = annotateLines('alpha\nbeta\n');
    expect(a).toHaveLength(2);
    expect(a[0]).toMatchObject({ lineNumber: 1, content: 'alpha' });
    expect(a[0].anchor).toMatch(/^1:[0-9a-f]{2}$/);
    expect(a[1].lineNumber).toBe(2);
  });
  it('handles an empty body', () => {
    expect(annotateLines('')).toEqual([]);
  });
});

describe('parseAnchor', () => {
  it('accepts hashed, bare, numeric, and read-line-verbatim forms', () => {
    expect(parseAnchor('42:a3')).toEqual({ lineNumber: 42, hash: 'a3' });
    expect(parseAnchor('42')).toEqual({ lineNumber: 42 });
    expect(parseAnchor(42)).toEqual({ lineNumber: 42 });
    expect(parseAnchor('42:a3|const x = 1;')).toEqual({
      lineNumber: 42,
      hash: 'a3',
    });
  });
  it('rejects garbage and out-of-range', () => {
    expect(parseAnchor('nope')).toBeNull();
    expect(parseAnchor(0)).toBeNull();
  });
});

describe('parseAnchorRange', () => {
  it('parses inclusive ranges; rejects reversed / malformed', () => {
    expect(parseAnchorRange('42:a3..47:b1')).toMatchObject({
      start: { lineNumber: 42 },
      end: { lineNumber: 47 },
    });
    expect(parseAnchorRange('47..42')).toBeNull();
    expect(parseAnchorRange('42')).toBeNull();
  });
});

describe('verifyAnchor', () => {
  const body = 'alpha\nbeta\ngamma\n';
  const a = annotateLines(body);
  const wrong = a[1].hash === '00' ? '01' : '00';
  it('valid anchor -> null', () => {
    expect(verifyAnchor(body, { lineNumber: 2, hash: a[1].hash })).toBeNull();
  });
  it('bare line number in range -> null (opted out of hash check)', () => {
    expect(verifyAnchor(body, { lineNumber: 2 })).toBeNull();
  });
  it('stale hash -> diagnostic', () => {
    expect(verifyAnchor(body, { lineNumber: 2, hash: wrong })).not.toBeNull();
  });
  it('out of range -> diagnostic with actualHash null', () => {
    expect(verifyAnchor(body, { lineNumber: 99 })?.actualHash).toBeNull();
  });
});

describe('applyHashlineOp', () => {
  const body = 'a\nb\nc\n';
  const an = annotateLines(body);
  it('replace_line', () => {
    const r = applyHashlineOp(body, {
      kind: 'replace_line',
      anchor: { lineNumber: 2, hash: an[1].hash },
      newContent: 'B',
    });
    expect(r.ok).toBe(true);
    expect(r.newBody).toBe('a\nB\nc\n');
  });
  it('insert_after', () => {
    const r = applyHashlineOp(body, {
      kind: 'insert_after',
      anchor: { lineNumber: 1 },
      newContent: 'X',
    });
    expect(r.newBody).toBe('a\nX\nb\nc\n');
  });
  it('replace_range', () => {
    const r = applyHashlineOp(body, {
      kind: 'replace_range',
      range: { start: { lineNumber: 1 }, end: { lineNumber: 2 } },
      newContent: 'Z',
    });
    expect(r.newBody).toBe('Z\nc\n');
  });
  it('delete_range', () => {
    const r = applyHashlineOp(body, {
      kind: 'delete_range',
      range: { start: { lineNumber: 2 }, end: { lineNumber: 2 } },
    });
    expect(r.newBody).toBe('a\nc\n');
  });
  it('stale-hash op -> failure diagnostic', () => {
    const wrong = an[1].hash === '00' ? '01' : '00';
    const r = applyHashlineOp(body, {
      kind: 'replace_line',
      anchor: { lineNumber: 2, hash: wrong },
      newContent: 'B',
    });
    expect(r.ok).toBe(false);
    expect(r.diagnostic).toMatch(/stale hash/);
  });
});

describe('formatHashlineRead', () => {
  it('annotates lines with anchors + <file> wrapper', () => {
    const out = formatHashlineRead('a.ts', 'x\ny\n');
    expect(out).toMatch(/<file path="a.ts">/);
    expect(out).toMatch(/1:[0-9a-f]{2}\|x/);
    expect(out).toMatch(/2:[0-9a-f]{2}\|y/);
    expect(out).toMatch(/<\/file>/);
  });
  it('respects offset/limit + emits a truncation notice', () => {
    const body =
      Array.from({ length: 5 }, (_, i) => `L${i + 1}`).join('\n') + '\n';
    const out = formatHashlineRead('a.ts', body, 1, 2);
    expect(out).toMatch(/2:[0-9a-f]{2}\|L2/);
    expect(out).toMatch(/3:[0-9a-f]{2}\|L3/);
    expect(out).not.toMatch(/\|L1/);
    expect(out).toMatch(/truncated: 2 more lines/);
  });
});
