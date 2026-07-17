import { describe, it, expect } from 'vitest';
import { gradeSbp } from '../../client/studio/evals/sbpGrader';
import type { GradeDeps } from '../../client/studio/evals/grader';

const RUN_TOTALS = {
  durationMs: 0,
  turns: 1,
  cost: { total: 0, input: 0, output: 0, cacheRead: 0 },
  tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
};
const F2P =
  'test/units/modules/test_async_wrapper.py::TestAsyncWrapper::test_run_module';

/** deps that return a canned pytest output + git-apply exit code. */
function deps(pytestOut: string, gitApplyCode = 0): GradeDeps {
  return {
    run: async (cmd, args) => {
      if (cmd === 'git' && args.includes('apply'))
        return { out: '', code: gitApplyCode };
      if (args.join(' ').includes('pytest')) return { out: pytestOut, code: 0 };
      return { out: '', code: 0 }; // the cat-heredoc write
    },
    readFile: async () => '',
    exists: async () => false,
  };
}
const input = {
  taskName: 'sbpro-ansible-ansible-39bd8b99',
  projectPath: '/p',
  runTotals: RUN_TOTALS,
};

describe('gradeSbp (Docker-free SBP grader)', () => {
  it('scores 5 when patch applies + fail_to_pass passes (empty pass_to_pass = free point)', async () => {
    const r = await gradeSbp(input, deps(`${F2P} PASSED\n\n1 passed in 0.3s`));
    expect(r.scoreMax).toBe(5);
    expect(r.score).toBe(5); // 1 patch + 3 f2p + 1 p2p(empty)
  });

  it('scores 2 when the fail_to_pass test FAILED', async () => {
    const r = await gradeSbp(input, deps(`${F2P} FAILED\n\n1 failed in 0.3s`));
    expect(r.score).toBe(2); // 1 patch + 0 f2p + 1 p2p(empty)
  });

  it('scores 0 when the test_patch does not apply', async () => {
    const r = await gradeSbp(input, deps('', 1));
    expect(r.score).toBe(0);
    expect(r.checks?.[0]).toMatchObject({
      name: 'test_patch applies',
      passed: false,
    });
  });
});
