import { describe, expect, it } from 'vitest';
import { decorateForNonePattern } from '../../../client/studio/agent/patterns/decorate';

describe('decorateForNonePattern', () => {
  it('preserves the user text verbatim at the head', () => {
    const out = decorateForNonePattern('add a tests panel');
    expect(out.startsWith('add a tests panel\n\n---\n\n')).toBe(true);
  });

  it('instructs the model to propose designs and ask before editing', () => {
    const out = decorateForNonePattern('x');
    expect(out).toContain('Present 2-3 designs');
    expect(out).toContain('`ask_user`');
    expect(out).toContain('Do not start editing first');
  });

  it('tells the model NOT to manufacture questions for mechanical work', () => {
    const out = decorateForNonePattern('x');
    expect(out).toContain('no interesting decision');
    expect(out).toContain('Do not manufacture questions');
  });

  it('is safe to re-apply: a settled design must not be re-litigated', () => {
    const out = decorateForNonePattern('x');
    expect(out).toContain('the design is settled');
    expect(out).toContain('Do not re-litigate');
  });

  it('excludes naming/style tiebreaks from what warrants ask_user', () => {
    expect(decorateForNonePattern('x')).toContain(
      'Never call `ask_user` for naming, formatting, style, or tiebreaks',
    );
  });
});
