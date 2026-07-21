// The Kimi Code plan key is the second BYO provider credential ugly-code stores
// (alongside glmCodingKey). Its merge semantics mirror glmCodingKey's, and — the
// point of the generalization — the two keys must be INDEPENDENT: patching or
// clearing one must never touch the other. Also covers `byoKeyField`, the single
// source of truth mapping a BYO model id to its settings field.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_USER_SETTINGS,
  byoKeyField,
  mergeUserSettings,
  parseStoredUserSettings,
  userSettingsPatchSchema,
} from '../../shared/userSettings';

const withKimi = {
  ...DEFAULT_USER_SETTINGS,
  codingAgent: {
    ...DEFAULT_USER_SETTINGS.codingAgent,
    kimiCodingKey: 'kimi-secret',
  },
};

describe('kimiCodingKey merge semantics', () => {
  it('is absent by default', () => {
    expect(DEFAULT_USER_SETTINGS.codingAgent.kimiCodingKey).toBeUndefined();
  });

  it('stores a key', () => {
    const next = mergeUserSettings(DEFAULT_USER_SETTINGS, {
      codingAgent: { kimiCodingKey: 'kimi-secret' },
    });
    expect(next.codingAgent.kimiCodingKey).toBe('kimi-secret');
  });

  it('KEEPS the key when an unrelated toggle is patched', () => {
    const next = mergeUserSettings(withKimi, {
      codingAgent: { autoLint: true },
    });
    expect(next.codingAgent.kimiCodingKey).toBe('kimi-secret');
    expect(next.codingAgent.autoLint).toBe(true);
  });

  it('clears the key on an explicit null (the Remove button)', () => {
    const next = mergeUserSettings(withKimi, {
      codingAgent: { kimiCodingKey: null },
    });
    expect(next.codingAgent.kimiCodingKey).toBeUndefined();
  });

  it('accepts null in the patch schema', () => {
    const r = userSettingsPatchSchema.safeParse({
      codingAgent: { kimiCodingKey: null },
    });
    expect(r.success).toBe(true);
  });

  it('round-trips through the stored JSON blob', () => {
    const stored = JSON.stringify(withKimi);
    expect(parseStoredUserSettings(stored).codingAgent.kimiCodingKey).toBe(
      'kimi-secret',
    );
  });
});

describe('the two BYO keys are independent', () => {
  const both = {
    ...DEFAULT_USER_SETTINGS,
    codingAgent: {
      ...DEFAULT_USER_SETTINGS.codingAgent,
      glmCodingKey: 'zai-secret',
      kimiCodingKey: 'kimi-secret',
    },
  };

  it('clearing Kimi leaves GLM intact', () => {
    const next = mergeUserSettings(both, {
      codingAgent: { kimiCodingKey: null },
    });
    expect(next.codingAgent.kimiCodingKey).toBeUndefined();
    expect(next.codingAgent.glmCodingKey).toBe('zai-secret');
  });

  it('clearing GLM leaves Kimi intact', () => {
    const next = mergeUserSettings(both, {
      codingAgent: { glmCodingKey: null },
    });
    expect(next.codingAgent.glmCodingKey).toBeUndefined();
    expect(next.codingAgent.kimiCodingKey).toBe('kimi-secret');
  });

  it('salvages BOTH keys past a bad neighbor field', () => {
    const poisoned = JSON.stringify({
      ...both,
      codingAgent: {
        ...both.codingAgent,
        sessionDefaults: { pattern: 'not-a-real-pattern' },
      },
    });
    const parsed = parseStoredUserSettings(poisoned).codingAgent;
    expect(parsed.glmCodingKey).toBe('zai-secret');
    expect(parsed.kimiCodingKey).toBe('kimi-secret');
  });
});

describe('byoKeyField maps model → credential field', () => {
  it('maps the two BYO models to their fields', () => {
    expect(byoKeyField('glm_coding_plan')).toBe('glmCodingKey');
    expect(byoKeyField('kimi_coding_plan')).toBe('kimiCodingKey');
  });

  it('returns undefined for metered models', () => {
    expect(byoKeyField('kimi_k3')).toBeUndefined();
    expect(byoKeyField('deepseek_v4_pro')).toBeUndefined();
  });
});
