import { describe, it, expect } from 'vitest';
import { spliceMissingUserRows, type HistoryRow } from '../../client/studio/agent/messageBackfill';

interface Row {
  id: string;
  role: string;
  content?: string;
}
const mk = (id: string, text: string): Row => ({ id, role: 'user', content: text });
const h = (id: string, role: string, text = role === 'user' ? 'txt-' + id : ''): HistoryRow => ({ id, role, text });

describe('spliceMissingUserRows', () => {
  it('inserts a missing prompt BEFORE a live-streaming reply (the reported bug)', () => {
    // Viewer attached late: it only has the live assistant reply (random id, absent from history).
    const current: Row[] = [{ id: 'live-abc', role: 'assistant' }];
    const history = [h('s:0', 'user', 'hello?'), h('s:1', 'assistant')];
    const out = spliceMissingUserRows(current, history, mk);
    expect(out.map((r) => r.id)).toEqual(['s:0', 'live-abc']); // prompt above the reply
    expect(out[0]).toMatchObject({ role: 'user', content: 'hello?' });
  });

  it('is idempotent — a prompt already present is not duplicated', () => {
    const current: Row[] = [{ id: 's:0', role: 'user', content: 'hi' }, { id: 'live-x', role: 'assistant' }];
    const history = [h('s:0', 'user'), h('s:1', 'assistant')];
    const out = spliceMissingUserRows(current, history, mk);
    expect(out).toBe(current); // unchanged reference — nothing spliced
  });

  it('does NOT splice assistant/tool rows (they stream live under a different id)', () => {
    const current: Row[] = [];
    const history = [h('s:0', 'assistant'), h('s:1', 'tool')];
    expect(spliceMissingUserRows(current, history, mk)).toEqual([]);
  });

  it('places each missing prompt in multi-turn history order', () => {
    // Has turn 1 reply + turn 2 live reply; missing BOTH user prompts (edge: both dropped).
    const current: Row[] = [{ id: 's:1', role: 'assistant' }, { id: 'live-2', role: 'assistant' }];
    const history = [h('s:0', 'user', 'q1'), h('s:1', 'assistant'), h('s:2', 'user', 'q2'), h('s:3', 'assistant')];
    const out = spliceMissingUserRows(current, history, mk);
    // q1 before s:1; q2 before the live reply (absent from history → newest).
    expect(out.map((r) => r.id)).toEqual(['s:0', 's:1', 's:2', 'live-2']);
  });

  it('skips empty prompts', () => {
    const out = spliceMissingUserRows([], [h('s:0', 'user', '')], mk);
    expect(out).toEqual([]);
  });

  it('appends a missing prompt when there is nothing after it', () => {
    const current: Row[] = [{ id: 's:0', role: 'user', content: 'first' }];
    const history = [h('s:0', 'user'), h('s:1', 'assistant'), h('s:2', 'user', 'second')];
    const out = spliceMissingUserRows(current, history, mk);
    expect(out.map((r) => r.id)).toEqual(['s:0', 's:2']);
  });
});
