# Level 6 — the discriminator suite

Goal: five tasks that push opus / deepseek-v4-pro / GLM 5.2 to their **breaking point**
and actually separate them. L1–L5 saturate (models tie) because the tasks max out AND
the LLM judge adds ±2 noise. L6 fixes both.

## Design principles (apply to every task)

1. **Brutal calibration** — tuned so the strongest model lands ~10–30%, not 100%.
2. **Gradient scoring** — score = fraction of a large hidden suite (mutants killed /
   tests passing / cases compiling), never pass-fail. A 3-point capability gap shows as
   a curve even at a low ceiling.
3. **Deterministic grading only — NO LLM judge.** Hidden tests, mutation kill-rate,
   compile checks, corrected pass_to_pass / fail_to_pass. This is what kills the ±2
   noise that blocked L5 discrimination.
4. **Contamination-resistant** — all fresh-authored, private fixtures (grader + hidden
   faults vendored server-side, SBP-style; never in the model's workspace). Regenerate
   the mutants/spec periodically so a memorized answer never helps. Explicitly NOT
   SWE-bench-derived (retired/contaminated: 76% file-ID from issue text; K-Prize held-out
   tops out at 7.5%).
5. **Every task blends the two chosen axes** — long-horizon endurance + a planted
   adversarial trap (the happy-path solution fails).
6. **Multi-run (3× per model), report mean + spread** — brutal tasks are noisy.
7. **Reward-hacking instrumentation** — detect grader/test tampering, reading hidden
   expected values, or asserting the buggy behavior. Any detected hack → hard cap.

Research basis (2025–26): dimensions ranked by how much they STILL separate frontier
models — (1) test-quality/reward-hacking [grows with capability, contamination-proof],
(2) long-horizon coherence, (3) minimal-diff discipline [~7× spread], (4) hard debugging
[concurrency sub-50%], (5) type-level design [greenfield, no incumbent benchmark].

---

## The five tasks

### L6.1 — `l6-test-suite-mutation` · test quality & reward-hacking  ← START HERE
The #1 discriminator (the only one whose gap grows with capability).
- **Task:** given a module + a precise spec, write a test suite that *proves it correct*.
- **Grade:** run the model's tests against **N hidden mutants** (buggy variants). Score =
  mutation kill-rate (fraction of mutants at least one test fails on). Tests must also all
  pass on the reference impl (else invalid — penalize a suite that "passes" by asserting
  nothing).
- **Adversarial:** ship a pre-existing test that PASSES but asserts buggy behavior — does
  the model notice/fix it? A high score is impossible without catching mutants it was
  never shown.
- **Reward-hacking:** instrument for edits outside the test file, reads of the mutants/
  grader, or vacuous assertions.
- **Why brutal:** frontier mutation scores are 18–34% (TestGenEval). Fresh mutants.

### L6.2 — `l6-endurance-build` · long-horizon coherence
- **Task:** build a small but real system to a precise multi-section spec in one session
  (e.g. a query engine / state machine / wire protocol) where late phases depend on early
  decisions.
- **Grade:** large hidden integration suite; fraction passing.
- **Adversarial:** a planted contradiction — a requirement in a late section conflicts
  with an early one. Does the model detect + resolve, or follow blindly and break?
- **Why brutal:** coherence collapses over 100+ turns (Vending-Bench meltdowns; METR 80%
  horizon ~5× shorter than 50%). Unique trajectory = uncontaminated.

### L6.3 — `l6-surgical-fix` · minimal-diff discipline
- **Task:** fix one specific failing behavior in a sizeable module.
- **Grade:** (fail_to_pass fraction) × (**pass_to_pass survival**) × (inverse diff-size /
  added cyclomatic complexity). Use CORRECTED F2P/P2P labels (UTBoost: raw labels wrong
  ~54%).
- **Adversarial:** the obvious fix location is a decoy; a naive/broad fix breaks M sibling
  tests. Over-editing is punished hard.
- **Why brutal:** crispest per-model spread (~7×: 0.06 vs 0.44 edit-distance; models hit
  90% F2P but 7% P2P).

### L6.4 — `l6-concurrency-debug` · hard / production debugging
- **Task:** a non-deterministic bug (race / ordering-dependent / state leak) with a
  MISLEADING stack trace and sparse logs. Reproduce, root-cause, fix without breaking.
- **Grade:** hidden suite incl. repeated/stress runs to catch flakiness; fraction passing.
  A symptom-masking fix leaves the race → hidden stress test still fails.
- **Adversarial:** the stack trace points at the wrong place; the obvious fix hides the
  symptom.
- **Why brutal:** debug-gym ~52% *with* a debugger; self-debug decays 60–80% in 2–3 tries;
  CONCUR shows frontier models still emit deadlocks/races.

### L6.5 — `l6-type-level-api` · type-safe design (greenfield)
- **Task:** design a type-safe API such that **misuse is a compile error** (advanced
  generics / conditional + mapped types in TS, or trait bounds in Rust).
- **Grade:** hidden set of **should-compile** and **should-NOT-compile** usage cases.
  Score = (valid cases that compile + invalid cases correctly rejected) / total.
- **Adversarial:** some valid-looking usages must be rejected; some odd-looking ones must
  compile — the type boundaries must be exact.
- **Why brutal:** no incumbent benchmark; type-level design is largely unmeasured. Type
  errors already dominate LLM compile failures.

---

## Build order & status

- [x] **L6.1 test-suite-mutation** — BUILT. Fixture `ugly-evals-l6-test-suite-mutation`.
      SCALED (2026-07-10) from an 11-function interval module to a **32-function
      collection/numeric toolkit** (`src/kit.ts`), so the surface is too large to test
      exhaustively in-budget and *prioritisation* becomes the discriminator. **50 mutants
      (31 adversarial) + 9 equivalents** vendored in `evals/l6/mutation.ts`. Calibrated
      offline (scratchpad `build_kit_mutants.py` + `calib3.mjs`, esbuild-transform +
      worker-per-mutant with a timeout): paranoid golden kills 50/50, all 9 equivalents
      survive, a competent happy-path suite kills only **18/50 → 2/5**. `mutationScore`
      gate now passes a per-mutant vitest timeout (a mutant can make the suite a
      synchronous infinite loop vitest cannot interrupt — one hung a run for 30+ min).
- [x] **L6.3 surgical-fix** — BUILT + RUNNING. Fixture `ugly-evals-l6-surgical-fix`
      (billing proration; `roundCents` documents half-away-from-zero, implements
      `Math.round` → under-credits by 1¢). Hidden regression suite vendored in
      `evals/l6/hidden.ts`. New `hiddenTests`, `diffBudget`, `unchanged:` gates.
- [x] **L6.4 concurrency-debug** — BUILT + calibrated. Fixture `ugly-evals-l6-concurrency-debug`
      (async ledger; `transfer` does read-check-write across await points with no
      serialization → concurrent transfers lose/create money and overdraw). The obvious
      per-account-lock fix DEADLOCKS on opposite-direction transfers; only a global lock or
      canonically-ordered per-account locks pass. Hidden stress suite (conservation, no
      overdraft, no deadlock) vendored in `evals/l6/hidden.ts`; `unchanged:src/store.ts` gate
      blocks the desync-the-store cheat. Calibrated: buggy 2/4, naive-lock 2/4 (deadlock),
      correct 4/4. **opus 5/5** — wrote ordered locks AND handled the `from===to` reentrancy
      deadlock I hadn't even tested (107s, $0.52, store unchanged → genuine).
- [x] **l6-spec-conformance (TARIFF-1)** — BUILT + calibrated, the anti-opus flagship.
      Structural diagnosis of why opus 5/5'd everything: full visibility, a trustworthy
      runnable oracle, one critical decision, short horizon. This task inverts all four:
      an INVENTED ~19-section billing spec whose rules deliberately diverge from industry
      convention (training priors hurt), with a normative errata section at the end
      overriding six earlier clauses (E1 per-segment allowances, E2 cap-before-discount,
      E3 top-tier CEIL, E4 TRUNC proration, E5 volume boundary→lower tier, E6 credit ties
      by amount desc). 195 hidden vectors (143 core + 52 interaction) generated from a
      host-side reference impl; fixture ships 13 teaching vectors. floor() ⇒ full gate
      credit needs 100%. Calibrated through the real injected-vitest path: reference 5/5;
      a correct-except-errata "skim" impl 89/143 + 21/52 → **2/5**; every erratum costs
      5–46 vectors. New `hiddenTests:<key>` keyed-suite gate support.
- [x] **l6-compound-incident** — BUILT + calibrated, the misleading-oracle task. One
      symptom (wrong day-2 revenue report), three jointly-necessary causes: stale memo
      keyed by pageSize only (A), paginate drops the last record of every full page (B),
      ingestAll is forEach(async) fire-and-forget (C). The visible repro stays red until
      ALL THREE are fixed — verified across the full 2³ matrix — so a correct single fix
      reads as a failed fix (the incident report says two engineers already reverted
      "failed" fixes). Hidden per-cause probes + non-repro-data e2e give the gradient:
      0–1 causes → 2/5, 2 → 3/5, 3 → 5/5.
- [ ] l6-amnesia-relay — forced context loss across fresh sessions; needs a small
      `freshSessionPerTurn` harness feature. Third breaker if T1/T2 don't land.
- [ ] L6.5 type-level-api
- [ ] add `level: 6` to the ladder + UI grouping; wire per-task multi-run + mean/spread
- [ ] first full L6 round (3 models × 3 runs), report the separation

### Verdict 2 (2026-07-10, evening): opus also beats the structurally anti-opus tasks

Ran the two tasks built from the structural diagnosis. **Opus 5/5 on both.**

- **l6-compound-incident: 5/5** ($0.75, 12 turns, 168s). The misleading-oracle trap never
  fired: opus read all four source files BEFORE running anything, identified all three
  causes statically, and fixed them in one pass — its cache fix (WeakMap per store + record-
  count staleness check) was cleaner than the calibration's canonical fix. Lesson: when
  complete comprehension is achievable in one context read, the trap is dead on arrival.
- **l6-spec-conformance (TARIFF-1): 5/5** ($2.00, 16 turns, 565s). **195/195 hidden vectors,
  independently re-verified outside the grader.** A perfect implementation of an invented
  spec with six errata overrides, where a correct-except-errata impl calibrates to 2/5.
  Opus read the whole spec, honored every erratum, and iterated only against the 13 public
  teaching vectors.

**Sharpened conclusion.** Six L6 tasks, every axis: thoroughness, surgical precision,
concurrency insight, misleading oracle, anti-prior careful reading with a 100%-perfection
bar. All 5/5, all verified genuine. The two structural properties none of these removed are
the two that matter: (1) **full visibility** — every fixture/spec still fit in one working
set; (2) **short horizon** — opus never needed more than 16 turns / 10 minutes. The honest
statement: *we can no longer author a well-specified, single-session, single-context task
that opus 4.8 fails.* Remaining levers are structural, not calibration:
  - **amnesia relay (T3)** — force context loss across sessions; needs `freshSessionPerTurn`
    in the task driver.
  - **scale beyond context** — a generated spec/codebase too large to hold in one working
    set (hundreds of sections / 100k+ LOC), where selective reading must replace complete
    reading.
Meanwhile the new tasks remain strong discriminators DOWN the ladder (skim impl = 2/5,
partial fixes = 2-3/5): running deepseek/glm banks the model separation the scoreboard needs.

### Verdict (2026-07-10): opus passes every single-insight L6 axis at 5/5

Built and calibrated three hard, deterministic, contamination-resistant tasks across the
axes research ranks as frontier weaknesses — **test quality (50/50), minimal-diff surgical
fix (5/5), hard concurrency debugging (5/5, avoiding two deadlock traps)**. Opus aced all
three. A competent-but-weaker suite scores 2/5 on L6.1 and buggy/naive fixes score 2/4 on
L6.4, so these are excellent discriminators **for weaker models** — they just do not put
opus 4.8 in the 10–30% band. Any task that hinges on a single hard insight or on thoroughness,
opus solves. The remaining untried lever is **L6.2 long-horizon endurance**: failure by
accumulated drift over a many-hour build, not a single step — a different failure mode. Next
decision: build L6.2, or run deepseek/glm on L6.1/L6.3/L6.4 to bank the discrimination we have.

### Calibration results — opus, 2026-07-09

The two tasks WORK: deterministic, gradient-scored, and hack-resistant (all three
zero-conditions verified). They are **not yet brutal** — opus is nowhere near the
10–30% target of principle 1.

| run | result | cost | turns |
|---|---|---|---|
| L6.1, 12 mutants, spec listed the invariants | 12/12 killed → 5/5 | $0.55 | 9 |
| L6.1, 22 mutants, invariant checklist removed | 22/22 killed → 5/5 | $0.56 | 10 |
| L6.1, ticket no longer discloses mutation grading | **21/22** killed | $0.82 | 11 |
| L6.3, surgical fix | 1-line fix in the shared chokepoint, own regression test, 2-line diff, hidden suite 8/8 → 5/5 | $0.32 | 11 |

Findings that generalise to the rest of L6:

1. **Do not disclose the grading function.** The first ticket told the agent its suite
   would be mutation-tested. Removing that sentence was the only change that ever moved
   the score. State the engineering goal, never the scoring mechanism.
2. **`round()` was eating the gradient.** `round(4 × 21/22) = 4` → a suite that missed a
   real bug still printed 5/5. Both proportional gates now **floor**. Any task whose
   score is `round(pts × k/n)` is hiding its own signal.
3. **The only mutant that survived was a degenerate-input one** (`clamp` with empty
   bounds). Opus tests stated behaviour exhaustively and skips inputs the spec does not
   name. That is the seam to attack: mutants that only die under degenerate, adversarial,
   or property-based inputs.
4. **Scale is the missing axis.** A ~150-line pure module is tractable for a frontier
   model no matter how many mutants it carries. To reach 10–30%, the mutation target must
   be a large unfamiliar codebase where *choosing what to test* is the hard part — which
   also folds in the "understand very complex codebases" axis.
5. `assistantTurns` never exceeded 11 and cost never exceeded $0.82. Nothing here is
   long-horizon yet; L6.2 endurance remains the untested axis.

### Update — 2026-07-10: scaled L6.1 to 32 functions, opus 5/5 → 4/5 → (rerun in flight)

On the 16-function version opus killed **29/31 → 4/5** (missed only the two deepest
degenerate-input mutants) — near-ceiling. Acting on finding #4, scaled to a **32-function
kit** with 50 mutants concentrated in the corners (empty/single inputs, ties, duplicates,
NaN, negative counts, immutability). Competent happy-path testing scores **18/50 → 2/5**.

**Result: opus killed 50/50 → 5/5.** It wrote a 671-line suite and covered every corner,
including all 31 adversarial mutants. Verified genuine (not timeout-inflated): the whole run —
agent + grading 60 vitest invocations — took 204s (~2s/run), so no 90s timeout ever fired.

**Conclusion: test-writing is NOT the axis that breaks opus.** Established across two versions
(29/31 then 50/50). Opus is exceptional at exhaustive, corner-aware test authoring; scaling the
surface only made it write more tests, not miss more. This task is an excellent discriminator
for *weaker* models (happy-path = 2/5) but will not put opus in the 10–30% band. To actually
fail opus, pivot axis → **L6.4 hard concurrency/debugging** (research: frontier models <50%),
where the bottleneck is reasoning about interleavings, not thoroughness.

Two engineering lessons from the scale-up, both now fixed:
- **A mutant can hang the grader.** `chunk` with a step of `n-1` and `n=1` is a *synchronous*
  infinite loop; vitest's test-timeout can't interrupt sync loops, so `vitest run` hangs
  forever and wedged a grading run for 30+ min. `mutationScore`/`hiddenTests` now pass a
  per-mutant `timeoutMs` (→ `spawnCollect` kill); a timed-out mutant counts as killed.
- **Calibrate before shipping — it catches unfair mutants.** The offline golden/equivalent
  matrix flagged two "mutants" that were actually behaviour-preserving (`lcm ||→&&`,
  `rotate` negative-index via JS `slice`) and they were reclassified as equivalents.
- **Grading is O(mutants) vitest cold-starts** (~50 runs). Under machine load this is minutes;
  calibrate offline with esbuild-transform + a worker-per-mutant, never 50 vitest boots.

Grading lives in `client/studio/evals/` (gate kinds + SBP host-side grader); fixtures at
`github.com/Effective-Nihilists/ugly-evals-l6-*` with hidden faults/grader vendored so they
never enter the agent's workspace.

---

## L6-REAL: real-world evals (pivot 2026-07-10, model=fable)

User critique of the puzzle set: mutation/surgical/concurrency/compound/TARIFF-1 are all "find
the planted trick" — opus 5/5 all. Real programming = build real things + fix real incidents +
harden real code. Mined the actual repos for real-world evals that STILL grade deterministically.

### Family A — Resurrect real production incidents (real debugging, hidden regression tests)
From ugly-code/ugly-studio git history; check out the pre-fix commit, hand the real incident
report, grade with hidden tests derived from the ACTUAL fix. Top "brutal" candidates:
- **send-rpc-instant-abort** (ugly-code 787bc54, pre=2881187): DOUBLE misdirection — the pre-fix
  state contains a plausible recent "fix" that IS the cause; correct fix requires an undocumented
  host-bridge lifecycle invariant that lives OUTSIDE the repo; naive fix reintroduces the original
  bug. This breaks opus's "read everything" pillar because the invariant isn't in the codebase.
- **stale-build-task-reuse** (4d63f0e): "the fix didn't work" but it's fine — stale task never
  restarts onto new build; un-pinned cache fill in a different fn than the reader.
- **stale-task-restart-race** (725c3f7): async race in an unpatchable host taskManager; needs a
  renderer-side workaround + non-obvious listener re-registration.
- **lifetime-turn-budget-stuck** (50712fb): budget bug two layers down in consumed framework; a
  misleading code comment asserts the wrong invariant.
- ugly-studio headless-gradeable: disposed-frame-safesend-crash (isDestroyed() lies), dup-ipc-
  handlers-dead-topbar, releases-range-spa-fallback, perf-snapshots-null-envelope, dock-icon-heal-flood.

### Family B — Build a real product, graded OBJECTIVELY (no judge)
ugly-app ships a deterministic quality surface via `ugly-app/playwright` + `__uglyInspect`:
pageerror/console.error==[], waitForApp (app mounted), overlaps, safe-area violations, route
transitions, native-bridge-contract (installUglyNativeMock), **cross-client-sync (two browser
contexts vs one dev server over /ws)**, static gates (build/tsc/lint counts). Score = fraction of
a 20-30 flow battery + quality gates. This is the "build a game" family with an objective grader.
Caveats found: expectClean temporal checks are ~0ms-windowed (assert on inspectWindow manually);
keyboard.coveredInputs is dead headless; long-tasks/jank are machine-load sensitive (generous budgets).

### Family C — Improve the harness FOR REAL (singularity test, ship code not DESIGN.md)
Graded by whether a WEAK model's deterministic-gate scores rise under the agent's modified harness.
Needs ~2-3 days plumbing (UGLY_HARNESS_DIR dynamic import + N-repeat parallel grading runner +
deterministic-gate filter). 16 concrete unbuilt ideas mined from the 3 L5 DESIGN.md's (syntactic
edit gate, LSP-diagnostics-in-tool-result, nearest-match edit recovery, findings-preserving
compaction, diff-format fallback…). Highest value, highest effort — deferred.

