---
name: eval-swarm
description: Use when you want realistic users to stress-test an existing ugly-app product's real features and file genuine feedback — spins up persona subagents that drive real (user-billed) AI against seeded data, on any app in the fleet.
user-invocable: true
---

# Eval Swarm

Point a swarm of realistic **user personas** at an existing ugly-app product. Each persona
drives the app's **real features** with the **real, user-billed AI** (no stubs, no fakes),
actually looks at what came back, and files honest feedback about whether the tool works.

The orchestrator (you) creates the accounts, dispatches the personas as subagents, and
aggregates their findings into one ranked list you can hand to `/fix-feedback`.

**This is not `bot-swarm`.** `bot-swarm` evolves a *blank canvas* — it invents what to
build and demands ambitious redesigns. Eval-swarm evaluates a *finished product*: does
this real feature, on real data, actually work for a real user? Personas here are graders,
not art directors. If you are staring at a blank template, you want `bot-swarm`.

## When to use

- You shipped a feature and want to know if it holds up under real, varied usage.
- You want fleet-wide, repeatable "does this tool actually work?" feedback for any app.
- You want genuine bugs/UX gaps surfaced by usage, not a lint pass.

**When NOT to use:** blank-canvas invention (`bot-swarm`); a single scripted regression
check (`verify:e2e` / Playwright specs); anything that must be free/hermetic (this run
spends real AI tokens billed to your account — see Billing).

## Core principle

**Feedback is only worth as much as the usage behind it.** A persona that did not run
the real feature, on real data, and *see* the result with its own eyes produces
imagination — dead weight that pollutes the signal. Every guardrail below exists to keep
each finding anchored to something the persona actually did and saw.

**Corollary — grade the OUTCOME, never the UI's self-report.** A green check, a "done"
status, and a completed turn are claims by the thing under test; they are not evidence.
Assert ground truth outside the app: read the file on disk, query the row, diff the repo.
An app that politely tells you it did nothing still renders as success — that exact hole
let five ugly-code rounds score a coding agent that could not search (see Step 0.6). When
a persona's goal implies a durable change, the verdict must be checked against that
change, not against the transcript describing it.

---

## Billing

`auth:create-bot` now creates **owner-billed** test accounts: every persona's AI spend
is charged to *your* (the caller's) ugly.bot account via `billToUserId`, not to a fake
free tier. This run costs real money. Keep persona count and per-persona action budgets
modest (3–5 personas, ~10–20 AI calls each is plenty).

**Cost lever:** the only way to reduce per-call cost is a cheap-model override the app
honors — and it must be set as an **env var on the `ugly-app dev` process** (e.g. ugly-ink
reads `INK_FORCE_MODEL=deepseek_v4_flash`). There is no generic override: if the app's
`bots/eval-swarm.json` doesn't declare a `model` var, cost control is unavailable and the
run proceeds at full production-model price. Don't guess a var name — an unrecognized env
var silently does nothing.

---

## Step 0 — Preflight (fail fast, no workarounds)

Run these checks first. **If any fails, STOP and report the exact fix to the user** —
do not try to route around it. A swarm launched against a broken environment produces
fake findings, which is worse than no findings.

1. **In an ugly-app project?** `npx ugly-app url` must succeed. If it errors, you are not
   in an ugly-app child app — stop.

2. **Host is agent-ready?** Run `npx ugly-app doctor`. Read the bottom line:
   - `agent-ready: yes` → continue.
   - `agent-ready: no — ...` → STOP. The usual cause is no global user token; the fix is
     `npx ugly-app login`, which opens a browser and **cannot** complete from a headless
     agent. Surface the reason and end the run. Do not loop on `login`.

3. **Playwright available?** `pnpm exec playwright --version` must succeed, and chromium
   must be installed (`pnpm exec playwright install chromium` if the persona launch later
   errors with a missing-browser message). Playwright is not a framework guarantee — some
   child apps don't ship it. If the package is absent, STOP and tell the user to add it;
   personas cannot drive the app without a browser.

4. **Test-account op is deployed?** Create your first persona account early as the smoke
   test — reuse it in Step 3, don't throw it away (there is **no delete** for these bot
   accounts; an idle one bills nothing, so just keep it):
   `npx ugly-app auth:create-bot --slug <first-persona-slug> --name "<Name>"`.
   - Success (JSON with `userId`/`token`/`email`) → the op is live; continue.
   - `unknown op` / non-JSON error → the target ugly.bot backend predates
     `appTestAccountCreate`. STOP and tell the user the backend needs redeploying.

