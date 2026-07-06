import { describe, it, expect, vi } from 'vitest';
import {
  classifyForAuto,
  heuristicShortcut,
  promoteSuperIfHard,
  isClassificationConfident,
  type ClassifyOutput,
  type Judge,
} from '../../../client/studio/agent/patterns/classify';

describe('heuristicShortcut', () => {
  it('routes repair/regression to investigate-fix', () => {
    expect(heuristicShortcut('the login button is broken')).toBeNull(); // no explicit fix/trace signal
    expect(heuristicShortcut('Traceback (most recent call last):\n  File "x.py", line 3')?.pattern).toBe('investigate-fix');
    expect(heuristicShortcut('diff --git a/x b/x')?.pattern).toBe('investigate-fix');
  });
  it('routes a bare question to chat-qa', () => {
    expect(heuristicShortcut('how does the websocket reconnect work?')?.pattern).toBe('chat-qa');
  });
  it('lets a novel-feature request fall through to the LLM', () => {
    expect(heuristicShortcut('add a settings page with a theme toggle')).toBeNull();
  });
});

describe('classifyForAuto', () => {
  it('uses the heuristic without calling the judge for a stacktrace', async () => {
    const judge = vi.fn<Judge>();
    const out = await classifyForAuto('panic: nil pointer dereference', judge);
    expect(out.pattern).toBe('investigate-fix');
    expect(judge).not.toHaveBeenCalled();
  });
  it('promotes to super-spec-build-verify when the judge reports hard difficulty', async () => {
    const judge: Judge = async () => '{"pattern":"spec-build-verify","confidence":0.8,"difficulty":0.75,"reason":"new feature"}';
    const out = await classifyForAuto('add a new export endpoint that streams CSV', judge);
    expect(out.pattern).toBe('super-spec-build-verify'); // difficulty ≥ 0.7 → promoted
  });
  it('keeps the base pattern for routine difficulty', async () => {
    const judge: Judge = async () => '{"pattern":"spec-build-verify","confidence":0.8,"difficulty":0.5,"reason":"routine feature"}';
    const out = await classifyForAuto('add a small settings toggle', judge);
    expect(out.pattern).toBe('spec-build-verify');
  });
  it('parses runnerUp and confidence', async () => {
    const judge: Judge = async () =>
      '{"pattern":"quick-edit","confidence":0.5,"runnerUp":"investigate-fix","runnerUpConfidence":0.45,"difficulty":0.2,"reason":"tiny"}';
    const out = await classifyForAuto('change the copy on the button', judge);
    expect(out.pattern).toBe('quick-edit');
    expect(out.runnerUp).toBe('investigate-fix');
  });
  it('falls back safely on unparseable judge output', async () => {
    const out = await classifyForAuto('add a new export endpoint', async () => 'no json');
    expect(out.parseError).toBeTruthy();
  });
});

describe('promoteSuperIfHard', () => {
  it('promotes only eligible base patterns above the threshold', () => {
    const base = (p: ClassifyOutput['pattern'], difficulty: number): ClassifyOutput => ({
      pattern: p,
      confidence: 1,
      difficulty,
      reason: '',
    });
    expect(promoteSuperIfHard(base('spec-build-verify', 0.8)).pattern).toBe('super-spec-build-verify');
    expect(promoteSuperIfHard(base('investigate-fix', 0.9)).pattern).toBe('super-investigate-fix');
    expect(promoteSuperIfHard(base('spec-build-verify', 0.5)).pattern).toBe('spec-build-verify');
    expect(promoteSuperIfHard(base('quick-edit', 0.95)).pattern).toBe('quick-edit'); // not eligible
    expect(promoteSuperIfHard(base('chat-qa', 0.99)).pattern).toBe('chat-qa');
  });
});

describe('isClassificationConfident', () => {
  const out = (o: Partial<ClassifyOutput>): ClassifyOutput => ({
    pattern: 'spec-build-verify',
    confidence: 0.8,
    difficulty: 0.5,
    reason: '',
    ...o,
  });
  it('rejects low confidence and near-tie runner-ups', () => {
    expect(isClassificationConfident(out({ confidence: 0.3 }))).toBe(false);
    expect(isClassificationConfident(out({ confidence: 0.5, runnerUp: 'quick-edit', runnerUpConfidence: 0.45 }))).toBe(false);
    expect(isClassificationConfident(out({ confidence: 0.8 }))).toBe(true);
    expect(isClassificationConfident(out({ confidence: 0.8, runnerUp: 'quick-edit', runnerUpConfidence: 0.4 }))).toBe(true);
  });
});
