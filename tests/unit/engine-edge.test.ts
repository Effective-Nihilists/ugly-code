import { describe, expect, it } from 'vitest';
import { runAgent, type AgentEvent, type StepFn } from '../../client/agent/engine';
import type { AgentMessage } from '../../shared/agent';

// Edge cases of the client-side agent loop that the happy-path suite
// (agent.test.ts) doesn't cover: the Stop-button abort path, parallel tool
// dispatch, model threading, empty-text suppression, and result truncation.

describe('agent engine — edge cases', () => {
  it('short-circuits on an already-aborted signal without calling step', async () => {
    const ac = new AbortController();
    ac.abort();
    let stepCalls = 0;
    const step: StepFn = () => {
      stepCalls++;
      return Promise.resolve({ message: { role: 'assistant', content: 'nope' } });
    };
    const events: AgentEvent[] = [];
    const history: AgentMessage[] = [{ role: 'user', content: 'go' }];

    const out = await runAgent({
      history,
      step,
      dispatch: () => Promise.resolve('x'),
      signal: ac.signal,
      onEvent: (e) => events.push(e),
    });

    expect(stepCalls).toBe(0);
    expect(out).toBe(history); // same array — caller keeps the conversation
    expect(history).toHaveLength(1);
    expect(events).toEqual([{ type: 'error', message: 'Aborted' }]);
  });

  it('dispatches multiple tool_use blocks in order and feeds them back as one user turn', async () => {
    const turns: AgentMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a' } },
          { type: 'tool_use', id: 't2', name: 'list_dir', input: { path: '.' } },
        ],
      },
      { role: 'assistant', content: 'done' },
    ];
    let i = 0;
    const step: StepFn = () => Promise.resolve({ message: turns[i++]! });
    const order: string[] = [];
    const dispatch = (name: string): Promise<string> => {
      order.push(name);
      return Promise.resolve(`${name}-result`);
    };
    const history: AgentMessage[] = [{ role: 'user', content: 'go' }];

    await runAgent({ history, step, dispatch });

    expect(order).toEqual(['read_file', 'list_dir']);
    // Both results come back in a SINGLE user turn, in dispatch order.
    expect(history[2]).toMatchObject({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 't1', content: 'read_file-result' },
        { type: 'tool_result', tool_use_id: 't2', content: 'list_dir-result' },
      ],
    });
  });

  it('threads the model option through to step', async () => {
    const seen: Array<string | undefined> = [];
    const step: StepFn = ({ model }) => {
      seen.push(model);
      return Promise.resolve({ message: { role: 'assistant', content: 'hi' } });
    };
    await runAgent({
      history: [{ role: 'user', content: 'go' }],
      step,
      dispatch: () => Promise.resolve('x'),
      model: 'claude_opus_4_8',
    });
    expect(seen).toEqual(['claude_opus_4_8']);
  });

  it('does not emit an assistant event for a whitespace-only text turn', async () => {
    const turns: AgentMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '   ' },
          { type: 'tool_use', id: 't1', name: 'list_dir', input: {} },
        ],
      },
      { role: 'assistant', content: 'real answer' },
    ];
    let i = 0;
    const step: StepFn = () => Promise.resolve({ message: turns[i++]! });
    const assistantTexts: string[] = [];
    await runAgent({
      history: [{ role: 'user', content: 'go' }],
      step,
      dispatch: () => Promise.resolve('ok'),
      onEvent: (e) => {
        if (e.type === 'assistant') assistantTexts.push(e.text);
      },
    });
    expect(assistantTexts).toEqual(['real answer']);
  });

  it('truncates oversized tool results before feeding them back to the model', async () => {
    const turns: AgentMessage[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: {} }] },
      { role: 'assistant', content: 'ok' },
    ];
    let i = 0;
    const step: StepFn = () => Promise.resolve({ message: turns[i++]! });
    const big = 'x'.repeat(40_000);
    const history: AgentMessage[] = [{ role: 'user', content: 'go' }];

    await runAgent({ history, step, dispatch: () => Promise.resolve(big) });

    const fedBack = (history[2] as { content: Array<{ content: string }> }).content[0]!.content;
    expect(fedBack.length).toBeLessThan(big.length);
    expect(fedBack).toContain('[truncated 10000 chars]');
  });
});
