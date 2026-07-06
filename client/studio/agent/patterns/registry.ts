// Pattern registry — SBV steps ported verbatim from
// ugly-studio f5a74c2^:server/coding-agent/patterns/registry.ts. Allow-lists are
// intersected with ugly-code's ToolName union (shared/agent.ts).
import type { ToolName } from '../../../../shared/agent';
import type { Pattern, PatternId, Step } from './types';

// Read-only-flavored allow-list (hard-removes the edit family at the tool layer).
// bash + python_exec stay callable for tests / AST walks.
const READ_ONLY_TOOL_ALLOWLIST: readonly ToolName[] = [
  'read',
  'grep',
  'glob',
  'bash',
  'python_exec',
  'python_libraries',
  'spec_write',
  'spec_read',
  'ask_user',
  'web_search',
  'web_fetch',
  'dep_docs',
  'analyze_image',
  'scratchpad',
  'memory_read',
  'memory_save',
  'memory_list',
  'memory_delete',
  'todos',
  'dev_server_start',
  'dev_server_stop',
  'dev_server_logs',
  'dev_server_errors',
];

const READ_ONLY_TOOL_SUFFIXES: Partial<Record<ToolName, string>> = {
  bash: '\n\nREAD-ONLY STEP RULE: Do NOT modify the workspace via this shell — no file writes (redirects > / >> to source files), no in-place edits (sed -i, perl -i, awk -i), no destructive ops (rm, mv on tracked files). Read-only queries (cat, ls, grep, git status, test runners) and tempfile work under /tmp are fine. The dedicated `edit` / `multiedit` / `write` tools are unavailable this step — they will be re-enabled when the next step opens.',
  python_exec:
    "\n\nREAD-ONLY STEP RULE: Do NOT mutate workspace files in this script — no `open(path, 'w'/'a')` on source paths, no `Path.write_text` / pathlib writes, no `shutil` mutations under cwd. AST walks, libcst inspect, pathlib reads, requests fetches are all fine. Tempfile work under /tmp is fine. The dedicated edit tools are unavailable this step.",
};

// SPEC gets the read-only base PLUS the edit family (the user often asks for a
// visual scaffold alongside the spec; a model without `write` fakes it via bash
// heredocs and burns turns). Only SPEC opens edit — a stricter read-only step
// (diagnose/repro) would use READ_ONLY_TOOL_ALLOWLIST directly.
const SPEC_TOOL_ALLOWLIST: readonly ToolName[] = [
  ...READ_ONLY_TOOL_ALLOWLIST,
  'write',
  'edit',
  'multiedit',
];

const SPEC_STEP: Step = {
  id: 'spec',
  label: 'Spec',
  allowedTools: SPEC_TOOL_ALLOWLIST,
  systemPromptTail: [
    'Step: SPEC. You are designing a NEW FEATURE. The output of this step is a buildable design document — not a bug-investigation report.',
    '',
    'Before writing the spec, perform FEATURE DESIGN ANALYSIS:',
    '',
    '(1) DATA MODEL. Enumerate every collection / table the feature needs. For each: name, key fields, scope (per-user / per-family / global), real-time sync requirements. Use the framework idioms you find in the existing codebase (e.g. ugly-app projects: Zod schemas + defineCollections in shared/collections.ts).',
    '',
    '(2) API SURFACE. List EVERY endpoint by its concrete name and the action it performs. Do NOT collapse multiple actions into a generic "respond" or "action" endpoint — if the user mentions snooze, no-show, reschedule, mark-arrived, and mark-left, the spec must name FIVE distinct endpoints. Granularity at the design layer is mandatory; the executor cannot re-derive endpoint names from a generic description. For each endpoint: name, auth shape (req / authReq), input keys, output keys, and the side-effect (DB write, push broadcast, etc.).',
    '',
    '(3) UI SURFACE. Enumerate pages, routes, and the components on each. For each user-visible action, name the endpoint it calls. If the user asked for multiple design variants, name each variant explicitly (e.g. "Calm / Sharp / Warm / Minimal / Playful") so the executor knows what to render.',
    '',
    "(4) BACKGROUND WORK. List cron jobs, scheduled notifications, webhook handlers, etc. with their trigger conditions and what they do. Don't abstract a 7:30 AM check-in and a 5:30 PM check-out into one generic 'scheduled notification job' — name each one.",
    '',
    '(5) USER FLOWS. Walk through the 3-5 most important flows end-to-end. Each flow names the entry point (UI click / push notification tap), the endpoint hit, the data mutated, and the resulting broadcast / notification. Flows reveal missing endpoints faster than feature-list reviews.',
    '',
    'Write the spec via `spec_write` covering goal, scope, non-goals, the five analysis sections above, and testable acceptance criteria. Every acceptance criterion must cite a specific endpoint, collection, page, or job by NAME — not just describe desired user-facing behavior.',
    '',
    "ARTIFACTS ALONGSIDE THE SPEC: when the user explicitly asks for a visualization (interactive HTML demo, mockup page, schema sketch, etc.), produce it via the `write` / `edit` / `multiedit` tools as part of this step — do NOT fake it through `bash` heredocs or `python_exec` triple-quoted strings. Don't write implementation code in SPEC; the BUILD step implements the design against the real codebase.",
    '',
    'Once the spec exists and any explicitly-requested demo artifact is written, END YOUR TURN. Do not keep working — the orchestrator advances to BUILD on its own.',
  ].join('\n'),
  advanceCriteria:
    'Spec exists with all four sections (goal / scope / non-goals / acceptance criteria) and acceptance criteria are testable.',
  pauseForUserReviewAfter: true,
};

