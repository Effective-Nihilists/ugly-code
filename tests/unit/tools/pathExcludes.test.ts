import { describe, it, expect } from 'vitest';
import { HARD_EXCLUDES } from '../../../client/agent/tools/pathExcludes';

describe('HARD_EXCLUDES', () => {
  it('excludes the dirs that blow up model context', () => {
    for (const d of ['.git', 'node_modules', 'dist', 'build', '.venv']) {
      expect(HARD_EXCLUDES).toContain(d);
    }
  });
});
