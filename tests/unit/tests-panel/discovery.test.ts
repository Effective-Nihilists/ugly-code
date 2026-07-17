// Detection + collection, driven against the node UglyNative mock's virtual fs
// and a stubbed spawn. That gives exact control over "declared but not
// installed", "declared and empty", and the one-runner-fails-others-survive
// case, none of which the real repo can produce on demand.
import { describe, expect, it } from 'vitest';
import { resetMock } from '../../helpers/uglyNativeMock';
import {
  collectTests,
  detectRunners,
  playwrightRootDirRel,
} from '../../../client/studio/panels/tests/discovery';

const CWD = '/repo';

const VITEST_LIST = JSON.stringify([
  { name: 'suite > passes', file: '/repo/tests/a.test.ts' },
  { name: 'suite > fails', file: '/repo/tests/a.test.ts' },
]);

const PW_LIST = JSON.stringify({
  config: { rootDir: '/repo/tests/e2e' },
  suites: [
    {
      specs: [
        {
          title: 'loads',
          file: 'app.spec.ts',
          line: 4,
          tests: [{ projectName: 'chromium' }],
        },
        {
          title: 'loads',
          file: 'app.spec.ts',
          line: 4,
          tests: [{ projectName: 'firefox' }],
        },
      ],
    },
  ],
});

describe('detectRunners', () => {
  it('detects vitest from a devDependency', async () => {
    resetMock({
      files: {
        '/repo/package.json': JSON.stringify({
          devDependencies: { vitest: '^3' },
        }),
      },
    });
    expect((await detectRunners(CWD)).vitest).toBe(true);
  });

  it('detects vitest from the test script alone', async () => {
    resetMock({
      files: {
        '/repo/package.json': JSON.stringify({
          scripts: { test: 'vitest run' },
        }),
      },
    });
    expect((await detectRunners(CWD)).vitest).toBe(true);
  });

  it('requires BOTH the dep and a config for playwright', async () => {
    resetMock({
      files: {
        '/repo/package.json': JSON.stringify({
          devDependencies: { '@playwright/test': '^1' },
        }),
      },
    });
    expect((await detectRunners(CWD)).playwright).toBe(false);

    resetMock({
      files: {
        '/repo/package.json': JSON.stringify({
          devDependencies: { '@playwright/test': '^1' },
        }),
        '/repo/playwright.config.ts': 'export default {}',
      },
    });
    expect((await detectRunners(CWD)).playwright).toBe(true);
  });

  it('detects pytest from pyproject, pytest.ini, or conftest.py', async () => {
    resetMock({
      files: { '/repo/pyproject.toml': '[tool.pytest.ini_options]\n' },
    });
    expect((await detectRunners(CWD)).pytest).toBe(true);

    resetMock({ files: { '/repo/pytest.ini': '[pytest]' } });
    expect((await detectRunners(CWD)).pytest).toBe(true);

    resetMock({ files: { '/repo/conftest.py': '' } });
    expect((await detectRunners(CWD)).pytest).toBe(true);
  });

  it('reports every runner absent for an empty directory', async () => {
    // Regression: `exists()` used to be stat-and-catch. A host whose `stat`
    // doesn't throw on a missing path made every probe true, so pytest was
    // "detected" in repos with no Python at all.
    resetMock({ files: {} });
    expect(await detectRunners(CWD)).toEqual({
      vitest: false,
      pytest: false,
      playwright: false,
    });
  });

  it('does not detect pytest from a pyproject without a [tool.pytest] table', async () => {
    resetMock({ files: { '/repo/pyproject.toml': '[project]\nname = "x"\n' } });
    expect((await detectRunners(CWD)).pytest).toBe(false);
  });
});

describe('playwrightRootDirRel', () => {
  it('derives rootDir relative to the repo (json `file` is rootDir-relative)', () => {
    expect(
      playwrightRootDirRel(
        JSON.stringify({ config: { rootDir: '/repo/tests/e2e' } }),
        '/repo',
      ),
    ).toBe('tests/e2e');
  });
  it('returns empty when rootDir is the repo root or outside it', () => {
    expect(
      playwrightRootDirRel(
        JSON.stringify({ config: { rootDir: '/repo' } }),
        '/repo',
      ),
    ).toBe('');
    expect(
      playwrightRootDirRel(
        JSON.stringify({ config: { rootDir: '/other' } }),
        '/repo',
      ),
    ).toBe('');
  });
  it('survives malformed json', () => {
    expect(playwrightRootDirRel('not json', '/repo')).toBe('');
  });
});

