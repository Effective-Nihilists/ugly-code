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

Store `BASE_URL="$(npx ugly-app url)"` for the run. Everything the swarm reads and writes
lives on **this local server** — the framework read CLIs (`ugly-app feedback`, `errors`,
`logs`) query **prod**, not local, so don't use them to inspect the run.

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

Write each persona as a short brief you will hand to its subagent: who they are, their
goal for this session, the exact features they should exercise, and what would make them
say "this tool works" vs. "this is broken."

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
> Base URL: `<BASE_URL>`. Your account token: `<token>`.
>
> **Authenticate**, then actually use the product to pursue your goal:
> 1. In headless Chromium (`pnpm exec playwright` / the Playwright MCP if available), set
>    cookie `auth_token=<token>` for `<BASE_URL>`, then `goto` the app and wait for the
>    hydration selector `<WAIT_SEL>` (see Screenshot recipe), never `networkidle`.
> 2. Drive the real features toward your goal. **Trigger the real AI** — generate, coach,
>    extract, chat, whatever this app does — and **wait for real responses**. This spends
>    real (owner-billed) tokens; that is expected. Budget ~10–20 AI interactions.
> 3. **SEE what happened.** Screenshot each meaningful state and inspect it with vision
>    (Read the PNG, or `analyze_image` if available) before judging it. A finding written
>    without a logged look at the thing you are critiquing is invalid — discard it.
> 4. Judge as your persona: did the feature do what you came for? Was the AI output good,
>    wrong, empty, slow, truncated, off-tone? Was anything broken, confusing, or missing?
>
> **File each real finding** with
> `npx ugly-app feedback:submit --type <bug|design|feature> --message "<what you did →
> what you saw → why it's wrong>" --token <token> --url <page>`. Every message must name
> the concrete thing you did and saw.
>
> **Return to me** a JSON array of your findings (`{type, severity, feature, message,
> evidence}`) plus a one-line verdict: does this tool work for you? Return the findings as
> your final message — they are data for aggregation, not a human report.

**Guardrails to state in every dispatch:**
- Real AI only. If you find yourself imagining a response instead of waiting for one, stop
  and actually run the feature.
- Vision before verdict. No finding about a screen you did not look at.
- Ground every message in "I did X, I saw Y." Vague wishes ("would be nice if…") that
  could have been written without opening the app are noise — cut them.

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
5. Hand off the ranked list **as content** for fixing — either fix the items directly in
   this session, or paste the list into a `/fix-feedback`-style pass (using its ambition
   policy), since the fixer cannot pull these local rows itself.

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

---

## Config (optional, per-app)

An app can ship `bots/eval-swarm.json` for repeatable runs:

```json
{
  "personas": [
    { "slug": "plotter", "name": "The Plotter", "brief": "...", "goal": "...", "needs": "consume" }
  ],
  "seed": "bots/seed-story.mjs",
  "model": "deepseek_v4_flash"
}
```

- `seed` — the command to check/run for consume-persona data (still fails per Step 2 if
  data is absent after it; the skill does not auto-run seeders unless the app documents it).
- `model` — a cheap-model override env the app honors for eval runs (e.g. ugly-ink's
  `INK_FORCE_MODEL`). Cost control only; default is the app's real production model.

If no config exists, invent personas per Step 1 — that is the normal path.

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

## Completion

One-line summary:

```
Eval swarm complete. Personas: {N}/{M} succeeded. Findings: {total} ({dedup} unique). Top issue: {…}. Verdict: {works / broken}.
```
