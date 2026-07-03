// Task B2.1 — multiedit (sequential, atomic string-match edits to one file).
import { describe, it, expect, beforeEach } from 'vitest';
import { resetMock, mockFiles } from '../../helpers/uglyNativeMock';
import { multieditTool } from '../../../client/agent/tools/multiedit';

beforeEach(() => resetMock({ files: { '/proj/a.ts': 'let x = 1;\nlet y = 2;\nlet y = 2;\n' } }));

describe('multiedit', () => {
  it('applies edits in sequence', async () => {
    await multieditTool.run(
      {
        path: '/proj/a.ts',
        edits: [
          { old_string: 'x = 1', new_string: 'x = 10' },
          { old_string: 'y = 2;\nlet y = 2;', new_string: 'y = 20;' },
        ],
      },
      undefined,
    );
    expect(mockFiles().get('/proj/a.ts')).toBe('let x = 10;\nlet y = 20;\n');
  });

  it('replace_all replaces every occurrence', async () => {
    await multieditTool.run(
      { path: '/proj/a.ts', edits: [{ old_string: 'y = 2', new_string: 'y = 9', replace_all: true }] },
      undefined,
    );
    expect(mockFiles().get('/proj/a.ts')).toBe('let x = 1;\nlet y = 9;\nlet y = 9;\n');
  });

  it('aborts atomically when an old_string is missing', async () => {
    const out = await multieditTool.run(
      {
        path: '/proj/a.ts',
        edits: [
          { old_string: 'x = 1', new_string: 'x = 10' },
          { old_string: 'NOPE', new_string: '!' },
        ],
      },
      undefined,
    );
    expect(out).toMatch(/not found|no match/i);
    expect(out).toMatch(/edit 2|index 1/i);
    // file unchanged
    expect(mockFiles().get('/proj/a.ts')).toBe('let x = 1;\nlet y = 2;\nlet y = 2;\n');
  });
});
