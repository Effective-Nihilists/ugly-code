import { describe, expect, it } from 'vitest';
import { composeSessionSnapshot } from '../../client/studio/agent/clientAgent';
import { SessionSnapshotSchema } from '../../client/studio/shared/api';

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
    cacheReadTokens: 40,
    cacheCreationTokens: 5,
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
    expect(snap.cacheReadTokens).toBe(40);
    expect(snap.cacheCreationTokens).toBe(5);
    expect(snap.messageCount).toBe(3);
    expect(snap.sessionId).toBe('abc'); // workspace:session split
    expect(snap.compositeId).toBe('cs:abc');
  });

  // Regression: the client agent OMITS codebaseReadiness until the first
  // indexer/readiness event (clientAgent.ts: `if (readiness !== undefined)
  // snap.codebaseReadiness = readiness`). SessionSnapshotSchema used to REQUIRE
  // it, so every early snapshot failed safeParse and was dropped — the chat's
  // session state never applied and the input froze (agent unusable → deps never
  // installed → preview/database/publish all fail). The schema must tolerate an
  // absent/null codebaseReadiness, matching both the producer and the consumer
  // (useCodingAgentChat guards `if (snap.codebaseReadiness !== undefined)`).
  it('validates a snapshot that omits codebaseReadiness (indexer not ready yet)', () => {
    const snap = composeSessionSnapshot({
      ...base,
      model: 'glm_5_1',
      reasoningEffort: 'medium',
      permissionMode: 'edit',
      modelMode: { kind: 'auto' },
      patternMode: 'auto',
    });
    expect(snap.codebaseReadiness).toBeUndefined();
    const parsed = SessionSnapshotSchema.safeParse(snap);
    expect(parsed.success).toBe(true);
  });

  // The mount/cast snapshot path (useCodingAgentChat) does NOT parse — it reads
  // the raw emitted snapshot and calls `.map` on the pending arrays. If the
  // producer omits them they arrive `undefined` → "Cannot read properties of
  // undefined (reading 'map')". The snapshot must be COMPLETE, not just parseable.
  it('emits complete pending arrays so the cast path never maps undefined', () => {
    const snap = composeSessionSnapshot({
      ...base,
      model: 'glm_5_1',
      reasoningEffort: 'medium',
      permissionMode: 'edit',
      modelMode: { kind: 'auto' },
      patternMode: 'auto',
    });
    expect(Array.isArray(snap.pendingPermissions)).toBe(true);
    expect(Array.isArray(snap.pendingAskUsers)).toBe(true);
    expect(Array.isArray(snap.pendingStepReviews)).toBe(true);
    expect(snap.eval).toBeNull();
  });
});
