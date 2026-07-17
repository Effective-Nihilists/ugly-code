/**
 * Remove `//` and block comments from TS/JS source, preserving string and template
 * literals (and everything's length-agnostic — this is for scanning, not rewriting).
 *
 * Why: the Workers panel discovers cron tasks by regex-scanning `shared/cron.ts` as
 * TEXT. A regex has no idea what a comment is, so the commented-out example in every
 * scaffold —
 *     //   nightly: defineWorker({ schedule: '0 3 * * *', description: '…' }),
 * — was parsed as a REAL worker: the panel listed `nightly`, showed its schedule, and
 * offered an "Enqueue on Prod" button for a task that does not exist (the tell was the
 * description rendering as the literal '…'). Strip comments before scanning so only
 * live code counts.
 *
 * This is still a text scan, not a parser — the honest fix is to read the deployed
 * worker manifest from the server. But a commented-out example must never be able to
 * enqueue anything against production.
 */
export function stripComments(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];

    // Line comment → drop to end of line (keep the newline; line structure matters).
    if (c === '/' && next === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    // Block comment → drop through the terminator.
    if (c === '/' && next === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    // String / template literal → copy verbatim so a "//" inside a literal survives.
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += src[i++];
      while (i < n) {
        if (src[i] === '\\') {
          out += src[i] + (src[i + 1] ?? '');
          i += 2;
          continue;
        }
        out += src[i];
        if (src[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}
