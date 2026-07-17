// A failed `rg` spawn must NOT look like a clean empty search.
//
// Regression: ripgrep missing from the task child's PATH made spawnCollect settle with
// code=null. glob/grep had no branch for null, so both fell through to their empty-output
// return and rendered a green, successful "no matches" card. The agent was told the
// project contained no files and gave up — the failure was invisible for hours of
// debugging. These tests pin the loud behavior.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../client/agent/tools/lspForProject', () => ({
  projectRoot: () => '/proj',
  lspForProject: vi.fn(async () => null),
}));

import { globTool } from '../../../client/agent/tools/glob';
import { grepTool } from '../../../client/agent/tools/grep';
import { resetMock } from '../../helpers/uglyNativeMock';

const ENOENT = 'spawn rg ENOENT';

describe('glob — rg spawn failure', () => {
  it('reports the failure instead of "no files match"', async () => {
    resetMock({ proc: () => ({ error: ENOENT, code: null }) });
    const out = await globTool.run({ pattern: '**/*.ts' }, { projectDir: '/proj' });
    expect(out).toMatch(/failed|did not run/i);
    expect(out).not.toMatch(/no files match/i);
  });

  it('names ripgrep so the cause is actionable even when stderr is blank', async () => {
    // Whitespace-only: the mock needs a truthy `error` to emit process.error at all,
    // and it trims to nothing — which is what exercises the fallback wording.
    resetMock({ proc: () => ({ error: '   ', code: null }) });
    const out = await globTool.run({ pattern: '**/*.ts' }, { projectDir: '/proj' });
    expect(out).toMatch(/ripgrep|rg/i);
  });

  it('a genuine empty result still reads as "no files match"', async () => {
    resetMock({ proc: () => ({ stdout: '', code: 1 }) });
    const out = await globTool.run({ pattern: '**/*.nope' }, { projectDir: '/proj' });
    expect(out).toMatch(/no files match/i);
    expect(out).not.toMatch(/failed/i);
  });

  it('a real rg error (exit 2) still surfaces as an error', async () => {
    resetMock({ proc: () => ({ stderr: 'regex parse error', code: 2 }) });
    const out = await globTool.run({ pattern: '[' }, { projectDir: '/proj' });
    expect(out).toMatch(/glob error, exit 2/);
    expect(out).toMatch(/regex parse error/);
  });
});

describe('grep — rg spawn failure', () => {
  it('reports the failure instead of "no matches"', async () => {
    resetMock({ proc: () => ({ error: ENOENT, code: null }) });
    const out = await grepTool.run({ pattern: 'qty' }, { projectDir: '/proj' });
    expect(out).toMatch(/failed|did not run/i);
    expect(out).not.toMatch(/^\(no matches/);
  });

  it('a genuine empty result still reads as "no matches"', async () => {
    resetMock({ proc: () => ({ stdout: '', code: 1 }) });
    const out = await grepTool.run({ pattern: 'zzz' }, { projectDir: '/proj' });
    expect(out).toMatch(/no matches/i);
    expect(out).not.toMatch(/failed/i);
  });

  it('a real rg error (exit 2) still surfaces as an error', async () => {
    resetMock({ proc: () => ({ stderr: 'regex parse error', code: 2 }) });
    const out = await grepTool.run({ pattern: '[' }, { projectDir: '/proj' });
    expect(out).toMatch(/grep error, exit 2/);
  });
});
