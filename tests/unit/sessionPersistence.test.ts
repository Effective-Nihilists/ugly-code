import { describe, expect, it } from 'vitest';
import { planCompaction, decodeAssistantPayload, type ActiveRow } from '../../client/studio/agent/serverSessionApi';
import { rowsToDisplayMessages } from '../../client/studio/agent/sessionDisplay';
import type { StoredMessageRow } from '../../client/studio/agent/serverSessionApi';
import { compareCodingMessages } from '../../shared/codingCollections';

// Server-side coding-session persistence (survive reload). Two pure transforms
// carry the load-bearing correctness:
//   1. planCompaction — the seq-mapping that keeps the server "normal" query
//      equal to runAgent's post-compaction working context.
//   2. rowsToDisplayMessages — stored rows → studio chat parts for replay.

const row = (over: Partial<StoredMessageRow>): StoredMessageRow => ({
  seq: 0,
  role: 'user',
  kind: 'message',
  compacted: false,
  content: JSON.stringify('hi'),
  ...over,
});

describe('planCompaction (compaction seq-mapping)', () => {
  const active: ActiveRow[] = [0, 1, 2, 3, 4, 5].map((seq) => ({ seq, id: `S:${seq}` }));

  it('drops the oldest N rows and folds them into one summary at the boundary seq', () => {
    // runAgent keeps the recent 2 → drops 4 (seqs 0..3).
    const plan = planCompaction(active, 4, 'S');
    expect(plan).not.toBeNull();
    expect(plan!.droppedIds).toEqual(['S:0', 'S:1', 'S:2', 'S:3']);
    // Summary sits at the dropped block's position (oldest dropped seq).
    expect(plan!.summarySeq).toBe(0);
    expect(plan!.summaryId).toBe('S:summary:0');
    // The new active set = [summary, ...kept] — exactly runAgent's [summary, recent].
    expect(plan!.newActiveRows).toEqual([
      { seq: 0, id: 'S:summary:0' },
      { seq: 4, id: 'S:4' },
      { seq: 5, id: 'S:5' },
    ]);
  });

  it('a second compaction supersedes the prior summary (same boundary id → overwrite)', () => {
    const afterFirst = planCompaction(active, 4, 'S')!.newActiveRows; // [summary:0, 4, 5]
    // Session grows, then compacts again dropping [summary:0, 4] keeping [5].
    const grown: ActiveRow[] = [...afterFirst, { seq: 6, id: 'S:6' }, { seq: 7, id: 'S:7' }];
    const plan2 = planCompaction(grown, 2, 'S');
    expect(plan2!.droppedIds).toEqual(['S:summary:0', 'S:4']);
    // Boundary seq is the prior summary's seq (0) → same summary _id, overwritten.
    expect(plan2!.summaryId).toBe('S:summary:0');
    expect(plan2!.newActiveRows).toEqual([
      { seq: 0, id: 'S:summary:0' },
      { seq: 5, id: 'S:5' },
      { seq: 6, id: 'S:6' },
      { seq: 7, id: 'S:7' },
    ]);
  });

  it('is a no-op when there is nothing to drop', () => {
    expect(planCompaction(active, 0, 'S')).toBeNull();
    expect(planCompaction([], 3, 'S')).toBeNull();
  });
});

