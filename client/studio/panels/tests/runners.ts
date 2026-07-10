// Argv builders for collecting and running tests, per runner.
//
// Pure: every function returns `{cmd, args, env?}` and never spawns. That keeps
// the escaping rules (which differ sharply per runner) unit-testable.
//
// Each run uses ONE spawn with a dual reporter: a streaming reporter for live
// per-test progress, plus a structured report written to a temp file that the
// caller reads on exit for authoritative statuses + failure detail. A plain
// `--reporter=json` alone only emits at the end, which is useless for progress.

import { escapeRegex } from './parsers';
import type { TestSelector } from './types';

export interface Argv {
  cmd: string;
  args: string[];
  env?: Record<string, string>;
}

/** Where a run's structured report lands. Written by the child, read on exit. */
export interface ReportTarget {
  path: string;
}

// ── collect ──────────────────────────────────────────────────────────────────

export function vitestCollectArgv(): Argv {
  // `--no-install` so a missing binary FAILS instead of silently downloading a
  // package from the network mid-panel-render.
  return { cmd: 'npx', args: ['--no-install', 'vitest', 'list', '--json'] };
}

export function pytestCollectArgv(useUv: boolean): Argv {
  return useUv
    ? { cmd: 'uv', args: ['run', 'pytest', '--collect-only', '-q', '-p', 'no:cacheprovider'] }
    : { cmd: 'pytest', args: ['--collect-only', '-q', '-p', 'no:cacheprovider'] };
}

export function playwrightCollectArgv(): Argv {
  return { cmd: 'npx', args: ['--no-install', 'playwright', 'test', '--list', '--reporter=json'] };
}

// ── run ──────────────────────────────────────────────────────────────────────

/**
 * vitest: tap-flat streams per-file as each file finishes; json is written to
 * `report.path` on exit. vitest accepts repeated `--reporter` flags plus a
 * per-reporter `--outputFile.json`.
 */
export function vitestRunArgv(report: ReportTarget, selector?: TestSelector): Argv {
  const args = ['--no-install', 'vitest', 'run'];
  if (selector?.runner === 'vitest') {
    args.push(selector.file);
    if (selector.fullName) {
      // `-t` is a REGEX, matched as a substring against the concatenated
      // `describe > test` name. Escaping is mandatory: a real vitest name in
      // this repo is "has a special [name] with (regex) chars", where the
      // brackets would otherwise become a character class and match nothing.
      args.push('-t', escapeRegex(selector.fullName));
    }
  } else if (selector) {
    throw new Error(`vitestRunArgv got a ${selector.runner} selector`);
  }
  args.push('--reporter=tap-flat', '--reporter=json', `--outputFile.json=${report.path}`);
  return { cmd: 'npx', args };
}

/** vitest, scoped to a whole file (run-file). */
export function vitestRunFileArgv(report: ReportTarget, file: string): Argv {
  return {
    cmd: 'npx',
    args: [
      '--no-install',
      'vitest',
      'run',
      file,
      '--reporter=tap-flat',
      '--reporter=json',
      `--outputFile.json=${report.path}`,
    ],
  };
}

/**
 * pytest: `-v` streams `<nodeid> PASSED|FAILED|SKIPPED`; `--junit-xml` gives
 * structured failure detail. JUnit is built in — no plugin, unlike
 * `--json-report`, which is frequently absent.
 */
export function pytestRunArgv(
  report: ReportTarget,
  useUv: boolean,
  target?: string,
): Argv {
  const pytestArgs = ['-v', '-p', 'no:cacheprovider', `--junit-xml=${report.path}`];
  // pytest nodeids are exact and unique — no regex, no escaping. Passed as a
  // single argv element, so brackets in `test_param[1]` are safe.
  if (target) pytestArgs.push(target);
  return useUv
    ? { cmd: 'uv', args: ['run', 'pytest', ...pytestArgs] }
    : { cmd: 'pytest', args: pytestArgs };
}

/**
 * playwright: `list` streams; the json reporter would ALSO write to stdout and
 * interleave with it — setting PLAYWRIGHT_JSON_OUTPUT_NAME redirects it to a
 * file instead. (Verified: with the env var set, stdout carries zero JSON.)
 */
export function playwrightRunArgv(
  report: ReportTarget,
  selector?: TestSelector,
  opts?: { singleProject?: string },
): Argv {
  const args = ['--no-install', 'playwright', 'test'];
  if (selector?.runner === 'playwright') {
    // `file:line` pins the exact spec; `-g` disambiguates same-line params.
    args.push(`${selector.file}:${selector.line}`);
    args.push('-g', escapeRegex(selector.title));
    if (selector.project) args.push('--project', selector.project);
  } else if (selector) {
    throw new Error(`playwrightRunArgv got a ${selector.runner} selector`);
  }
  // A run-all across chromium+firefox+webkit is a 3x blow-up and minutes long.
  // The panel defaults to one project and says so.
  if (!selector?.project && opts?.singleProject) args.push('--project', opts.singleProject);
  args.push('--reporter=list,json');
  return {
    cmd: 'npx',
    args,
    env: { PLAYWRIGHT_JSON_OUTPUT_NAME: report.path },
  };
}

export function playwrightRunFileArgv(
  report: ReportTarget,
  file: string,
  opts?: { singleProject?: string },
): Argv {
  const args = ['--no-install', 'playwright', 'test', file];
  if (opts?.singleProject) args.push('--project', opts.singleProject);
  args.push('--reporter=list,json');
  return { cmd: 'npx', args, env: { PLAYWRIGHT_JSON_OUTPUT_NAME: report.path } };
}

/** Build the run argv for a single test, from its selector alone. */
export function runOneArgv(
  selector: TestSelector,
  report: ReportTarget,
  opts: { useUv: boolean },
): Argv {
  switch (selector.runner) {
    case 'vitest':
      return vitestRunArgv(report, selector);
    case 'pytest':
      return pytestRunArgv(report, opts.useUv, selector.nodeId);
    case 'playwright':
      return playwrightRunArgv(report, selector);
  }
}

/** Signature of a "command not found / package missing" collect failure. */
export function looksNotInstalled(stderr: string, code: number | null): boolean {
  const s = stderr.toLowerCase();
  return (
    code === 127 ||
    s.includes('command not found') ||
    s.includes('cannot find module') ||
    s.includes('cannot find package') ||
    s.includes('no such file or directory') ||
    s.includes('is not recognized as an internal or external command') ||
    // `npx --no-install <bin>` when the bin isn't in node_modules
    s.includes('could not determine executable') ||
    s.includes('npm error could not determine executable')
  );
}
