// `makeResolveApiKey` is the ONLY thing that puts the user's GLM key on the
// main agent turn (agentTurn -> streamAgentTurn -> streamUglyBotTurn). Two
// guarantees matter: an ordinary metered turn must never pay for a Neon read,
// and — for a BYO model — a *transient* settings-read failure must NOT be
// downgraded to "no key" (that sends the turn keyless and ugly.bot refuses with
// a misleading "supply your own key", even though the key IS stored). It retries
// the read, then surfaces an honest, distinct error the turn can show.
import { describe, expect, it, vi } from 'vitest';
import { makeResolveApiKey } from '../../server/byoKey';
import { DEFAULT_USER_SETTINGS } from '../../shared/userSettings';

const settingsDoc = (glmCodingKey?: string) => ({
  data: JSON.stringify({
    ...DEFAULT_USER_SETTINGS,
    codingAgent: { ...DEFAULT_USER_SETTINGS.codingAgent, ...(glmCodingKey ? { glmCodingKey } : {}) },
  }),
});

describe('makeResolveApiKey', () => {
  it('returns the stored key for a BYO model', async () => {
    const getDoc = vi.fn().mockResolvedValue(settingsDoc('zai-secret'));
    const resolve = makeResolveApiKey(() => ({ getDoc }));
    await expect(resolve('u1', 'glm_coding_plan')).resolves.toBe('zai-secret');
    expect(getDoc).toHaveBeenCalledTimes(1);
  });

  it('never reads settings for an ordinary metered model', async () => {
    // The hot path: every normal turn calls this. A Neon round-trip per turn
    // would be a silent latency + cost regression.
    const getDoc = vi.fn();
    const resolve = makeResolveApiKey(() => ({ getDoc }));
    await expect(resolve('u1', 'deepseek_v4_pro')).resolves.toBeUndefined();
    await expect(resolve('u1', 'glm_5_2')).resolves.toBeUndefined();
    expect(getDoc).not.toHaveBeenCalled();
  });

  it('returns undefined (not a throw) when a BYO model has no key stored', async () => {
    const getDoc = vi.fn().mockResolvedValue(settingsDoc());
    const resolve = makeResolveApiKey(() => ({ getDoc }));
    // ugly.bot then refuses the call with a clear message; it must never fall
    // back to the shared Z.ai account.
    await expect(resolve('u1', 'glm_coding_plan')).resolves.toBeUndefined();
  });

  it('retries a transient read failure, then succeeds (worked-then-randomly-failed)', async () => {
    // The real incident: the key IS stored (earlier turns worked), but one turn's
    // D1 read blipped. A single flake must not fail the turn.
    const getDoc = vi
      .fn()
      .mockRejectedValueOnce(new Error('D1_ERROR: network'))
      .mockResolvedValue(settingsDoc('zai-secret'));
    const resolve = makeResolveApiKey(() => ({ getDoc }));
    await expect(resolve('u1', 'glm_coding_plan')).resolves.toBe('zai-secret');
    expect(getDoc.mock.calls.length).toBeGreaterThan(1);
  });

  it('throws an honest, distinct error when the read keeps failing for a BYO model', async () => {
    // NOT undefined: undefined would go keyless -> ugly.bot returns the confusing
    // "supply your own Z.ai key" even though the key is stored. A thrown error
    // propagates through streamAgentTurn and shows the user the REAL reason.
    const getDoc = vi.fn().mockRejectedValue(new Error('D1_ERROR: overloaded'));
    const resolve = makeResolveApiKey(() => ({ getDoc }));
    await expect(resolve('u1', 'glm_coding_plan')).rejects.toThrow(/z\.?ai|coding plan|load/i);
  });

  it('never throws for a metered model even if the DB handle is unavailable', async () => {
    // The read is BYO-only, so a metered turn is never exposed to a read failure.
    const resolve = makeResolveApiKey(() => {
      throw new Error('TypedDB not initialized for this request');
    });
    await expect(resolve('u1', 'deepseek_v4_pro')).resolves.toBeUndefined();
  });

  it('handles a user with no settings doc at all', async () => {
    const getDoc = vi.fn().mockResolvedValue(null);
    const resolve = makeResolveApiKey(() => ({ getDoc }));
    await expect(resolve('new-user', 'glm_coding_plan')).resolves.toBeUndefined();
  });
});
