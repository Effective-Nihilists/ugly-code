// Tests panel — discover and run vitest / pytest / playwright in the selected
// repo, with live per-test progress and visible failures.
//
// State lives in a module-level registry keyed by repo path (NOT in React), so a
// running suite survives leaving the tab — same shape as PreviewPanel's dev
// server. A run is stopped only by the explicit Stop button, never by unmount.
//
// Each run is ONE spawn producing two things: a streaming reporter (live status
// per test) and a structured report file read on exit (authoritative statuses +
// failure detail). The stream is progress-only; the report is truth. Unknown
// stream lines are ignored, so a runner version bump degrades to "no live
// progress" instead of a broken panel.

import React from 'react';
import { native } from 'ugly-app/native';
import { ansiToNodes } from './ansi';
import { GitRepoSelector, useActiveRepoPath } from './GitRepoSelector';
import { collectTests, groupByFile, type CollectResult } from './tests/discovery';
import {
  matchPlaywrightEvent,
  parsePlaywrightListLine,
  parsePlaywrightReport,
  parsePytestVerboseLine,
  parsePytestJunit,
  parseVitestReport,
  parseVitestTapLine,
  pytestJunitKey,
  stripAnsi,
} from './tests/parsers';
import {
  playwrightRunFileArgv,
  pytestRunArgv,
  runOneArgv,
  vitestRunFileArgv,
  type Argv,
} from './tests/runners';
import {
  emptyTree,
  TEST_RUNNERS,
  type RunnerAvailability,
  type TestCase,
  type TestFailure,
  type TestRunner,
  type TestStatus,
  type TestTree,
} from './tests/types';

/** Raw log cap. PreviewPanel uses 12k; a full suite blows past that instantly.
 *  Per-test state lives in Maps, so truncating the log never loses pass/fail. */
const LOG_CAP = 200_000;

/** run-all across chromium+firefox+webkit is a 3x blow-up and takes minutes. */
const PLAYWRIGHT_DEFAULT_PROJECT = 'chromium';

// ── module-level run registry ────────────────────────────────────────────────

interface RunState {
  tree: TestTree;
  availability: Record<TestRunner, RunnerAvailability>;
  notes: Partial<Record<TestRunner, string>>;
  useUv: boolean;
  status: Map<string, TestStatus>;
  detail: Map<string, TestFailure>;
  log: string;
  proc: { kill: (sig?: string) => void } | null;
  running: boolean;
  runToken: number;
  collectState: 'idle' | 'collecting' | 'ready' | 'error';
  collectError: string | null;
  subs: Set<() => void>;
}

function newRunState(): RunState {
  return {
    tree: emptyTree(),
    availability: { vitest: 'absent', pytest: 'absent', playwright: 'absent' },
    notes: {},
    useUv: false,
    status: new Map(),
    detail: new Map(),
    log: '',
    proc: null,
    running: false,
    runToken: 0,
    collectState: 'idle',
    collectError: null,
    subs: new Set(),
  };
}

const runs = new Map<string, RunState>();

function getRun(repo: string): RunState {
  let s = runs.get(repo);
  if (!s) {
    s = newRunState();
    runs.set(repo, s);
  }
  return s;
}

function notify(s: RunState): void {
  for (const cb of s.subs) cb();
}

function appendLog(s: RunState, chunk: string): void {
  s.log = (s.log + chunk).slice(-LOG_CAP);
}

function allCases(tree: TestTree): TestCase[] {
  return TEST_RUNNERS.flatMap((r) => tree.byRunner[r]);
}

// ── collect ──────────────────────────────────────────────────────────────────

async function refresh(repo: string): Promise<void> {
  const s = getRun(repo);
  if (s.collectState === 'collecting') return;
  s.collectState = 'collecting';
  s.collectError = null;
  notify(s);
  try {
    const res: CollectResult = await collectTests(repo);
    s.tree = res.tree;
    s.availability = res.availability;
    s.notes = res.notes;
    s.useUv = res.useUv;
    s.status = new Map();
    s.detail = new Map();
    s.collectState = 'ready';
  } catch (e) {
    s.collectState = 'error';
    s.collectError = e instanceof Error ? e.message : String(e);
  }
  notify(s);
}

// ── run ──────────────────────────────────────────────────────────────────────

const REPORT_DIR = '.ugly-studio/tests';

