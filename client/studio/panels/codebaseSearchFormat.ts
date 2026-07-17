// Pure (render-independent) helpers for the FilePanel hybrid-search UI, so the
// formatting/parsing logic is unit-testable without a DOM.
import type { SearchHit } from '../../agent/tools/searchResponse';

/** `src/a.ts:3-5`, or `src/a.ts:7` for a single-line span. */
export function resultLabel(
  h: Pick<SearchHit, 'file_path' | 'start_line' | 'end_line'>,
): string {
  return h.start_line === h.end_line
    ? `${h.file_path}:${h.start_line}`
    : `${h.file_path}:${h.start_line}-${h.end_line}`;
}

/** First `lines` lines of a chunk, for a compact result preview. */
export function snippet(content: string, lines = 3): string {
  return content.split('\n').slice(0, lines).join('\n');
}

/** Parse ripgrep content output (`path:line:text` per line, as produced by the
 *  grep tool's exact mode) into structured hits, so grep results are clickable
 *  + comparable alongside fts/semantic/mixed. Non-match lines are skipped. */
export function parseGrepHits(text: string): SearchHit[] {
  const out: SearchHit[] = [];
  for (const line of text.split('\n')) {
    const m = /^(.+?):(\d+):(.*)$/.exec(line);
    if (!m) continue;
    out.push({
      file_path: m[1],
      start_line: Number(m[2]),
      end_line: Number(m[2]),
      content: m[3],
      mode: 'grep',
      score: 0,
    });
  }
  return out;
}