### Family D — Security hardening (real-world, exploit-suite grading) ← BUILDING FIRST
"Acme Notes" service, 12 real vulns / 9 classes (IDOR, SQLi+scope, path traversal abs/encoded, JWT
alg:none, predictable reset token, SSRF literal/encoded/redirect, proto pollution __proto__/
constructor, mass-assignment). Hidden supertest EXPLOIT suite: floor(12 × closed/12), 1pt/vuln.
Public functional suite must stay green with 3 dangerous-looking-but-legit inputs → blanket
denylist "fixes" break functionality. Zero judge gates.
- **Variant A (primed ticket "harden for a security audit")**: strong discriminator, opus ~80%,
  smooth gradient, weaker fleet ~45%.
- **Variant B (UNPRIMED ticket "make it production-ready", never says security)**: the real
  opus-breaker candidate. Evidence (Pearce/Perry/CyberSecEval): models under-secure when not told
  to look. Predicted opus ~5-8/12 exploits. Same fixture, same hidden grade, second ticket only.
  Most realistic too (real audits start from "make this robust"), tests NOTICING not patching-on-command.

---

## Family B (build a real product, objective grading) — BUILT + RUN (2026-07-10)

`l6-build-sokoban`: build a Sokoban game to a spec; graded by a NEW `uxFlows` gate that
builds the app, serves the static client, and plays it in headless chromium — scoring a
hidden 25-flow Playwright battery (board/cell contract, move rules, undo/restart, win
lifecycle, WASD, on-screen controls, level advance) + `__uglyInspect` overlap & safe-area.
Zero LLM judge, no backend. Runner + battery vendored in `evals/l6/uxflows.ts`.

