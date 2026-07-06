# Pattern-engine E2E suite (CLI-driven)

End-to-end verification of the coding-agent **3-axis pattern engine** (Pattern × Model × Permission), driven entirely through the CLI. It doubles as a **harness-improvement instrument**: each assertion is also a signal of where the cheap-model harness needs work (routing misroutes, budget blowouts, cheap-vs-max gaps), following the monolith methodology in `app@HEAD:CODING.md §18`.

Test file: [`tests/unit/cli/pattern-engine-e2e.test.ts`](../tests/unit/cli/pattern-engine-e2e.test.ts).

## Running it

Gated — skipped by default (it makes real, if cheap, model calls against a deployed origin):

```bash
RUN_REAL_SMOKE=1 UGLY_CODE_ORIGIN=<deployed-ugly-code-url> pnpm test pattern-engine-e2e
```

- `RUN_REAL_SMOKE=1` — opt into real model spend.
- `UGLY_CODE_ORIGIN` — the deployed ugly-code URL the CLI drives (`/api/agentTurn`).
- Auth: `~/.ugly-bot/auth.json` (or the CLI `--test-user` path on the origin).
- **Cost control**: every case pins `--model deepseek_v4_flash` (cheapest OSS id; also the aux/pollinator/picker model), so a full matrix run stays inexpensive.

Under the hood each case spawns `ugly-code --eval <task> --json …` and asserts on the structured result (`score`, `scoreMax`, `solved`, `costUsd`, `turns`, `resolvedPattern`, `config`).

## New CLI flags (also usable standalone)

```
ugly-code --eval <task> [--model <id>] [--pattern <id>]
          [--model-mode auto|max|group|single:<id>] [--group-models a,b,c]
          [--toolset <name>] [--json] [--origin <url>] [--token <t>] [--test-user]
```

- `--pattern <id>` — pin a pattern (`spec-build-verify`, `super-spec-build-verify`, `quick-edit`, `investigate-fix`, `super-investigate-fix`, `chat-qa`, `chat-advisory`), or `auto` to route, or `none`.
- `--model-mode` — the model axis: `auto`, `max` (N-peer + picker), `single:<id>`, `group`.
- `--group-models a,b,c` — explicit group/peer pool (implies group mode).
- `--json` — structured output for assertions, incl. `resolvedPattern` (what the classifier chose).

## What it covers (and the harness signal on each)

| Group | Asserts | Harness-improvement signal |
|---|---|---|
| **A. auto routing** | `--pattern auto` resolves each task to the right pattern family | Misroutes (bug→spec, question→edit) = classifier tuning targets (§18.1) |
| **B. per-pattern exec** | pinned pattern runs to a graded result within budget | A pattern that never advances / thrashes = step `advanceCriteria` needs sharpening (§18.4) |
| **C. model axis** | single / max / group each complete + apply a winner | Where `max`/`group` lifts a task the cheap single run fails = cross-pollination payoff (§18.5 A3) |
| (all) | `costUsd` + `turns` within task budget; non-silent run (`turns > 0`) | Budget blowouts / silent 0-tool failures = the guardrails in §18 |

## Using it to improve the harness

1. **Routing** — run group A across many tasks; every case where `resolvedPattern` is outside the expected family is a labeled classifier miss. Feed these back into the `classify.ts` prompt / heuristics.
2. **Cheap-vs-strong gap** — run the same task under `single:deepseek_v4_flash` vs `max`. Tasks the cheap single run fails but `max` solves are the "cross-pollination earns its keep" set worth investing retrieval/prompt effort in (CODING.md §16.5).
3. **Budget discipline** — watch `turns`/`costUsd`; a pattern consistently near `maxTurns` without solving points at a weak step gate.
4. **Extend the matrix** — add `{ task, pattern|model-mode, expect }` rows. Task names come from `client/studio/evals/tasks.json` (59 tasks across `bug-fix` / `feature` / `planning`). Grading is deterministic via the same graders the nightly uses, so "solved" never drifts from the beat-Opus scoreboard.

## Scope notes

- These are session-level, real-money (though cheap) cells — run on demand, not per-PR. The per-PR guardrails are the pure-unit tests: `tests/unit/agent/{patterns,classify,modelAxis}.test.ts`.
- `group` mode currently runs persona peers + picker with one kickoff turn each; the full parent-keyed blackboard + directed `ask_peer`/`answer_peer` coordination is a follow-up.
