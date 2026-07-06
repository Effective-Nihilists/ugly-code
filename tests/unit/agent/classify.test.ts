import { describe, it, expect, vi } from 'vitest';
import { classifyForAuto, heuristicShortcut, shouldRunEngine, type Judge } from '../../../client/studio/agent/patterns/classify';

describe('heuristicShortcut', () => {
  it('routes repair/regression to investigate-fix (skip SBV)', () => {
    expect(heuristicShortcut('the login button is broken')?.pattern).toBe('investigate-fix');
    expect(heuristicShortcut('fix the failing test in add.ts')?.pattern).toBe('investigate-fix');
  });
  it('routes a bare question to chat-qa', () => {
    expect(heuristicShortcut('how does the websocket reconnect work?')?.pattern).toBe('chat-qa');
  });
  it('lets a novel-feature request fall through to the LLM', () => {
    expect(heuristicShortcut('add a settings page with a theme toggle')).toBeNull();
  });
});

describe('classifyForAuto', () => {
  it('uses the heuristic without calling the judge for a fix request', async () => {
    const judge = vi.fn<Judge>();
    const out = await classifyForAuto('this is broken', judge);
    expect(out.pattern).toBe('investigate-fix');
    expect(judge).not.toHaveBeenCalled();
  });
  it('calls the judge for an ambiguous novel request and parses the JSON', async () => {
    const judge: Judge = async () => 'sure: {"pattern":"spec-build-verify","confidence":0.8,"difficulty":0.75,"reason":"new feature"}';
    const out = await classifyForAuto('add a new export endpoint that streams CSV', judge);
    expect(out.pattern).toBe('spec-build-verify');
    expect(out.difficulty).toBe(0.75);
  });
  it('falls back safely on unparseable judge output', async () => {
    const out = await classifyForAuto('add a new export endpoint', async () => 'no json');
    expect(out.parseError).toBeTruthy();
  });
});

describe('shouldRunEngine', () => {
  it('runs SBV only for novel + non-trivial (difficulty ≥ 0.65)', () => {
    expect(shouldRunEngine({ pattern: 'spec-build-verify', confidence: 1, difficulty: 0.8, reason: '' })).toBe(true);
    expect(shouldRunEngine({ pattern: 'spec-build-verify', confidence: 1, difficulty: 0.3, reason: '' })).toBe(false); // trivial → skip
    expect(shouldRunEngine({ pattern: 'investigate-fix', confidence: 1, difficulty: 0.9, reason: '' })).toBe(false); // repair → skip
  });
});