- Validated end-to-end: reference Sokoban in a scaffolded ugly-app = 25/25; empty scaffold ~2/25.
- The runner independently caught a REAL overlapping-controls bug in an existing opus breakout build.
- **opus 25/25** ($3.41, 54 turns, 470s) — a correct, polished Sokoban. First scored 23/25, but
  BOTH misses were grader over-strictness: opus conditionally renders the win banner
  (`{solved && <div data-id=win>}`, idiomatic + spec-compliant), and my "hidden at start" check
  threw on the absent node. Fixed to be render-strategy-agnostic; re-verified opus 25/25.

Sokoban chosen for full determinism (no RNG) so the battery asserts exact board state after
exact key sequences. LESSON: single-reference calibration is insufficient — a second valid
implementation (opus's conditional render) exposed the grader brittleness. Calibrate against
≥2 idiomatically-different correct implementations.

### L6-REAL scoreboard so far (opus)
| task | family | opus | note |
|---|---|---|---|
| l6-security-audit (unprimed) | D security | 19/19 (12/12 exploits) | proactively secured; breaker missed |
| l6-security-hardening (primed) | D security | not yet run | discriminator variant |
| l6-build-sokoban | B build | 25/25 | perfect build; grader now robust + discriminating |

Opus aces every real-world task too. The value delivered: deterministic, judge-free, real-world
graders (exploit-suite + objective browser UX) that discriminate DOWN the fleet and found real
bugs. Remaining breaker candidate: Family A out-of-repo-invariant incident. Family C (harness) unbuilt.

### Family B gradient — CONFIRMED (2026-07-10)
The uxFlows grader discriminates precisely and diagnostically (no LLM judge):
| build | score | notes |
|---|---|---|
| correct reference / opus | 25/25 | perfect |
| reference + 3 realistic defects | **19/25** | failing flows = the exact defects: 4× undo, on-screen restart, overlap |
| empty scaffold | ~2/25 | floor |
The 6 failures on the defective build named exactly the injected bugs (broken undo, overlapping
restart/next, ...) — the grader tells you WHAT broke, not just a number.

### Harness bug found: proxy-model dispatch fails on long-`setup` tasks
glm scored 5/5 on bug-fix-null-check (light fixture) but produced ZERO work on l6-build-sokoban
(HomePage untouched, no dist, no history entry) — twice. opus (local claude CLI) ran the same
task fine. The difference: l6-build-sokoban's `setup` is a full `ugly-app@latest init` scaffold +
`playwright install`, minutes long; the ugly.bot-proxy-dispatched agent turn (glm/deepseek via
runClientAgentTurn) does not survive that setup and never starts, ending at the
"codebaseProvider() called before setCodebaseProvider" indexer warning. FLEET RUNS on scaffold-
setup tasks (build-sokoban, boss-*) are currently blocked for proxy models until this is fixed
(establish the proxy agent connection AFTER setup, or lengthen the pre-turn timeout). Not a
grader bug — the uxFlows grader itself is model-agnostic and works.

---

## Family A (resurrect real incident) — BUILT + RUN — opus 5/5 (2026-07-10)

`l6-resurrect-incident`: distilled the real send-rpc-instant-abort bug (787bc54). The v0.1.101
"fix" made the coding task's onCall fire-and-forget to dodge a task.call timeout bubble; the
vendored host (src/host.js) drives frames only while onCall is pending and finalises on settle,
so fire-and-forget aborts every turn silently. The key invariant lives in the host shim (not the
app logic) — the intended attack on opus's "read everything" pillar. Calibrated 4-way: buggy 1/3,
correct 3/3, naive-re-fix (await but show timeout) 2/3, lazy-swallow-all 2/3. `unchanged:src/host.js`.

**opus 5/5** ($0.90, 19 turns, 210s, host.js untouched, verified 3/3 independently). It reverted
fire-and-forget to await, split error handling to swallow ONLY the benign task.call timeout while
surfacing ensureCodingTask failures, and left a comment *articulating the host invariant it had to
infer* ("the host finalises the task the instant onCall settles"). It read host.js, connected the
finalize-on-resolve behaviour to the fire-and-forget cause, and rejected the incident's misleading
"the fix is live" framing. The out-of-repo property is softened in a self-contained fixture (opus
reads host.js), so it did not break opus — but it is a faithful, hard, real-incident debugging task.

## FINAL VERDICT — L6 (2026-07-10)

Nine+ tasks across every axis and framing: test-quality, minimal-diff, concurrency, spec-conformance,
compound-cause, misleading-oracle, security-hardening (primed + unprimed), objective product-building,
and out-of-repo-invariant debugging. **Opus 4.8 scored 5/5 (or the max) on every single one, all
independently verified.** No well-specified single-session task — puzzle or real-world, single-insight
or multi-trap, invariant in-repo or in a vendored shim — broke it. That is the measured result.

What was actually delivered (more valuable than a lucky breaker): a suite of **deterministic,
judge-free, real-world graders** — mutation kill-rate, hidden regression probes, exploit suites, and
an objective browser-UX flow battery — that discriminate DOWN the fleet (competent/partial attempts
score 2/5) and have caught real bugs (an overlapping-controls defect in an existing opus breakout
build; two of my own unfair mutants; a grader-brittleness exposed by opus's idiomatic conditional
render). Reusable across every future task and model.

Remaining/known: Family C (improve-the-harness-for-real, graded by weak-model uplift) unbuilt — the
one axis (long-horizon uplift, not single-session) still untried. Harness bug: proxy-model dispatch
fails on long-`setup` scaffold tasks, blocking glm/deepseek fleet runs on build-sokoban until fixed.

---

## HARNESS STABILIZATION (2026-07-11) — two proxy-model eval bugs fixed; fleet numbers were artifacts

Every prior glm/deepseek eval result was invalid due to TWO bugs that only hit the proxy-model
(client-agent) path, never the claude-cli (opus) path:
1. **bootDriver never installed the codebase provider.** After 78cad4d dropped the host fallback +
   1a5a94c routed grep/readiness through codebaseProvider(), the client agent threw at boot →
   0 work, no history, exit 0 (silent). Fix: bootDriver installs localCodebaseProvider like coding-task.
2. **eval graded the base project dir, but the client agent worked in a git worktree.** deepseek
   fully SOLVED bug-fix-null-check (correct fix, tests green) but scored 0/5 because its edits were in
   `.ugly-studio/worktrees/<session>/`, invisible to the grader. Fix: eval forces `branchMode: 'main'`.

**Verified with deepseek_v4_pro (harness now stable):**
| task | grader | before fix | after fix |
|---|---|---|---|
| bug-fix-null-check | vitest gates | 0/5 (solved, worktree) | **5/5** ($0.001) |
| l6-resurrect-incident | hiddenTests (3 probes) | (dispatch dead) | **5/5** ($0.009, correct fix) |

**Big implication:** deepseek matches opus (5/5, 5/5) on these two. The "opus dominates the fleet"
premise was PARTLY a broken-harness artifact — proxy models were scored 0 for work they actually did.
Real discrimination requires re-running the fleet on the fixed harness. Per cost discipline: deepseek
only for now; glm paused. Graders proven with a proxy model so far: vitest, hiddenTests. Still to
prove: mutationScore, uxFlows (needs the fixed dispatch on the scaffold task).

### First TRUSTWORTHY discrimination (2026-07-11, fixed harness, deepseek verified)
| task | grader | opus | deepseek | note |
|---|---|---|---|---|
| bug-fix-null-check | vitest | 5/5 | 5/5 | tie |
| l6-resurrect-incident | hiddenTests | 5/5 | 5/5 | deepseek solved the double-misdirection too |
| l6-test-suite-mutation | mutationScore | 5/5 (50/50) | **4/5 (48/50)** | deepseek missed clamp-throw + takewhile-stop; equivalents clean (no cheat) |

deepseek is genuinely strong — near-opus. The finest-grained grader (mutationScore, 50-mutant gradient)
is what surfaces the gap: opus writes a more thorough suite (all 50) vs deepseek's 48. This is exactly
the deterministic, verified, per-point discrimination the L6 suite was built for. Graders proven with a
proxy model: vitest, hiddenTests, mutationScore. Last to prove: uxFlows.
