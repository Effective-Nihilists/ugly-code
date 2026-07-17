// Tests for sessionConfig — pure mapping helpers (no I/O, no React).
import { describe, it, expect } from 'vitest';
import {
  axesToConfig,
  completeConfig,
  coerceModelMode,
  sessionConfigSchema,
  sessionConfigDefaultsSchema,
} from '../../shared/sessionConfig';

describe('coerceModelMode', () => {
  it('passes through auto', () => {
    expect(coerceModelMode({ kind: 'auto' })).toEqual({ kind: 'auto' });
  });

  it('passes through max', () => {
    expect(coerceModelMode({ kind: 'max' })).toEqual({ kind: 'max' });
  });

  it('passes through single with model', () => {
    expect(
      coerceModelMode({ kind: 'single', model: 'deepseek_v4_pro' }),
    ).toEqual({
      kind: 'single',
      model: 'deepseek_v4_pro',
    });
  });

  it('passes through group with models', () => {
    expect(coerceModelMode({ kind: 'group', models: ['a', 'b'] })).toEqual({
      kind: 'group',
      models: ['a', 'b'],
    });
  });

  it('collapses deprecated mid to single with survivor', () => {
    expect(
      coerceModelMode({ kind: 'mid', survivor: 'deepseek_v4_pro' }),
    ).toEqual({
      kind: 'single',
      model: 'deepseek_v4_pro',
    });
  });

  it('collapses deprecated auto-cheap to auto', () => {
    expect(coerceModelMode({ kind: 'auto-cheap' })).toEqual({ kind: 'auto' });
  });

  it('collapses unknown kind to auto', () => {
    expect(coerceModelMode({ kind: 'bogus' })).toEqual({ kind: 'auto' });
  });
});

describe('axesToConfig', () => {
  it('maps an AxisState to a SessionConfig', () => {
    const config = axesToConfig({
      model: 'deepseek_v4_pro',
      modelMode: { kind: 'auto' },
      permissionMode: 'edit',
      reasoningEffort: 'high',
      patternMode: 'none',
    });
    expect(config.model).toBe('deepseek_v4_pro');
    expect(config.mode).toEqual({ kind: 'auto' });
    expect(config.perm).toBe('edit');
    expect(config.reasoning).toBe('high');
    expect(config.pattern).toBe('none');
  });
});

describe('completeConfig', () => {
  it('fills gaps from fallback', () => {
    const fallback = {
      model: 'deepseek_v4_pro',
      modelMode: { kind: 'auto' as const },
      permissionMode: 'edit' as const,
      reasoningEffort: 'high' as const,
      patternMode: 'none' as const,
    };
    const partial = { model: 'deepseek_v4_flash' };
    const full = completeConfig(partial, fallback);
    expect(full.model).toBe('deepseek_v4_flash'); // from partial
    expect(full.mode).toEqual({ kind: 'auto' }); // from fallback
    expect(full.perm).toBe('edit');
    expect(full.reasoning).toBe('high');
    expect(full.pattern).toBe('none');
  });

  it('uses all defaults when partial is undefined', () => {
    const fallback = {
      model: 'deepseek_v4_pro',
      modelMode: { kind: 'max' as const },
      permissionMode: 'yolo' as const,
      reasoningEffort: 'max' as const,
      patternMode: 'auto' as const,
    };
    const full = completeConfig(undefined, fallback);
    expect(full).toEqual({
      model: 'deepseek_v4_pro',
      mode: { kind: 'max' },
      perm: 'yolo',
      reasoning: 'max',
      pattern: 'auto',
    });
  });
});

describe('schema validation', () => {
  it('accepts a valid SessionConfig', () => {
    const valid = {
      model: 'deepseek_v4_pro',
      mode: { kind: 'auto' },
      perm: 'edit',
      reasoning: 'high',
      pattern: 'none',
    };
    expect(sessionConfigSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects an invalid SessionConfig', () => {
    const invalid = {
      model: 123,
      mode: 'bogus',
      perm: 'bogus',
      reasoning: 'bogus',
      pattern: 'bogus',
    };
    expect(sessionConfigSchema.safeParse(invalid).success).toBe(false);
  });

  it('accepts partial SessionConfigDefaults', () => {
    const partial = { model: 'deepseek_v4_flash' };
    expect(sessionConfigDefaultsSchema.safeParse(partial).success).toBe(true);
  });

  it('accepts empty defaults', () => {
    expect(sessionConfigDefaultsSchema.safeParse({}).success).toBe(true);
  });
});
