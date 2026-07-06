# Prove It's a Worthwhile Win — deepseek_v4_pro vs claude-cli

**Date:** 2026-07-06
**Status:** Plan (design + execution steps). The core question behind the whole season.
**Goal:** Quantify whether **ugly-code + deepseek_v4_pro (features on)** matches or beats **claude-cli (Claude Code CLI + its model)** on the eval suite, at lower cost — and isolate *which* of the built features actually move the number. Run both agents in the **same eval harness** for apples-to-apples score/cost/turns.

---

## 0. Why this, and the honest starting point

Everything built this session (SBV pattern engine, python_exec hardening + guard, criteria judge, classifier, comparison harness) is only worth keeping if it demonstrably helps a cheap model compete with the frontier baseline. **So far the only real numbers are on `smoke-trivial-fix` — a one-line fix. That is not evidence of anything.** A trivial task can't distinguish a good harness from a bad one. This plan gets the spread across real tasks, against the actual baseline the season's bet is calibrated on (Claude Code + Sonnet).

The bet (CODING.md North Star): *cheap model + verified evidence + strict harness + targeted tools ≥ frontier model + loose harness, at a fraction of the cost.* This plan is the falsifiable test of it.

---

## 1. The one enabler to build: claude-cli inside the eval CLI

The eval CLI's `runTurn` (`client/cli/taskDriver.ts`) always calls `runClientAgentTurn` (the ugly.bot agent core). To run the baseline, dispatch claude-cli models to the **existing** `runClaudeCliTurn` (`client/studio/agent/claudeCliAgent.ts`), which spawns the local `claude --print --output-format stream-json` on the cloned fixture.

**Why it's small + fair:**
- `runClaudeCliTurn(sessionId, userText, model, emit)` matches `runTurn`'s shape.
- It captures `total_cost_usd` + `messageCount` and writes them via `sessionApi.upsert` — and the eval CLI installs the **fs session store**, so both agents write `costUsd`/`turns` to the *same* `~/.ugly-code/session/<id>/metadata.json` that `readRunTotals` reads. **Uniform metrics, no special-casing.**
- `claude` is on PATH (`/opt/homebrew/bin/claude`) and `~/.claude` is authed in a Claude Code env.

**Task (Plan-1-style, ~1 task):**
```ts
// taskDriver.ts runTurn — dispatch by model
import { isClaudeCliModel, runClaudeCliTurn } from '../studio/agent/claudeCliAgent';
export async function runTurn(sessionId, text, onMsg, selection?) {
  const model = selection?.model;
  if (isClaudeCliModel(model)) return void await runClaudeCliTurn(sessionId, text, model!, onMsg);
  await runClientAgentTurn(sessionId, text, onMsg, selection);
}
```
- Thread `model` into the selection (already partly there via `--model`), and ensure `runEval`'s `--model claude-cli` reaches `runTurn`'s selection.
- **Caveat to verify:** claude-cli ignores `patternMode`/`toolset` (it's the baseline — no SBV/toolset gating applies; those only shape the ugly-code side). Guard against setting eval-mode criteria grading on claude-cli runs.
- **Acceptance:** `ugly-code --eval smoke-trivial-fix --model claude-cli` clones the fixture, runs Claude Code CLI on it, grades, and records score+cost+turns in history — same shape as a deepseek run.

---

## 2. The comparison matrix

Two questions, so two axes of configs. Run each on the **same task set** (§3):

| Config label | model | pattern | toolset | Purpose |
|---|---|---|---|---|
| `claude-cli` | claude-cli | — | — | **The baseline.** Claude Code CLI, its own tools. |
| `deepseek-bare` | deepseek_v4_pro | none | no-python | Cheap model, **features OFF** — the floor. |
| `deepseek-full` | deepseek_v4_pro | auto | default | Cheap model, **features ON** (classifier→SBV when warranted, python_exec, criteria judge in eval mode). |

- **`claude-cli` vs `deepseek-full`** answers the headline: does the harnessed cheap model match the baseline, and at what cost ratio?
- **`deepseek-bare` vs `deepseek-full`** answers the ablation: do *the features* close the gap (or not)? This is the honest one — per Ep 05, pattern shape may not fix capability gaps.
- Optional 4th cell `deepseek-python` (python on, pattern none) to isolate python_exec's contribution specifically (Ep 04).

Spec file (`--compare ep-proof.json`):
```json
{ "tasks": ["<the §3 set>"],
  "configs": [
    { "label": "claude-cli", "model": "claude-cli" },
    { "label": "deepseek-bare", "model": "deepseek_v4_pro", "pattern": "none", "toolset": "no-python" },
    { "label": "deepseek-full", "model": "deepseek_v4_pro", "pattern": "auto" }
  ] }
```

---

## 3. Task selection

Not one task — a **spread across difficulty and kind**, so the result distinguishes harness quality. Start with ~6 (a manageable pre-shoot run), expand toward the season tournament's 11:

| Task | Kind | Why |
|---|---|---|
| `smoke-trivial-fix` | trivial bug | sanity floor — everyone should get it; classifier should skip SBV |
| `breaking-change-find-callers` | find-callers | Ep 04 python pro (AST-walk vs grep) |
| `multi-file-refactor-ordered` | ordered refactor | multi-file coherence; SBV/verify relevance |
| a `feature`/`spec` task (e.g. `todo-app-spec`) | feature | where SBV SPEC-first should help a weak model |
| `sbpro-ansible-ansible-39bd8b99` | SWE-bench-Pro hard | the honest failure beat — the §17.14.3 "pattern doesn't fix capability" case |
| one more mid `bug-fix` with a non-obvious cause | investigate | where the cheap model tends to thrash |

(Full list to finalize against `registry.ts` difficulty + `hasFixture`. SWE-bench-Pro tasks are Python repos — confirm they run without docker in this harness before including.)

---

## 4. Metrics + what "worthwhile" means

The comparison harness already emits **score/scoreMax, cost ($), turns** per cell and renders a scoreboard + persists to `~/.ugly-code/comparisons/` + the history ledger.

**A worthwhile win, stated falsifiably:**
- **Parity-at-fraction:** `deepseek-full` total score ≥ ~90% of `claude-cli`'s, at **< 20% of the cost** (the season's stated <20% target).
- **Features earn their keep:** `deepseek-full` beats `deepseek-bare` on aggregate score *or* cost-per-pass by a margin larger than run-to-run noise. If it doesn't, that's a real finding — cut the features that don't move it (as I already did for 2c/recursive_llm).
- **Per-task story:** where each wins/loses, on tape. The losses (e.g. the ansible SWE-bench-Pro cell) are the honest failure beats.

