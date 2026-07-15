/**
 * Per-user coding-agent settings — the source of truth for the studio's
 * `getUserSettings` / `updateUserSettings` / `resetUserSettings` requests.
 *
 * These used to live in a host-local file (`~/.ugly-studio/coding-agent.json`)
 * served by the old Node sidecar. In the browser-served studio the host disk is
 * unreachable, so settings now persist per-user in Neon (see the `userSettings`
 * collection in ./collections.ts) and are read/written via the ugly-app request
 * pattern (shared/api.ts + server/index.ts) — NOT window.UglyNative.
 *
 * The persisted doc stores the settings object as a JSON string blob so
 * collections.ts stays under TypeScript's type-instantiation budget (the coding
 * collections were split out for the same reason). The typed shape lives here;
 * reads zod-parse the blob and merge it over DEFAULT_USER_SETTINGS.
 */
import { z } from 'zod';
import { sessionConfigDefaultsSchema } from './sessionConfig';

// The `codingAgent` block mirrors the studio's `getUserSettings` output
// (client/studio/shared/api.ts). Optional fields are advanced/aux-model knobs a
// future Settings panel writes; the chat only reads the required feature toggles
// (see serverToFeatures in useCodingAgentChat.ts).
export const codingAgentSettingsSchema = z.object({
  memory: z.object({ read: z.boolean(), write: z.boolean() }),
  multiAgent: z.object({ enabled: z.boolean() }),
  autoLint: z.boolean(),
  checkpoints: z.boolean(),
  specs: z.object({ enabled: z.boolean() }),
  systemSkills: z.object({ enabled: z.boolean() }),
  autoTsc: z.object({ enabled: z.boolean() }),
  codebaseIndex: z.boolean(),
  autoAllowlist: z.array(z.string()),
  pureJudgeMode: z.boolean(),
  expensiveParallel: z.boolean(),
  temperatureOverride: z.number().optional(),
  auxModel: z.string().optional(),
  judgeModel: z.string().optional(),
  pickerModel: z.string().optional(),
  pollinator: z.string().nullable().optional(),
  pollinatorEnabled: z.boolean().optional(),
  phaseTimeoutMs: z.number().nullable().optional(),
  hangFallbackMs: z.number().nullable().optional(),
  superSpecModels: z.array(z.string()).optional(),
  superSynthesisModel: z.string().optional(),
  superInjectionStyle: z.enum(['advisory', 'imperative']).optional(),
  /**
   * Z.ai GLM Coding Plan API key. The ONLY provider credential stored here.
   *
   * It is forwarded to ugly.bot on each `agentStep` (never stored there) and
   * bills against the user's own flat-rate subscription rather than ugly.bot's
   * metered account. Without it the `glm_coding_plan` model is hidden in the
   * picker and rejected by ugly.bot.
   *
   * Stored in plaintext in the Neon settings blob, like every other field here.
   */
  glmCodingKey: z.string().optional(),
  // The user's LAST-picked session config (model + run modes), remembered so a NEW
  // coding session defaults to it. Per-session picks live on the session itself
  // (CodingSession.config); this is only the seed for freshly-created sessions.
  sessionDefaults: sessionConfigDefaultsSchema.optional(),
});
export type CodingAgentSettings = z.infer<typeof codingAgentSettingsSchema>;

export const userSettingsSchema = z.object({
  reinforcement: z.object({ enabled: z.boolean() }),
  codingAgent: codingAgentSettingsSchema,
});
export type UserSettings = z.infer<typeof userSettingsSchema>;

// Deep-partial patch accepted by updateUserSettings. Nested toggle objects are
// individually optional so a caller can flip a single field.
export const userSettingsPatchSchema = z.object({
  reinforcement: z.object({ enabled: z.boolean().optional() }).optional(),
  codingAgent: z
    .object({
      memory: z.object({ read: z.boolean().optional(), write: z.boolean().optional() }).optional(),
      multiAgent: z.object({ enabled: z.boolean().optional() }).optional(),
      autoLint: z.boolean().optional(),
      checkpoints: z.boolean().optional(),
      specs: z.object({ enabled: z.boolean().optional() }).optional(),
      systemSkills: z.object({ enabled: z.boolean().optional() }).optional(),
      autoTsc: z.object({ enabled: z.boolean().optional() }).optional(),
      codebaseIndex: z.boolean().optional(),
      autoAllowlist: z.array(z.string()).optional(),
      pureJudgeMode: z.boolean().optional(),
      expensiveParallel: z.boolean().optional(),
      temperatureOverride: z.number().optional(),
      auxModel: z.string().nullable().optional(),
      judgeModel: z.string().nullable().optional(),
      pickerModel: z.string().nullable().optional(),
      pollinator: z.string().nullable().optional(),
      pollinatorEnabled: z.boolean().optional(),
      phaseTimeoutMs: z.number().nullable().optional(),
      hangFallbackMs: z.number().nullable().optional(),
      superSpecModels: z.array(z.string()).optional(),
      superSynthesisModel: z.string().nullable().optional(),
      superInjectionStyle: z.enum(['advisory', 'imperative']).nullable().optional(),
      // `null` clears the stored key (see mergeUserSettings).
      glmCodingKey: z.string().nullable().optional(),
      // Remembered defaults for new sessions (see CodingSession.config).
      sessionDefaults: sessionConfigDefaultsSchema.optional(),
    })
    .optional(),
});
export type UserSettingsPatch = z.infer<typeof userSettingsPatchSchema>;

