/**
 * Display-side ranking helpers shared by the unified ModelPicker and any
 * other UI that compares coding-agent models. Pure functions, no React,
 * no socket — safe to import from server code if needed.
 *
 * Three concerns live here:
 *   1. `subscriptionOf(model)` — group rows by where the user's money
 *      goes (ugly.bot prepaid vs BYO subscription vs Claude CLI), not by
 *      who built the weights. Drives the section headers in the picker.
 *   2. `agenticPriceIndex(id)` — weighted blend of input / output / cache
 *      rates approximating the cost of a typical agentic-coding turn,
 *      where cache reads dominate (~80% of total tokens at Anthropic's
 *      reported 90–95% cache-hit rate for Claude Code).
 *   3. `sweTier(score)` — colored tier band for the SWE-bench Verified
 *      badge that replaces the old smartness dots. Top tier (≥82%) is
 *      reserved for frontier-class models; today Opus 4.8 (~88%) and
 *      Opus 4.7 (87.6%) land in green.
 */

import type { CodingAgentModel } from 'ugly-app/shared';
import { STANDARD_MODEL_RATES } from './model-rates.js';

// ──────────────────────────────────────────────────────────────────
// Subscription grouping
// ──────────────────────────────────────────────────────────────────

export type SubscriptionKey =
  | 'ugly.bot' // Anthropic / OpenAI / Google / open-weight / DeepSeek — billed via ugly.bot prepaid credits
  | 'claude-cli' // Claude Pro / Max plan, invoked via the local `claude` CLI
  | 'anthropic'; // Generic Anthropic endpoint (ANTHROPIC_BASE_URL / settings)

export const SUBSCRIPTION_ORDER: readonly SubscriptionKey[] = [
  'ugly.bot',
  'claude-cli',
  'anthropic',
] as const;

const SUBSCRIPTION_LABEL: Record<SubscriptionKey, string> = {
  'ugly.bot': 'ugly.bot',
  'claude-cli': 'Claude CLI',
  'anthropic': 'Anthropic',
};

export function subscriptionLabel(key: SubscriptionKey): string {
  return SUBSCRIPTION_LABEL[key];
}

/**
 * Map a model to the subscription it bills against. Falls back to
 * 'ugly.bot' for any framework-catalog id (Anthropic / OpenAI / Google /
 * open-weight / DeepSeek) — those all route through ugly.bot's prepaid
 * credit pool. The generic Anthropic rows (`anthropic:*`) and the Claude
 * CLI rows (provider === 'claude-cli') get their own keys.
 */
export function subscriptionOf(model: CodingAgentModel): SubscriptionKey {
  if (model.provider === 'claude-cli') return 'claude-cli';
  if (model.id.startsWith('anthropic:')) return 'anthropic';
  return 'ugly.bot';
}

/**
 * True when a model bills through ugly.bot's prepaid credits — i.e.,
 * everything that isn't the generic Anthropic endpoint or a Claude CLI
 * tier. Used by the auto-mode allowlist filter (auto only routes through
 * ugly.bot) and by the wire-loose autoAllowlist validator.
 */
export function isUglyBotModel(model: CodingAgentModel): boolean {
  return subscriptionOf(model) === 'ugly.bot';
}

/** Same predicate keyed by id only. Returns false for the generic Anthropic endpoint or claude-code tiers. */
export function isUglyBotModelId(id: string): boolean {
  if (id.startsWith('anthropic:')) return false;
  if (id === 'claude-code' || id.startsWith('claude-code:')) return false;
  return true;
}

/**
 * The four framework ids that make up the default session pool — the same
 * list the server materializes into `DEFAULT_MAX_POOL` (see
 * `studio/server/coding-agent/session.ts`). Exported from this shared
 * module so the model picker UI can render them as pinned rows directly
 * after the Auto entries without duplicating the list, and the server
 * importer keeps client and server in lock-step.
 *
 * Order is meaningful: it's the order rows appear in the picker (and the
 * order the max-mode runner consumes the pool).
 *
 * 2026-06-21 refresh: all-OSS, strong-tier-only. DeepSeek V4 Pro (SWE
 * 80.6) and Kimi K2.7 Code anchor the frontier; MiniMax M2.7 (~78) and
 * GLM-5.2 cover the value tier. Swapped the two superseded seats for
 * their newer, stronger coding versions: Kimi K2.6 → K2.7 Code
 * (coding-specialized, ~30% fewer reasoning tokens at higher coding
 * scores) and GLM-5.1 → 5.2 (Terminal-Bench 2.1 81.0, up from 5.1's
 * 63.5; SWE-bench Pro 62.1 vs 58.4). The cheaper / weaker rows
 * (Qwen 30B-A3B, MiniMax M2.5, Kimi K2 Thinking) stay out of the
 * default seats — explicit picks still work via the picker.
 */
