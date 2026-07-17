// Task B3.4 dep_docs (real uglyNativeMock).
import { describe, it, expect } from 'vitest';
import { resetMock } from '../../helpers/uglyNativeMock';
import { depDocsTool } from '../../../client/agent/tools/depDocs';

describe('dep_docs', () => {
  it('reads a package README from node_modules', async () => {
    resetMock({
      files: {
        '/proj/node_modules/left-pad/README.md': '# left-pad\nPad a string.',
      },
    });
    const out = await depDocsTool.run(
      { package: 'left-pad' },
      { projectDir: '/proj' },
    );
    expect(out).toContain('left-pad');
    expect(out).toContain('Pad a string');
  });
  it('falls back to package.json when no README', async () => {
    resetMock({
      files: {
        '/proj/node_modules/foo/package.json': JSON.stringify({
          description: 'Foo lib',
          version: '1.2.3',
        }),
      },
    });
    const out = await depDocsTool.run(
      { package: 'foo' },
      { projectDir: '/proj' },
    );
    expect(out).toContain('Foo lib');
  });
  it('reports when the package is not installed', async () => {
    resetMock({ files: {} });
    const out = await depDocsTool.run(
      { package: 'nope' },
      { projectDir: '/proj' },
    );
    expect(out).toMatch(/no docs|not installed/i);
  });
});