// Factory defaults. The codingAgent block matches DEFAULT_FEATURES in
// useCodingAgentChat.ts so a user with no persisted doc sees the same toggles
// the client already assumes.
export const DEFAULT_USER_SETTINGS: UserSettings = {
  reinforcement: { enabled: true },
  codingAgent: {
    memory: { read: true, write: true },
    multiAgent: { enabled: true },
    autoLint: false,
    checkpoints: false,
    specs: { enabled: true },
    systemSkills: { enabled: true },
    autoTsc: { enabled: false },
    codebaseIndex: true,
    autoAllowlist: ['deepseek_v4_pro', 'deepseek_v4_flash', 'glm_5_1'],
    pureJudgeMode: false,
    expensiveParallel: false,
  },
};

/**
 * Deep-merge a settings patch over a base. Nested toggle objects merge field-by-
 * field; `null` in the patch clears an optional field. Undefined patch fields are
 * ignored (keep the base value). Returns a fresh object — inputs are not mutated.
 */
export function mergeUserSettings(base: UserSettings, patch: UserSettingsPatch): UserSettings {
  const ca = base.codingAgent;
  const p = patch.codingAgent ?? {};
  return {
    reinforcement: { enabled: patch.reinforcement?.enabled ?? base.reinforcement.enabled },
    codingAgent: {
      ...ca,
      memory: { read: p.memory?.read ?? ca.memory.read, write: p.memory?.write ?? ca.memory.write },
      multiAgent: { enabled: p.multiAgent?.enabled ?? ca.multiAgent.enabled },
      autoLint: p.autoLint ?? ca.autoLint,
      checkpoints: p.checkpoints ?? ca.checkpoints,
      specs: { enabled: p.specs?.enabled ?? ca.specs.enabled },
      systemSkills: { enabled: p.systemSkills?.enabled ?? ca.systemSkills.enabled },
      autoTsc: { enabled: p.autoTsc?.enabled ?? ca.autoTsc.enabled },
      codebaseIndex: p.codebaseIndex ?? ca.codebaseIndex,
      autoAllowlist: p.autoAllowlist ?? ca.autoAllowlist,
      pureJudgeMode: p.pureJudgeMode ?? ca.pureJudgeMode,
      expensiveParallel: p.expensiveParallel ?? ca.expensiveParallel,
      // Optional scalar/model knobs: `null` clears, `undefined` keeps base.
      ...mergeOptional(ca, p),
      // Remembered new-session defaults: merge the patch over the stored value.
      ...(p.sessionDefaults !== undefined
        ? { sessionDefaults: { ...ca.sessionDefaults, ...p.sessionDefaults } }
        : {}),
    },
  };
}

