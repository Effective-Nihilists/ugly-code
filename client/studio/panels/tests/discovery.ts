// Runner detection + test collection for the Tests panel.
//
// Detection reads config files only (no spawning). Collection spawns each
// present runner's list/collect command. One runner failing NEVER hides the
// others — each resolves independently to present | not-installed | absent.

import { native } from 'ugly-app/native';
import { spawnCollect } from '../../../agent/tools/spawn';
import {
  parsePlaywrightList,
  parsePytestCollect,
  parseVitestList,
} from './parsers';
import {
  looksNotInstalled,
  playwrightCollectArgv,
  pytestCollectArgv,
  vitestCollectArgv,
} from './runners';
import {
  emptyTree,
  type RunnerAvailability,
  type TestCase,
  type TestRunner,
  type TestTree,
} from './types';

const COLLECT_TIMEOUT_MS = 90_000;

// ── fs helpers (mirrors agent/finish/languages.ts) ───────────────────────────

function join(dir: string, child: string): string {
  return dir.endsWith('/') ? `${dir}${child}` : `${dir}/${child}`;
}

/** Use the facade's own `exists` rather than languages.ts's `stat`-and-catch:
 *  not every host implementation throws on a missing path (the node test mock
 *  returns a zeroed dir stat), which would make every probe report `true`. */
async function exists(path: string): Promise<boolean> {
  try {
    return await native.fs.exists(path);
  } catch {
    return false;
  }
}

async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await native.fs.readFile(path);
  } catch {
    return null;
  }
}

interface PackageJsonShape {
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
}

