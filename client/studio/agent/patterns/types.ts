// Pattern engine types — ported from ugly-studio f5a74c2^:server/coding-agent/patterns/types.ts,
// trimmed to what the in-repo SBV engine uses (single-mode, natural-stop advance).
import type { ToolName } from '../../../../shared/agent';

export type PatternId = 'spec-build-verify';
export type StepId = 'spec' | 'build' | 'verify';

export interface Step {
  id: StepId;
  label: string;
  /** Injected via user-message decoration (not the system prompt), so the
   *  cacheable system prefix stays byte-stable across step transitions. */
  systemPromptTail: string;
  /** Hard allow-list — the live `tools` getter filters to only these. Unset =
   *  full tool access (BUILD/VERIFY). */
  allowedTools?: readonly ToolName[];
  toolDescriptionSuffixes?: Partial<Record<ToolName, string>>;
  advanceCriteria: string;
  isTerminal?: boolean;
  pauseForUserReviewAfter?: boolean;
}

export interface Pattern {
  id: PatternId;
  label: string;
  description: string;
  steps: Step[];
}
