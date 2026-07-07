# Coding-harness improvement backlog

Ideas mined from the `l5-improve-the-harness` eval (opus / deepseek / glm DESIGN.md's,
2026-07) — the "can the agent improve itself" task. Every item is grounded in a real
`file:line` the models found; each item's first step is **verify the citation against
current code**, then implement.

**Status legend:** ✅ built · ⏳ backlog · ⛔ skipped (deferred by decision)

**The virtuous cycle:** each item removes a real weakness, so the next
`l5-improve-the-harness` run has less low-hanging fruit — the task becomes a sharper
frontier discriminator. Re-run the eval ×3 after each batch and watch the ~9–10 mean
drop toward a spread; that drop is the progress metric.

Effort: XS (<1h) · S (hours) · M (1–2d) · L (>2d). "(3×)" = all three models flagged it.

---

## ✅ Phase 1 — Execution feedback loop  (BUILT — see below)

All three models' #1 finding: the agent loop has **no mid-turn verification** — a failed
edit/build returns a string and the model is *trusted* to react; the only real gate is
the Finish pipeline, which runs on explicit "Finish," never in the loop. This is why
deepseek shipped a non-compiling game and glm shipped one that crashes on play.

Built: a universal turn-end verify gate (`runAgent` `onSettle` hook + `resolveVerifyGate`)
that runs the project's typecheck when the model tries to end a turn after edits, injects
failures back, and keeps the turn going until it's clean (capped). Plus head+tail bash
truncation so test/compile errors (at the tail) are no longer cut. See "Universality" below.

---

## ⏳ Phase 2 — Quick wins (backlog)

- **Nearest-match on `edit` miss (3×).** S. `agent/tools/applyEdit.ts:61` — on `old_string`
  not found, return the Levenshtein-closest line instead of a dead "not found."
- **Return a unified diff from `edit` (3×).** S. Replace "Edited foo.ts" with a small
  context diff so the model verifies without a re-read.
- **Syntactic gate on edit/multiedit/write.** S. Reject an edit that makes a known
  language un-parseable before applying (catches duplicate-`const`-class breaks at write).
- **Reconcile "iter 15" with maxTurns 12.** XS. `shared/agent.ts:294` promises 15
  iterations; the loop caps at 12. *(Verified.)*
- **`multiAgent` default — evaluate.** XS decision. `agent/tools/gating.ts:48` is `false`.
- **Judge missing-verdict → `unknown` not fail; repair `parseClassifier`/`extractJsonArray`.** XS.

## ⏳ Phase 3 — Compaction keeps *findings*, not just turns (P1, 3×)

`clientAgent.ts:396-470` — tool results capped at 900 chars, one summary blob.
- **Importance-tag tool results before compaction.** M (test_failure / file_read /
  edit_applied / exploration; weight the budget).
- **Token-aware `keepRecentTurns`.** S (it's a fixed turn count today).
- **Persistent `<findings>` block across compactions.** M — wire the existing `scratchpad`
  tool in as external memory, pinned like `taskText`.

## ⛔ Phase 4 — Multi-model orchestration (SKIPPED — deferred by decision)

Not being built for now. Recorded for later:
- Execution-gated winner selection (run the picker's winner in a worktree + test it).
- Rotate the picker model out of its own candidate pool (self-family bias, `picker.ts`).
- Make `git apply --reject` loud — `applyWinnerDiff` silently drops rejected hunks.

## ⏳ Phase 5 — LSP / prompt / tooling (backlog)

- **Auto-inject LSP diagnostics after `.ts/.tsx` edits (3×).** S — `grep mode=lsp-diagnostics`
  is <100ms; append to the system prompt on dirty files (a faster twin of Phase 1).
- **`lsp_rename` tool + findReferences edit pre-flight.** M — refactors complete by
  construction instead of grep-and-miss.
- **Python LSP.** S — `resolveLspSpawn` returns null for Python.
- **System-prompt corrections.** S — repro-first for bug-fix; allow verifying multi-file
  refactors; drop `sed -i` (bypasses dirty-tracking/LSP); few-shot examples.
- **Adaptive bash timeout + retry.** S — fixed 120s is both too long and too short.
- **Delegate results structured + diff-returning + budget-scaled.** M.
- **Todos wired into the loop.** S — inject current todos into the prompt; stagnation nudge;
  turn-end "N incomplete todos" reminder.
- **Finish pipeline: parallel gates + feed failures back to the agent.** S.

---

## Universality of the execution feedback loop (Phase 1)

The loop is **language-agnostic**: it runs *a verify command* and feeds the result back —
it never hardcodes a language. Language-specificity lives entirely in `resolveVerifyGate`,
a tiered resolver (`studio-agent/finish/languages.ts`):

1. **Project-declared command (universal, any language).** Prefer the project's own
   `typecheck` / `test` / `check` / `build` script (package.json), or a `Makefile` /
   `justfile` target. A Rust or Go project that declares how it verifies itself Just Works.
2. **Language adapter (canonical per-language).** Node→`tsc --noEmit`, Python→`pyright`/`mypy`.
   Adding a language = adding an adapter, *not* touching the loop. Today: Node + Python.
3. **LSP diagnostics (protocol-universal fast-path).** Any language with a configured LSP
   server (Phase 5 item).

**Graceful degradation:** if no verify command resolves for a project, the gate returns
null and the turn ends normally — an unknown language is never blocked, it just isn't
verified. So this is **not** a ts/js/python-only feature; those are the best-supported
adapters today, and every other language is covered the moment it either declares a verify
script (tier 1) or gets an adapter (tier 2).
