// The GLM Coding Plan key is the only provider credential ugly-code stores.
// Its merge semantics matter: `undefined` must keep the stored key (a settings
// patch that touches an unrelated toggle must not silently log the user out of
// their subscription), and `null` must clear it.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_USER_SETTINGS,
  mergeUserSettings,
  parseStoredUserSettings,
  userSettingsPatchSchema,
} from '../../shared/userSettings';

const withKey = {
  ...DEFAULT_USER_SETTINGS,
  codingAgent: { ...DEFAULT_USER_SETTINGS.codingAgent, glmCodingKey: 'zai-secret' },
};

describe('glmCodingKey merge semantics', () => {
  it('is absent by default', () => {
    expect(DEFAULT_USER_SETTINGS.codingAgent.glmCodingKey).toBeUndefined();
  });

  it('stores a key', () => {
    const next = mergeUserSettings(DEFAULT_USER_SETTINGS, {
      codingAgent: { glmCodingKey: 'zai-secret' },
    });
    expect(next.codingAgent.glmCodingKey).toBe('zai-secret');
  });

  it('KEEPS the key when an unrelated toggle is patched', () => {
    // The trap: a patch that omits glmCodingKey must not drop it.
    const next = mergeUserSettings(withKey, { codingAgent: { autoLint: true } });
    expect(next.codingAgent.glmCodingKey).toBe('zai-secret');
    expect(next.codingAgent.autoLint).toBe(true);
  });

  it('clears the key on an explicit null (the Remove button)', () => {
    const next = mergeUserSettings(withKey, { codingAgent: { glmCodingKey: null } });
    expect(next.codingAgent.glmCodingKey).toBeUndefined();
  });

  it('accepts null in the patch schema', () => {
    const r = userSettingsPatchSchema.safeParse({ codingAgent: { glmCodingKey: null } });
    expect(r.success).toBe(true);
  });

  it('round-trips through the stored JSON blob', () => {
    const stored = JSON.stringify(withKey);
    expect(parseStoredUserSettings(stored).codingAgent.glmCodingKey).toBe('zai-secret');
  });

  it('survives a stored doc that predates the field', () => {
    const legacy = JSON.stringify({
      ...DEFAULT_USER_SETTINGS,
      codingAgent: { ...DEFAULT_USER_SETTINGS.codingAgent },
    });
    expect(parseStoredUserSettings(legacy).codingAgent.glmCodingKey).toBeUndefined();
  });
});
