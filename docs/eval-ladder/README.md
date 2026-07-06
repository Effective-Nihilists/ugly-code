# Eval capability ladder — 5 levels × 5 tasks

A curated ladder over the eval suite: **Level 1 (simple bug fix) → Level 5
(real-world agentic)**, 5 tasks per level. Levels are authored on each task
(`level` field in `client/studio/evals/tasks.json`) and shown as grouped
sections in the Studio eval picker; tasks without an authored level fall back to
the derived `difficulty`.

Grading gets more subjective as you climb: deterministic gates (`tsc` / `vitest`)
at the bottom, LLM-judge (0–5) rubrics at the top. The judge is always the local
`claude --print` critic (`UGLY_GRADER_MODEL`, default `sonnet`), so it is
independent of the model under test — all competitors are judged identically.

## The 25 tasks

| Level                                  | Tasks                                                                                                                                                      |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1 — Simple bug fix**                 | `smoke-trivial-fix`, `bug-fix-null-check`, `bug-fix-ts-error`, `short-numeric-pythagorean-overflow`, `short-regex-email-localpart-strip`                   |
| **2 — Harder bug fix / small feature** | `bug-fix-indirect-cause`, `bug-fix-misleading-stack`, `adversarial-config`, `debug-flaky-async`, `feature-add-endpoint`                                    |
| **3 — Multi-file / discipline**        | `breaking-change-find-callers`, `multi-file-refactor-ordered`, `bug-fix-passes-but-breaks-sibling`, `refactor-preserve-api`, `divergent-strategy-sql-perf` |
| **4 — Agentic long-horizon**           | `agentic-orm-migration-with-trap`, `agentic-stack-trace-lying`, `impossible-rrule-iterator`, `impossible-lost-updates`, `vague-make-nicer`                 |
| **5 — Real-world agentic**             | `sbpro-ansible-ansible-39bd8b99`, `boss-chatgpt-clone`, `l5-large-refactor`, `l5-improve-the-harness`, `l5-build-canvas-game`                              |

L1–L4 and the first two L5 tasks are curated from the existing suite. The three
new L5 fixtures live under `github.com/Effective-Nihilists/`:
`ugly-evals-l5-large-refactor` (behavior-preserving refactor),
`ugly-evals-l5-improve-the-harness` (the "singularity test" — research SOTA +
review this harness → `DESIGN.md`), and `ugly-evals-l5-build-canvas-game` (a
publishable Breakout game — deploy two builds and compare head-to-head).

## Running the round (3-model comparison)

The models under test this round: `claude-code:opus` (local `claude` CLI),
`deepseek_v4_pro`, and `glm_5_2` (both via the ugly.bot proxy). `claude` must be
on `PATH` (it is the Opus agent _and_ the grader for every cell).

Run **one level at a time** to checkpoint score/cost between levels (L4/L5 cells
cost $4–8 each; 25×3 = 75 cells run sequentially):

```bash
ugly-code --compare docs/eval-ladder/level-1.json --origin https://code.ugly.bot --test-user
ugly-code --compare docs/eval-ladder/level-2.json --origin https://code.ugly.bot --test-user
# … level-3, level-4, level-5
```

Or the whole ladder at once:

```bash
ugly-code --compare docs/eval-ladder/ladder-round.json --origin https://code.ugly.bot --test-user
```

Each run prints a `score/max $cost Nturns` scoreboard per task and writes the
full result to `~/.ugly-code/comparisons/comparison-<ts>.json`. Aggregate by
level: report each model's per-level mean (0–5) and the first level where it
drops below threshold ("level reached").

Notes:

- Do **not** pass `--model-mode group`; the research task (`l5-improve-the-harness`)
  needs `web_search`, which is single-mode only. Compare cells are single-model
  anyway.
- `l5-improve-the-harness` relies on the grader seeing the newly-created
  `DESIGN.md` — enabled by the `collectDiff` fix (stages new files before
  diffing) in `client/studio/evals/grader.ts`.
