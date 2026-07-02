/**
 * Standard published per-token rates for the BYO-key / subscription
 * providers wired into the coding agent. Used by `SessionReadout` to
 * surface an estimated cost chip — the live token counters multiplied
 * by these rates.
 *
 * Single source of truth: `textGenModelData` in ugly-app. The catalog
 * over there carries `inputTokenNanoDollar` / `outputTokenNanoDollar`
 * / `cacheReadTokenNanoDollar` / `cacheWriteTokenNanoDollar` per
 * framework model id; this file converts those nano-USD-per-token
 * numbers into USD-per-million-tokens and re-keys them to:
 *   1. The framework id itself (e.g. `claude_sonnet_4_6`).
 *   2. The BYO-prefix alias used by the studio picker (e.g.
 *      `deepseek:deepseek-v4-pro`, `z-ai:glm-5.1`). The underlying
 *      model is the same; the prefix only signals "user-supplied
 *      key on the provider's pay-as-you-go endpoint" vs "framework-
 *      billed via ugly.bot."
 *
 * BYO-only ids that have no framework counterpart in the catalog
 * (Kimi K2.5, MiniMax M2.7) get a small hardcoded override below.
 *
 * Numbers are USD per **million tokens**. Sources:
 *   - DeepSeek:  https://api-docs.deepseek.com/quick_start/pricing
 *   - z.ai:      https://docs.z.ai/guides/overview/pricing
 *   - Kimi:      https://platform.moonshot.ai/docs/pricing
 *   - MiniMax:   https://platform.minimax.io/docs/guides/pricing-token-plan
 *   - Anthropic: https://www.anthropic.com/pricing
 */
import { textGenModelData, type TextGenModel } from 'ugly-app/shared';

export interface ModelRates {
  /** Input tokens (cache-miss) USD per million. */
  inputPerM: number;
  /** Output tokens USD per million. */
  outputPerM: number;
  /** Cache-hit (read) tokens USD per million. Falls back to inputPerM when absent. */
  cacheReadPerM?: number;
  /** Cache-creation (write) tokens USD per million. Falls back to inputPerM when absent. */
  cacheWritePerM?: number;
}

/**
 * Convert TextGen's per-token nano-USD into USD-per-million.
 *   1 nanoUSD/token = 1e-9 USD/token = 1e-9 * 1e6 USD/Mtok = 1e-3 USD/Mtok
 * — i.e. divide by 1000.
 */
function ratesFromTextGen(id: TextGenModel): ModelRates {
  const d = textGenModelData[id];
  return {
    inputPerM: d.inputTokenNanoDollar / 1000,
    outputPerM: d.outputTokenNanoDollar / 1000,
    ...(d.cacheReadTokenNanoDollar !== undefined
      ? { cacheReadPerM: d.cacheReadTokenNanoDollar / 1000 }
      : {}),
    ...(d.cacheWriteTokenNanoDollar !== undefined
      ? { cacheWritePerM: d.cacheWriteTokenNanoDollar / 1000 }
      : {}),
  };
}

/**
 * Final rate map: one entry per framework (ugly.bot) id, walked from
 * `textGenModelData`. The generic `anthropic:custom` row has no rate card
 * (the operator pays the upstream directly), so it simply isn't listed —
 * the cost chip shows nothing for it.
 */
function buildRates(): Record<string, ModelRates> {
  const out: Record<string, ModelRates> = {};
  for (const id of Object.keys(textGenModelData) as TextGenModel[]) {
    out[id] = ratesFromTextGen(id);
  }
  return out;
}

export const STANDARD_MODEL_RATES: Record<string, ModelRates> = buildRates();

/**
 * Claude Code's `result.modelUsage` is keyed by Anthropic API model
 * IDs with a date suffix (e.g. `claude-sonnet-4-6-20260201`). Map
 * to the canonical clean name used in `STANDARD_MODEL_RATES` so
 * `estimateCost` finds the rates. Prefix-match so a new dated build
 * doesn't silently fall through.
 */
export function canonicalizeAnthropicModelId(apiId: string): string | null {
  if (apiId.startsWith('claude-opus-4-7')) return 'claude_opus_4_7';
  if (apiId.startsWith('claude-sonnet-4-6')) return 'claude_sonnet_4_6';
  if (apiId.startsWith('claude-haiku-4-5')) return 'claude_haiku_4_5';
  return null;
}

/**
 * True when the model is served by a direct (non-ugly.bot) endpoint the
 * user pays for themselves — the generic `anthropic:custom` provider. The
 * `SessionReadout` tooltip uses this to caveat the cost estimate, since we
 * don't meter or price that endpoint.
 */
export function isSubscriptionProvider(modelId: string): boolean {
  return modelId.startsWith('anthropic:');
}

export interface UsageBreakdown {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface CostEstimate {
  total: number;
  parts: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
}

/**
 * Multiply token counts by the model's standard rates. Returns null when
 * no rates are known for the model id.
 *
 * Cache reads / writes fall back to the input rate when the model
 * doesn't publish a separate cache rate — close enough for an estimate,
 * and avoids under-counting on providers that don't discount cache.
 */
export function estimateCost(
  modelId: string,
  usage: UsageBreakdown,
): CostEstimate | null {
  const rates = STANDARD_MODEL_RATES[modelId];
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Record<string, …> index yields undefined for an unknown model id at runtime
  if (!rates) return null;
  const cacheReadRate = rates.cacheReadPerM ?? rates.inputPerM;
  const cacheWriteRate = rates.cacheWritePerM ?? rates.inputPerM;
  const input = (usage.inputTokens * rates.inputPerM) / 1_000_000;
  const output = (usage.outputTokens * rates.outputPerM) / 1_000_000;
  const cacheRead = (usage.cacheReadTokens * cacheReadRate) / 1_000_000;
  const cacheWrite = (usage.cacheCreationTokens * cacheWriteRate) / 1_000_000;
  return {
    total: input + output + cacheRead + cacheWrite,
    parts: { input, output, cacheRead, cacheWrite },
  };
}
