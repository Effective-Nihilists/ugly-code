import { describe, it, expect } from 'vitest';
import { getPattern } from '../../../client/studio/agent/patterns/registry';
import { renderStepDecoration, decorateForStep, filterToolsForStep } from '../../../client/studio/agent/patterns/decorate';

describe('SBV registry', () => {
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

  it('renderStepDecoration has the header + advance note', () => {
    expect(renderStepDecoration(build)).toMatch(/^# Step: Build/);
    expect(renderStepDecoration(build)).toContain('THREE-FIX RULE');
  });

  it('filters tools to the step allowlist; passes all through when unset', () => {
    const specs = [{ name: 'edit' }, { name: 'delegate' }, { name: 'spec_write' }] as never[];
    expect(filterToolsForStep(specs, spec).map((s: { name: string }) => s.name).sort()).toEqual(['edit', 'spec_write']);
    expect(filterToolsForStep(specs, build)).toHaveLength(3);
    expect(filterToolsForStep(specs, null)).toHaveLength(3);
  });
});