// Merge the optional codingAgent fields where `null` means "clear" and
// `undefined` means "keep base". Kept separate so the required-field merge above
// stays readable.
function mergeOptional(
  ca: CodingAgentSettings,
  p: NonNullable<UserSettingsPatch['codingAgent']>,
): Partial<CodingAgentSettings> {
  const out: Partial<CodingAgentSettings> = {};
  const num = (v: number | null | undefined, base: number | undefined): number | undefined =>
    v === null ? undefined : v ?? base;
  const numN = (v: number | null | undefined, base: number | null | undefined): number | null | undefined =>
    v === undefined ? base : v;
  const strN = (v: string | null | undefined, base: string | null | undefined): string | null | undefined =>
    v === undefined ? base : v;

  const temperatureOverride = num(p.temperatureOverride, ca.temperatureOverride);
  if (temperatureOverride !== undefined) out.temperatureOverride = temperatureOverride;
  const auxModel = p.auxModel === undefined ? ca.auxModel : p.auxModel ?? undefined;
  if (auxModel !== undefined) out.auxModel = auxModel;
  const judgeModel = p.judgeModel === undefined ? ca.judgeModel : p.judgeModel ?? undefined;
  if (judgeModel !== undefined) out.judgeModel = judgeModel;
  const pickerModel = p.pickerModel === undefined ? ca.pickerModel : p.pickerModel ?? undefined;
  if (pickerModel !== undefined) out.pickerModel = pickerModel;
  // `null` clears the stored key (the Settings "Remove" action). Note the
  // asymmetry with the knobs above: `out` is spread AFTER `...ca`, so simply
  // omitting a field leaves the base value in place — it can never clear it.
  // To actually remove the key the property must be present and undefined.
  if (p.glmCodingKey === null) out.glmCodingKey = undefined;
  else if (p.glmCodingKey !== undefined) out.glmCodingKey = p.glmCodingKey;
  else if (ca.glmCodingKey !== undefined) out.glmCodingKey = ca.glmCodingKey;
  const pollinator = strN(p.pollinator, ca.pollinator);
  if (pollinator !== undefined) out.pollinator = pollinator;
  if (p.pollinatorEnabled !== undefined) out.pollinatorEnabled = p.pollinatorEnabled;
  else if (ca.pollinatorEnabled !== undefined) out.pollinatorEnabled = ca.pollinatorEnabled;
  const phaseTimeoutMs = numN(p.phaseTimeoutMs, ca.phaseTimeoutMs);
  if (phaseTimeoutMs !== undefined) out.phaseTimeoutMs = phaseTimeoutMs;
  const hangFallbackMs = numN(p.hangFallbackMs, ca.hangFallbackMs);
  if (hangFallbackMs !== undefined) out.hangFallbackMs = hangFallbackMs;
  if (p.superSpecModels !== undefined) out.superSpecModels = p.superSpecModels;
  else if (ca.superSpecModels !== undefined) out.superSpecModels = ca.superSpecModels;
  const superSynthesisModel =
    p.superSynthesisModel === undefined ? ca.superSynthesisModel : p.superSynthesisModel ?? undefined;
  if (superSynthesisModel !== undefined) out.superSynthesisModel = superSynthesisModel;
  const superInjectionStyle =
    p.superInjectionStyle === undefined ? ca.superInjectionStyle : p.superInjectionStyle ?? undefined;
  if (superInjectionStyle !== undefined) out.superInjectionStyle = superInjectionStyle;
  return out;
}

/**
 * Parse a persisted JSON blob and merge over defaults.
 *
 * TOLERANT BY DESIGN. This read feeds `updateUserSettings`' read-modify-write
 * (server reads current → merges patch → writes back). An all-or-nothing parse
 * is therefore a data-loss trap: if ONE stale/invalid field made the read return
 * defaults, the very next settings write (e.g. `sessionDefaults` on a model pick)
 * would persist those defaults and silently erase the user's `glmCodingKey`
 * credential. So we degrade field-by-field rather than discarding the whole doc:
 *
 *   1. Validate against the DEEP-optional patch schema (not
 *      `userSettingsSchema.partial()`, which only makes the TOP level optional and
 *      so rejects any blob whose nested codingAgent is missing a field). This
 *      alone rescues older/partial blobs.
 *   2. If a PRESENT field has a bad type (e.g. a sessionDefaults enum from an old
 *      client), the patch parse still fails — so salvage the one field that must
 *      never be lost, the provider credential, before falling back to defaults.
 */
export function parseStoredUserSettings(raw: string | null | undefined): UserSettings {
  if (!raw) return DEFAULT_USER_SETTINGS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_USER_SETTINGS;
  }
  const lenient = userSettingsPatchSchema.safeParse(parsed);
  if (lenient.success) return mergeUserSettings(DEFAULT_USER_SETTINGS, lenient.data);
  const key = extractGlmCodingKey(parsed);
  return key === undefined
    ? DEFAULT_USER_SETTINGS
    : mergeUserSettings(DEFAULT_USER_SETTINGS, { codingAgent: { glmCodingKey: key } });
}

/** Pull a well-typed, non-empty glmCodingKey straight out of a raw parsed blob. */
function extractGlmCodingKey(parsed: unknown): string | undefined {
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const ca = (parsed as { codingAgent?: unknown }).codingAgent;
  if (ca === null || typeof ca !== 'object') return undefined;
  const key = (ca as { glmCodingKey?: unknown }).glmCodingKey;
  return typeof key === 'string' && key.length > 0 ? key : undefined;
}