async function reportPathFor(repo: string, runner: TestRunner): Promise<string> {
  const dir = `${repo}/${REPORT_DIR}`;
  try {
    await native.fs.mkdir(dir, true);
  } catch {
    /* already exists */
  }
  return `${dir}/${runner}-report.${runner === 'pytest' ? 'xml' : 'json'}`;
}

/** Apply a streamed line to the live status map. */
function applyStreamLine(s: RunState, runner: TestRunner, line: string): boolean {
  if (runner === 'vitest') {
    const ev = parseVitestTapLine(line);
    if (!ev) return false;
    s.status.set(ev.id, ev.status);
    return true;
  }
  if (runner === 'pytest') {
    const ev = parsePytestVerboseLine(line);
    if (!ev) return false;
    s.status.set(ev.id, ev.status);
    return true;
  }
  const raw = parsePlaywrightListLine(line);
  if (!raw) return false;
  // The list reporter's path is cwd-relative; the tree's is repo-relative.
  const id = matchPlaywrightEvent(raw, s.tree.byRunner.playwright);
  if (!id) return false;
  s.status.set(id, raw.status);
  return true;
}

/** Read the structured report and overwrite the streamed statuses with truth. */
async function applyReport(
  s: RunState,
  runner: TestRunner,
  path: string,
  repo: string,
): Promise<void> {
  let raw: string;
  try {
    raw = await native.fs.readFile(path);
  } catch {
    // No report (crashed before writing / runner too old). The streamed statuses
    // are all we have; leave them rather than blanking the run.
    return;
  }
  if (runner === 'vitest') {
    const { statuses, failures } = parseVitestReport(raw, repo);
    for (const [id, st] of statuses) s.status.set(id, st);
    for (const [id, f] of failures) s.detail.set(id, f);
    return;
  }
  if (runner === 'playwright') {
    const rootRel = s.tree.byRunner.playwright[0]?.file.includes('/')
      ? s.tree.byRunner.playwright[0].file.split('/').slice(0, -1).join('/')
      : '';
    const { statuses, failures } = parsePlaywrightReport(raw, rootRel);
    for (const [id, st] of statuses) s.status.set(id, st);
    for (const [id, f] of failures) s.detail.set(id, f);
    return;
  }
  // pytest: junit has no file/line, so map each collected nodeid onto its
  // derived junit key rather than trying to invert `classname`.
  const failures = parsePytestJunit(raw);
  for (const c of s.tree.byRunner.pytest) {
    if (c.selector.runner !== 'pytest') continue;
    const f = failures.get(pytestJunitKey(c.selector.nodeId));
    if (f) s.detail.set(c.id, f);
  }
}

interface RunRequest {
  runner: TestRunner;
  argv: Argv;
  /** ids this run is expected to report on — marked `queued` up front. */
  scope: string[];
}

async function startRun(repo: string, req: RunRequest): Promise<void> {
  const s = getRun(repo);
  stopRun(repo); // supersede any in-flight run

  const token = ++s.runToken;
  s.running = true;
  s.log = '';
  for (const id of req.scope) {
    s.status.set(id, 'queued');
    s.detail.delete(id);
  }
  notify(s);

  const reportPath = await reportPathFor(repo, req.runner);
  // A stale report from a previous run would be applied as truth if this run
  // dies before writing one.
  try {
    await native.fs.rm(reportPath, { force: true });
  } catch {
    /* nothing to remove */
  }

  if (s.runToken !== token) return; // stopped while we were preparing

  let pending = '';
  const onChunk = (chunk: string): void => {
    if (s.runToken !== token) return;
    appendLog(s, chunk);
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    let touched = false;
    for (const line of lines) {
      if (applyStreamLine(s, req.runner, line)) touched = true;
    }
    if (touched) notify(s);
    else notify(s); // log grew
  };

  let proc: ReturnType<typeof native.process.spawn>;
  try {
    proc = native.process.spawn(req.argv.cmd, req.argv.args, {
      cwd: repo,
      ...(req.argv.env ? { env: req.argv.env } : {}),
    });
  } catch (e) {
    s.running = false;
    appendLog(s, `\nFailed to spawn ${req.argv.cmd}: ${String(e)}\n`);
    notify(s);
    return;
  }
  s.proc = proc;

  proc.onStdout(onChunk);
  proc.onStderr(onChunk);
  proc.onError((err: string) => {
    if (s.runToken !== token) return;
    appendLog(s, `\n${err}\n`);
    notify(s);
  });
  proc.onExit(() => {
    if (s.runToken !== token) return;
    void (async () => {
      await applyReport(s, req.runner, reportPath, repo);
      if (s.runToken !== token) return;
      // Anything the run never reported on (filtered out, or the run was cut
      // short) goes back to idle rather than spinning forever.
      for (const id of req.scope) {
        if (s.status.get(id) === 'queued' || s.status.get(id) === 'running') {
          s.status.set(id, 'idle');
        }
      }
      s.running = false;
      s.proc = null;
      notify(s);
    })();
  });
}

