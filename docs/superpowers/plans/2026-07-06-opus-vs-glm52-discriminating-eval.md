# claude-cli Opus vs GLM 5.2 — Discriminating Eval Plan + Cost Estimate

**Date:** 2026-07-06
**Goal:** Head-to-head **`claude-code:opus` (Claude Code CLI, Opus)** vs **`glm_5_2` (ugly-code, features on)** on tasks selected for *discrimination* — where the cheap pool historically failed vs opus, and/or even opus didn't max. GLM 5.2 is newer than the models in the historical data, so this re-measures whether the gap still holds.

Model ids confirmed: opus = `claude-code:opus` (→ `claude --model opus`); glm = `glm_5_2`. Both already run in the eval CLI (claude-cli dispatch is wired).

---

## 1. Task selection — from CODING.md §16.5 (GRADER_SCORES.csv, 466 runs)

The historical inventory of which tasks separate model tiers ("Cheap" = best across kimi/glm/minimax/deepseek-flash/deepseek-pro):

| Task | Max | Cheap | Sonnet | Opus | Why it discriminates | Runs here? |
|---|---|---|---|---|---|---|
| `bug-fix-ts-error` | 1 | **1** | 1 | **0** | **Opus regresses below cheap** — best "GLM beats Opus" probe | ✅ coarse works (binary) |
| `breaking-change-find-callers` | 2* | **1** | — | **2** | Opus solves, cheap misses a caller (my probe) | ✅ coarse works |
| `boss-chatgpt-clone` | 8 | 6 | 6 | **8** | Opus-only full-stack solver (cheap 6/8) | ⚠ needs granular gates |
| `impossible-lost-updates` | 13 | 10 | 12 | 12 | Even opus < max; adversarial concurrency | ⚠ needs granular gates |
| `impossible-lamport-replay` | 8 | 7 | 7 | 7 | Even opus < max (no separation) | ⚠ needs granular gates |
| `impossible-rrule-iterator` | 9 | **9** | 5 | **9** | Both solve (baseline sanity); sonnet-weak | ⚠ needs granular gates |
| `plan-refactor-store` | 5 | **5** | 2 | **3** | Opus over-engineers, cheap wins | ❌ planning (no code to `npm test`) |
| `spec-multi-round-rate-limited-export` | 16 | 15 | 15 | 14 | Opus < cheap; but 60-turn/$8 budget | ⚠ granular + expensive |
| `sbpro-tutao-tutanota-1ff82aa3` | 5 | 0 | — | 5 | The stub-trap | ❌ SWE-bench-Pro → Docker |

\* `breaking-change-find-callers` has no granular gate; scored /2 here.

**The grading reality (must decide up front):** every candidate has `gates: 0` in ugly-code. The granular graders (`/8`, `/13`) live in the monolith's `eval-bridge` CHECKERS + the cloned repos' `eval/` dirs, **not ported**. So today my harness scores them via the coarse **`tsc + npm test` fallback (out of 2)** = "did it compile + does the test suite pass." That cleanly discriminates **binary** tasks (solved vs not) but *collapses* the partial-credit story (a 6/8 and an 8/8 can both read as 2/2 or both <2).

---

## 2. Two-tier plan

**Tier A — runnable NOW, coarse pass/fail (fast, cheap):**
Tasks where "solved vs not" is the discriminator:
- `bug-fix-ts-error` (Opus historically **fails** → does Opus-CLI still? does GLM 5.2 pass?)
- `breaking-change-find-callers` (Opus solves, cheap missed — does GLM 5.2 close it?)
- `impossible-rrule-iterator` (both should solve — sanity that GLM 5.2 isn't broken)

This 3-task Tier-A answers the sharpest question cheaply: **on tasks with clear model separation, does GLM 5.2 match or beat Opus?** — and it re-tests the one "cheap beats opus" case (`bug-fix-ts-error`).

**Tier B — needs a ~half-day grader port first (granular scores):**
Port the per-task checkers (or invoke each cloned repo's `eval/` suite as a `custom:` gate) so `boss-chatgpt-clone` (/8), `impossible-lost-updates` (/13), `spec-multi-round` (/16) score with real granularity. Only then do these tasks discriminate faithfully. This is where the *interesting* partial-credit story lives (Opus 8/8 vs cheap 6/8), so it's worth doing — but it's a prerequisite, not a same-day run.

**Matrix (both tiers):** 2 configs — `opus` (`model: claude-code:opus`) and `glm-full` (`model: glm_5_2, pattern: auto`). Optional 3rd `glm-bare` (pattern none, no-python) to ablate whether the harness features help *GLM specifically*.

```json
{ "tasks": ["bug-fix-ts-error","breaking-change-find-callers","impossible-rrule-iterator"],
  "configs": [
    { "label": "opus",     "model": "claude-code:opus" },
    { "label": "glm-full", "model": "glm_5_2", "pattern": "auto" }
  ] }
```

---

## 3. Cost estimate

Cost is **Opus-dominated**; GLM 5.2 is per-token-cheap (~$0.001–0.03/task, like deepseek in the probe). Opus cost scales with turns/complexity. Anchors: my probe's claude-cli was $0.13 (trivial) / $0.69 (52-turn find-callers); CODING.md Opus was $1.62 (tutanota) / $2.68 (orm-migration). Per-task budget caps (`maxCostUsd`) bound the worst case.

**Tier A (3 tasks × 2 configs), single run:**

| Task | Budget cap | Opus (est.) | GLM 5.2 (est.) |
|---|---|---|---|
| bug-fix-ts-error | $0.75 | ~$0.25 | ~$0.005 |
| breaking-change-find-callers | $1.00 | ~$0.70 | ~$0.01 |
| impossible-rrule-iterator | $3.00 | ~$1.20 | ~$0.02 |
| **Tier A total (1×)** | — | **~$2.15** | **~$0.04** → **~$2.2/run** |

- **Tier A, 3× runs (variance):** **~$6.5**.
- **Tier B adds** `boss-chatgpt-clone` (~$2.5 Opus), `impossible-lost-updates` (~$1.5), `impossible-lamport-replay` (~$1.2), `spec-multi-round` (~$3–4 Opus, $8 budget). Tier-A+B single run ≈ **~$11–13**; 3× ≈ **~$33–40**. GLM side across all ≈ **<$1**.
- **Absolute worst case** (every Opus cell hits its budget cap, full A+B set): sum of `maxCostUsd` ≈ **~$22.5/run**.

**Two cost caveats to state on tape:**
1. **Opus-via-CLI billing:** Claude Code reports `total_cost_usd`, but on a Max/subscription plan the *marginal* spend may be $0 — the reported figure is the API-equivalent. So "Opus cost" here is a list-price comparison, not necessarily out-of-pocket. (This is itself an episode point.)
2. GLM 5.2 runs on the ugly.bot metered proxy (real per-token spend, tiny).

---

## 4. Recommendation

Run **Tier A (3 tasks × opus vs glm-full, 3×)** first — **~$6.5**, ~30–45 min. It directly answers "does GLM 5.2 match/beat Opus where models separate," re-tests the Opus-regression case, and needs zero new grading work. If GLM 5.2 shows life there, **port the granular graders and run Tier B** for the partial-credit tasks where the real gap (Opus 8/8 vs cheap 6/8) lives — that's the ~half-day investment that makes `boss-chatgpt-clone` / `impossible-*` scoreable and turns this into publishable season evidence.

**Decision needed before running:** accept coarse `/2` pass-fail for Tier A now, or invest in the granular grader port first so *all* tasks (including the partial-credit ones) discriminate properly.
