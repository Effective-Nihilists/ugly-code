import { describe, it, expect } from 'vitest';
import {
  filterToolsByToolset,
  isToolset,
} from '../../../client/studio/agent/toolsets';

const specs = [
  { name: 'read' },
  { name: 'python_exec' },
  { name: 'python_libraries' },
  { name: 'bash' },
] as never[];

describe('filterToolsByToolset', () => {
  it('no-python drops the python tools', () => {
    expect(
      filterToolsByToolset(specs, 'no-python').map(
        (s: { name: string }) => s.name,
      ),
    ).toEqual(['read', 'bash']);
  });
  it('default / null passes everything through', () => {
    expect(filterToolsByToolset(specs, 'default')).toHaveLength(4);
    expect(filterToolsByToolset(specs, null)).toHaveLength(4);
  });
});

describe('isToolset', () => {
  it('validates known names', () => {
    expect(isToolset('no-python')).toBe(true);
    expect(isToolset('nonsense')).toBe(false);
  });
});
