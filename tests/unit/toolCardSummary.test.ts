// Regression tests for the three ways the collapsed transcript lied (eval round 6).
import { describe, it, expect } from 'vitest';
import {
  badgeLabel,
  isNoResultSentinel,
  parseGlobFiles,
  parseGrepOutput,
  searchBadge,
} from '../../client/studio/panels/toolCardSummary';

const rgOutput = [
  'format.ts:3:export function formatSummary(tasks: Task[]): string {',
  'report.ts:2:import { formatTask, formatSummary } from \'./format\';',
  'report.ts:5:  return [...tasks.map(formatTask), \'\', formatSummary(tasks)].join(\'\\n\');',
].join('\n');

describe('parseGrepOutput — ripgrep format (the "0 matches" lie)', () => {
  it("parses rg's file:line:text — the format the tool actually emits", () => {
    // The card badged "0 matches" while its own body listed these three.
    const parsed = parseGrepOutput(rgOutput);
    expect(parsed?.hits).toHaveLength(3);
    expect(parsed?.hits[0]).toEqual({
      file: 'format.ts',
      line: 3,
      text: 'export function formatSummary(tasks: Task[]): string {',
    });
    expect(parsed?.hits[2]?.file).toBe('report.ts');
  });

  it('parses absolute paths (grep scoped to a worktree emits them)', () => {
    const parsed = parseGrepOutput('/tmp/p/.ugly-studio/worktrees/cs_a/format.ts:3:export function f() {}');
    expect(parsed?.hits[0]?.file).toBe('/tmp/p/.ugly-studio/worktrees/cs_a/format.ts');
    expect(parsed?.hits[0]?.line).toBe(3);
  });

  it('does not mistake a Windows drive letter for the line number', () => {
    const parsed = parseGrepOutput('C:\\src\\a.ts:12:const x = 1;');
    expect(parsed?.hits[0]).toEqual({ file: 'C:\\src\\a.ts', line: 12, text: 'const x = 1;' });
  });

  it('still parses the legacy header/"Line N:" transcripts', () => {
    const parsed = parseGrepOutput('src/a.ts:\n  Line 4: const x = 1;');
    expect(parsed?.hits[0]).toEqual({ file: 'src/a.ts', line: 4, text: 'const x = 1;' });
  });

  it('returns null for the no-match sentinel (not a bogus hit)', () => {
    expect(parseGrepOutput('(no matches for "zzz")')).toBeNull();
  });
});

describe('parseGlobFiles — the "1 file" lie', () => {
  it('an empty glob is ZERO files, not one line of prose', () => {
    // '(no files match "**/*.test.*")' is one line of text → the old code badged "1 file",
    // asserting tests exist in a project with none.
    expect(parseGlobFiles('(no files match "**/*.test.*")')).toEqual([]);
  });
  it('counts real paths', () => {
    expect(parseGlobFiles('types.ts\nstore.ts\nformat.ts')).toHaveLength(3);
  });
  it('legacy empty string sentinel', () => {
    expect(parseGlobFiles('No matches found')).toEqual([]);
  });
});

describe('isNoResultSentinel', () => {
  it('recognizes both tools\' sentinels and blank', () => {
    expect(isNoResultSentinel('(no matches for "x")')).toBe(true);
    expect(isNoResultSentinel('(no files match "y")')).toBe(true);
    expect(isNoResultSentinel('   ')).toBe(true);
  });
  it('does not swallow real output that merely mentions no matches', () => {
    expect(isNoResultSentinel('src/a.ts:1:// no matches for the regex here')).toBe(false);
  });
});

describe('searchBadge — a failure is never a count', () => {
  const parse = (t: string): number => parseGlobFiles(t).length;

  it('errored call badges "failed", never a count (the green-check lie)', () => {
    // rg timed out; the body says so, but the badge used to read "0 matches ✓".
    const badge = searchBadge('error', 'Error: grep failed — the search did not run', null, false, parse);
    expect(badge.kind).toBe('failed');
    expect(badgeLabel(badge, 'match')).toBe('failed');
  });

  it('running call shows no count yet', () => {
    expect(searchBadge('running', '', null, false, parse).kind).toBe('running');
  });

  it('genuine empty result badges 0, not 1', () => {
    const badge = searchBadge('done', '(no files match "**/*.test.*")', null, false, parse);
    expect(badgeLabel(badge, 'file')).toBe('0 files');
  });

  it('metadata count wins over parsing when present', () => {
    const badge = searchBadge('done', 'whatever', 42, false, parse);
    expect(badgeLabel(badge, 'match')).toBe('42 matches');
  });

  it('truncation is marked', () => {
    expect(badgeLabel(searchBadge('done', 'a\nb', null, true, parse), 'file')).toBe('2+ files');
  });

  it('singular/plural', () => {
    expect(badgeLabel(searchBadge('done', 'a', null, false, parse), 'file')).toBe('1 file');
    expect(badgeLabel(searchBadge('done', 'a', null, false, parse), 'match')).toBe('1 match');
  });
});
