import { describe, it, expect } from 'vitest';
import {
  getPattern,
  getStep,
  getTerminalStep,
  CLASSIFIABLE_PATTERN_IDS,
  PATTERN_REGISTRY,
} from '../../../client/studio/agent/patterns/registry';
import {
  renderStepDecoration,
  decorateForStep,
  filterToolsForStep,
} from '../../../client/studio/agent/patterns/decorate';
import {
  superToBasePattern,
  isSuperPattern,
  NAMED_PATTERN_IDS,
} from '../../../client/studio/agent/patterns/types';

describe('pattern registry — all 7 patterns', () => {
  it('registers every named pattern', () => {
    expect(Object.keys(PATTERN_REGISTRY).sort()).toEqual(
      [...NAMED_PATTERN_IDS].sort(),
    );
    expect(CLASSIFIABLE_PATTERN_IDS).toHaveLength(7);
  });

  it('each pattern has ≥1 step and exactly one terminal step', () => {
    for (const id of NAMED_PATTERN_IDS) {
      const p = getPattern(id)!;
      expect(p.steps.length).toBeGreaterThan(0);
      expect(p.steps.filter((s) => s.isTerminal)).toHaveLength(1);
      expect(getTerminalStep(id).isTerminal).toBe(true);
    }
  });

  it('spec-build-verify has three steps with the right ids + gating', () => {
    const p = getPattern('spec-build-verify')!;
    expect(p.steps.map((s) => s.id)).toEqual(['spec', 'build', 'verify']);
    const spec = p.steps[0];
    expect(spec.allowedTools).toContain('spec_write');
    expect(spec.allowedTools).toContain('edit');
    expect(spec.allowedTools).not.toContain('delegate');
    expect(p.steps[1].allowedTools).toBeUndefined();
    expect(p.steps[2].isTerminal).toBe(true);
    expect(p.steps[1].systemPromptTail).toContain('THREE-FIX RULE');
    expect(p.steps[2].systemPromptTail).toContain('RED-GREEN-REVERT');
  });

  it('investigate-fix runs repro → diagnose → fix → verify with read-only investigation steps', () => {
    const p = getPattern('investigate-fix')!;
    expect(p.steps.map((s) => s.id)).toEqual([
      'repro',
      'diagnose',
      'fix',
      'verify',
    ]);
    // repro + diagnose are read-only (no edit family); fix + verify are full.
    expect(p.steps[0].allowedTools).not.toContain('edit');
    expect(p.steps[1].allowedTools).not.toContain('edit');
    expect(p.steps[2].allowedTools).toBeUndefined();
    // diagnose pauses for user review.
    expect(
      getStep('investigate-fix', 'diagnose')?.pauseForUserReviewAfter,
    ).toBe(true);
  });

  it('chat-qa is a single one-shot answer step; chat-advisory researches then synthesizes', () => {
    const qa = getPattern('chat-qa')!;
    expect(qa.steps.map((s) => s.id)).toEqual(['answer']);
    expect(qa.steps[0].loops).toBe('one-shot');
    const adv = getPattern('chat-advisory')!;
    expect(adv.steps.map((s) => s.id)).toEqual(['research', 'synthesize']);
    expect(adv.steps[0].allowedTools).not.toContain('edit'); // research is read-only
  });

  it('write-capable steps are marked gradeAfter (build / fix / edit)', () => {
    expect(getStep('spec-build-verify', 'build')?.gradeAfter).toBe(true);
    expect(getStep('investigate-fix', 'fix')?.gradeAfter).toBe(true);
    expect(getStep('quick-edit', 'edit')?.gradeAfter).toBe(true);
    // read-only / verify steps are not graded.
    expect(getStep('spec-build-verify', 'verify')?.gradeAfter).toBeUndefined();
    expect(getStep('investigate-fix', 'repro')?.gradeAfter).toBeUndefined();
  });

  it('super patterns reuse their base steps (reference equality) and map back via superToBasePattern', () => {
    expect(getPattern('super-spec-build-verify')!.steps).toBe(
      getPattern('spec-build-verify')!.steps,
    );
    expect(getPattern('super-investigate-fix')!.steps).toBe(
      getPattern('investigate-fix')!.steps,
    );
    expect(superToBasePattern('super-spec-build-verify')).toBe(
      'spec-build-verify',
    );
    expect(superToBasePattern('super-investigate-fix')).toBe('investigate-fix');
    expect(superToBasePattern('quick-edit')).toBe('quick-edit'); // identity for non-super
    expect(isSuperPattern('super-spec-build-verify')).toBe(true);
    expect(isSuperPattern('spec-build-verify')).toBe(false);
    expect(isSuperPattern(null)).toBe(false);
  });

  it('unknown pattern → undefined', () => {
    expect(getPattern('nope')).toBeUndefined();
  });
});

describe('decoration + tool filtering', () => {
  const [spec, build] = getPattern('spec-build-verify')!.steps;

  it('decorates the first user message with the step', () => {
    const d = decorateForStep('add a widget', spec);
    expect(d.startsWith('add a widget\n\n---\n\n# Step: Spec')).toBe(true);
    expect(d).toContain('end your turn');
  });

  it('renders the askUserClause when present', () => {
    expect(renderStepDecoration(spec)).toContain('ask_user');
  });

  it('renderStepDecoration has the header + advance note', () => {
    expect(renderStepDecoration(build)).toMatch(/^# Step: Build/);
    expect(renderStepDecoration(build)).toContain('THREE-FIX RULE');
  });

  it('filters tools to the step allowlist; passes all through when unset', () => {
    const specs = [
      { name: 'edit' },
      { name: 'delegate' },
      { name: 'spec_write' },
    ] as never[];
    expect(
      filterToolsForStep(specs, spec)
        .map((s: { name: string }) => s.name)
        .sort(),
    ).toEqual(['edit', 'spec_write']);
    expect(filterToolsForStep(specs, build)).toHaveLength(3);
    expect(filterToolsForStep(specs, null)).toHaveLength(3);
  });
});
