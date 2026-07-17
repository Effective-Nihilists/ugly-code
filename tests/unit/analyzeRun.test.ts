import { describe, it, expect } from 'vitest';
import { analyzeTranscript } from '../../client/cli/analyzeRun';

function row(seq: number, role: string, content: unknown, kind = 'message') {
  return { seq, role, kind, content: JSON.stringify(content) };
}

describe('analyzeTranscript', () => {
  it('counts tools, errors, reads/edits, first-edit, narration, compactions', () => {
    const rows = [
      row(0, 'user', 'do it'),
      row(1, 'assistant', {
        content: [
          { type: 'tool_use', name: 'read' },
          { type: 'tool_use', name: 'grep' },
        ],
      }),
      row(2, 'tool', { results: [{ is_error: false }, { is_error: true }] }),
      row(3, 'assistant', { content: [{ type: 'text', text: 'thinking...' }] }), // narration-only
      row(4, 'assistant', { content: [{ type: 'tool_use', name: 'edit' }] }),
      row(5, 'tool', { results: [{ is_error: false }] }),
      row(6, 'user', 'summary', 'summary'), // compaction
    ];
    const a = analyzeTranscript(rows);
    expect(a.toolCalls).toEqual({ read: 1, grep: 1, edit: 1 });
    expect(a.totalToolCalls).toBe(3);
    expect(a.toolErrors).toBe(1);
    expect(a.reads).toBe(2);
    expect(a.edits).toBe(1);
    expect(a.readToEditRatio).toBe(2);
    expect(a.turnsToFirstEdit).toBe(3); // 3rd assistant turn
    expect(a.narrationOnlyTurns).toBe(1);
    expect(a.compactions).toBe(1);
    expect(a.assistantTurns).toBe(3);
  });

  it('handles a run with no edits', () => {
    const a = analyzeTranscript([
      row(1, 'assistant', { content: [{ type: 'tool_use', name: 'read' }] }),
    ]);
    expect(a.turnsToFirstEdit).toBeNull();
    expect(a.readToEditRatio).toBe(1); // reads with no edit → the read count
  });
});
