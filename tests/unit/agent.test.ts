import { describe, expect, it } from 'vitest';
import { runAgent, type StepFn } from '../../client/agent/engine';
import { AGENT_TOOLS, agentMessageSchema, type AgentMessage } from '../../shared/agent';

describe('agent tool specs', () => {
  it('exposes the expected tools with valid JSON-schema parameters', () => {
    expect(AGENT_TOOLS.map((t) => t.name)).toEqual([
      'list_dir',
      'read_file',
      'write_file',
      'edit_file',
      'codebase_search',
      'run_command',
      'db_query',
      'db_get',
      'db_set',
    ]);
    for (const t of AGENT_TOOLS) {
      expect(t.parameters?.type).toBe('object');
      expect(Array.isArray(t.parameters?.required)).toBe(true);
    }
  });

  it('agentMessageSchema accepts text, tool_use, and tool_result content', () => {
    expect(
      agentMessageSchema.safeParse({
        role: 'assistant',
        content: [
          { type: 'text', text: 'hi' },
          { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a' } },
        ],
      }).success,
    ).toBe(true);
    expect(
      agentMessageSchema.safeParse({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'data' }],
      }).success,
    ).toBe(true);
  });
});

describe('agent engine loop', () => {
  it('runs a tool, feeds tool_result back, and stops on a text-only turn', async () => {
    const turns: AgentMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Reading.' },
          { type: 'tool_use', id: 'a', name: 'read_file', input: { path: 'x.txt' } },
        ],
      },
      { role: 'assistant', content: 'The file says hi.' },
    ];
    let i = 0;
    const step: StepFn = () => Promise.resolve({ message: turns[i++]! });
    const dispatched: string[] = [];
    const dispatch = (name: string): Promise<string> => {
      dispatched.push(name);
      return Promise.resolve('hi');
    };
    const events: string[] = [];
    const history: AgentMessage[] = [{ role: 'user', content: 'read x.txt' }];

    await runAgent({ history, step, dispatch, onEvent: (e) => events.push(e.type) });

    expect(dispatched).toEqual(['read_file']);
    // user → assistant(tool_use) → user(tool_result) → assistant(final)
    expect(history).toHaveLength(4);
    expect(history[2]).toMatchObject({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'a', content: 'hi' }],
    });
    expect(events).toContain('done');
  });

  it('feeds a tool error back as tool_result and keeps going', async () => {
    const turns: AgentMessage[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'b', name: 'read_file', input: {} }] },
      { role: 'assistant', content: 'Recovered.' },
    ];
    let i = 0;
    const step: StepFn = () => Promise.resolve({ message: turns[i++]! });
    const dispatch = (): Promise<string> => Promise.reject(new Error('boom'));
    const history: AgentMessage[] = [{ role: 'user', content: 'go' }];

    await runAgent({ history, step, dispatch });

    expect(history[2]).toMatchObject({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'b', content: 'Error: boom' }],
    });
    expect(history[3]).toMatchObject({ role: 'assistant', content: 'Recovered.' });
  });

  it('stops at maxSteps when the model never finishes', async () => {
    const step: StepFn = () =>
      Promise.resolve({
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'list_dir', input: {} }] },
      });
    const dispatch = (): Promise<string> => Promise.resolve('ok');
    const events: string[] = [];
    const history: AgentMessage[] = [{ role: 'user', content: 'loop' }];

    await runAgent({ history, step, dispatch, maxSteps: 3, onEvent: (e) => events.push(e.type) });

    expect(events.filter((e) => e === 'tool_call')).toHaveLength(3);
    expect(events).toContain('error');
  });
});
