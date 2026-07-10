// Pure parsers for each runner's collect output, streaming reporter, and
// structured (authoritative) report. No spawning, no IO — every function takes
// a string and returns data, so the whole surface is unit-testable against
// recorded fixtures (tests/unit/tests-panel/fixtures/).
//
// Division of labour, per runner:
//   - the STREAM gives live progress and may be lossy/format-drifty
//   - the STRUCTURED report (json / junit-xml) is the source of truth on exit
// Unknown stream lines are ignored rather than throwing, so a runner version
// bump degrades to "no live progress" instead of breaking the panel.

import type { TestCase, TestEvent, TestFailure, TestRunner } from './types';

// ── shared helpers ───────────────────────────────────────────────────────────

// Matching ANSI escapes inherently requires the ESC control character.
// eslint-disable-next-line no-control-regex -- ESC is the thing being matched
const ANSI_RE = /\[[0-9;]*m/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

/**
 * Read a capture group honestly.
 *
 * TS types `RegExpExecArray` as `string[]`, but a group that did not
 * participate in the match is `undefined` at RUNTIME. Indexing therefore lies,
 * and `m[3].replace(...)` throws on exactly the inputs the optional group exists
 * for (e.g. a self-closing `<failure … />`). `.at()` gives the true type.
 */
function group(m: RegExpExecArray, i: number): string | undefined {
  return m.at(i);
}

/** Escape a literal string for embedding in a regex (vitest -t, playwright -g). */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function makeTestId(runner: TestRunner, file: string, ident: string): string {
  return `${runner}::${file}::${ident}`;
}

/** Inverse of makeTestId. Idents may themselves contain `::` (pytest classes). */
export function parseTestId(
  id: string,
): { runner: TestRunner; file: string; ident: string } | null {
  const parts = id.split('::');
  if (parts.length < 3) return null;
  const runner = parts[0];
  if (runner !== 'vitest' && runner !== 'pytest' && runner !== 'playwright') return null;
  return { runner, file: parts[1] ?? '', ident: parts.slice(2).join('::') };
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/** Make `abs` relative to `root` (both posix-ish). Returns `abs` when outside. */
export function relativize(abs: string, root: string): string {
  const a = toPosix(abs);
  const r = toPosix(root).replace(/\/+$/, '');
  return r && a.startsWith(r + '/') ? a.slice(r.length + 1) : a;
}

// ── vitest ───────────────────────────────────────────────────────────────────

interface VitestListEntry {
  name: string;
  file: string;
}

/**
 * `vitest list --json` → `[{name: "<describe> > <test>", file: "<ABS path>"}]`.
 * No line numbers are available.
 */
export function parseVitestList(stdout: string, repoRoot: string): TestCase[] {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout.trim());
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: TestCase[] = [];
  for (const item of raw as unknown[]) {
    if (!item || typeof item !== 'object') continue;
    const e = item as Partial<VitestListEntry>;
    if (typeof e.name !== 'string' || typeof e.file !== 'string') continue;
    const file = relativize(e.file, repoRoot);
    out.push({
      id: makeTestId('vitest', file, e.name),
      runner: 'vitest',
      file,
      name: e.name,
      selector: { runner: 'vitest', file, fullName: e.name },
    });
  }
  return out;
}

// `ok 3 - path/f.test.ts > suite > name # SKIP`
// `not ok 2 - path/f.test.ts > suite > name # time=4.70ms`
// A SKIPPED test is reported as `ok ... # SKIP`, NOT `not ok` — miss that and
// every skip is scored as a pass.
const TAP_RE = /^(not ok|ok)\s+\d+\s+-\s+(.*?)(?:\s+#\s*(.*))?$/;

/**
 * Streamed `--reporter=tap-flat`. vitest flushes these per FILE as each file
 * finishes, so progress is chunky but live. The subject is `<relFile> > <name>`,
 * which is exactly `makeTestId('vitest', file, name)`'s two halves.
 */
export function parseVitestTapLine(line: string): TestEvent | null {
  const m = TAP_RE.exec(stripAnsi(line).trim());
  if (!m) return null;
  const okTok = group(m, 1);
  const subject = group(m, 2);
  if (!subject) return null;
  const sep = subject.indexOf(' > ');
  if (sep === -1) return null;
  const file = subject.slice(0, sep);
  const name = subject.slice(sep + 3);

  // The optional `# …` trailer; undefined when a line carries no directive.
  const dir = group(m, 3) ?? '';
  const isSkip = /^skip\b/i.test(dir);
  const status = isSkip ? 'skipped' : okTok === 'ok' ? 'passed' : 'failed';

  const timeM = /time=([\d.]+)ms/.exec(dir);
  const durationMs = timeM ? Number(timeM[1]) : undefined;

  return {
    id: makeTestId('vitest', file, name),
    status,
    ...(durationMs != null && Number.isFinite(durationMs) ? { durationMs } : {}),
  };
}

interface VitestJsonAssertion {
  ancestorTitles?: string[];
  title?: string;
  status?: string;
  failureMessages?: string[];
}
interface VitestJsonSuite {
  name?: string;
  assertionResults?: VitestJsonAssertion[];
}

/**
 * `--reporter=json --outputFile.json=<f>` written on exit. Authoritative
 * statuses + failure messages. `name` on each suite is the ABSOLUTE file path;
 * the assertion's identity is `[...ancestorTitles, title].join(' > ')`, which
 * reconstructs the same ident the TAP stream used.
 */
export function parseVitestReport(
  json: string,
  repoRoot: string,
): { statuses: Map<string, TestEvent['status']>; failures: Map<string, TestFailure> } {
  const statuses = new Map<string, TestEvent['status']>();
  const failures = new Map<string, TestFailure>();
  let doc: { testResults?: VitestJsonSuite[] };
  try {
    doc = JSON.parse(json) as { testResults?: VitestJsonSuite[] };
  } catch {
    return { statuses, failures };
  }
  for (const suite of doc.testResults ?? []) {
    if (!suite.name) continue;
    const file = relativize(suite.name, repoRoot);
    for (const a of suite.assertionResults ?? []) {
      if (!a.title) continue;
      const ident = [...(a.ancestorTitles ?? []), a.title].join(' > ');
      const id = makeTestId('vitest', file, ident);
      const st =
        a.status === 'passed' ? 'passed' : a.status === 'failed' ? 'failed' : 'skipped';
      statuses.set(id, st);
      const msg = a.failureMessages?.[0];
      if (st === 'failed' && msg) {
        const clean = stripAnsi(msg);
        const nl = clean.indexOf('\n');
        failures.set(id, {
          message: nl === -1 ? clean : clean.slice(0, nl),
          stack: nl === -1 ? undefined : clean.slice(nl + 1),
        });
      }
    }
  }
  return { statuses, failures };
}

// ── pytest ───────────────────────────────────────────────────────────────────

/**
 * `pytest --collect-only -q` → one nodeid per line, then a blank line and a
 * `N tests collected` summary we must drop.
 */
export function parsePytestCollect(stdout: string): TestCase[] {
  const out: TestCase[] = [];
  for (const rawLine of stripAnsi(stdout).split('\n')) {
    const line = rawLine.trim();
    // Summary/error lines never look like `path.py::ident`.
    if (!/^[^\s:]+\.py::/.test(line)) continue;
    const sep = line.indexOf('::');
    const file = line.slice(0, sep);
    const ident = line.slice(sep + 2);
    out.push({
      id: makeTestId('pytest', file, ident),
      runner: 'pytest',
      file,
      name: ident,
      selector: { runner: 'pytest', nodeId: line },
    });
  }
  return out;
}

// `tests/test_demo.py::test_fails FAILED                        [ 33%]`
// `tests/test_demo.py::test_skipped SKIPPED (nope)              [ 50%]`
const PYTEST_V_RE =
  /^([^\s:]+\.py::\S+)\s+(PASSED|FAILED|SKIPPED|ERROR|XFAIL|XPASS)\b/;

/** Streamed `pytest -v`. nodeids are exact, so this is the cleanest of the three. */
export function parsePytestVerboseLine(line: string): TestEvent | null {
  const m = PYTEST_V_RE.exec(stripAnsi(line).trim());
  if (!m) return null;
  const [, nodeId, word] = m;
  if (!nodeId || !word) return null;
  const status =
    word === 'PASSED' || word === 'XPASS'
      ? 'passed'
      : word === 'FAILED' || word === 'ERROR'
        ? 'failed'
        : 'skipped';
  const sep = nodeId.indexOf('::');
  return {
    id: makeTestId('pytest', nodeId.slice(0, sep), nodeId.slice(sep + 2)),
    status,
  };
}

/**
 * Map a pytest nodeid onto the JUnit `classname` + `name` pair.
 *
 * JUnit carries NO file/line attribute — only a dotted `classname`. But the
 * mapping is deterministic in the other direction: a nodeid is
 * `<file>.py[::<Class>]*::<name>`, and classname is that same file path with
 * `/`→`.` and `.py` dropped, with any class segments appended. So we derive the
 * key from the nodeid rather than trying to invert classname (which is ambiguous
 * — you can't tell a package segment from a class segment).
 */
export function pytestJunitKey(nodeId: string): string {
  const parts = nodeId.split('::');
  const file = parts[0] ?? '';
  const name = parts[parts.length - 1] ?? '';
  const classes = parts.slice(1, -1);
  const mod = file.replace(/\.py$/, '').replace(/\//g, '.');
  const classname = [mod, ...classes].join('.');
  return `${classname}::${name}`;
}

/** `pytest --junit-xml` — authoritative failure messages + tracebacks. */
export function parsePytestJunit(xml: string): Map<string, TestFailure> {
  const out = new Map<string, TestFailure>();
  // Deliberately regex, not DOMParser: this runs in the renderer AND (later)
  // possibly a Node task, and the schema here is trivially flat.
  //
  // A passing testcase is SELF-CLOSING (`<testcase … />`). The attrs group must
  // therefore stop before `/>` — with a greedy `[^>]*` it eats the slash, the
  // open-tag branch matches a self-closing tag, and `…</testcase>` then runs on
  // to the NEXT case's body, pairing the wrong attributes with the wrong failure.
  const caseRe = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
  // The leading boundary is load-bearing: a bare /name="…"/ also matches inside
  // `classname="…"`, so `name` would read back the classname.
  const attrRe = (attrs: string, name: string): string | undefined => {
    const m = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs);
    return m?.[1];
  };
  let m: RegExpExecArray | null;
  while ((m = caseRe.exec(xml)) !== null) {
    // A passing testcase is self-closing, so group 2 (the body) is undefined.
    const attrs = group(m, 1) ?? '';
    const body = group(m, 2) ?? '';
    const classname = attrRe(attrs, 'classname');
    const name = attrRe(attrs, 'name');
    if (!classname || !name) continue;
    // `<skipped>` is NOT a failure. Also handle the self-closing form.
    const fail = /<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/.exec(body);
    if (!fail) continue;
    const failAttrs = group(fail, 2) ?? '';
    const stack = decodeXml(group(fail, 3) ?? '');
    const message = decodeXml(attrRe(failAttrs, 'message') ?? 'test failed');
    out.set(`${decodeXml(classname)}::${decodeXml(name)}`, {
      message: message.split('\n')[0] ?? message,
      stack: stack.trim() || undefined,
    });
  }
  return out;
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#10;/g, '\n')
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)))
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// ── playwright ───────────────────────────────────────────────────────────────