function stopRun(repo: string): void {
  const s = getRun(repo);
  if (s.proc) {
    try {
      s.proc.kill('SIGINT');
    } catch {
      /* already gone */
    }
  }
  s.runToken += 1;
  s.proc = null;
  if (s.running) {
    for (const [id, st] of s.status) {
      if (st === 'queued' || st === 'running') s.status.set(id, 'idle');
    }
    s.running = false;
  }
  notify(s);
}

// ── run entry points ─────────────────────────────────────────────────────────

async function runAll(repo: string, runner: TestRunner): Promise<void> {
  const s = getRun(repo);
  const cases = s.tree.byRunner[runner];
  const scope = cases.map((c) => c.id);
  const report = { path: await reportPathFor(repo, runner) };
  const argv =
    runner === 'vitest'
      ? { cmd: 'npx', args: ['--no-install', 'vitest', 'run', '--reporter=tap-flat', '--reporter=json', `--outputFile.json=${report.path}`] }
      : runner === 'pytest'
        ? pytestRunArgv(report, s.useUv)
        : {
            cmd: 'npx',
            args: ['--no-install', 'playwright', 'test', '--project', PLAYWRIGHT_DEFAULT_PROJECT, '--reporter=list,json'],
            env: { PLAYWRIGHT_JSON_OUTPUT_NAME: report.path },
          };
  await startRun(repo, { runner, argv, scope });
}

async function runFile(repo: string, runner: TestRunner, file: string): Promise<void> {
  const s = getRun(repo);
  const scope = s.tree.byRunner[runner].filter((c) => c.file === file).map((c) => c.id);
  const report = { path: await reportPathFor(repo, runner) };
  const argv =
    runner === 'vitest'
      ? vitestRunFileArgv(report, file)
      : runner === 'pytest'
        ? pytestRunArgv(report, s.useUv, file)
        : playwrightRunFileArgv(report, file, { singleProject: PLAYWRIGHT_DEFAULT_PROJECT });
  await startRun(repo, { runner, argv, scope });
}

async function runOne(repo: string, tc: TestCase): Promise<void> {
  const s = getRun(repo);
  const report = { path: await reportPathFor(repo, tc.runner) };
  const selector =
    tc.selector.runner === 'playwright'
      ? { ...tc.selector, project: tc.selector.project ?? PLAYWRIGHT_DEFAULT_PROJECT }
      : tc.selector;
  const argv = runOneArgv(selector, report, { useUv: s.useUv });
  await startRun(repo, { runner: tc.runner, argv, scope: [tc.id] });
}

// ── presentational ───────────────────────────────────────────────────────────

const STATUS_ICON: Record<TestStatus, string> = {
  idle: '○',
  queued: '·',
  running: '◍',
  passed: '✓',
  failed: '✕',
  skipped: '⊘',
};

const STATUS_COLOR: Record<TestStatus, string> = {
  idle: 'var(--text-muted)',
  queued: 'var(--text-muted)',
  running: 'var(--accent, #f0a000)',
  passed: '#4caf50',
  failed: '#e53935',
  skipped: 'var(--text-muted)',
};

interface Counts {
  passed: number;
  failed: number;
  skipped: number;
  total: number;
}

function Counters({ counts }: { counts: Counts }) {
  return (
    <span style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
      <span style={{ color: '#4caf50' }}>{counts.passed} passed</span>
      {' · '}
      <span style={{ color: counts.failed ? '#e53935' : 'var(--text-muted)' }}>
        {counts.failed} failed
      </span>
      {' · '}
      <span>{counts.skipped} skipped</span>
      {' · '}
      <span>{counts.total} total</span>
    </span>
  );
}

