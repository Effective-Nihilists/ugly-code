import { describe, it, expect } from 'vitest';
import { parseVitestCounts } from '../../client/studio/evals/grader';

// rrule (and other from-scratch tasks) ship a real vitest vector suite. The
// vitestScore gate must read the *pass count* — not just the exit code — so a
// partial implementation (e.g. 30/50 vectors) earns proportional credit and
// harness improvements become measurable.
describe('parseVitestCounts', () => {
  it('parses an all-passing summary', () => {
    expect(parseVitestCounts('\n Tests  50 passed (50)\n')).toEqual({ passed: 50, total: 50 });
  });
  it('parses a partial summary (passed | failed)', () => {
    expect(parseVitestCounts(' Tests  30 passed | 20 failed (50)\n')).toEqual({ passed: 30, total: 50 });
  });
  it('infers total from passed+failed when the (N) is absent', () => {
    expect(parseVitestCounts('Tests  12 failed | 8 passed')).toEqual({ passed: 8, total: 20 });
  });
  it('returns zero when no test summary is present (crash/no run)', () => {
    expect(parseVitestCounts('Error: cannot find module')).toEqual({ passed: 0, total: 0 });
  });
});