async function readPackageJson(cwd: string): Promise<PackageJsonShape | null> {
  const raw = await readFileOrNull(join(cwd, 'package.json'));
  if (raw == null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function hasDep(pkg: PackageJsonShape | null, name: string): boolean {
  return Boolean(pkg?.devDependencies?.[name] ?? pkg?.dependencies?.[name]);
}

// ── detection (config-file reads only) ───────────────────────────────────────

/** Does this repo DECLARE the runner? (Says nothing about whether it's installed.) */
export async function detectRunners(
  cwd: string,
): Promise<Record<TestRunner, boolean>> {
  const pkg = await readPackageJson(cwd);

  const vitest =
    hasDep(pkg, 'vitest') || /\bvitest\b/.test(pkg?.scripts?.test ?? '');

  const playwright =
    hasDep(pkg, '@playwright/test') &&
    ((await exists(join(cwd, 'playwright.config.ts'))) ||
      (await exists(join(cwd, 'playwright.config.js'))) ||
      (await exists(join(cwd, 'playwright.config.mjs'))));

  const pyproject = await readFileOrNull(join(cwd, 'pyproject.toml'));
  const pytest =
    Boolean(pyproject && /\[tool\.pytest(\.|\])/.test(pyproject)) ||
    (await exists(join(cwd, 'pytest.ini'))) ||
    (await exists(join(cwd, 'conftest.py')));

  return { vitest, pytest, playwright };
}

/** Is `uv` on PATH? languages.ts assumes `uv run pytest`, but uv is often absent. */
export async function hasUv(cwd: string): Promise<boolean> {
  const r = await spawnCollect('uv', ['--version'], { cwd, timeoutMs: 10_000 });
  return r.code === 0;
}

/**
 * playwright's json report gives `file` relative to `config.rootDir`, not the
 * repo root. Read the config's testDir so ids come out repo-relative.
 */
export function playwrightRootDirRel(listJson: string, cwd: string): string {
  try {
    const doc = JSON.parse(listJson) as { config?: { rootDir?: string } };
    const rootDir = doc.config?.rootDir;
    if (!rootDir) return '';
    const norm = (s: string): string =>
      s.replace(/\\/g, '/').replace(/\/+$/, '');
    const r = norm(rootDir);
    const c = norm(cwd);
    return r.startsWith(c + '/') ? r.slice(c.length + 1) : '';
  } catch {
    return '';
  }
}

// ── collection ───────────────────────────────────────────────────────────────

export interface CollectResult {
  tree: TestTree;
  availability: Record<TestRunner, RunnerAvailability>;
  /** Human-readable reason per runner, when not `present`. */
  notes: Partial<Record<TestRunner, string>>;
  useUv: boolean;
}

async function collectVitest(
  cwd: string,
): Promise<{ cases: TestCase[]; avail: RunnerAvailability; note?: string }> {
  const { cmd, args } = vitestCollectArgv();
  const r = await spawnCollect(cmd, args, {
    cwd,
    timeoutMs: COLLECT_TIMEOUT_MS,
  });
  if (r.code !== 0) {
    return looksNotInstalled(r.stderr, r.code)
      ? {
          cases: [],
          avail: 'not-installed',
          note: 'vitest is not installed — run your package manager’s install.',
        }
      : {
          cases: [],
          avail: 'present',
          note: humanizeCollectFailure('vitest', r.stderr || r.stdout),
        };
  }
  return { cases: parseVitestList(r.stdout, cwd), avail: 'present' };
}

async function collectPytest(
  cwd: string,
  useUv: boolean,
): Promise<{ cases: TestCase[]; avail: RunnerAvailability; note?: string }> {
  const { cmd, args } = pytestCollectArgv(useUv);
  const r = await spawnCollect(cmd, args, {
    cwd,
    timeoutMs: COLLECT_TIMEOUT_MS,
  });
  // pytest exits 5 when it collected nothing; that's "no tests", not a failure.
  if (r.code !== 0 && r.code !== 5) {
    return looksNotInstalled(r.stderr, r.code)
      ? {
          cases: [],
          avail: 'not-installed',
          note: 'pytest is not installed — `pip install pytest` (or add uv).',
        }
      : {
          cases: [],
          avail: 'present',
          note: humanizeCollectFailure('pytest', r.stderr || r.stdout),
        };
  }
  return { cases: parsePytestCollect(r.stdout), avail: 'present' };
}

async function collectPlaywright(
  cwd: string,
): Promise<{ cases: TestCase[]; avail: RunnerAvailability; note?: string }> {
  const { cmd, args } = playwrightCollectArgv();
  const r = await spawnCollect(cmd, args, {
    cwd,
    timeoutMs: COLLECT_TIMEOUT_MS,
  });
  if (r.code !== 0) {
    return looksNotInstalled(r.stderr, r.code)
      ? {
          cases: [],
          avail: 'not-installed',
          note: '@playwright/test is not installed.',
        }
      : {
          cases: [],
          avail: 'present',
          note: humanizeCollectFailure('playwright', r.stderr || r.stdout),
        };
  }
  const rootDirRel = playwrightRootDirRel(r.stdout, cwd);
  return { cases: parsePlaywrightList(r.stdout, rootDirRel), avail: 'present' };
}

function firstLine(s: string): string {
  const l = s.trim().split('\n')[0] ?? '';
  return l.length > 200 ? l.slice(0, 200) + '…' : l;
}

/**
 * A collect that failed for a reason OTHER than "not installed" often prints only
 * a bare stack frame or bundler vendor path — e.g. `vitest list --json` throwing
 * from `…/vitest/dist/vendor/cac.<hash>.js:403` on a version that doesn't accept
 * the flag, even though `vitest run` works fine. Dumping that path at the user (in
 * red, next to "0 tests") reads as "the panel is broken". Detect that noise and
 * fall back to plain language; surface the raw first line only when it's a real,
 * human-readable message.
 */
function humanizeCollectFailure(runner: TestRunner, raw: string): string {
  const line = firstLine(raw);
  const looksLikeNoise =
    line === '' ||
    /\.(m?[jt]s|cjs):\d+$/.test(line) || // ends in some/file.ext:lineNo
    /[/\\](?:vendor|dist|node_modules)[/\\]/.test(line) || // bundler internals
    line.startsWith('file://') ||
    /^\s*at\s/.test(line); // a stack frame
  return looksLikeNoise
    ? `${runner} couldn’t list tests here — press Run to execute them directly.`
    : line;
}

/** Detect, then collect each declared runner concurrently. */
export async function collectTests(cwd: string): Promise<CollectResult> {
  const declared = await detectRunners(cwd);
  const useUv = declared.pytest ? await hasUv(cwd) : false;

  const tree = emptyTree();
  const availability: Record<TestRunner, RunnerAvailability> = {
    vitest: 'absent',
    pytest: 'absent',
    playwright: 'absent',
  };
  const notes: Partial<Record<TestRunner, string>> = {};

  const jobs: Promise<void>[] = [];

  if (declared.vitest) {
    jobs.push(
      collectVitest(cwd).then((r) => {
        tree.byRunner.vitest = r.cases;
        availability.vitest = r.avail;
        if (r.note) notes.vitest = r.note;
      }),
    );
  }
  if (declared.pytest) {
    jobs.push(
      collectPytest(cwd, useUv).then((r) => {
        tree.byRunner.pytest = r.cases;
        availability.pytest = r.avail;
        if (r.note) notes.pytest = r.note;
      }),
    );
  }
  if (declared.playwright) {
    jobs.push(
      collectPlaywright(cwd).then((r) => {
        tree.byRunner.playwright = r.cases;
        availability.playwright = r.avail;
        if (r.note) notes.playwright = r.note;
      }),
    );
  }

  // allSettled, not all: one runner blowing up must not blank the whole panel.
  await Promise.allSettled(jobs);
  return { tree, availability, notes, useUv };
}

/** Group a runner's cases by file, preserving discovery order. */
export function groupByFile(
  cases: TestCase[],
): { file: string; cases: TestCase[] }[] {
  const map = new Map<string, TestCase[]>();
  for (const c of cases) {
    const arr = map.get(c.file);
    if (arr) arr.push(c);
    else map.set(c.file, [c]);
  }
  return [...map.entries()].map(([file, cs]) => ({ file, cases: cs }));
}
