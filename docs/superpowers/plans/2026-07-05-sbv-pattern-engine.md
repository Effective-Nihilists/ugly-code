# SBV Pattern Engine (Plan 3a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use `- [ ]`.

**Goal:** Port the monolith's Spec-Build-Verify pattern as an in-repo step engine: SPEC→BUILD→VERIFY run as sequential, tool-gated, decorated `controller.send` calls, advancing on natural stop. Carries the verbatim THREE-FIX (BUILD) and RED-GREEN-REVERT (VERIFY) protocols.

**Architecture:** Entirely in `clientAgent.ts` + a new `patterns/` module — no ugly-app framework change. Step instructions inject via **user-message decoration** (keeps the cacheable system prefix byte-stable, matching the monolith); tools gate via the existing **live `tools` getter** filtered by the session's current step; advancement is **natural stop** (the model ends its turn → driver advances). The mid-step continue/advance LLM judge is intentionally NOT built (it was already removed from the monolith; boundary criteria-grader is Plan 3b).

**Tech Stack:** TypeScript (ESM), vitest.

## Global Constraints

- Step prompts + allowlists ported **verbatim** from `ugly-studio f5a74c2^:server/coding-agent/patterns/registry.ts`.
- Allowlists intersect ugly-code's `ToolName` union (`shared/agent.ts`).
- Decoration separator = `'\n\n---\n\n'`; each step message ends with "When this step is complete, end your turn — the orchestrator advances on its own."
- Advancement = natural stop (model turn with no tool call). No per-turn LLM judge (Plan 3b = boundary grader).
- `patternMode`: a concrete pattern id runs the engine; `'none'`/`'auto'` → current single-send behavior (classifier is Plan 3c).
- TDD, one commit per task.

## File Structure

- Create `client/studio/agent/patterns/types.ts` — `Step`, `Pattern`, `PatternId`.
- Create `client/studio/agent/patterns/registry.ts` — allowlists + SPEC/BUILD/VERIFY + `SPEC_BUILD_VERIFY` + `getPattern`.
- Create `client/studio/agent/patterns/decorate.ts` — `renderStepDecoration`, `decorateForStep`, `filterToolsForStep`.
- Modify `client/studio/agent/clientAgent.ts` — `state.currentStep`; `get tools()` filters by step; `runPatternTurn` driver; dispatch from `runClientAgentTurn`.
- Tests: `tests/unit/agent/patterns.test.ts`.

---

### Task 1: Pattern types + registry (verbatim SBV)

**Files:** Create `client/studio/agent/patterns/types.ts`, `client/studio/agent/patterns/registry.ts`. Test: `tests/unit/agent/patterns.test.ts` (registry portion).

**Interfaces:** `interface Step { id; label; systemPromptTail: string; allowedTools?: readonly ToolName[]; toolDescriptionSuffixes?: Partial<Record<ToolName,string>>; advanceCriteria: string; isTerminal?: boolean; pauseForUserReviewAfter?: boolean }`; `interface Pattern { id: PatternId; label; description; steps: Step[] }`; `getPattern(id): Pattern | undefined`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/agent/patterns.test.ts
import { describe, it, expect } from 'vitest';
import { getPattern } from '../../../client/studio/agent/patterns/registry';

describe('SBV registry', () => {
  it('spec-build-verify has three steps with the right ids + gating', () => {
    const p = getPattern('spec-build-verify')!;
    expect(p.steps.map((s) => s.id)).toEqual(['spec', 'build', 'verify']);
    const spec = p.steps[0];
    expect(spec.allowedTools).toContain('spec_write');
    expect(spec.allowedTools).toContain('edit');       // SPEC opens the edit family
    expect(spec.allowedTools).not.toContain('delegate');
    expect(p.steps[1].allowedTools).toBeUndefined();    // BUILD = full tools
    expect(p.steps[2].isTerminal).toBe(true);
    expect(p.steps[1].systemPromptTail).toContain('THREE-FIX RULE');
    expect(p.steps[2].systemPromptTail).toContain('RED-GREEN-REVERT');
  });
});
```

- [ ] **Step 2: Run → FAIL** (`pnpm vitest run tests/unit/agent/patterns.test.ts`).

- [ ] **Step 3: Implement.** Create `types.ts`:

```ts
import type { ToolName } from '../../../../shared/agent';

