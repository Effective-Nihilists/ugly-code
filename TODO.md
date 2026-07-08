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

- [ ] **L6.1 test-suite-mutation** — fixture (module + spec + hidden mutants + bait test)
      + deterministic mutation-kill grader + task def → run on claude / glm / deepseek. ← in progress
- [ ] L6.2 endurance-build
- [ ] L6.3 surgical-fix
- [ ] L6.4 concurrency-debug
- [ ] L6.5 type-level-api
- [ ] add `level: 6` to the ladder + UI grouping; wire per-task multi-run + mean/spread
- [ ] first full L6 round (3 models × 3 runs), report the separation

Grading lives in `client/studio/evals/` (gate kinds + SBP host-side grader); fixtures at
`github.com/Effective-Nihilists/ugly-evals-l6-*` with hidden faults/grader vendored so they
never enter the agent's workspace.
