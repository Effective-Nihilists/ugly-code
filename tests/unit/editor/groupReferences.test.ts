// Task 4 — groupReferences (pure).
import { describe, it, expect } from 'vitest';
import { groupReferences } from '../../../client/studio/components/ReferencesPanel';

describe('groupReferences', () => {
  it('groups hits by file preserving first-seen order', () => {
    const g = groupReferences([
      { path: 'b.ts', line: 1, character: 0 },
      { path: 'a.ts', line: 5, character: 2 },
      { path: 'b.ts', line: 9, character: 1 },
    ]);
    expect(g.map((x) => x.path)).toEqual(['b.ts', 'a.ts']);
    expect(g[0].hits).toHaveLength(2);
    expect(g[1].hits).toHaveLength(1);
  });
});
