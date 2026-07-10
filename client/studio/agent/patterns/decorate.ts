// Step-instruction injection via user-message decoration (keeps the cacheable
// system prefix byte-stable) + per-step tool filtering. Ported from
// ugly-studio f5a74c2^:server/coding-agent/patterns/decorate-user-message.ts.
import type { AgentToolSpec } from '../../../../shared/agent';
import type { Step } from './types';

const SEP = '\n\n---\n\n';

export function renderStepDecoration(step: Step): string {
  const askUser = step.askUserClause ? `\n\n${step.askUserClause}` : '';
  return `# Step: ${step.label}\n\n${step.systemPromptTail}${askUser}\n\nWhen this step is complete, end your turn — the orchestrator advances on its own.`;
}

export function decorateForStep(userText: string, step: Step): string {
  return `${userText}${SEP}${renderStepDecoration(step)}`;
}

/**
 * Clarify-first instruction for the `none` pattern (the flat loop, which has no
 * step engine and therefore no `systemPromptTail` to counterbalance the base
 * prompt's "EDIT BOLDLY" / "BE AUTONOMOUS" rules — making it the eagerest mode).
 *
 * Injected as a user-message decoration rather than into AGENT_SYSTEM_PROMPT so
 * the cacheable system prefix stays byte-stable and no other pattern changes.
 *
 * Written to be safe to re-apply on every turn: once the design questions are
 * answered the model is told explicitly to stop asking and build.
 */
const NONE_DECORATION = [
  '# Before you build',
  '',
  'Do NOT default to the simplest thing you can implement. First decide whether this request contains any interesting design decisions — a choice between materially different approaches, a data model with more than one defensible shape, a tradeoff the user would want to weigh (performance vs simplicity, where a thing lives, what a thing is called when the name encodes a concept).',
  '',
  'If there is at least one such decision, and the user has not already settled it:',
  '  - Do the reading you need to make the options concrete. Investigation is encouraged; speculation is not.',
  '  - Present 2-3 designs. For each, state what it does, what it costs, and what it forecloses.',
  '  - Say which one you recommend and why.',
  '  - Then call `ask_user` to get the decision. Do not start editing first.',
  '',
  'If there is genuinely no interesting decision here — a clear bug with one obvious fix, a mechanical change, a question with a factual answer — then proceed and do the work. Do not manufacture questions to look careful.',
  '',
  'Likewise, if the user has already answered these questions (in this message or earlier in the conversation), or has told you to proceed, the design is settled: build it. Do not re-litigate a decision that has been made.',
  '',
  'Never call `ask_user` for naming, formatting, style, or tiebreaks you can resolve by reading the codebase.',
].join('\n');

/** Append the clarify-first instruction to a `none`-pattern user turn. */
export function decorateForNonePattern(userText: string): string {
  return `${userText}${SEP}${NONE_DECORATION}`;
}

/** Filter the model-facing tool specs to a step's allow-list (unset → all),
 *  appending any per-tool read-only description suffixes. */
export function filterToolsForStep(specs: AgentToolSpec[], step: Step | null): AgentToolSpec[] {
  if (!step?.allowedTools) return specs;
  const allow = new Set<string>(step.allowedTools);
  return specs
    .filter((s) => allow.has(s.name))
    .map((s) => {
      const suffix = step.toolDescriptionSuffixes?.[s.name];
      return suffix ? { ...s, description: `${s.description}${suffix}` } : s;
    });
}