describe('rowsToDisplayMessages (history replay)', () => {
  it('maps user / assistant / tool / summary rows to studio parts', () => {
    const rows: StoredMessageRow[] = [
      row({ seq: 0, role: 'user', content: JSON.stringify('build me a thing') }),
      row({
        seq: 1,
        role: 'assistant',
        content: JSON.stringify([
          { type: 'text', text: 'on it' },
          { type: 'tool_use', id: 'tu1', name: 'write_file', input: { path: 'a.ts' } },
        ]),
      }),
      row({
        seq: 2,
        role: 'tool',
        content: JSON.stringify({
          results: [
            { tool_use_id: 'tu1', content: 'wrote a.ts', is_error: false },
            { tool_use_id: 'tu2', content: 'Error: nope', is_error: true },
          ],
        }),
      }),
      row({ seq: 0, kind: 'summary', role: 'user', content: JSON.stringify('summary of earlier turns') }),
    ];

    const msgs = rowsToDisplayMessages('S', rows);

    // user
    expect(msgs[0]).toMatchObject({ id: 'S:0', role: 'user' });
    expect(msgs[0].parts[0]).toEqual({ type: 'text', data: { text: 'build me a thing' } });
    // assistant: text + tool_call (input serialized to a JSON string) + finish
    expect(msgs[1].role).toBe('assistant');
    expect(msgs[1].parts.map((p) => p.type)).toEqual(['text', 'tool_call', 'finish']);
    expect(msgs[1].parts[1].data).toMatchObject({ id: 'tu1', name: 'write_file', input: '{"path":"a.ts"}' });
    // tool: ONE bundled row expands to one display message PER result (matches live)
    const tools = msgs.filter((m) => m.role === 'tool');
    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({ id: 'S:2:0' });
    expect(tools[0].parts[0].data).toMatchObject({ tool_call_id: 'tu1', content: 'wrote a.ts', is_error: false });
    expect(tools[1].parts[0].data).toMatchObject({ tool_call_id: 'tu2', is_error: true });
    // summary: inline compaction marker at its timeline position
    const summary = msgs[msgs.length - 1];
    expect(summary.id).toBe('S:summary:0');
    expect(String(summary.parts[0].data?.text)).toContain('Compacted earlier messages');
    expect(String(summary.parts[0].data?.text)).toContain('summary of earlier turns');
  });

  it('carries the per-message model from a wrapped assistant row (badge survives reload)', () => {
    const rows: StoredMessageRow[] = [
      row({
        seq: 0,
        role: 'assistant',
        content: JSON.stringify({ content: [{ type: 'text', text: 'hi' }], model: 'glm_5_1' }),
      }),
      // Legacy bare-array assistant row (predates per-message model) still renders.
      row({ seq: 1, role: 'assistant', content: JSON.stringify([{ type: 'text', text: 'legacy' }]) }),
    ];
    const msgs = rowsToDisplayMessages('S', rows);
    expect(msgs[0].model).toBe('glm_5_1');
    expect(msgs[0].parts[0]).toEqual({ type: 'text', data: { text: 'hi' } });
    expect(msgs[1].model).toBeUndefined();
    expect(msgs[1].parts[0]).toEqual({ type: 'text', data: { text: 'legacy' } });
  });
});

describe('compareCodingMessages (transcript ordering — DB sorts seq as text)', () => {
  const sortRows = <T extends { seq: number; kind: string }>(rows: T[]): T[] =>
    [...rows].sort(compareCodingMessages);

  it('orders numerically, NOT lexically (so tool_calls precede their results)', () => {
    // The exact lexical scramble the DB returns for seqs 0..21.
    const lexical = [0, 1, 10, 11, 12, 19, 2, 20, 21, 3, 9].map((seq) => ({ seq, kind: 'message' }));
    expect(sortRows(lexical).map((r) => r.seq)).toEqual([0, 1, 2, 3, 9, 10, 11, 12, 19, 20, 21]);
  });

  it('keeps a compaction summary at the head of the block it subsumes', () => {
    // includeCompacted view: summary shares seq 0 with the (compacted) original.
    const full = [
      { seq: 1, kind: 'message' },
      { seq: 0, kind: 'message' }, // original (compacted) at the boundary
      { seq: 0, kind: 'summary' }, // summary reuses the boundary seq
      { seq: 2, kind: 'message' },
    ];
    const ordered = sortRows(full);
    expect(ordered[0].kind).toBe('summary'); // summary first at seq 0
    expect(ordered.map((r) => r.seq)).toEqual([0, 0, 1, 2]);
  });

  it('normal view: summary (seq 0) sorts before the kept recents', () => {
    // After compaction the originals are excluded; only [summary, ...recents].
    const normal = [
      { seq: 5, kind: 'message' },
      { seq: 4, kind: 'message' },
      { seq: 0, kind: 'summary' },
    ];
    expect(sortRows(normal).map((r) => `${r.seq}:${r.kind}`)).toEqual([
      '0:summary',
      '4:message',
      '5:message',
    ]);
  });
});

describe('decodeAssistantPayload', () => {
  it('accepts the wrapped {content, model} form and the legacy bare ContentPart[]', () => {
    expect(decodeAssistantPayload({ content: [{ type: 'text', text: 'x' }], model: 'm1' })).toEqual({
      content: [{ type: 'text', text: 'x' }],
      model: 'm1',
    });
    expect(decodeAssistantPayload([{ type: 'text', text: 'y' }])).toEqual({
      content: [{ type: 'text', text: 'y' }],
    });
    expect(decodeAssistantPayload(null)).toEqual({ content: [] });
  });
});
