// Pattern classifier for `patternMode: 'auto'` — ported from ugly-studio f5a74c2^:
// server/coding-agent/patterns/classify.ts, adapted to a governed judge() call.
//
// ugly-code ships only the spec-build-verify pattern, so `auto` reduces to an
// ENGINE-SKIP decision: run SBV only for genuinely-novel, non-trivial work
// (pattern=spec-build-verify AND difficulty ≥ ENGINE_SKIP_THRESHOLD); everything
// else — bug fixes, trivial edits, questions — runs a plain single-send. This is
// the monolith's own rationale for skipping the engine below difficulty 0.65.
import type { Judge } from './judge';

export type ClassifierPattern = 'spec-build-verify' | 'quick-edit' | 'investigate-fix' | 'chat-qa';

export interface ClassifyOutput {
  pattern: ClassifierPattern;
  confidence: number;
  difficulty: number;
  reason: string;
  parseError?: string;
}

/** Below this difficulty the engine is skipped (plain single-send). */
export const ENGINE_SKIP_THRESHOLD = 0.65;

const FALLBACK: ClassifyOutput = {
  pattern: 'spec-build-verify',
  confidence: 0,
  difficulty: 0.5,
  reason: 'classifier failed; safest defaults',
  parseError: 'no parseable response',
};

const SYSTEM_PROMPT = [
  "You are a routing classifier for a coding agent. Given the user's first message of a session, decide which execution pattern to run and how difficult the task is.",
  '',
  'PATTERNS:',
  '  - spec-build-verify — genuinely-novel behavior or new surface area (new pages, new tools, new endpoints, new features). Bug repair, perf fixes, and "something is broken" requests are NEVER spec-build-verify — they belong in investigate-fix even when the cause is unclear.',
  '  - quick-edit — one-shot small change (typo, copy, one-liner, simple rename).',
  '  - investigate-fix — any request to repair, fix, restore, or unbreak existing behavior — including bare imperatives like "fix it", "this is broken", "X stopped working", "regression". Use this even when no stacktrace is provided.',
  '  - chat-qa — direct factual or how-it-works answer. No code edits. Bare questions with no imperative verb.',
  '',
  '`spec-build-verify` is the most expensive pattern. Pick it ONLY when the user is clearly asking for NEW behavior. If the prompt could plausibly be repair (fix / repair / unbreak / restore / patch, or "X is broken", "X doesn\'t work", "regression in Y"), prefer investigate-fix.',
  '',
  'DIFFICULTY (0..1):',
  '  - 0.0 .. 0.3 — trivial. Typo, single-line change, simple rename in one file.',
  '  - 0.3 .. 0.6 — routine. Bug fix in a known location, single-component feature, scoped multi-file rename with explicit call sites.',
  '  - 0.6 .. 0.8 — non-trivial. Multi-file refactor without an explicit callsite list, feature touching several components, debug with non-obvious cause.',
  '  - 0.8 .. 1.0 — hard. Architectural change, novel system, stub-trap (a method that exists but "doesn\'t work"), data-layer perf, misleading stack trace, "why is X broken/flaky/slow" with no obvious local fix.',
  '',
  'OUTPUT (strict JSON, no prose, no fences):',
  '  {"pattern": "<spec-build-verify | quick-edit | investigate-fix | chat-qa>", "confidence": <0..1>, "difficulty": <0..1>, "reason": "<ONE short sentence, under 25 words>"}',
  '',
  'Output the JSON object and nothing else.',
].join('\n');

const FIX_RE = /\b(fix|fixes|fixed|broke|broken|breaks|regression|crash(?:es|ed|ing)?|unbreak|restore|doesn'?t work|does not work|not working|stopped working|slow|flaky)\b/i;
const STACKTRACE_RE = /\bTraceback\b|\bat .+\(.+:\d+\)|\n\s+File ".+", line \d+/;
const QUESTION_RE = /^\s*(what|how|why|which|who|where|when|is|are|does|do|can|could|should)\b[\s\S]*\?\s*$/i;
const EDIT_VERB_RE = /\b(add|create|build|implement|write|make|generate|refactor|rename|remove|delete|update|change|edit)\b/i;

/** Cheap deterministic shortcuts for obvious non-SBV cases (skip the LLM call). */
export function heuristicShortcut(text: string): ClassifyOutput | null {
  const t = text.trim();
  if (STACKTRACE_RE.test(t) || FIX_RE.test(t)) {
    return { pattern: 'investigate-fix', confidence: 0.92, difficulty: 0.5, reason: 'repair/regression signal' };
  }
  if (QUESTION_RE.test(t) && !EDIT_VERB_RE.test(t)) {
    return { pattern: 'chat-qa', confidence: 0.85, difficulty: 0.2, reason: 'bare question, no imperative' };
  }
  return null;
}

function parseClassifier(raw: string): ClassifyOutput {
  const m = /\{[\s\S]*\}/.exec(raw);
  if (!m) return FALLBACK;
  try {
    const o = JSON.parse(m[0]) as Partial<ClassifyOutput>;
    const patterns: ClassifierPattern[] = ['spec-build-verify', 'quick-edit', 'investigate-fix', 'chat-qa'];
    const pattern = patterns.includes(o.pattern as ClassifierPattern) ? (o.pattern as ClassifierPattern) : 'spec-build-verify';
    const clamp = (n: unknown, d: number): number => (typeof n === 'number' && n >= 0 && n <= 1 ? n : d);
    return {
      pattern,
      confidence: clamp(o.confidence, 0.5),
      difficulty: clamp(o.difficulty, 0.5),
      reason: typeof o.reason === 'string' ? o.reason.slice(0, 200) : '',
    };
  } catch {
    return FALLBACK;
  }
}

/** Classify the first user message: heuristic shortcut, else one cheap judge call. */
export async function classifyForAuto(userText: string, judge: Judge): Promise<ClassifyOutput> {
  const shortcut = heuristicShortcut(userText);
  if (shortcut) return shortcut;
  let raw: string;
  try { raw = await judge(SYSTEM_PROMPT, userText.slice(0, 4000), 400); } catch { return FALLBACK; }
  return parseClassifier(raw);
}

/** Run the SBV engine only for genuinely-novel, non-trivial work. */
export function shouldRunEngine(out: ClassifyOutput): boolean {
  return out.pattern === 'spec-build-verify' && out.difficulty >= ENGINE_SKIP_THRESHOLD;
}