export type PatternId = 'spec-build-verify';

export interface Step {
  id: 'spec' | 'build' | 'verify';
  label: string;
  systemPromptTail: string;
  allowedTools?: readonly ToolName[];
  toolDescriptionSuffixes?: Partial<Record<ToolName, string>>;
  advanceCriteria: string;
  isTerminal?: boolean;
  pauseForUserReviewAfter?: boolean;
}
export interface Pattern { id: PatternId; label: string; description: string; steps: Step[] }
```

Create `registry.ts` — port the allowlists + steps VERBATIM from the recovery (SPEC_STEP/BUILD_STEP/VERIFY_STEP with full `systemPromptTail`, `advanceCriteria`; `READ_ONLY_TOOL_ALLOWLIST` ∩ ugly-code ToolNames; `SPEC_TOOL_ALLOWLIST = [...READ_ONLY, 'write','edit','multiedit']`). Drop tools ugly-code lacks (`dev_server_screenshot` etc. — keep only names in the `ToolName` union). Export `SPEC_BUILD_VERIFY` + `getPattern`.

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit** `feat(patterns): SBV registry (verbatim steps + tool allowlists)`.

---

### Task 2: Step decoration + tool filtering

**Files:** Create `client/studio/agent/patterns/decorate.ts`; extend `tests/unit/agent/patterns.test.ts`.

**Interfaces:**
- `renderStepDecoration(step: Step): string` → `# Step: {label}\n\n{systemPromptTail}\n\nWhen this step is complete, end your turn — the orchestrator advances on its own.`
- `decorateForStep(userText: string, step: Step): string` → `${userText}\n\n---\n\n${renderStepDecoration(step)}`
- `filterToolsForStep(specs: AgentToolSpec[], step: Step | null): AgentToolSpec[]` → when `step?.allowedTools`, keep only specs whose `name` is in the set (+ append `toolDescriptionSuffixes`); else return `specs` unchanged.

- [ ] **Step 1: Add failing tests**

```ts
import { renderStepDecoration, decorateForStep, filterToolsForStep } from '../../../client/studio/agent/patterns/decorate';
import { getPattern } from '../../../client/studio/agent/patterns/registry';

describe('decoration + tool filtering', () => {
  const [spec, build] = getPattern('spec-build-verify')!.steps;
  it('decorates the first user message with the step', () => {
    const d = decorateForStep('add a widget', spec);
    expect(d.startsWith('add a widget\n\n---\n\n# Step: Spec')).toBe(true);
    expect(d).toContain('end your turn');
  });
  it('filters tools to the step allowlist; passes all through when unset', () => {
    const specs = [{ name: 'edit' }, { name: 'delegate' }, { name: 'spec_write' }] as never[];
    expect(filterToolsForStep(specs, spec).map((s: { name: string }) => s.name).sort()).toEqual(['edit', 'spec_write']);
    expect(filterToolsForStep(specs, build)).toHaveLength(3); // BUILD = no allowlist
    expect(filterToolsForStep(specs, null)).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `decorate.ts`:**

```ts
import type { AgentToolSpec } from '../../../../shared/agent';
import type { Step } from './types';

