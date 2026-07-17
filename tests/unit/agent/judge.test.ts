import { describe, it, expect, vi } from 'vitest';
import {
  deriveCriteria,
  gradeAgainstCriteria,
  buildRevisePrompt,
  type Judge,
} from '../../../client/studio/agent/patterns/judge';

describe('deriveCriteria', () => {
  it('parses a rubric (≥2) from the judge JSON', async () => {
    const judge: Judge = vi.fn(
      async () =>
        'sure:\n[{"id":"C1","statement":"add(a,b) returns a+b","rationale":"core"},{"id":"C2","statement":"tests pass","rationale":"guard"}]',
    );
    const c = await deriveCriteria('fix add', '', judge);
    expect(c.map((x) => x.id)).toEqual(['C1', 'C2']);
  });
  it('returns [] on <2 criteria or parse failure', async () => {
    expect(
      await deriveCriteria(
        'x',
        '',
        async () => '[{"id":"C1","statement":"only one"}]',
      ),
    ).toEqual([]);
    expect(await deriveCriteria('x', '', async () => 'no json here')).toEqual(
      [],
    );
  });
});

describe('gradeAgainstCriteria', () => {
  const criteria = [
    { id: 'C1', statement: 'a+b', rationale: '' },
    { id: 'C2', statement: 'tests pass', rationale: '' },
  ];
  it('grades per criterion and collects failing', async () => {
    const judge: Judge = async () =>
      '[{"id":"C1","pass":true,"reason":"ok","evidence":"add.ts:2"},{"id":"C2","pass":false,"reason":"no test run"}]';
    const r = await gradeAgainstCriteria('fix add', criteria, 'diff', judge);
    expect(r.parsed).toBe(true);
    expect(r.failing.map((v) => v.id)).toEqual(['C2']);
    expect(r.verdicts[0].evidence).toBe('add.ts:2');
  });
  it('reconciles a missing verdict as fail', async () => {
    const judge: Judge = async () => '[{"id":"C1","pass":true,"reason":"ok"}]'; // C2 omitted
    const r = await gradeAgainstCriteria('x', criteria, 'diff', judge);
    expect(r.failing.map((v) => v.id)).toEqual(['C2']);
    expect(r.verdicts[1].reason).toMatch(/did not return a verdict/);
  });
  it('empty criteria → not parsed, no failing', async () => {
    const r = await gradeAgainstCriteria('x', [], 'diff', async () => '[]');
    expect(r.parsed).toBe(false);
  });
});

describe('buildRevisePrompt', () => {
  it('lists failing criteria; adds a removal addendum when the reason implies deletion', () => {
    const p = buildRevisePrompt([
      { id: 'C1', pass: false, reason: 'missing endpoint', evidence: 'api.ts' },
      {
        id: 'C2',
        pass: false,
        reason: 'old sendProgress calls must be removed',
      },
    ]);
    expect(p).toContain('REVISE');
    expect(p).toContain('C1: missing endpoint [api.ts]');
    expect(p).toContain('DELETE THE OLD CODE');
  });
  it('empty when nothing fails', () => {
    expect(buildRevisePrompt([])).toBe('');
  });
});
