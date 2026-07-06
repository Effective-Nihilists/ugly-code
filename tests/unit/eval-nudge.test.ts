import { describe, it, expect } from 'vitest';
import { shouldNudgeForNoEdit } from '../../client/cli/evalRun';

// Phase-5 telemetry lever: the cheap model sometimes investigates a hard task then
// ends its turn without editing (turns-to-first-edit: never → 0 diff → 0 score). A
// single no-edit nudge recovers those runs — but must NOT fire for planning tasks
// (which legitimately produce no code diff) or when the agent already edited.
describe('shouldNudgeForNoEdit', () => {
  it('nudges an implementation task that made zero edits', () => {
    expect(shouldNudgeForNoEdit('bug-fix', 0)).toBe(true);
    expect(shouldNudgeForNoEdit('feature', 0)).toBe(true);
  });
  it('does not nudge when the agent already edited', () => {
    expect(shouldNudgeForNoEdit('bug-fix', 3)).toBe(false);
    expect(shouldNudgeForNoEdit('feature', 1)).toBe(false);
  });
  it('never nudges a planning task (no diff expected)', () => {
    expect(shouldNudgeForNoEdit('planning', 0)).toBe(false);
  });
});