const SEP = '\n\n---\n\n';
export function renderStepDecoration(step: Step): string {
  return `# Step: ${step.label}\n\n${step.systemPromptTail}\n\nWhen this step is complete, end your turn — the orchestrator advances on its own.`;
}
export function decorateForStep(userText: string, step: Step): string {
  return `${userText}${SEP}${renderStepDecoration(step)}`;
}
export function filterToolsForStep(specs: AgentToolSpec[], step: Step | null): AgentToolSpec[] {
  if (!step?.allowedTools) return specs;
  const allow = new Set<string>(step.allowedTools);
  return specs
    .filter((s) => allow.has(s.name))
    .map((s) => {
      const suffix = step.toolDescriptionSuffixes?.[s.name];
      return suffix ? { ...s, description: `${s.description ?? ''}${suffix}` } : s;
    });
}
```

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit** `feat(patterns): step decoration + per-step tool filtering`.

---

### Task 3: Wire the driver into clientAgent

**Files:** Modify `client/studio/agent/clientAgent.ts`; extend `tests/unit/agent/patterns.test.ts` if a pure driver helper is extracted.

**Interfaces:** `state.currentStep: Step | null` (default null). `get tools()` wraps `filterToolsForStep(sessionToolSpecs(...), state.currentStep)`. New `runPatternTurn(state, sessionId, userText, pattern, emit)`: for each step, set `state.currentStep = step`, `await state.controller.send(i === 0 ? decorateForStep(userText, step) : renderStepDecoration(step))`; clear `state.currentStep = null` in a `finally`. `runClientAgentTurn` dispatches to `runPatternTurn` when `resolvePattern(state)` returns a pattern (i.e. `state.patternMode === 'spec-build-verify'`), else the existing single send.

- [ ] **Step 1:** Add `currentStep` to the session state type + `getOrCreate` init (`currentStep: null`).

- [ ] **Step 2:** Change `get tools()` (clientAgent.ts:616-620) to:

```ts
    get tools() {
      const mode = state.modelMode.kind === 'group' ? 'group' : 'single';
      const isUglyApp = uglyAppBySession.get(sessionId) ?? false;
      return filterToolsForStep(sessionToolSpecs({ mode, isUglyApp }), state.currentStep);
    },
```

(import `filterToolsForStep` + `renderStepDecoration`/`decorateForStep` + `getPattern` + `type Step`.)

- [ ] **Step 3:** Add the driver + dispatch. In `runClientAgentTurn`, after `ensureResumed` + the user-message persist/emit, replace the single `await state.controller.send(userText)` with:

```ts
  const pattern = state.patternMode === 'spec-build-verify' ? getPattern('spec-build-verify') : undefined;
  if (pattern) {
    try {
      for (let i = 0; i < pattern.steps.length; i++) {
        state.currentStep = pattern.steps[i];
        await state.controller.send(i === 0 ? decorateForStep(userText, pattern.steps[i]) : renderStepDecoration(pattern.steps[i]));
      }
    } finally {
      state.currentStep = null;
    }
  } else {
    await state.controller.send(userText);
  }
```

(Confirm `state.patternMode` is the axis field; it is passthrough state on the session — read its `.kind`/value shape and compare to `'spec-build-verify'`.)

- [ ] **Step 4:** Run the full unit suite (`pnpm vitest run`) — no regressions; patterns tests pass.

- [ ] **Step 5:** Commit `feat(agent): SBV driver — step-gated decorated sends, advance on stop`.

---

### Task 4: Real smoke

- [ ] Run an eval with the pattern forced to `spec-build-verify` (extend the CLI with `--pattern` or set `state.patternMode` in the driver bootstrap). Observe: three decorated sends, SPEC turn gated to the SPEC allowlist, natural-stop advancement, a graded result. Capture the transcript from `~/.ugly-code/session/<id>/messages.jsonl` and confirm the SPEC/BUILD/VERIFY decorations appear. No commit (verification), or commit the `--pattern` CLI flag if added.

---

## Self-Review

- **Coverage:** registry (verbatim SBV) = T1; decoration + gating = T2; driver + dispatch = T3; real run = T4. The mid-step continue/advance judge is deliberately omitted (removed upstream); boundary grader = Plan 3b; classifier = Plan 3c.
- **Checkpoints:** confirm `state.patternMode`'s exact shape (passthrough axis) before comparing to `'spec-build-verify'`; confirm `controller.send` awaits to natural stop (it does — clientAgent.ts:781 already `await`s it); the SPEC `pauseForUserReviewAfter` gate is a no-op for the CLI/eval (non-interactive) — skip it.
- **Placeholders:** none — T1 ports the fully-recovered verbatim step consts.