const BUILD_STEP: Step = {
  id: 'build',
  label: 'Build',
  systemPromptTail: [
    'Step: BUILD.',
    'Implement the spec produced in the previous step. Edits + targeted reads only.',
    'Do not re-spec. The spec is fixed at this point.',
    '',
    'THREE-FIX RULE: if you have already cycled BUILD → VERIFY 3 times without resolving the failing tests, STOP iterating on the current direction. End your turn with an explicit statement: "I have tried 3 fix-cycles without success; the bug may be at a different architectural layer than I have targeted. Possible structural causes: [enumerate the alternative directions you have considered]." The orchestrator will route this back for re-spec rather than letting you thrash on the same surface fix.',
  ].join(' '),
  advanceCriteria: 'Implementation matches every acceptance criterion in the spec.',
};

const VERIFY_STEP: Step = {
  id: 'verify',
  label: 'Verify',
  systemPromptTail: [
    'Step: VERIFY.',
    'Run tests, lint, and tsc on touched modules. Fix only regressions caused by the change.',
    'Do not refactor or expand scope.',
    '',
    'RED-GREEN-REVERT-RED-GREEN PROTOCOL: for any test that the user referenced as a regression guard for this change, validate that the test is actually load-bearing for your fix.',
    '(1) Run the test against the current (post-fix) state. Confirm GREEN.',
    '(2) Revert your fix temporarily — `git stash`, or comment out the change.',
    '(3) Re-run the test. It must turn RED, and the failure message must match the symptom your fix addresses. If the test stays GREEN here, the test is NOT testing your fix — it was passing for unrelated reasons. Investigate before claiming completion.',
    '(4) Restore the fix (`git stash pop`, or uncomment) and re-run. Confirm GREEN again.',
    'Skip this protocol only when the change does not affect any user-named test (e.g. pure refactor, doc update).',
  ].join(' '),
  advanceCriteria: 'All gates pass, or only pre-existing failures remain.',
  isTerminal: true,
};

const SPEC_BUILD_VERIFY: Pattern = {
  id: 'spec-build-verify',
  label: 'Spec → Build → Verify',
  description:
    'Non-trivial new behavior or any change with unclear scope. Spec is approved before code is written; verify gates ensure the spec is met.',
  steps: [SPEC_STEP, BUILD_STEP, VERIFY_STEP],
};

const PATTERN_REGISTRY: Record<PatternId, Pattern> = {
  'spec-build-verify': SPEC_BUILD_VERIFY,
};

export function getPattern(id: string): Pattern | undefined {
  return (PATTERN_REGISTRY as Record<string, Pattern>)[id];
}

export { READ_ONLY_TOOL_ALLOWLIST, SPEC_TOOL_ALLOWLIST, READ_ONLY_TOOL_SUFFIXES };
