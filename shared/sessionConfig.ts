/**
 * `SessionConfig` — the per-session run configuration the user picks in the chat
 * header (model + run modes). It is a PER-SESSION setting stored, strictly typed,
 * on the CodingSession doc (server-persisted, so every browser that opens the
 * session sees the same values), seeded at creation from the per-user
 * `sessionDefaults` (which remembers the user's last pick so a NEW session starts
 * where they left off). Changing one session never affects another.
 *
 * Deliberately split into typed fields (not a JSON blob) so type errors surface at
 * compile time. The enums/union mirror client/studio/shared/api.ts
 * `SessionSnapshot`; `reasoning` reuses the framework's canonical schema.
 */
import { z } from 'zod';
import { reasoningEffortSchema, type ReasoningEffort } from 'ugly-app/shared';

/** Permission axis — plain edits, auto-approve (yolo), or plan-only. */
export const sessionPermissionSchema = z.enum(['edit', 'yolo', 'claude-plan']);
export type SessionPermission = z.infer<typeof sessionPermissionSchema>;

/**
 * Model-mode axis — how many models run and how. Current variants only; the
 * deprecated `mid`/`auto-cheap` shapes are resume-translated by the studio and are
 * never written into a session's config.
 */
export const sessionModelModeSchema = z.union([
  z.object({ kind: z.literal('auto') }),
  z.object({ kind: z.literal('max') }),
  z.object({ kind: z.literal('single'), model: z.string() }),
  z.object({
    kind: z.literal('group'),
    models: z.array(z.string()),
    personas: z.record(z.string(), z.string()).optional(),
  }),
]);
export type SessionModelMode = z.infer<typeof sessionModelModeSchema>;

/** Pattern axis — which SBV/engine pattern (or none/auto) drives the turn. */
export const sessionPatternSchema = z.enum([
  'none',
  'auto',
  'spec-build-verify',
  'super-spec-build-verify',
  'quick-edit',
  'investigate-fix',
  'super-investigate-fix',
  'chat-qa',
  'chat-advisory',
]);
export type SessionPattern = z.infer<typeof sessionPatternSchema>;

export const sessionConfigSchema = z.object({
  model: z.string(),
  mode: sessionModelModeSchema,
  perm: sessionPermissionSchema,
  reasoning: reasoningEffortSchema,
  pattern: sessionPatternSchema,
});
export type SessionConfig = z.infer<typeof sessionConfigSchema>;

/** A user's remembered defaults for NEW sessions — any subset may be set. */
export const sessionConfigDefaultsSchema = sessionConfigSchema.partial();
export type SessionConfigDefaults = z.infer<typeof sessionConfigDefaultsSchema>;

// ── Pure mapping helpers (no I/O; safe for both the worker + renderer) ────────

/** The chat header's live axis state, mapped 1:1 onto SessionConfig's fields. */
export interface AxisState {
  model: string;
  modelMode: SessionModelMode;
  permissionMode: SessionPermission;
  reasoningEffort: ReasoningEffort;
  patternMode: SessionPattern;
}

/**
 * Narrow a header model-mode (which still carries deprecated `mid`/`auto-cheap`
 * variants for resume back-compat) to the strict `SessionModelMode` stored in
 * config; deprecated shapes collapse the way the studio's resume translator does.
 */
export function coerceModelMode(m: {
  kind: string;
  model?: string;
  survivor?: string;
  models?: string[];
  personas?: Record<string, string>;
}): SessionModelMode {
  switch (m.kind) {
    case 'single':
      return { kind: 'single', model: m.model ?? '' };
    case 'max':
      return { kind: 'max' };
    case 'group':
      return { kind: 'group', models: m.models ?? [], ...(m.personas ? { personas: m.personas } : {}) };
    case 'mid':
      return { kind: 'single', model: m.survivor ?? '' };
    default: // 'auto', deprecated 'auto-cheap', or anything unknown
      return { kind: 'auto' };
  }
}

export function axesToConfig(a: AxisState): SessionConfig {
  return { model: a.model, mode: a.modelMode, perm: a.permissionMode, reasoning: a.reasoningEffort, pattern: a.patternMode };
}

/** Fill any gaps in a (possibly partial) config with a full fallback → full config. */
export function completeConfig(partial: SessionConfigDefaults | undefined, fallback: AxisState): SessionConfig {
  return {
    model: partial?.model ?? fallback.model,
    mode: partial?.mode ?? fallback.modelMode,
    perm: partial?.perm ?? fallback.permissionMode,
    reasoning: partial?.reasoning ?? fallback.reasoningEffort,
    pattern: partial?.pattern ?? fallback.patternMode,
  };
}