Cost-per-pass = `cost / score` is the sharper metric than raw cost (it penalizes cheap-but-wrong).

---

## 5. Execution

1. Build §1 (claude-cli dispatch) — ~1 task, unit + a `--model claude-cli` smoke.
2. Write `ep-proof.json` (§2 configs × §3 tasks).
3. `ugly-code --compare ep-proof.json --origin https://code.ugly.bot` — runs the full matrix (N tasks × 3 configs). Budget: real LLM spend on both sides; hard tasks take minutes each. Expect ~20–40 min wall-clock for 6×3.
4. Capture the scoreboard + `--history`; fold the numbers into `app/youtube/EP04_GUIDE.md` / `EP05_GUIDE.md` data sections.
5. **Variance:** LLM runs are non-deterministic. For any cell that's close or surprising, run it **3×** and report median (or all three) — a single run is anecdote, not evidence. The harness makes re-runs cheap to script.

---

## 6. Risks / unknowns (be honest on tape)

- **claude-cli cost attribution:** relies on Claude Code's `total_cost_usd` in its stream-json `result` — verify it's populated (subscription vs API-key billing may report 0). If 0, note the claude cost is "subscription, not per-token" — itself a real point for the episode.
- **claude-cli tool parity:** Claude Code CLI brings its *own* tools (its edit/bash/etc.), not ugly-code's. That's fair (it's the baseline as-shipped), but it means the comparison is "two whole agents," not "same tools, different model." State that explicitly.
- **deepseek pool availability + rate limits** on the ugly.bot proxy; hard tasks may hit budget `maxTurns`.
- **SWE-bench-Pro fixtures** may need docker/python setup the CLI doesn't provide → some cells may be un-runnable; drop or flag them (no silent truncation).
- **Determinism/variance** (above) — the single biggest threat to a credible number.
- **Small-N:** 6 tasks is a pre-shoot probe, not a verdict. The season tournament (11 tasks) is the real claim; this plan is the method, scaled up.

---

## 7. Recommendation

Build §1 (small) and run a **3-task probe** first (`smoke-trivial-fix`, `breaking-change-find-callers`, one hard task) × the 3 configs — cheap, fast, and immediately tells us whether the deepseek-full harness is even in the same league as claude-cli before committing to the full 6–11 task pre-shoot. If the probe shows no life, that's the most important (and most honest) finding, and it should redirect effort away from more features toward the model/tool gaps the numbers expose.
