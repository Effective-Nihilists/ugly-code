// Token-level unified diff for the coding-transcript tool cards.
//
// The cards used to render an edit as two whole blocks (BEFORE, then AFTER). When an
// edit changes one identifier on a long line, that shows two ~90%-identical lines and
// makes the reader diff them by eye. This module produces a unified row list with the
// changed *tokens* marked inside each line, so the eye lands on the actual change.
//
// Dependency-free by design: the transcript is the hot path of the IDE and a diff lib
// is a lot of bundle for one card. Inputs here are edit snippets (tens of lines), not
// whole files, so a plain LCS is the right size of hammer — with SIZE_GUARD as the
// bail-out for pathological inputs (minified bundles pasted into an edit).

export interface Part {
  text: string;
  /** True when this token is part of what actually changed on the line. */
  changed: boolean;
}

export type DiffRow =
  | { kind: 'context'; text: string }
  | { kind: 'del'; parts: Part[] }
  | { kind: 'add'; parts: Part[] }
  /** A collapsed run of unchanged lines between hunks. */
  | { kind: 'gap'; count: number };

/** Above this, the O(n*m) LCS is not worth it — fall back to whole-line changes. */
const SIZE_GUARD = 1200;
/** Unified-diff context lines kept either side of a change. */
const CONTEXT = 3;
/**
 * Below this token-level similarity, a del/add pair is treated as two unrelated lines
 * rather than an edit — highlighting 90% of both lines is noise, not signal.
 */
const PAIR_SIMILARITY = 0.3;

interface Op { kind: 'eq' | 'del' | 'add'; text: string }

/** Words, runs of whitespace, and single punctuation chars — the units a reader scans. */
export function tokenize(line: string): string[] {
  return line.match(/\s+|[A-Za-z0-9_$]+|[^\s A-Za-z0-9_$]/g) ?? [];
}

/**
 * Longest common subsequence over two token/line arrays, returned as an op list.
 * Bails to a whole-replacement op list when the inputs are too big to diff cheaply.
 */
function lcsOps(a: string[], b: string[]): Op[] {
  if (a.length * b.length > SIZE_GUARD * SIZE_GUARD || a.length + b.length === 0) {
    return [
      ...a.map((text): Op => ({ kind: 'del', text })),
      ...b.map((text): Op => ({ kind: 'add', text })),
    ];
  }
  const n = a.length;
  const m = b.length;
  // dp[i][j] = LCS length of a[i:] and b[j:]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'eq', text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ kind: 'del', text: a[i] });
      i++;
    } else {
      ops.push({ kind: 'add', text: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ kind: 'del', text: a[i++] });
  while (j < m) ops.push({ kind: 'add', text: b[j++] });
  return ops;
}

/** Merge adjacent same-flag tokens so the DOM gets one span per run, not per token. */
function coalesce(parts: Part[]): Part[] {
  const out: Part[] = [];
  for (const p of parts) {
    // Guard on length, not truthiness: indexed access is typed as always-present
    // here, but it really is undefined on the first pass.
    const last = out.length > 0 ? out[out.length - 1] : undefined;
    if (last?.changed === p.changed) last.text += p.text;
    else out.push({ ...p });
  }
  return out;
}

/**
 * Token-diff one changed line against its counterpart. Returns the parts for the
 * deleted line and the added line, each marking only the tokens unique to it.
 */
export function diffLinePair(oldLine: string, newLine: string): { del: Part[]; add: Part[] } {
  const ops = lcsOps(tokenize(oldLine), tokenize(newLine));
  const del: Part[] = [];
  const add: Part[] = [];
  for (const op of ops) {
    if (op.kind === 'eq') {
      del.push({ text: op.text, changed: false });
      add.push({ text: op.text, changed: false });
    } else if (op.kind === 'del') del.push({ text: op.text, changed: true });
    else add.push({ text: op.text, changed: true });
  }
  return { del: coalesce(del), add: coalesce(add) };
}

/** Share of tokens common to both lines — used to decide if a pair is an edit or a swap. */
function similarity(oldLine: string, newLine: string): number {
  const a = tokenize(oldLine).filter((t) => t.trim() !== '');
  const b = tokenize(newLine).filter((t) => t.trim() !== '');
  if (a.length === 0 && b.length === 0) return 1;
  const pool = [...b];
  let common = 0;
  for (const t of a) {
    const k = pool.indexOf(t);
    if (k !== -1) {
      pool.splice(k, 1);
      common++;
    }
  }
  return (2 * common) / (a.length + b.length);
}

/** Pair up a run of deleted lines with a run of added lines, token-diffing each pair. */
function emitRun(dels: string[], adds: string[], out: DiffRow[]): void {
  const pairs = Math.min(dels.length, adds.length);
  for (let k = 0; k < pairs; k++) {
    const o = dels[k];
    const n = adds[k];
    if (similarity(o, n) >= PAIR_SIMILARITY) {
      const { del, add } = diffLinePair(o, n);
      out.push({ kind: 'del', parts: del }, { kind: 'add', parts: add });
    } else {
      out.push({ kind: 'del', parts: [{ text: o, changed: true }] });
      out.push({ kind: 'add', parts: [{ text: n, changed: true }] });
    }
  }
  for (const o of dels.slice(pairs)) out.push({ kind: 'del', parts: [{ text: o, changed: true }] });
  for (const n of adds.slice(pairs)) out.push({ kind: 'add', parts: [{ text: n, changed: true }] });
}

/**
 * Build the unified row list for an edit. Unchanged lines beyond CONTEXT either side of
 * a change collapse into a single `gap` row so a big edit stays scannable.
 */
export function buildDiffRows(oldStr: string, newStr: string): DiffRow[] {
  const oldLines = oldStr === '' ? [] : oldStr.split('\n');
  const newLines = newStr === '' ? [] : newStr.split('\n');
  const ops = lcsOps(oldLines, newLines);

  // Group into rows, pairing consecutive del/add runs so they can be token-diffed.
  const rows: DiffRow[] = [];
  let dels: string[] = [];
  let adds: string[] = [];
  const flush = (): void => {
    if (dels.length > 0 || adds.length > 0) emitRun(dels, adds, rows);
    dels = [];
    adds = [];
  };
  for (const op of ops) {
    if (op.kind === 'eq') {
      flush();
      rows.push({ kind: 'context', text: op.text });
    } else if (op.kind === 'del') dels.push(op.text);
    else adds.push(op.text);
  }
  flush();

  // Collapse context runs that are far from any change.
  const isChange = (r: DiffRow): boolean => r.kind === 'del' || r.kind === 'add';
  const keep = rows.map((r, i) => {
    if (isChange(r)) return true;
    for (let d = 1; d <= CONTEXT; d++) {
      if ((rows[i - d] && isChange(rows[i - d])) || (rows[i + d] && isChange(rows[i + d]))) return true;
    }
    return false;
  });
  const out: DiffRow[] = [];
  let dropped = 0;
  rows.forEach((r, i) => {
    if (keep[i]) {
      if (dropped > 0) {
        out.push({ kind: 'gap', count: dropped });
        dropped = 0;
      }
      out.push(r);
    } else dropped++;
  });
  if (dropped > 0) out.push({ kind: 'gap', count: dropped });
  return out;
}

/** `+N −M` counts for a card header. */
export function diffStats(rows: DiffRow[]): { added: number; removed: number } {
  return {
    added: rows.filter((r) => r.kind === 'add').length,
    removed: rows.filter((r) => r.kind === 'del').length,
  };
}
