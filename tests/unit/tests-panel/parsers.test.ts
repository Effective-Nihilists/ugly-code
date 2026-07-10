// Parser tests over RECORDED output from real runs of vitest 3.2, pytest 9.1
// and playwright 1.61 (fixtures/ captured during implementation). Parsers are
// pure string→data, so nothing spawns here.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  escapeRegex,
  makeTestId,
  matchPlaywrightEvent,
  parsePlaywrightList,
  parsePlaywrightListLine,
  parsePlaywrightReport,
  parsePytestCollect,
  parsePytestJunit,
  parsePytestVerboseLine,
  parseTestId,
  parseVitestList,
  parseVitestReport,
  parseVitestTapLine,
  pytestJunitKey,
  relativize,
  stripAnsi,
} from '../../../client/studio/panels/tests/parsers';

const fx = (n: string): string => readFileSync(join(__dirname, 'fixtures', n), 'utf8');
const lines = (s: string): string[] => s.split('\n');

// ── testId round-trip ────────────────────────────────────────────────────────

describe('testId', () => {
  it('round-trips a simple id', () => {
    const id = makeTestId('vitest', 'tests/a.test.ts', 'suite > case');
    expect(parseTestId(id)).toEqual({
      runner: 'vitest',
      file: 'tests/a.test.ts',
      ident: 'suite > case',
    });
  });

  it('round-trips a pytest ident that itself contains ::', () => {
    const id = makeTestId('pytest', 'tests/t.py', 'TestGroup::test_x');
    expect(parseTestId(id)).toEqual({
      runner: 'pytest',
      file: 'tests/t.py',
      ident: 'TestGroup::test_x',
    });
  });

  it('rejects an unknown runner', () => {
    expect(parseTestId('jest::a::b')).toBeNull();
  });
});

describe('escapeRegex', () => {
  it('escapes chars that appear in real test names', () => {
    // Verified real vitest name: "has a special [name] with (regex) chars"
    const escaped = escapeRegex('has [brackets] and (parens) + $x');
    expect(new RegExp(escaped).test('has [brackets] and (parens) + $x')).toBe(true);
    // Unescaped, `[brackets]` would be a character class and would NOT match.
    expect(new RegExp(escaped).test('has b and (parens) + $x')).toBe(false);
  });
});

describe('relativize', () => {
  it('strips the repo root', () => {
    expect(relativize('/repo/tests/a.test.ts', '/repo')).toBe('tests/a.test.ts');
  });
  it('leaves an outside path alone', () => {
    expect(relativize('/other/a.ts', '/repo')).toBe('/other/a.ts');
  });
});

// ── vitest ───────────────────────────────────────────────────────────────────

describe('vitest', () => {
  it('parses `vitest list --json` into repo-relative cases', () => {
    const json = JSON.stringify([
      { name: 'suite > passes', file: '/repo/tests/a.test.ts' },
      { name: 'suite > fails', file: '/repo/tests/a.test.ts' },
    ]);
    const cases = parseVitestList(json, '/repo');
    expect(cases).toHaveLength(2);
    expect(cases[0]?.file).toBe('tests/a.test.ts');
    expect(cases[0]?.id).toBe('vitest::tests/a.test.ts::suite > passes');
    expect(cases[0]?.selector).toEqual({
      runner: 'vitest',
      file: 'tests/a.test.ts',
      fullName: 'suite > passes',
    });
  });

  it('parses streaming tap-flat: ok / not ok / SKIP', () => {
    const tap = fx('vitest.tap');
    const events = lines(tap)
      .map(parseVitestTapLine)
      .filter((e): e is NonNullable<typeof e> => e !== null);
    expect(events).toHaveLength(4);

    const byStatus = events.reduce<Record<string, number>>((acc, e) => {
      acc[e.status] = (acc[e.status] ?? 0) + 1;
      return acc;
    }, {});
    // 2 passed (incl. the SKIP line's sibling), 2 failed, 1 skipped
    expect(byStatus).toEqual({ passed: 1, failed: 2, skipped: 1 });
  });

  it('scores a SKIP directive as skipped, not passed', () => {
    // The trap: vitest reports a skipped test as `ok N - … # SKIP`, so a naive
    // `startsWith('ok')` check counts every skip as a pass.
    const ev = parseVitestTapLine(
      'ok 3 - tests/x.test.ts > fixture suite > is skipped # SKIP',
    );
    expect(ev?.status).toBe('skipped');
  });

  it('extracts duration from the tap directive', () => {
    const ev = parseVitestTapLine('ok 1 - a.test.ts > s > n # time=0.69ms');
    expect(ev?.durationMs).toBeCloseTo(0.69);
  });

  it('ignores TAP preamble and unknown lines', () => {
    expect(parseVitestTapLine('TAP version 13')).toBeNull();
    expect(parseVitestTapLine('1..4')).toBeNull();
    expect(parseVitestTapLine('    error:')).toBeNull();
  });

  it('reads authoritative statuses + failure detail from the json report', () => {
    const { statuses, failures } = parseVitestReport(fx('vitest-report.json'), '/Users/admin/Documents/GitHub/ugly-code');
    const id = (n: string): string => makeTestId('vitest', 'tests/unit/__tmp_fail.test.ts', `fixture suite > ${n}`);

    expect(statuses.get(id('passes'))).toBe('passed');
    expect(statuses.get(id('fails with a diff'))).toBe('failed');
    expect(statuses.get(id('is skipped'))).toBe('skipped');

    const f = failures.get(id('fails with a diff'));
    expect(f?.message).toContain('expected { a: 1 } to deeply equal { a: 2 }');
    expect(f?.stack).toContain('__tmp_fail.test.ts');
  });

  it('agrees with the tap stream on every id (stream and report reconcile)', () => {
    const root = '/Users/admin/Documents/GitHub/ugly-code';
    const streamed = lines(fx('vitest.tap'))
      .map(parseVitestTapLine)
      .filter((e): e is NonNullable<typeof e> => e !== null);
    const { statuses } = parseVitestReport(fx('vitest-report.json'), root);
    // The whole design rests on the two producing identical ids.
    for (const ev of streamed) {
      expect(statuses.get(ev.id), `no report entry for ${ev.id}`).toBe(ev.status);
    }
  });
});

