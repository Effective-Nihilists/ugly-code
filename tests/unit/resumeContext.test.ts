import { describe, it, expect } from 'vitest';
import {
  reconstructResumeContext,
  type StoredMessageRow,
} from '../../client/studio/agent/serverSessionApi';

// #3: a fresh process (e.g. a new background task after a Studio restart) must rebuild a
// prior session's working context from the persisted rows so the next turn CONTINUES with
// full context. This is the pure core of clientAgent.ensureResumed().
const row = (
  seq: number,
  role: StoredMessageRow['role'],
  content: unknown,
  kind: StoredMessageRow['kind'] = 'message',
): StoredMessageRow => ({
  seq,
  role,
  kind,
  compacted: false,
  content: JSON.stringify(content),
});

describe('reconstructResumeContext', () => {
  it('rebuilds messages in order, tracks activeRows + nextSeq', () => {
    const rows = [
      row(0, 'user', 'build me a thing'),
      row(1, 'assistant', [{ type: 'text', text: 'on it' }]),
    ];
    const r = reconstructResumeContext(rows, 'cs1');
    expect(r.messages).toEqual([
      { role: 'user', content: 'build me a thing' },
      { role: 'assistant', content: [{ type: 'text', text: 'on it' }] },
    ]);
    expect(r.activeRows).toEqual([
      { seq: 0, id: 'cs1:0' },
      { seq: 1, id: 'cs1:1' },
    ]);
    expect(r.nextSeq).toBe(2);
  });

  it('empty session → no messages, nextSeq 0', () => {
    const r = reconstructResumeContext([], 'cs1');
    expect(r.messages).toEqual([]);
    expect(r.nextSeq).toBe(0);
  });

  it('summary rows get a summary id', () => {
    const r = reconstructResumeContext(
      [row(3, 'user', 'Original task:\nx', 'summary')],
      'cs1',
    );
    expect(r.activeRows[0]).toEqual({ seq: 3, id: 'cs1:summary:3' });
    expect(r.nextSeq).toBe(4);
  });

  it('heals a dangling tool_use (interrupted mid-turn): adds an interrupted tool_result + a continue-ready assistant', () => {
    const rows = [
      row(0, 'user', 'run the build'),
      row(1, 'assistant', [
        {
          type: 'tool_use',
          id: 'tool-1',
          name: 'run_command',
          input: { cmd: 'pnpm build' },
        },
      ]),
    ];
    const r = reconstructResumeContext(rows, 'cs1');
    // a tool_result for the dangling use, then a trailing assistant so turns alternate
    expect(r.messages).toHaveLength(4);
    expect(r.messages[2]).toEqual({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tool-1',
          content: expect.stringContaining('Interrupted'),
        },
      ],
    });
    expect(r.messages[3].role).toBe('assistant');
  });

  it('heals a trailing user message: appends a continue-ready assistant so the next user turn alternates', () => {
    const rows = [row(0, 'user', 'hello')];
    const r = reconstructResumeContext(rows, 'cs1');
    expect(r.messages).toHaveLength(2);
    expect(r.messages[0]).toEqual({ role: 'user', content: 'hello' });
    expect(r.messages[1].role).toBe('assistant');
  });
});
