import { describe, expect, it } from 'vitest';
import { composeSessionSnapshot } from '../../client/studio/agent/clientAgent';

// Regression: the client-side coding agent emits a `session_state` snapshot
// after every turn. It used to HARDCODE model/modelMode/patternMode to
// claude_sonnet_4_6 / auto / auto, so the chat header reset the user's picks
// each turn (selected deepseek_v4_flash → flipped to sonnet; pattern "none" →
// flipped to "auto"). The snapshot must echo the session's actual selection.

describe('composeSessionSnapshot (client-agent telemetry echo)', () => {
  const base = {
    sessionId: 'cs:abc',
    cwd: '/proj',
    createdAt: 1000,
    updatedAt: 2000,
    cost: 0.5,
    promptTokens: 10,
    completionTokens: 20,
    perModel: [],
    messageCount: 3,
  };

  it('echoes the selected model instead of the hardcoded default', () => {
    const snap = composeSessionSnapshot({
      ...base,
      model: 'deepseek_v4_flash',
      reasoningEffort: 'max',
      permissionMode: 'edit',
      modelMode: { kind: 'single', model: 'deepseek_v4_flash' },
      patternMode: 'auto',
    });
    expect(snap.model).toBe('deepseek_v4_flash');
    expect(snap.modelMode).toEqual({ kind: 'single', model: 'deepseek_v4_flash' });
  });

  it('echoes a "none" pattern mode instead of resetting to "auto"', () => {
    const snap = composeSessionSnapshot({
      ...base,
      model: 'deepseek_v4_flash',
      reasoningEffort: 'max',
      permissionMode: 'edit',
      modelMode: { kind: 'single', model: 'deepseek_v4_flash' },
      patternMode: 'none',
    });
    expect(snap.patternMode).toBe('none');
  });

  it('carries the live telemetry numbers through unchanged', () => {
    const snap = composeSessionSnapshot({
      ...base,
      model: 'glm_5_1',
      reasoningEffort: 'medium',
      permissionMode: 'yolo',
      modelMode: { kind: 'auto' },
      patternMode: 'auto',
    });
    expect(snap.cost).toBe(0.5);
    expect(snap.promptTokens).toBe(10);
    expect(snap.completionTokens).toBe(20);
    expect(snap.messageCount).toBe(3);
    expect(snap.sessionId).toBe('abc'); // workspace:session split
    expect(snap.compositeId).toBe('cs:abc');
  });
});