describe('collectTests', () => {
  it('collects vitest + playwright, deduping playwright’s per-project fan-out', async () => {
    resetMock({
      files: {
        '/repo/package.json': JSON.stringify({
          devDependencies: { 'vitest': '^3', '@playwright/test': '^1' },
        }),
        '/repo/playwright.config.ts': 'export default {}',
      },
      proc: (cmd, args) => {
        if (args.includes('vitest'))
          return { stdout: VITEST_LIST, stderr: '', code: 0 };
        if (args.includes('playwright'))
          return { stdout: PW_LIST, stderr: '', code: 0 };
        return { stdout: '', stderr: '', code: 0 };
      },
    });

    const res = await collectTests(CWD);
    expect(res.availability.vitest).toBe('present');
    expect(res.tree.byRunner.vitest.map((c) => c.id)).toEqual([
      'vitest::tests/a.test.ts::suite > passes',
      'vitest::tests/a.test.ts::suite > fails',
    ]);

    expect(res.availability.playwright).toBe('present');
    // Two projects, ONE case — and the file is repo-relative, not rootDir-relative.
    expect(res.tree.byRunner.playwright).toHaveLength(1);
    expect(res.tree.byRunner.playwright[0]?.file).toBe('tests/e2e/app.spec.ts');
    expect(res.tree.byRunner.playwright[0]?.projects?.sort()).toEqual([
      'chromium',
      'firefox',
    ]);

    // Never declared → never spawned, never shown.
    expect(res.availability.pytest).toBe('absent');
  });

  it('marks a declared-but-uninstalled runner `not-installed` with a hint', async () => {
    resetMock({
      files: {
        '/repo/package.json': JSON.stringify({
          devDependencies: { vitest: '^3' },
        }),
      },
      proc: () => ({
        stdout: '',
        stderr: 'npm error could not determine executable to run',
        code: 1,
      }),
    });
    const res = await collectTests(CWD);
    expect(res.availability.vitest).toBe('not-installed');
    expect(res.notes.vitest).toContain('not installed');
    expect(res.tree.byRunner.vitest).toEqual([]);
  });

  it('one runner failing does not hide the others', async () => {
    resetMock({
      files: {
        '/repo/package.json': JSON.stringify({
          devDependencies: { 'vitest': '^3', '@playwright/test': '^1' },
        }),
        '/repo/playwright.config.ts': 'export default {}',
      },
      proc: (cmd, args) => {
        if (args.includes('playwright'))
          return { stdout: '', stderr: 'boom', code: 1 };
        return { stdout: VITEST_LIST, stderr: '', code: 0 };
      },
    });
    const res = await collectTests(CWD);
    expect(res.tree.byRunner.vitest).toHaveLength(2); // survived
    expect(res.tree.byRunner.playwright).toEqual([]);
    expect(res.notes.playwright).toBe('boom');
  });

  it('treats pytest exit code 5 (no tests collected) as success, not failure', async () => {
    resetMock({
      files: { '/repo/pytest.ini': '[pytest]' },
      proc: (cmd, args) => {
        if (args.includes('--version'))
          return { stdout: '', stderr: '', code: 1 }; // no uv
        return { stdout: '\nno tests ran\n', stderr: '', code: 5 };
      },
    });
    const res = await collectTests(CWD);
    expect(res.availability.pytest).toBe('present');
    expect(res.useUv).toBe(false);
    expect(res.tree.byRunner.pytest).toEqual([]);
    expect(res.notes.pytest).toBeUndefined();
  });

  it('prefers `uv run pytest` when uv is on PATH', async () => {
    resetMock({
      files: { '/repo/pytest.ini': '[pytest]' },
      proc: (cmd, args) => {
        if (cmd === 'uv' && args.includes('--version'))
          return { stdout: 'uv 0.5', stderr: '', code: 0 };
        return { stdout: 'tests/t.py::test_a\n', stderr: '', code: 0 };
      },
    });
    const res = await collectTests(CWD);
    expect(res.useUv).toBe(true);
    expect(res.tree.byRunner.pytest.map((c) => c.id)).toEqual([
      'pytest::tests/t.py::test_a',
    ]);
  });
});
