// Shared types for the Tests panel.

export type TestRunner = 'vitest' | 'pytest' | 'playwright';

export const TEST_RUNNERS: readonly TestRunner[] = ['vitest', 'pytest', 'playwright'];

export type TestStatus =
  | 'idle'
  | 'queued'
  | 'running'
  | 'passed'
  | 'failed'
  | 'skipped';

/** Whether a runner can be driven in the selected repo at all. */
export type RunnerAvailability =
  /** Declared by the repo AND its binary resolved. */
  | 'present'
  /** Declared by the repo but the binary/package is missing → show an install hint. */
  | 'not-installed'
  /** The repo doesn't use this runner. Render nothing. */
  | 'absent';

/**
 * How to re-run exactly one test. Carried on the TestCase so `runOne` never has
 * to re-parse a testId — and so each runner's very different selector semantics
 * stay explicit rather than being re-derived from a string.
 */
export type TestSelector =
  /** vitest `-t` is a REGEX SUBSTRING match on the concatenated name. */
  | { runner: 'vitest'; file: string; fullName: string }
  /** pytest nodeids are exact and unique. */
  | { runner: 'pytest'; nodeId: string }
  /** playwright: `file:line` pins the spec; `-g` disambiguates; project collapses the N× fan-out. */
  | { runner: 'playwright'; file: string; line: number; title: string; project?: string };

export interface TestCase {
  /** `<runner>::<relFile>::<ident>` — React key AND stream-match key. */
  id: string;
  runner: TestRunner;
  /** Repo-relative, posix separators. */
  file: string;
  /** Display name within the file (describe chain + test title). */
  name: string;
  selector: TestSelector;
  /** playwright only: the projects this spec runs under (chromium/firefox/…). */
  projects?: string[];
}

export interface TestFailure {
  message: string;
  stack?: string;
}

/** Discovered tests grouped runner → file → cases. */
export interface TestTree {
  byRunner: Record<TestRunner, TestCase[]>;
}

export function emptyTree(): TestTree {
  return { byRunner: { vitest: [], pytest: [], playwright: [] } };
}

/** A single line of streamed per-test progress, normalized across runners. */
export interface TestEvent {
  /** Matches TestCase.id when discovery saw this test; otherwise a synthesized id. */
  id: string;
  status: Extract<TestStatus, 'passed' | 'failed' | 'skipped'>;
  durationMs?: number;
}