// ── pytest ───────────────────────────────────────────────────────────────────

describe('pytest', () => {
  const collectOut = [
    'tests/test_demo.py::test_passes',
    'tests/test_demo.py::test_fails',
    'tests/test_demo.py::TestGroup::test_in_class',
    'tests/test_demo.py::test_param[1]',
    '',
    '6 tests collected in 0.00s',
  ].join('\n');

  it('parses --collect-only -q, dropping the summary line', () => {
    const cases = parsePytestCollect(collectOut);
    expect(cases.map((c) => c.name)).toEqual([
      'test_passes',
      'test_fails',
      'TestGroup::test_in_class',
      'test_param[1]',
    ]);
    expect(cases[2]?.selector).toEqual({
      runner: 'pytest',
      nodeId: 'tests/test_demo.py::TestGroup::test_in_class',
    });
  });

  it('parses the -v stream, including SKIPPED (reason)', () => {
    const events = lines(fx('pytest-verbose.txt'))
      .map(parsePytestVerboseLine)
      .filter((e): e is NonNullable<typeof e> => e !== null);
    expect(events).toHaveLength(6);
    const byStatus = events.reduce<Record<string, number>>((a, e) => {
      a[e.status] = (a[e.status] ?? 0) + 1;
      return a;
    }, {});
    expect(byStatus).toEqual({ passed: 4, failed: 1, skipped: 1 });
  });

  it('ignores the session header and progress noise', () => {
    expect(parsePytestVerboseLine('collecting ... collected 6 items')).toBeNull();
    expect(parsePytestVerboseLine('=========== test session starts ===========')).toBeNull();
  });

  it('derives the JUnit key from a nodeid (classname is not invertible)', () => {
    expect(pytestJunitKey('tests/test_demo.py::test_passes')).toBe(
      'tests.test_demo::test_passes',
    );
    expect(pytestJunitKey('tests/test_demo.py::TestGroup::test_in_class')).toBe(
      'tests.test_demo.TestGroup::test_in_class',
    );
    expect(pytestJunitKey('tests/test_demo.py::test_param[1]')).toBe(
      'tests.test_demo::test_param[1]',
    );
  });

  it('extracts failure detail from junit-xml and keys it by the derived key', () => {
    const failures = parsePytestJunit(fx('pytest-junit.xml'));
    const key = pytestJunitKey('tests/test_demo.py::test_fails');
    const f = failures.get(key);
    expect(f).toBeDefined();
    expect(f?.message).toContain('AssertionError: one is not two');
    expect(f?.stack).toContain('assert 1 == 2');
    // Skips are not failures.
    expect(failures.has(pytestJunitKey('tests/test_demo.py::test_skipped'))).toBe(false);
  });

  it('every junit failure key is reachable from a collected nodeid', () => {
    const failures = parsePytestJunit(fx('pytest-junit.xml'));
    const nodeIds = [
      'tests/test_demo.py::test_passes',
      'tests/test_demo.py::test_fails',
      'tests/test_demo.py::test_skipped',
      'tests/test_demo.py::TestGroup::test_in_class',
      'tests/test_demo.py::test_param[1]',
      'tests/test_demo.py::test_param[2]',
    ];
    const derived = new Set(nodeIds.map(pytestJunitKey));
    for (const k of failures.keys()) expect(derived.has(k)).toBe(true);
  });
});

