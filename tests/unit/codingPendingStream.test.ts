// The doc-driven transcript projection (C-transcript): a `pending` transient assistant
// row must render as `isStreaming` (no terminal `finish` part), and its durable commit
// (no `pending`) must flip it finished — so the streaming indicator is derivable purely
// from the docs, with no dependency on the gated task.listen event stream.
import { describe, expect, it } from 'vitest';
import { rowsToDisplayMessages } from '../../client/studio/agent/sessionDisplay';
import {
  projectAgentMessagesToChat,
  type RawAgentMessage,
} from '../../client/studio/hooks/useCodingAgentChat';

const sid = 'cs:test';
const assistantRow = (seq: number, text: string, pending: boolean) => ({
  seq,
  role: 'assistant' as const,
  kind: 'message' as const,
  compacted: false,
  content: JSON.stringify({
    content: [{ type: 'text', text }],
    ...(pending ? { pending: true } : {}),
  }),
});
const project = (rows: ReturnType<typeof assistantRow>[]) =>
  projectAgentMessagesToChat(
    rowsToDisplayMessages(sid, rows) as unknown as RawAgentMessage[],
  );

describe('C-transcript: pending transient row → isStreaming, committed → finished', () => {
  it('a pending assistant row projects to an isStreaming message', () => {
    const [m] = project([assistantRow(0, 'partial…', true)]);
    expect(m.role).toBe('assistant');
    expect(m.content).toBe('partial…');
    expect(m.isStreaming).toBe(true);
  });

  it('a committed assistant row (no pending) projects to a finished message', () => {
    const [m] = project([assistantRow(0, 'final answer', false)]);
    expect(m.isStreaming).toBe(false);
    expect(m.content).toBe('final answer');
  });

  it('replacing the pending row with a committed one flips the streaming flag off', () => {
    const streaming = project([assistantRow(0, 'partial…', true)]);
    expect(streaming.some((m) => m.role === 'assistant' && m.isStreaming)).toBe(
      true,
    );
    const committed = project([assistantRow(0, 'final answer', false)]);
    expect(committed.some((m) => m.role === 'assistant' && m.isStreaming)).toBe(
      false,
    );
  });
});