export const DEFAULT_POOL_PINNED_IDS: readonly string[] = [
  'deepseek_v4_pro',
  'deepseek_v4_flash',
  'minimax_m2_7',
  'kimi_k2_7_code',
  'glm_5_2',
] as const;

// ──────────────────────────────────────────────────────────────────
// Agentic-coding weighted price index
// ──────────────────────────────────────────────────────────────────

/**
 * Weighted blend representing a typical agentic-coding token mix.
 *
 * Anthropic's "Lessons from building Claude Code" blog reports the
 * harness runs at a 90–95% cache hit rate; a healthy session is 95%+.
 * Output:input ratio for tool-heavy agent loops sits around 1:8–1:10.
 * Combining the two:
 *
 *   - cache_read   ~ 80% of total tokens
 *   - cache_write  ~  5%
 *   - fresh input  ~  5%
 *   - output       ~ 10%   (smaller volume but bills 5× input rate, so
 *                           it pulls weight in the dollar score)
 *
 * Returns USD per million effective tokens. Models without published
 * cache rates fall back to inputPerM for the cache columns — matches
 * the existing estimateCost() fallback in model-rates.ts.
 *
 * The `fallbackInputPerM` parameter is the model's `costPerM` field
 * (input rate), used when no entry exists in STANDARD_MODEL_RATES —
 * common for framework-billed rows whose rates are upstream.
 */
export function agenticPriceIndex(
  id: string,
  fallbackInputPerM: number,
): number {
  const r = STANDARD_MODEL_RATES[id];
  if (!r) return fallbackInputPerM;
  const cacheRead = r.cacheReadPerM ?? r.inputPerM;
  const cacheWrite = r.cacheWritePerM ?? r.inputPerM;
  return (
    0.8 * cacheRead +
    0.05 * cacheWrite +
    0.05 * r.inputPerM +
    0.1 * r.outputPerM
  );
}

export interface CostTier {
  label: '$' | '$$' | '$$$' | '$$$$';
  color: string;
}

/**
 * Bucket the weighted price index into four ASCII-dollar tiers. Boundaries
 * picked against today's catalog so DeepSeek Flash lands at $, GLM-4.6 at
 * $$, Sonnet 4.6 at $$$, Opus 4.7 at $$$$. Bump the thresholds when the
 * frontier shifts — these are display tiers, not policy gates.
 */
export function agenticCostTier(idx: number): CostTier {
  if (idx < 0.25) return { label: '$', color: '#22c55e' };
  if (idx < 1.0) return { label: '$$', color: '#84cc16' };
  if (idx < 4.0) return { label: '$$$', color: '#f59e0b' };
  return { label: '$$$$', color: '#ef4444' };
}

// ──────────────────────────────────────────────────────────────────
// SWE-bench Verified tier band
// ──────────────────────────────────────────────────────────────────

export interface SweTier {
  /** Hex color for the badge background / border. */
  color: string;
  /** Short label for the tooltip ("top tier" / "strong" / "capable" / "mid" / "weak"). */
  label: string;
}

/**
 * Map a SWE-bench Verified percentage to a five-band tier. The "top tier"
 * green band starts at 82% — narrow enough that today only Opus 4.8 (~88%)
 * and Opus 4.7 (87.6%) live there. Sonnet 4.6 / Kimi K2.7 Code / DeepSeek
 * V4 Pro / GLM-5.2 / MiniMax M2.7 / DeepSeek V4 Flash all land in "strong"
 * (75–82%).
 *
 * Cross-vendor scores aren't strictly apples-to-apples (different
 * harnesses, scaffolds, dates) — the badge is a quick comparator, not a
 * guarantee. Tooltip on each row spells that out.
 */
export function sweTier(score: number): SweTier {
  if (score >= 82) return { color: '#22c55e', label: 'top tier' };
  if (score >= 75) return { color: '#84cc16', label: 'strong' };
  if (score >= 65) return { color: '#facc15', label: 'capable' };
  if (score >= 50) return { color: '#f59e0b', label: 'mid' };
  return { color: '#ef4444', label: 'weak' };
}
