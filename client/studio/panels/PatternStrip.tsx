/**
 * Step strip for the active pattern.
 *
 * Renders as a stable second toolbar row directly beneath the chat's
 * top `.panel-toolbar` whenever `patternMode !== 'none'`. Shows step
 * chips once a pattern has resolved; before resolution it renders a
 * placeholder ("Pattern: resolving…") so the row doesn't pop into
 * existence after a few seconds — the user sees a single, stable two-
 * row toolbar from the start of the session.
 *
 * Driven entirely off the SessionSnapshot — `resolvedPattern`,
 * `currentStepId`, `currentStepIter`. Hidden when patternMode is
 * 'none'.
 */
import { type FC } from 'react';

type PatternId =
  | 'spec-build-verify'
  | 'super-spec-build-verify'
  | 'quick-edit'
  | 'investigate-fix'
  | 'super-investigate-fix'
  | 'chat-qa'
  | 'chat-advisory';

type StepId =
  | 'spec'
  | 'build'
  | 'verify'
  | 'edit'
  | 'verify-touched'
  | 'repro'
  | 'diagnose'
  | 'fix'
  | 'answer'
  | 'research'
  | 'synthesize';

interface StepLayout {
  id: StepId;
  label: string;
  /** Tooltip shown on hover; mirrors the pattern's `advanceCriteria`. */
  hint: string;
}

interface PatternLayout {
  steps: readonly StepLayout[];
}

const SBV_STEPS: readonly StepLayout[] = [
  { id: 'spec', label: 'Spec', hint: 'Write the spec; no edits.' },
  { id: 'build', label: 'Build', hint: 'Implement to the spec.' },
  { id: 'verify', label: 'Verify', hint: 'Run gates; fix regressions.' },
];
const IF_STEPS: readonly StepLayout[] = [
  { id: 'repro', label: 'Repro', hint: 'Reproduce or characterize.' },
  { id: 'diagnose', label: 'Diagnose', hint: 'Single root cause + fix.' },
  { id: 'fix', label: 'Fix', hint: 'Apply the chosen fix.' },
  { id: 'verify', label: 'Verify', hint: 'Repro gone, gates green.' },
];
const PATTERN_LAYOUTS: Record<PatternId, PatternLayout> = {
  'spec-build-verify': { steps: SBV_STEPS },
  'super-spec-build-verify': { steps: SBV_STEPS },
  'quick-edit': {
    steps: [
      { id: 'edit', label: 'Edit', hint: 'Smallest correct change.' },
      {
        id: 'verify-touched',
        label: 'Verify (touched)',
        hint: 'Lint + tsc on touched files.',
      },
    ],
  },
  'investigate-fix': { steps: IF_STEPS },
  'super-investigate-fix': { steps: IF_STEPS },
  'chat-qa': {
    steps: [{ id: 'answer', label: 'Answer', hint: 'Direct factual answer.' }],
  },
  'chat-advisory': {
    steps: [
      {
        id: 'research',
        label: 'Research',
        hint: 'Gather context; cite sources.',
      },
      {
        id: 'synthesize',
        label: 'Synthesize',
        hint: 'Write the proposal via spec_write.',
      },
    ],
  },
};

export interface PatternStripProps {
  /** Resolved pattern; null renders a placeholder row when patternMode
   *  is not 'none'. */
  pattern: PatternId | null;
  /** Active step id within the pattern. */
  currentStepId: StepId | null;
  /** Iteration counter inside the active step. */
  currentStepIter?: number;
  /**
   * True after the pattern's terminal step ends; cleared on the next
   * user turn. When set, every chip up to and including `currentStepId`
   * renders as 'done' (green) instead of 'active', so the user can see
   * what just ran without the orange "in progress" highlight.
   */
  currentStepFinished?: boolean;
  /**
   * The user's pattern-mode selection. When 'none' the strip is
   * hidden entirely. When 'auto' or any explicit pattern pick, the
   * strip is always visible — placeholder while pattern is null,
   * step chips once resolved.
   */
  patternMode: 'none' | 'auto' | PatternId;
}

type StepState = 'pending' | 'active' | 'done';

function stepState(
  steps: readonly StepLayout[],
  stepId: StepId,
  current: StepId | null,
  finished: boolean,
): StepState {
  if (current === null) return 'pending';
  const activeIdx = steps.findIndex((s) => s.id === current);
  const thisIdx = steps.findIndex((s) => s.id === stepId);
  if (thisIdx < 0 || activeIdx < 0) return 'pending';
  if (finished) return thisIdx <= activeIdx ? 'done' : 'pending';
  if (thisIdx === activeIdx) return 'active';
  return thisIdx < activeIdx ? 'done' : 'pending';
}

export const PatternStrip: FC<PatternStripProps> = ({
  pattern,
  currentStepId,
  currentStepIter,
  currentStepFinished = false,
  patternMode,
}) => {
  if (patternMode === 'none') return null;

  // No resolved pattern yet — hide the strip entirely rather than show a
  // perpetual "resolving…" placeholder. ('auto' only resolves on the host
  // mid-turn; the client agent doesn't resolve patterns at all, so the
  // placeholder would otherwise never clear.) The strip appears once a
  // concrete pattern is resolved.
  if (!pattern) return null;

  const layout = PATTERN_LAYOUTS[pattern];
  return (
    <div className="pattern-strip" data-id="pattern-strip">
      <div className="pattern-strip-row">
        <ol className="pattern-strip-steps">
          {layout.steps.map((step) => {
            const state = stepState(
              layout.steps,
              step.id,
              currentStepId,
              currentStepFinished,
            );
            return (
              <li
                key={step.id}
                className={`pattern-strip-step ${state}`}
                data-step-id={step.id}
                data-step-state={state}
                title={step.hint}
              >
                <span className="pattern-strip-step-label">{step.label}</span>
                {state === 'active' && currentStepIter !== undefined && (
                  <span className="pattern-strip-step-iter">
                    iter {currentStepIter + 1}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
};
