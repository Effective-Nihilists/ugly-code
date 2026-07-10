// `makeResolveApiKey` is the ONLY thing that puts the user's GLM key on the
// main agent turn (agentTurn -> streamAgentTurn -> streamUglyBotTurn). Two
// guarantees matter: an ordinary metered turn must never pay for a Neon read,
// and a settings-read failure must not take the turn down.
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

  it('swallows a settings-read failure rather than failing the turn', async () => {
    const getDoc = vi.fn().mockRejectedValue(new Error('neon down'));
    const resolve = makeResolveApiKey(() => ({ getDoc }));
    await expect(resolve('u1', 'glm_coding_plan')).resolves.toBeUndefined();
  });

  it('handles a user with no settings doc at all', async () => {
    const getDoc = vi.fn().mockResolvedValue(null);
    const resolve = makeResolveApiKey(() => ({ getDoc }));
    await expect(resolve('new-user', 'glm_coding_plan')).resolves.toBeUndefined();
  });
});