5. **Dev server up (no watchers)?** `npx ugly-app dev` is a **long-lived foreground
   process that never returns** — launch it **in the background** (Bash `run_in_background`)
   with any cost-control env var prepended (see Billing), NOT `--watch` (the swarm reads a
   stable build). Then poll `$(npx ugly-app url)` until it answers.

6. **Does the app's machinery actually WORK, or just not crash?** A broken environment
   usually announces itself; a **silently degraded** one does not, and that is the
   dangerous case — the run completes, every check is green, and the rating is fiction.
   Before dispatching, prove each capability the personas will exercise is *live*, not
   merely present: run the smallest real operation and look at its output.
   - **Real precedent:** ugly-code evals ran five rounds and earned ★★★★★ while the coding
     agent's `glob`/`grep` were **dead** — `rg` was missing from the task child's PATH, the
     failed spawn rendered as a green "no matches" card, and the agent concluded each
     project was empty. Nothing errored. The harness now refuses to start when a required
     binary is unresolvable (`assertAgentToolchain`) — **prefer a preflight that makes the
     harness refuse over one that warns.**
   - Generalize it: if the app shells out to a binary, resolve it; if it depends on an
     index/model/migration, query it for a known-present row. "It returned successfully"
     is not evidence — "it returned the thing I planted" is.

Store `BASE_URL="$(npx ugly-app url)"` for the run. Everything the swarm reads and writes
lives on **this local server** — the framework read CLIs (`ugly-app feedback`, `errors`,
`logs`) query **prod**, not local, so don't use them to inspect the run.

### Local vs. prod target