interface PwSpec {
  title?: string;
  file?: string;
  line?: number;
  tests?: { projectName?: string; results?: { status?: string; errors?: { message?: string; stack?: string }[] }[] }[];
}
interface PwSuite {
  specs?: PwSpec[];
  suites?: PwSuite[];
}

function flattenPwSpecs(suites: PwSuite[] | undefined, out: PwSpec[]): void {
  for (const s of suites ?? []) {
    for (const sp of s.specs ?? []) out.push(sp);
    flattenPwSpecs(s.suites, out);
  }
}

/**
 * `playwright test --list --reporter=json`.
 *
 * Two traps, both verified against a real run:
 *   1. `spec.id` is NOT stable — it differs per project, so the same spec shows
 *      up once per configured project (3× with chromium/firefox/webkit). We key
 *      on file+line+title and collect the project names.
 *   2. `spec.file` is relative to `config.rootDir` (e.g. `tests/e2e`), NOT to the
 *      repo root. Callers pass `rootDirRel` so ids match repo-relative paths.
 */
export function parsePlaywrightList(json: string, rootDirRel = ''): TestCase[] {
  let doc: { suites?: PwSuite[]; config?: { rootDir?: string } };
  try {
    doc = JSON.parse(json) as { suites?: PwSuite[] };
  } catch {
    return [];
  }
  const specs: PwSpec[] = [];
  flattenPwSpecs(doc.suites, specs);

  const byKey = new Map<string, TestCase>();
  for (const sp of specs) {
    if (!sp.file || !sp.title || sp.line == null) continue;
    const file = rootDirRel ? `${rootDirRel.replace(/\/+$/, '')}/${sp.file}` : sp.file;
    const ident = `${sp.line}::${sp.title}`;
    const id = makeTestId('playwright', file, ident);
    const projects = (sp.tests ?? [])
      .map((t) => t.projectName)
      .filter((p): p is string => typeof p === 'string' && p.length > 0);
    const existing = byKey.get(id);
    if (existing) {
      for (const p of projects) if (!existing.projects?.includes(p)) existing.projects?.push(p);
      continue;
    }
    byKey.set(id, {
      id,
      runner: 'playwright',
      file,
      name: sp.title,
      projects: [...projects],
      selector: { runner: 'playwright', file, line: sp.line, title: sp.title },
    });
  }
  return [...byKey.values()];
}