function btn(disabled?: boolean): React.CSSProperties {
  return {
    fontFamily: 'var(--font-label)',
    fontSize: 10.5,
    fontWeight: 700,
    letterSpacing: '0.1em',
    textTransform: 'uppercase',
    color: disabled ? 'var(--text-muted)' : 'var(--text-secondary)',
    background: 'transparent',
    border: '1px solid var(--border)',
    padding: '4px 10px',
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.5 : 1,
  };
}

// ── panel ────────────────────────────────────────────────────────────────────

export function TestsPanel(): React.ReactElement {
  const activeRepo = useActiveRepoPath();
  // No project open → nothing to discover. Keyed on '' so the registry never
  // grows a bogus entry, and the effects below stay unconditional (hook rules).
  const repo = activeRepo ?? '';
  const [, forceRender] = React.useReducer((n: number) => n + 1, 0);
  const s = getRun(repo);

  React.useEffect(() => {
    const run = getRun(repo);
    run.subs.add(forceRender);
    return () => {
      run.subs.delete(forceRender);
    };
  }, [repo]);

  // Collect once per repo on first sight. Switching `?repo=` collects the new one
  // and leaves the old registry entry (and any running suite) intact.
  React.useEffect(() => {
    if (!repo) return;
    const run = getRun(repo);
    if (run.collectState === 'idle') void refresh(repo);
  }, [repo]);

  const cases = allCases(s.tree);
  const counts = React.useMemo<Counts>(() => {
    const c: Counts = { passed: 0, failed: 0, skipped: 0, total: cases.length };
    for (const tc of cases) {
      const st = s.status.get(tc.id);
      if (st === 'passed' || st === 'failed' || st === 'skipped') c[st] += 1;
    }
    return c;
    // s.status is mutated in place; the force-render is what refreshes this.
  }, [cases, s.status, s.runToken, s.running, s.log]);

  const done = counts.passed + counts.failed + counts.skipped;
  const pct = counts.total ? (done / counts.total) * 100 : 0;

  const failures = cases.filter((c) => s.status.get(c.id) === 'failed');
  const activeRunners = TEST_RUNNERS.filter((r) => s.availability[r] !== 'absent');

  if (!repo) {
    return (
      <div style={{ padding: 16, color: 'var(--text-muted)', fontSize: 13 }}>
        Open a project to discover its tests.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minWidth: 0 }}>
      {/* toolbar */}
      <div
        className="panel-toolbar"
        style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}
      >
        <GitRepoSelector />
        <button
          data-id="tests-run-all"
          type="button"
          style={btn(s.running || s.collectState === 'collecting')}
          disabled={s.running || s.collectState === 'collecting'}
          onClick={() => {
            const first = activeRunners.find((r) => s.tree.byRunner[r].length > 0);
            if (first) void runAll(repo, first);
          }}
        >
          Run all
        </button>
        <button data-id="tests-stop" type="button" style={btn(!s.running)} disabled={!s.running} onClick={() => { stopRun(repo); }}>
          Stop
        </button>
        <button
          data-id="tests-refresh"
          type="button"
          style={btn(s.collectState === 'collecting')}
          disabled={s.collectState === 'collecting'}
          onClick={() => { void refresh(repo); }}
        >
          {s.collectState === 'collecting' ? 'Collecting…' : 'Refresh'}
        </button>
        <div style={{ flex: 1, minWidth: 80, height: 5, background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
          <div style={{ width: `${pct}%`, height: '100%', background: 'var(--accent, #f0a000)', transition: 'width 200ms linear' }} />
        </div>
        <Counters counts={counts} />
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: '10px 12px', minWidth: 0 }}>
        {s.collectState === 'error' && (
          <p style={{ color: '#e53935', fontSize: 12 }}>Collection failed: {s.collectError}</p>
        )}

        {s.collectState === 'ready' && activeRunners.length === 0 && (
          <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>
            No test runners detected in this repo. The panel looks for vitest, pytest, and
            playwright.
          </p>
        )}

        {activeRunners.map((runner) => {
          const avail = s.availability[runner];
          const runnerCases = s.tree.byRunner[runner];
          return (
            <div key={runner} style={{ marginBottom: 18 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span
                  style={{
                    fontFamily: 'var(--font-label)',
                    fontSize: 10.5,
                    fontWeight: 700,
                    letterSpacing: '0.14em',
                    textTransform: 'uppercase',
                    color: 'var(--text-secondary)',
                  }}
                >
                  {runner}
                </span>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  {runnerCases.length} tests
                </span>
                {runner === 'playwright' && runnerCases.length > 0 && (
                  <span style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
                    (run-all uses --project={PLAYWRIGHT_DEFAULT_PROJECT})
                  </span>
                )}
                {runnerCases.length > 0 && (
                  <button data-id={`tests-run-runner-${runner}`} type="button" style={btn(s.running)} disabled={s.running} onClick={() => { void runAll(repo, runner); }}>
                    Run
                  </button>
                )}
              </div>

              {avail === 'not-installed' && (
                <p style={{ fontSize: 12, color: '#f0a000', margin: '0 0 6px' }}>
                  {s.notes[runner] ?? `${runner} is declared but not installed.`}
                </p>
              )}
              {avail === 'present' && s.notes[runner] && (
                <p style={{ fontSize: 12, color: '#e53935', margin: '0 0 6px' }}>{s.notes[runner]}</p>
              )}
              {avail === 'present' && runnerCases.length === 0 && !s.notes[runner] && (
                <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>No tests found.</p>
              )}

              {groupByFile(runnerCases).map(({ file, cases: fileCases }) => (
                <div key={file} style={{ marginBottom: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 12, color: 'var(--text-primary)', fontFamily: 'var(--font-mono, monospace)' }}>
                      {file}
                    </span>
                    <button data-id="tests-run-file" type="button" style={btn(s.running)} disabled={s.running} onClick={() => { void runFile(repo, runner, file); }}>
                      Run file
                    </button>
                  </div>
                  <ul style={{ listStyle: 'none', margin: '3px 0 0', padding: '0 0 0 14px' }}>
                    {fileCases.map((tc) => {
                      const st = s.status.get(tc.id) ?? 'idle';
                      return (
                        <li key={tc.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0' }}>
                          <span aria-hidden style={{ color: STATUS_COLOR[st], width: 12 }}>
                            {STATUS_ICON[st]}
                          </span>
                          <span style={{ fontSize: 12, color: 'var(--text-secondary)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {tc.name}
                          </span>
                          <button data-id="tests-run-one" type="button" style={btn(s.running)} disabled={s.running} onClick={() => { void runOne(repo, tc); }}>
                            Run
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          );
        })}

        {failures.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <div
              style={{
                fontFamily: 'var(--font-label)',
                fontSize: 10.5,
                fontWeight: 700,
                letterSpacing: '0.14em',
                textTransform: 'uppercase',
                color: '#e53935',
                marginBottom: 6,
              }}
            >
              {failures.length} failed
            </div>
            {failures.map((tc) => {
              const d = s.detail.get(tc.id);
              return (
                <details key={tc.id} style={{ marginBottom: 6 }}>
                  <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--text-primary)' }}>
                    <span style={{ fontFamily: 'var(--font-mono, monospace)', color: 'var(--text-muted)' }}>{tc.file}</span>{' '}
                    {tc.name}
                  </summary>
                  <p style={{ fontSize: 12, color: '#e53935', margin: '4px 0' }}>
                    {d?.message ?? 'No failure detail was captured.'}
                  </p>
                  {d?.stack && (
                    <pre
                      style={{
                        fontSize: 11,
                        fontFamily: 'var(--font-mono, monospace)',
                        background: 'var(--bg-secondary)',
                        border: '1px solid var(--border)',
                        padding: 8,
                        maxHeight: 220,
                        overflow: 'auto',
                        whiteSpace: 'pre-wrap',
                        margin: 0,
                        color: 'var(--text-secondary)',
                      }}
                    >
                      {stripAnsi(d.stack)}
                    </pre>
                  )}
                </details>
              );
            })}
          </div>
        )}

        {s.log && (
          <details style={{ marginTop: 14 }} open={s.running}>
            <summary style={{ cursor: 'pointer', fontSize: 11, color: 'var(--text-muted)' }}>Raw output</summary>
            <pre
              style={{
                fontSize: 11,
                fontFamily: 'var(--font-mono, monospace)',
                background: 'var(--bg-secondary)',
                border: '1px solid var(--border)',
                padding: 8,
                maxHeight: 320,
                overflow: 'auto',
                whiteSpace: 'pre-wrap',
                margin: '4px 0 0',
              }}
            >
              {ansiToNodes(s.log)}
            </pre>
          </details>
        )}
      </div>
    </div>
  );
}
