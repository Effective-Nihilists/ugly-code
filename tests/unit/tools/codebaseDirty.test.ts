import { describe, it, expect } from 'vitest';
import { markDirty, drainDirty } from '../../../client/agent/tools/codebaseDirty';

describe('codebaseDirty', () => {
  it('accumulates unique paths and drains once', () => {
    markDirty('s1', '/p/a.ts');
    markDirty('s1', '/p/a.ts');
    markDirty('s1', '/p/b.ts');
    expect(drainDirty('s1').sort()).toEqual(['/p/a.ts', '/p/b.ts']);
    expect(drainDirty('s1')).toEqual([]); // cleared
  });

  it('isolates sessions', () => {
    markDirty('s2', '/p/c.ts');
    expect(drainDirty('s3')).toEqual([]);
    expect(drainDirty('s2')).toEqual(['/p/c.ts']);
  });

  it('ignores empty ids/paths', () => {
    markDirty('', '/p/x.ts');
    markDirty('s4', '');
    expect(drainDirty('s4')).toEqual([]);
  });
});