// `  ✓  1 [firefox] › .__pwfix/tests/demo.spec.ts:3:3 › demo group › passes fine (4ms)`
// `  -  5 [firefox] › ….spec.ts:5:8 › demo group › is skipped`      (skipped: no duration)
// `  ✘  4 [chromium] › ….spec.ts:4:3 › demo group › fails hard (2ms)`
const PW_LIST_RE =
  /^([✓✘×✕✖×\-])\s+\d+\s+\[([^\]]+)\]\s+›\s+(\S+?):(\d+):(\d+)\s+›\s+(.*)$/;

/**
 * Streamed `--reporter=list`.
 *
 * NOTE the path here is relative to CWD, whereas the json report's `file` is
 * relative to `config.rootDir`. They are not the same string, so we return the
 * cwd-relative file and let the caller resolve it against known TestCases by
 * suffix. The trailing `(4ms)` is present only for non-skipped tests.
 */
export function parsePlaywrightListLine(
  line: string,
): { file: string; line: number; title: string; project: string; status: TestEvent['status']; durationMs?: number } | null {
  const m = PW_LIST_RE.exec(stripAnsi(line).trimEnd().replace(/^\s+/, ''));
  if (!m) return null;
  const [, mark, project, file, lineNo, , rest] = m;
  if (!rest || !file || !project) return null;

  const status: TestEvent['status'] =
    mark === '-' ? 'skipped' : mark === '✓' ? 'passed' : 'failed';

  // `rest` is `<describe> › … › <title>` optionally followed by ` (4ms)`.
  let tail = rest;
  let durationMs: number | undefined;
  const dur = /\s+\((\d+(?:\.\d+)?)(ms|s)\)$/.exec(tail);
  if (dur) {
    tail = tail.slice(0, dur.index);
    const n = Number(dur[1]);
    durationMs = dur[2] === 's' ? n * 1000 : n;
  }
  const segs = tail.split(' › ');
  const title = segs[segs.length - 1] ?? tail;

  return {
    file,
    line: Number(lineNo),
    title,
    project,
    status,
    ...(durationMs != null ? { durationMs } : {}),
  };
}

