// Badge/summary logic for the search tool cards.
//
// These badges are the DEFAULT view of a transcript (cards collapse), so they are the
// most-read text in the product — and they were lying in three different ways:
//
//  1. `parseGrepOutput` only understood the old monolith format ("file.ts:" header, then
//     "  Line 3: text"). The tool emits ripgrep's `-n --no-heading` "file.ts:3:text", so
//     nothing parsed, hits was empty, and a grep with 3 real matches badged "0 matches".
//  2. The glob card treated only the literal 'No matches found' as empty, but the tool
//     returns `(no files match "…")` — one line of text — so an empty search badged
//     "1 file", asserting that files exist when none do.
//  3. A FAILED call (rg never ran) still got a count badge + green check, which is an
//     affirmative claim about a codebase nobody searched.
//
// Rule: a badge is derived from the tool's own metadata or a real parse — never from
// "how many lines of text came back" — and a failure is never summarized as a count.

export interface GrepHit {
  file: string;
  line: number;
  text: string;
}

/** The tools' no-result sentinels (`(no matches for "x")` / `(no files match "y")`). */
export function isNoResultSentinel(text: string): boolean {
  const t = text.trim();
  return (
    t === '' ||
    t === 'No matches found' || // legacy server string, kept for old transcripts
    /^\(no (matches for|files match)\b/i.test(t)
  );
}

/**
 * Parse grep output into hits. Understands ripgrep's `file:line:text` (what the tool
 * emits today) and the legacy header/"Line N:" layout (old persisted transcripts).
 * Returns null when there is nothing parseable.
 */
export function parseGrepOutput(
  text: string,
): { hits: GrepHit[]; summary: string } | null {
  if (!text || isNoResultSentinel(text)) return null;
  const hits: GrepHit[] = [];
  let currentFile = '';
  let summary = '';
  for (const line of text.split('\n')) {
    if (/^Found \d+ match/.test(line)) {
      summary = line.trim();
      continue;
    }
    if (!line.trim()) continue;

    // ripgrep `-n --no-heading`: "path/to/file.ts:12:  const x = 1"
    // Windows-safe: a leading drive letter ("C:\src\a.ts:12:…") must not be read as the
    // file/line split, so require the line number to be a run of digits between colons.
    const rg = /^(.*?[^:]):(\d+):(.*)$/.exec(line);
    if (rg && !/^\s/.test(line)) {
      hits.push({ file: rg[1], line: parseInt(rg[2], 10), text: rg[3] });
      continue;
    }

    // Legacy: "path/to/file.ts:" header …
    const fileMatch = /^(\S.*):$/.exec(line);
    if (fileMatch) {
      currentFile = fileMatch[1];
      continue;
    }
    // … followed by "  Line N[, Char M]: text"
    const hitMatch = /^\s+Line (\d+)(?:, Char \d+)?:\s?(.*)$/.exec(line);
    if (hitMatch && currentFile) {
      hits.push({ file: currentFile, line: parseInt(hitMatch[1], 10), text: hitMatch[2] });
    }
  }
  if (hits.length === 0) return null;
  return { hits, summary };
}

/**
 * Grep's result count for a given output_mode. `content` yields `file:line:text`, but
 * `files_with_matches` (rg -l) yields BARE PATHS and `count` yields `file:N` — neither
 * parses as a hit, so a grep that matched 3 files badged "0 matches" while its own body
 * listed them. Count what the mode actually returns.
 */
export function grepResultCount(text: string, mode: string | undefined): number {
  if (isNoResultSentinel(text)) return 0;
  if (mode === 'files_with_matches') {
    // rg -l: one path per line.
    return text.split('\n').map((l) => l.trim()).filter(Boolean).length;
  }
  if (mode === 'count') {
    // rg -c: "path:N" per line — the badge means total matches, so sum them.
    return text
      .split('\n')
      .map((l) => /:(\d+)\s*$/.exec(l.trim())?.[1])
      .filter((n): n is string => n !== undefined)
      .reduce((sum, n) => sum + parseInt(n, 10), 0);
  }
  return parseGrepOutput(text)?.hits.length ?? 0;
}

/** The noun a grep badge counts for a mode — files for -l, matches otherwise. */
export function grepBadgeNoun(mode: string | undefined): 'match' | 'file' {
  return mode === 'files_with_matches' ? 'file' : 'match';
}

/** Files listed by a glob result (one path per line), or [] for the no-match sentinel. */
export function parseGlobFiles(text: string): string[] {
  if (isNoResultSentinel(text)) return [];
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

export type CardBadge =
  | { kind: 'failed' }
  | { kind: 'running' }
  | { kind: 'count'; count: number; truncated: boolean };

/**
 * What a search card's badge should say. `status` is the tool-call status — an errored
 * call NEVER gets a count, however much text it returned.
 */
export function searchBadge(
  status: string | undefined,
  result: string | undefined,
  metaCount: number | null,
  truncated: boolean,
  parse: (text: string) => number,
): CardBadge {
  if (status === 'error') return { kind: 'failed' };
  if (status === 'running' || status === 'executing') return { kind: 'running' };
  const text = result ?? '';
  const count = metaCount ?? parse(text);
  return { kind: 'count', count, truncated };
}

/** Badge label, e.g. "3 matches", "0 files", "failed". */
export function badgeLabel(badge: CardBadge, noun: 'match' | 'file'): string {
  if (badge.kind === 'failed') return 'failed';
  if (badge.kind === 'running') return '…';
  const n = badge.count;
  const plural = n === 1 ? noun : `${noun}${noun === 'match' ? 'es' : 's'}`;
  return `${n}${badge.truncated ? '+' : ''} ${plural}`;
}

/**
 * The `(+N −M)` the edit/multiedit tools now append to their result. Authoritative: the
 * tool diffed the real file bodies, whereas the card can only guess (anchor edits carry
 * no old_string, so a guess reports every replacement as a pure addition).
 */
export function parseEditStat(result: string | undefined): { added: number; removed: number } | null {
  const m = /\(\+(\d+)\s*[−-](\d+)\)\s*$/.exec((result ?? '').trim());
  return m ? { added: parseInt(m[1], 10), removed: parseInt(m[2], 10) } : null;
}