Default to **local** (above) — it isolates the run and tests your current checkout. But
target **prod** (`BASE_URL=https://<app-domain>`, skip step 5's dev server) when the app is
**consume-heavy and the data only exists in prod** — e.g. a corpus/search app whose local
DB is empty, where every consume-persona would fail Step 2. Only the user can OK a prod run
(real users' app, real feedback queue). When you do run against prod:
- **Verify auth first:** load `$BASE_URL` in Playwright with a bot's `auth_token` cookie and
  confirm the app renders authed (not a login page) before dispatching — an SSO app may not
  honor the cookie, which would waste the whole (billed) swarm.
- **Tag feedback:** `feedback:submit` writes to the **real** prod queue that `ugly-app
  feedback` / `/fix-feedback` read. Have every persona prefix its message with `[eval-swarm]`
  so synthetic findings are filterable from genuine user feedback. (Upside vs. local: the
  fixer *can* read these — no in-context handoff needed.)
- You're testing the **deployed** build, not your checkout — deploy first if you want your
  latest changes evaluated.

---

## Step 1 — Design the personas (grounded in THIS app)

Do not use a stock roster. Open the app and design personas around what it actually does.

1. Browse `BASE_URL` (see Screenshot recipe) and read the app's real feature list —
   `shared/pages.ts`, `shared/api.ts`, and the top-level UI. Identify the 3–6 features a
   real user would actually come here to use (the AI-bearing ones matter most — those are
   the ones with something to get wrong).

2. Invent **3–5 personas**, each with a distinct *goal* and *tolerance*, that between them
   exercise those real features. Vary the axis that matters for THIS app (a writing tool:
   plotter vs. pantser vs. translator; a fitness app: rehab vs. bulk vs. casual). Two
   personas with the same goal is one wasted (billed) slot.

3. For each persona classify its data need:
   - **create-persona** — its usage *generates* the data (a writer starting a story). No
     seed required; the act of creating is itself the test.
   - **consume-persona** — it needs *existing* data to work on (a reader needs a
     manuscript; a coach-user needs a draft). Requires seed — see Step 2.

4. **Always include a first-run newcomer.** One persona must arrive COLD — has never used
   the app — and judge the ONBOARDING itself: landing → creating / opening the first project
   → writing the **first prompt** → seeing the first result. This cold-start is the
   make-or-break moment for adoption (a powerful tool that's confusing to *start* loses users
   at the door) and it's the single thing builders are most blind to. Have them narrate every
   hesitation out loud — "what do I click?", "what do I type here?", "wait, did that even
   work?" — and screenshot each dead-end.

Vary **UX tolerance** as a real axis, not just goals: an impatient newcomer who bails at the
first confusion surfaces different problems than a patient power user who pushes through
friction. The gap between their verdicts IS your ease-of-use signal — design at least two
personas whose *patience* differs, not just their task.

5. **Pick each persona's `device`: `desktop` | `ios` | `android`.** These apps ship to
   phones, where a whole class of bugs lives that a desktop viewport never shows — content
   bleeding under the notch/status bar, a docked composer or CTA hidden under the
   home-indicator, an input covered by the on-screen keyboard. A desktop-only swarm is
   **blind** to all of it. So give **at least two personas a mobile device** — the cold-start
   newcomer especially (first-run pain is worst on a phone), plus one persona whose goal leans
   on a text input / composer (the keyboard-overlap case). Mobile costs the same AI spend as
   desktop; it only changes the viewport and screenshots. A mobile persona runs the **Mobile
   safe-area + keyboard pass** in its contract (Step 3).

Write each persona as a short brief you will hand to its subagent: who they are, their
goal for this session, the exact features they should exercise, and what would make them
say "this tool works" vs. "this is broken" — AND what would make them say "this felt
effortless" vs. "I nearly gave up."

*(Optional repeatability: an app may ship `bots/eval-swarm.json` — `{ personas, seed,
model }`. If present, use it instead of inventing. See Config.)*

---

## Step 2 — Create accounts + verify data readiness

**Accounts (all personas):** for each persona,
`npx ugly-app auth:create-bot --slug <slug> --name "<Name>"`.
Save the JSON output — `{ userId, token, email }`. The `token` is the persona's session
JWT; the subagent presents it as the `auth_token` cookie to drive the app as that user.

**Data readiness (consume-personas only) — FAIL if not ready.** Before dispatching a
consume-persona, confirm the data it needs already exists **on the local server**. Check
it by loading the relevant page/list endpoint against `$BASE_URL` as that account (its
`auth_token` cookie) and confirming it is non-empty — **not** via `ugly-app feedback`/
`errors`, which read prod and will lie about the local DB the personas actually use. If
the data is absent:

> **STOP the run for that persona and report:** "Consume-persona `<slug>` needs
> `<what data>` but the app has none. Seed it first, then re-run." Name the app's seed
> path if one exists (`bots/seed*.mjs`, a documented seeder), or state that a seeder must
> be built. **Do not** have the persona limp along on an empty app and file "there's
> nothing here" as a finding — that is a setup failure masquerading as feedback.

This skill deliberately ships no seeder. A clean, specific failure here is the signal that
tells you (or the coding agent) exactly what data to set up.

---

## Step 3 — Dispatch persona subagents (parallel)

Dispatch **one subagent per persona, in parallel** (single message, multiple Agent
calls). Never batch-author findings for several personas in one pass — that is the exact
shortcut that produces imagination instead of usage. Give each subagent this contract:

> You are **<Persona Name>**: <one-line brief>. Your goal this session: <goal>.
> Base URL: `<BASE_URL>`. Your account token: `<token>`. Your device: `<desktop|ios|android>`.
>
> **Authenticate**, then actually use the product to pursue your goal:
> 1. In headless Chromium (`pnpm exec playwright` / the Playwright MCP if available):
>    - **`desktop`** → set cookie `auth_token=<token>` for `<BASE_URL>`, then `goto` the app.
>    - **`ios` / `android`** → drive a real phone frame. In a `.mjs` script inside the app dir
>      (`import { createMobileBotPage, raiseKeyboard, dismissKeyboard, waitForApp, expectClean }
>      from 'ugly-app/playwright'`), do
>      `const page = await createMobileBotPage(browser, '<token>', '<ios|android>')` — it sets a
>      phone viewport (390×844 iOS / 360×780 Android), touch emulation, and injects the top +
>      bottom device safe-area so the layout pads for real. `goto` **`<BASE_URL>/?debugSafeArea=true`**
>      so the red top / blue bottom / green keyboard bands render for your vision pass.
>    - Either way, wait for the hydration selector `<WAIT_SEL>` (see Screenshot recipe), never
>      `networkidle`. (If `ugly-app/playwright` lacks `createMobileBotPage`, the app is on an old
>      `ugly-app` — tell the orchestrator to bump it; do NOT fall back to a desktop viewport and
>      call it a mobile run.)
> 2. Drive the real features toward your goal. **Trigger the real AI** — generate, coach,
>    extract, chat, whatever this app does — and **wait for real responses**. This spends
>    real (owner-billed) tokens; that is expected. Budget ~10–20 AI interactions.
> 3. **SEE what happened.** Screenshot each meaningful state and inspect it with vision
>    (Read the PNG, or `analyze_image` if available) before judging it. A finding written
>    without a logged look at the thing you are critiquing is invalid — discard it.
> 4. Judge as your persona: did the feature do what you came for? Was the AI output good,
>    wrong, empty, slow, truncated, off-tone? Was anything broken, confusing, or missing?
> 5. **Judge the EXPERIENCE, not just the output.** Beyond "did it work": at each step, was it
>    obvious what to do next? Where did you hesitate, backtrack, misread a control, hunt for a
>    button, or feel lost? What did the app assume you already knew? What (if anything)
>    delighted you? Ease-of-use is a first-class finding — a feature that *works* but is
>    confusing to reach is still a real problem worth ranking (`type: 'design'`). Narrate this
>    in the user's own voice. **If you are the newcomer, walk the FULL cold start** — first
>    screen → create/open a project → write the first prompt → first result — and log every
>    friction point with a screenshot; that onboarding narrative is your most valuable output.
> 6. **Mobile safe-area + keyboard pass (only if your `device` is `ios`/`android`).** A phone
>    clips content the desktop layout never does. At each key screen you visit, judge these
>    states — screenshot and LOOK at each against the debug bands:
>    - **Top (notch / status bar):** is the header, back button, or top nav clear of the red
>      top band, or does it hide under it?
>    - **Bottom (home-indicator):** is a docked composer, send button, tab bar, or primary CTA
>      clear of the blue bottom band, or clipped by it?
>    - **Reachability:** for anything clickable that DOES sit in the top/bottom band — can you
>      scroll it clear to tap it, or is it stuck there (a fixed/sticky control jammed under the
>      notch/home-indicator is a real bug: permanently untappable)?
>    - **Seamless background:** does the strip under the notch/home-indicator show the SAME
>      background as the content, or an ugly bare white/black box at the very top/bottom edge?
>    - **Keyboard open:** focus the main text input, then `await raiseKeyboard(page, '<ios|android>')`.
>      Is the **focused** input — and its Send/submit button — still visible above the green
>      keyboard band, or hidden behind it? (`await dismissKeyboard(page)` when done.)
>    Then get the **hard signal**: `await expectClean(page, { allowSafeAreaViolations: false,
>    allowSafeAreaSeams: false, allowKeyboardCoverage: false, allowFocusedInputCovered: false })`.
>    It throws listing any interactive element crossing a safe-area edge (`safeAreaViolations`,
>    flagged `UNREACHABLE` when it can't be scrolled clear), a background seam (`safeAreaSeams`),
>    an input under the keyboard (`keyboard.coveredInputs`), or — worst — the focused element
>    hidden behind the keyboard (`focused input hidden behind keyboard`). Quote those selectors as
>    evidence. File each as `--type design`; a clipped/unreachable/covered control or a seam on a
>    **core** flow is high-severity (it caps the rating — see rubric), not a nit.
>
>    **Shortcut — the runtime auditor already logs these.** On a mobile device the framework
>    auto-detects all of the above and emits `console.error('[ugly.ux] …')` (→ the app's error
>    telemetry). So after driving a screen, also read the browser console for `[ugly.ux]` lines —
>    they name the exact selector and defect with zero extra work. (`ugly-app errors` surfaces the
>    same lines from real users' sessions.)
>
> **File each real finding** with
> `npx ugly-app feedback:submit --type <bug|design|feature> --message "<what you did →
> what you saw → why it's wrong>" --token <token> --url <page>`. Every message must name
> the concrete thing you did and saw. UX-friction findings are `--type design`.
>
> **Return to me** a JSON object as your final message (data for aggregation, not a human
> report):
> `{ findings: [{type, severity, feature, message, evidence}], ease: <1–5, how effortless was
> it to get what you came for>, firstRun: "<one-paragraph narrative of the onboarding + first-
> prompt experience, every hesitation named>", friction: ["<a moment you felt lost/confused/
> slowed>", …], delight: ["<anything that felt genuinely good>", …], verdict: "<does this tool
> work for you — AND did it feel good to use?>" }`. Findings must include design/UX friction
> (`type:'design'`), not only functional bugs. If your device is mobile, add
> `mobile: { device, safeAreaViolations: [...], unreachable: [...], seams: [...],
> keyboardCoveredInputs: [...], focusedCovered: "<selector or null>", uglyUxErrors: ["<any
> [ugly.ux] console.error lines>"], verdict: "<did the phone layout hold up?>" }` from your
> Mobile pass.

**Guardrails to state in every dispatch:**
- **A mobile persona that never checked safe-area or the keyboard did not do its job.** A phone
  run whose findings are all desktop-shaped (no notch / home-indicator / keyboard-overlap check)
  wasted the slot — run the Mobile pass and report `expectClean`'s result, even if it's clean.
- Real AI only. If you find yourself imagining a response instead of waiting for one, stop
  and actually run the feature.
- Vision before verdict. No finding about a screen you did not look at.
- Ground every message in "I did X, I saw Y." Vague wishes ("would be nice if…") that
  could have been written without opening the app are noise — cut them.
- **Green is a claim, not a result.** When your goal implies a durable change (a file
  edited, a row written, a doc saved), verify it OUTSIDE the app — read the file, query
  the row — before crediting it. If the app reports success and the change isn't there,
  that is a **blocker**, and it's the single most valuable finding you can file.
- **"There's nothing here" is a red flag, not a finding.** If the app claims the data you
  planted doesn't exist, suspect your environment before believing it (Step 0.6): a
  silently dead dependency looks exactly like an empty app. Report it as a possible
  harness failure so the orchestrator can check — don't grade the app on it.

Timeout ~20 min per persona. A persona that fails or times out does not block the others;
record which succeeded.

---

## Step 4 — Aggregate + present

The **authoritative output is the ranked list you build in-context** from the subagents'
returned findings arrays — that is the deliverable. (`feedback:submit` also logged each
finding to the **local** dev DB with its screenshot attached, but note: the shipped
`/fix-feedback` and `ugly-app feedback` read **prod**, so they will *not* see these local
rows. Don't hand off by telling a fixer to "go read the feedback" — it can't.)

1. Collect every subagent's returned findings array.
2. **Dedupe** across personas — the same real bug reported by three personas is one
   finding with three witnesses (note the corroboration; it raises severity).
3. **Rank** by severity × corroboration: broken features first, then wrong/empty AI
   output, then UX friction, then wishes.
4. Present one ranked list: for each item — feature, severity, how many personas hit it,
   the sharpest one-line evidence, and the persona verdicts (did the tool work?).
5. **Synthesize the EXPERIENCE, separately from the bug list.** Report the average `ease`
   score and its spread (a wide gap between the impatient and the patient persona is itself a
   finding — it means the app only works if you already know it). Give a short **first-run
   digest**: the friction points every newcomer hit walking new-project → first-prompt →
   first-result, plus anything that delighted. Onboarding friction rarely files as a "bug" but
   is the #1 reason a new user leaves — surface it as prominently as the top functional finding.
6. **Rate the product 1–5 stars** (see rubric) with a one-line justification. Lead the
   presentation with the rating — it is the headline the user wants; the ranked list is the
   evidence behind it.
7. Hand off the ranked list **as content** for fixing — either fix the items directly in
   this session, or paste the list into a `/fix-feedback`-style pass (using its ambition
   policy), since the fixer cannot pull these local rows itself.

**A persona reports a SYMPTOM; you diagnose the CAUSE before fixing.** "Exact search
returns only one book" is a symptom — the cause was an FTS index the D1 cutover never
backfilled (72k fragments, only the newest book indexed), found by querying prod D1
directly (`wrangler d1 execute … "SELECT count(*) FROM <c>_fts"`), not by reading the UI.
Root-cause at the data/infra layer (indexes, migrations, provisioning, backfills) before
touching surface code — several personas' separate complaints often trace to one cause,
and patching the surface leaves it broken.

### Iterating to a target rating (fix → re-run)

Eval-swarm is a *loop*, not a one-shot: run → rate → fix → re-run → confirm the rating
moved. That's how a product climbs from ★★★ to ★★★★★.

- **Reuse the same bot accounts across rounds.** They don't delete and idle ones bill
  nothing; a re-run just re-drives the app with fresh chats ("New chat"), so you don't
  mint (and pay to warm) a new roster each round.
- **Keep the round-N+1 goals the same** (don't tell personas "we fixed X, confirm it") —
  their existing goals naturally re-exercise the fixed areas, and a fresh, unbiased
  verdict is the honest signal. The rigorous persona's re-verification is the one that
  actually moves the rating.
- **Deploy before re-running a prod-target swarm** — personas test the *deployed* build,
  so a fix that's only committed won't show. (Data/index fixes like a backfill are live
  immediately; code fixes need a deploy.)
- **Track the trajectory**: report round N's rating, the ceiling finding, what you fixed,
  and round N+1's rating. The ceiling finding is your fix list — clear it and the next
  round's ceiling rises.
- **A billed re-run is the user's call.** After fixing, you may have *directly verified*
  every ceiling item yourself (drove the flow, read the screenshot); say so and offer the
  independent re-run rather than auto-spending another swarm's worth of tokens.

### Rating rubric (1–5 stars)

Rate the product as a whole, computed from the **worst core-feature outcome**, **how many
personas completed their primary goal**, the **persona verdicts**, and the **ease-of-use /
first-run experience** (the `ease` scores + onboarding friction). A broken feature caps the
score — polish can't buy back a blocker; and a feature that works but that a newcomer can't
figure out how to *reach* is a real defect, not a nit.

| Stars | Meaning | Gate |
|-------|---------|------|
| ★☆☆☆☆ **1 — Broken** | A core feature fails; a real user cannot accomplish the primary job. | Any blocker on a *primary* feature, or most personas' verdict = "broken". |
| ★★☆☆☆ **2 — Rough** | Only happy paths work; a primary feature is broken-with-workaround, or several high-severity bugs. | A primary feature is unreliable, or ≥2 high-severity correctness/empty-output findings. |
| ★★★☆☆ **3 — Usable** | Core jobs work but with real friction, wrong/empty AI output, or a broken *secondary* feature. | Any blocker/high on a secondary feature, or mixed persona verdicts. |
| ★★★★☆ **4 — Solid** | All core jobs work; findings are UX polish, edge cases, or wishes. | All personas completed their goal; no blocker/high on a core path. |
| ★★★★★ **5 — Excellent** | Every persona completed their goal; outputs accurate and trustworthy; only cosmetic nits. | Every verdict "works"; no finding above `low`. |

**Validity gate — publish no rating you can't vouch for the environment of.** Stars are a
claim about the product; they're only true if the product was the thing being measured.
Before you report a number, confirm Step 0.6 passed and that at least one persona's durable
change was verified outside the app. If a capability was silently dead, the round measured
your harness — say so and re-run; do NOT publish the score with a caveat. A wrong ★★★★★ is
more damaging than no rating, because it ends the investigation.

Caps are hard: one blocker on a primary feature means **≤2 stars no matter how good the
rest is**; a broken secondary feature caps at **3**. Half-stars are fine (e.g. ★★★½).
State the single finding that set the ceiling.

**Ease-of-use caps too.** If the first-run newcomer couldn't figure out how to start —
create/open a project, or write and send their first prompt — without trial-and-error, cap at
**3** however well the features work (a tool you can't figure out isn't "solid"). **5 requires
the cold start to feel effortless**, not merely for the features to be correct: average
`ease ≥ 4.5`, no newcomer left confused at a step, and no "I nearly gave up" verdict.

**Mobile safe-area / keyboard caps too.** If a mobile persona found, on a **core** flow, any of:
an interactive control clipped under the notch/home-indicator, a control **unreachable** there
(stuck, can't scroll to tap), the **focused** element hidden behind the keyboard, or a background
**seam** (bare white/black box under the notch/home-indicator) — cap at **3** however well the
desktop layout works. A real phone user literally cannot use what they can't reach or see, and a
bare box reads as broken. Name the offending control/edge as the ceiling finding. **5 requires a
clean mobile pass**: no core-flow safe-area violation, unreachable control, seam, or
keyboard-coverage (`expectClean` passes, and no `[ugly.ux]` console.error) on any device a persona
ran. (Cosmetic edge clipping of a non-interactive decoration is a `low` nit, not a cap.)

---

## Screenshot recipe — always wait for hydration

Any Playwright screenshot must wait on a real DOM signal, **not** `networkidle` (the SPA
hits networkidle before React hydrates → blank PNG → fake "blank page" findings).

**Pick the wait selector per app — don't hardcode one.** `[data-id]` is an ugly-ink
convention, not a framework guarantee; on an app that doesn't use it, `[data-id]` never
matches and *every* capture looks blank, so the personas file fabricated render bugs. In
Step 1, when you browse the app, note a selector that reliably marks "hydrated" for THIS
app — a real content selector from `shared/pages.ts`, or the framework-safe fallback
`#root > *` (root has children once React mounts). Use that as `WAIT_SEL`:

```bash
pnpm exec playwright screenshot --wait-for-selector "$WAIT_SEL" --browser chromium "$BASE_URL/" /tmp/eval.png
```

If `WAIT_SEL` never appears **and you've confirmed it's the right selector for this app**,
the page genuinely failed to render — report that as a real bug. Never fall back to a
no-wait capture.

**Writing your own Playwright script (multi-step journeys):** the CLI `pnpm exec playwright
screenshot` is one-shot; a persona driving a real journey (search → click → chat → wait)
writes a `.mjs` script instead. Two gotchas that will `ERR_MODULE_NOT_FOUND` you:
- **Import from the package that's actually installed.** Many apps ship `@playwright/test`,
  not standalone `playwright` — `import { chromium } from '@playwright/test'`. Check with
  `ls node_modules | grep playwright` first.
- **Put the script inside the project dir** (e.g. `./.eval-<slug>.mjs`), not `/tmp` — Node
  resolves bare imports from the script's own folder upward, so a script in a scratchpad
  can't find the app's `node_modules`. Delete it when done.

**Mobile personas — phone frame + safe-area.** Don't screenshot a mobile persona in a desktop
viewport. Use `createMobileBotPage(browser, token, 'ios'|'android')` from `ugly-app/playwright`
(phone viewport + touch + injected top/bottom safe-area), and load with `?debugSafeArea=true` so
the red top / blue bottom / green keyboard bands are visible in the PNG for your vision pass.
`raiseKeyboard(page, platform)` / `dismissKeyboard(page)` toggle the keyboard; `expectClean(page,
{ allowSafeAreaViolations: false, allowSafeAreaSeams: false, allowKeyboardCoverage: false,
allowFocusedInputCovered: false })` is the hard gate that lists clipped/unreachable/covered
interactive elements, background seams, and a focused input hidden behind the keyboard. The
framework also auto-logs all of these as `[ugly.ux]` `console.error` lines on a mobile device —
read the console too. (Requires a recent `ugly-app`; see TESTING.md → "Mobile safe-area +
keyboard".)

---

## Config (optional, per-app)

An app can ship `bots/eval-swarm.json` for repeatable runs:

```json
{
  "personas": [
    { "slug": "plotter", "name": "The Plotter", "brief": "...", "goal": "...", "needs": "consume", "device": "desktop" },
    { "slug": "newcomer", "name": "The Newcomer", "brief": "...", "goal": "...", "needs": "create", "device": "ios" }
  ],
  "seed": "bots/seed-story.mjs",
  "model": "deepseek_v4_flash"
}
```

- `seed` — the command to check/run for consume-persona data (still fails per Step 2 if
  data is absent after it; the skill does not auto-run seeders unless the app documents it).
- `model` — a cheap-model override env the app honors for eval runs (e.g. ugly-ink's
  `INK_FORCE_MODEL`). Cost control only; default is the app's real production model.
- `device` — per-persona `desktop` | `ios` | `android` (default `desktop`). Mobile personas
  run the Mobile safe-area + keyboard pass (Step 3). Give at least two personas a phone.

If no config exists, invent personas per Step 1 — that is the normal path.

---

## Standard ugly-app capabilities (what's cheap to build)

Every ugly-app child app is built on the same framework, so a large feature set is
**standard and low-cost to wire** — it's a handler + a collection + a page, not new
infrastructure. Use this list two ways: (1) when a persona wishes for something the app
lacks, check here — if it's a standard capability, mark the `feature` finding **"low-cost
(framework-standard)"** so the fixer knows it's an easy win, not a moonshot; (2) when
designing personas, exercise the AI-bearing standard features hardest — they have the most
to get wrong.

**Data & search**
- Typed collections on D1 or Neon (`createTypedDB` / `defineCollections`, zod schemas); CRUD via `socket.request` handlers.
- Full-text search (FTS5, `meta.search`); semantic/vector search (Cloudflare Vectorize, `meta.vector`); RRF hybrid fusion of the two.
- Structured queries: filters (`$in`, ranges), sort, pagination, counts.
- `trackDocs` / collab — live-syncing documents with realtime updates (no manual polling).

**AI (all user-billed or owner-proxied)**
- Text generation with multiple providers (Claude, DeepSeek, GLM…), streaming via SSE, `reasoningEffort`.
- Client-driven **agent loop** (`agentTurn` + tools + `sessionStore` memory) — a tool-using chat agent with durable per-user memory.
- Image generation (`createImageGen`), TTS (with viseme + 3D-avatar pipeline), embeddings (`createEmbeddingClient`), web search (`createWebSearchClient`).
- Grounded RAG: retrieval tool + citations that open the source (as in andalib's research chat).

**Auth & users**
- ugly.bot SSO (silent login, magic-link), `getUserId`/`getUserToken`/`userContextStore`; per-user preferences persisted cross-device.
- Bot/test accounts (`auth:create-bot`); user profiles (`userGet`).

**Comms & sharing**
- Push notifications (`pushSendTyped`), email (`emailSend` + templates), public login-free **share links** (`shareLink`), cross-app chat hub.

**Files, media & content**
- Uploads/storage via `ctx.storage` (R2), blob upload, public-prefix serving.
- Markdown editor + viewer (rich editing, streaming-markdown repair, annotations, heading labels).
- Conversations engine (threads, messages, sharing).

**App structure & ops**
- Pages & routing (`definePage`/`definePages`, typed params, deep-link + push routing, popups), SSR.
- Cron / scheduled tasks; A/B experiments; owner alerts.
- Telemetry to D1 — error logs, feedback reports, perf snapshots (queryable via `ugly-app errors`/`feedback`/`perf`).

**Trivially-assembled app features** (primitives already exist, ~a collection + a list/page):
bookmarks/favorites, search history/recents, calendar/events, comments/annotations,
tags/filters, a settings page, an admin gate.

If a wished-for feature is **not** on this list (needs a new provider, a novel algorithm,
native/mobile work, or cross-app infra), say so — that's a real-cost item, not an easy win.

---

## Red flags — STOP

| Thought | Reality |
|---------|---------|
| "I'll author all personas' findings in one pass" | That's imagination, not usage. One subagent per persona, each drives the app itself. |
| "The AI is slow, I'll assume the output" | An assumed output tests nothing. Wait for the real response — you're paying for it. |
| "The app's empty but I'll note that as feedback" | Setup failure, not feedback. Fail per Step 2 and seed first. |
| "I can skip the screenshot, I know what it says" | No finding about a screen you didn't look at. Vision before verdict. |
| "`login` failed, let me retry it headless" | It deadlocks on browser auth. Stop and tell the user. |
| "Stubs would be cheaper" | Stubbed AI produces fake critiques. This skill is real-AI by design; use `verify:e2e` for hermetic checks. |
| "I'll test this mobile-first app on desktop only" | A desktop viewport is blind to notch / home-indicator / keyboard clipping. Give ≥2 personas a phone `device` and run the Mobile pass. |
| "The mobile screenshot looks fine, skip `expectClean`" | Eyeballing misses sub-pixel overlaps. `expectClean` names the exact clipped/covered element — run it for the hard signal. |

## Completion

One-line summary — lead with the star rating:

```
Eval swarm complete. Rating: {★★★☆☆ 3/5} ({ceiling finding}). Personas: {N}/{M} succeeded. Findings: {total} ({dedup} unique). Top issue: {…}.
```
