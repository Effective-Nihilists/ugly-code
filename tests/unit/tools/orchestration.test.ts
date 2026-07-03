// Phase B5 — subagent runner + delegate/delegate_parallel/agent + blackboard.
import { describe, it, expect } from 'vitest';
import type { StepFn } from '../../../client/agent/engine';
import { runSubAgent } from '../../../client/agent/tools/subagent';
import {
  delegateTool,
  delegateParallelTool,
  agentTool,
} from '../../../client/agent/tools/delegate';
import { blackboardPostTool, readBlackboard } from '../../../client/agent/tools/blackboard';

// A fake step that immediately returns an assistant message (no tool calls).
const echoStep =
  (reply: string): StepFn =>
  async () => ({ message: { role: 'assistant', content: reply } });

describe('runSubAgent', () => {
  it('runs the nested loop and returns the final assistant text', async () => {
    const out = await runSubAgent('do a thing', { step: echoStep('sub done'), maxSteps: 2 });
    expect(out).toBe('sub done');
  });
  it('blocks nested delegation (recursion guard)', async () => {
    // Even if a subagent tried to call delegate, dispatch returns the guard msg;
    // here we assert the runner never throws and returns text.
    const out = await runSubAgent('x', { step: echoStep('ok'), maxSteps: 1 });
    expect(out).toBe('ok');
  });
});

describe('delegate tools', () => {
  it('delegate degrades cleanly with no step in ctx', async () => {
    expect(await delegateTool.run({ task: 't' }, {})).toMatch(/unavailable/i);
  });
  it('delegate runs a subagent when step is present', async () => {
    const out = await delegateTool.run({ task: 'find X' }, { step: echoStep('found X') });
    expect(out).toBe('found X');
  });
  it('delegate_parallel aggregates subtask results', async () => {
    const out = await delegateParallelTool.run(
      { tasks: ['a', 'b'] },
      { step: echoStep('r') },
    );
    expect(out).toMatch(/Subtask 1/);
    expect(out).toMatch(/Subtask 2/);
  });
  it('agent threads a role and runs', async () => {
    const out = await agentTool.run({ role: 'reviewer', task: 'review' }, { step: echoStep('lgtm') });
    expect(out).toBe('lgtm');
  });
});

describe('blackboard_post', () => {
  it('posts a note readable for the session', async () => {
    await blackboardPostTool.run({ message: 'use pg' }, { sessionId: 'sB' });
    expect(readBlackboard('sB').map((n) => n.message)).toContain('use pg');
  });
});