// ── playwright ───────────────────────────────────────────────────────────────

describe('playwright', () => {
  it('dedupes the per-project fan-out into one case, collecting projects', () => {
    const cases = parsePlaywrightList(fx('playwright-report.json'));
    const failing = cases.find((c) => c.name === 'fails hard');
    expect(failing).toBeDefined();
    // Two projects configured -> ONE case, not two. spec.id would have given two.
    expect(failing?.projects?.sort()).toEqual(['chromium', 'firefox']);
    expect(cases.filter((c) => c.name === 'fails hard')).toHaveLength(1);
  });

  it('prefixes rootDir so ids are repo-relative (json file is rootDir-relative)', () => {
    const cases = parsePlaywrightList(fx('playwright-report.json'), 'tests/e2e');
    expect(cases[0]?.file.startsWith('tests/e2e/')).toBe(true);
  });

  it('parses the streaming list reporter for pass / fail / skip', () => {
    const evs = lines(fx('playwright.list'))
      .map(parsePlaywrightListLine)
      .filter((e): e is NonNullable<typeof e> => e !== null);
    expect(evs).toHaveLength(8); // 4 specs x 2 projects
    const byStatus = evs.reduce<Record<string, number>>((a, e) => {
      a[e.status] = (a[e.status] ?? 0) + 1;
      return a;
    }, {});
    expect(byStatus).toEqual({ passed: 4, failed: 2, skipped: 2 });
  });

  it('handles a skipped line, which carries no duration', () => {
    const ev = parsePlaywrightListLine(
      '  -  5 [firefox] › tests/demo.spec.ts:5:8 › demo group › is skipped',
    );
    expect(ev?.status).toBe('skipped');
    expect(ev?.durationMs).toBeUndefined();
    expect(ev?.title).toBe('is skipped');
  });

  it('strips the trailing duration from the title', () => {
    const ev = parsePlaywrightListLine(
      '  ✓  1 [firefox] › tests/demo.spec.ts:3:3 › demo group › passes fine (4ms)',
    );
    expect(ev?.title).toBe('passes fine');
    expect(ev?.durationMs).toBe(4);
    expect(ev?.line).toBe(3);
    expect(ev?.project).toBe('firefox');
  });

  it('matches a cwd-relative stream line onto a repo-relative case', () => {
    // The core impedance mismatch: list says `.__pwfix/tests/demo.spec.ts`,
    // the json-derived tree says `tests/demo.spec.ts`.
    const cases = parsePlaywrightList(fx('playwright-report.json'));
    const ev = parsePlaywrightListLine(
      '  ✘  4 [chromium] › .__pwfix/tests/demo.spec.ts:4:3 › demo group › fails hard (2ms)',
    );
    expect(ev).not.toBeNull();
    const id = ev ? matchPlaywrightEvent(ev, cases) : null;
    expect(id).toBe(makeTestId('playwright', 'demo.spec.ts', '4::fails hard'));
  });

  it('aggregates per-project results: any failure fails the spec', () => {
    const { statuses, failures } = parsePlaywrightReport(fx('playwright-report.json'));
    const id = (l: number, t: string): string => makeTestId('playwright', 'demo.spec.ts', `${l}::${t}`);
    expect(statuses.get(id(3, 'passes fine'))).toBe('passed');
    expect(statuses.get(id(4, 'fails hard'))).toBe('failed');
    expect(statuses.get(id(5, 'is skipped'))).toBe('skipped');
    expect(failures.get(id(4, 'fails hard'))?.message).toContain('toBe');
  });

  it('strips ANSI from failure messages', () => {
    const { failures } = parsePlaywrightReport(fx('playwright-report.json'));
    const msg = failures.get(makeTestId('playwright', 'demo.spec.ts', '4::fails hard'))?.message ?? '';
    expect(msg).not.toMatch(/\[/);
    expect(stripAnsi(msg)).toBe(msg);
  });
});