/** Authoritative playwright JSON report (written to PLAYWRIGHT_JSON_OUTPUT_NAME). */
export function parsePlaywrightReport(
  json: string,
  rootDirRel = '',
): { statuses: Map<string, TestEvent['status']>; failures: Map<string, TestFailure> } {
  const statuses = new Map<string, TestEvent['status']>();
  const failures = new Map<string, TestFailure>();
  let doc: { suites?: PwSuite[] };
  try {
    doc = JSON.parse(json) as { suites?: PwSuite[] };
  } catch {
    return { statuses, failures };
  }
  const specs: PwSpec[] = [];
  flattenPwSpecs(doc.suites, specs);

  for (const sp of specs) {
    if (!sp.file || !sp.title || sp.line == null) continue;
    const file = rootDirRel ? `${rootDirRel.replace(/\/+$/, '')}/${sp.file}` : sp.file;
    const id = makeTestId('playwright', file, `${sp.line}::${sp.title}`);

    // A spec runs once per project. Aggregate: any failure fails the row; all
    // skipped ⇒ skipped. The panel groups by spec, not by project.
    let anyFailed = false;
    let anyPassed = false;
    let firstErr: TestFailure | undefined;
    for (const t of sp.tests ?? []) {
      for (const r of t.results ?? []) {
        if (r.status === 'failed' || r.status === 'timedOut') {
          anyFailed = true;
          const e = r.errors?.[0];
          if (e && !firstErr) {
            firstErr = {
              message: stripAnsi(e.message ?? 'test failed').split('\n')[0] ?? 'test failed',
              stack: e.stack ? stripAnsi(e.stack) : stripAnsi(e.message ?? '') || undefined,
            };
          }
        } else if (r.status === 'passed') anyPassed = true;
      }
    }
    statuses.set(id, anyFailed ? 'failed' : anyPassed ? 'passed' : 'skipped');
    if (anyFailed && firstErr) failures.set(id, firstErr);
  }
  return { statuses, failures };
}

/**
 * Resolve a streamed playwright list line onto a discovered TestCase id.
 * The stream's path is cwd-relative and the tree's is repo-relative, so match on
 * `line` + `title` + a path-suffix relation rather than string equality.
 */
export function matchPlaywrightEvent(
  ev: { file: string; line: number; title: string },
  cases: TestCase[],
): string | null {
  const evFile = toPosix(ev.file);
  for (const c of cases) {
    if (c.runner !== 'playwright') continue;
    if (c.selector.runner !== 'playwright') continue;
    if (c.selector.line !== ev.line || c.selector.title !== ev.title) continue;
    const cf = toPosix(c.file);
    if (evFile === cf || evFile.endsWith('/' + cf) || cf.endsWith('/' + evFile)) return c.id;
  }
  return null;
}
