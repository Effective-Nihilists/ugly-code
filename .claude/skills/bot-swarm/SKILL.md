---
name: bot-swarm
description: Run one autonomous cycle — manage feedback personas, collect feedback via Playwright, implement changes, journal results, restart clean. Fully unattended.
user-invocable: true
---

# Bot Swarm Cycle

Run one full autonomous cycle. No human input. No clarifying questions. Make the best possible decision at every step. If something breaks, fix it.

**CORE PRINCIPLE: Be maximally ambitious. Every bot in this swarm — feedback bots, maintain bot, manager — should push for big changes, not incremental tweaks. Feedback bots should demand major redesigns, new directions, bold experiments — not just "move this button 2px." The maintain bot must implement everything requested, no matter how large. "Too complex" is never a valid reason to skip work. The only limit is violating Critical Rules in CLAUDE.md.**

**DESIGN PRINCIPLE: The website must look genuinely designed, not framework-default. Before the maintain bot writes any UI it must commit to a specific aesthetic direction and execute it with restraint and intentionality:**

- **Tone**: pick one and stay there — editorial / brutalist / retro-futurist / luxury-refined / playful-toy / industrial / art-deco / soft-pastel — not a mash-up of every visual idea in sequence.
- **Typography**: pair a distinctive display font with a refined body font. Avoid the generic AI stack (Inter, Roboto, Arial, system-ui). Mono is for labels and metadata, not body copy.
- **Color**: a cohesive palette with dominant colors + sharp accents, expressed as CSS variables or theme tokens — not 200 different `style={{ color: '#...' }}` literals scattered across pages.
- **Structure**: build a real design-system folder (e.g. `client/<theme>/theme.ts` + `client/<theme>/<Component>.tsx`) and route every page through it. Repeating UI patterns become named components in that folder, not duplicated inline JSX.
- **Failure mode to avoid**: "framework defaults + inline styles on top of `Button`/`Card`/`Text`" reads as generic AI scaffolding regardless of how much functionality lives behind it.

If the harness exposes a `frontend-design` skill in `<available_skills>` (Claude Code with the official frontend-design plugin installed), read it for deeper aesthetic guidance — it's complementary, not a replacement for the principles above.

## About the Website

This website is a **blank canvas**. It is a full-stack app with AI capabilities, real-time data, and a complete UI component library — but it has no content, no pages, no purpose yet. The swarm decides what it becomes.

The template includes demo/test pages (todo demo, UI components, auth demo, etc.) that exist only to show developers what the framework can do. **These test pages are not the website. Ignore them entirely.** Do not iterate on them, redesign them, or treat them as features. They are documentation, not product.

On the **first cycle**, the manager invents what to build and creates the perspectives that will critique it. It can be a product or not, have users or not, serve a need or not — your call. Useful, useless, social, solitary, beautiful, hostile, earnest, absurd, gameful, contemplative, transactional, anti-transactional — all valid. The framework is yours to use however you want.

On **subsequent cycles**, the swarm evolves whatever it built. The direction emerges from the swarm's own pull, not from any pre-existing content.

There are no limits on what can be built. New pages, endpoints, collections, migrations, AI integrations, real-time features, image generation — everything is available.

**Known attractor — actively avoid.** First cycles have repeatedly collapsed onto the same idea: a digital Cabinet of Curiosities / Wunderkammer / museum of imaginary specimens, populated by a curator-and-ghost critic roster. If your candidate direction is in that family, pick something else. Variety across cycles is the whole point of running the swarm more than once.

## Working directory

Your CWD is already set to the session worktree — the root of the cycle's git checkout, where `bots/`, `package.json`, and everything else lives. **Do not prepend `cd "/Users/.../worktree" && ...` to every Bash command.** A real cycle (ws_tyf4w1dfmpu5wxzl, 2026-05-31) burned ~50 tokens per command on a redundant `cd` prefix across 86 of 98 Bash calls. Just run `npx ugly-app dev`, `git status`, `ls bots/`, etc. directly. If a command genuinely needs a different directory (rare), use a subshell `(cd path && ...)` or pass an absolute path.

## Base URL

Run `npx ugly-app url` to get the local server URL. Use this value everywhere (browsing, API calls, polling). Store it as `BASE_URL` for the cycle.

## Step 0 — Verify the environment (do this FIRST, no exceptions)

**Your first tool call this cycle MUST be `npx ugly-app doctor`.** Do not skim this and skip ahead — every failure mode below has produced a wedged session in production. Run it, read the bottom of the output, and decide:

```
agent-ready: yes        ← proceed to Step 1
agent-ready: no — ...   ← STOP. Surface the reason to the user. Do not continue.
```

**Do not try to fix `agent-ready: no` from inside the agent.** The usual cause is no global user token on the host. The fix is `npx ugly-app login`, which opens a browser and **cannot** complete from a headless agent — retrying it will deadlock waiting for browser auth, burn tool calls, and leave the cycle in an inconsistent state. End the cycle and tell the user.

Once `agent-ready: yes`, you do not need to set `UGLY_BOT_TOKEN` yourself. `ugly-app dev`, `auth:create-bot`, and `feedback:submit` all read the cached token from `~/.ugly-bot/` automatically. The per-persona `BOT_TOKEN` written into each bot's `.env` is separate and is what the feedback bots present when they sign in to the website.

## Other prerequisites

- The dev server must be running **without** `--watch` (see below)
- Playwright must be installed (`npx playwright install chromium`)

### Starting the dev server (no watchers)

The bot swarm modifies source files while the server runs. To avoid HMR reloads and watcher interference mid-cycle, start the server without watchers:

```bash
npx ugly-app dev
```

This starts Docker, MongoDB, and the server but **without** tsx watch, tsc --watch, or eslint --watch. Do **not** use `npm run dev` (which adds `--watch`) or `npx ugly-app dev --watch`. After the maintain bot finishes and commits, the restart step (Step 5) will kill and restart the server to pick up changes.

### Screenshot recipe — always wait for the SPA to hydrate

Any ad-hoc Playwright screenshot you take **outside of `run-bot.mjs`** (Step 4 journal captures, Step 5 verification captures, mid-cycle debugging) must wait on a real DOM signal, **not** `networkidle`. The framework hits `networkidle` before React hydrates and the captured PNG is blank — verified failure in cycle 001 where a "Restart: success" was logged against a blank verification screenshot.

Use one of these — and only these:

```bash
pnpm exec playwright screenshot --wait-for-selector "[data-id]" --browser chromium "$BASE_URL/" /tmp/page.png
```

```js
await page.goto(url, { waitUntil: 'load', timeout: 15000 });
await page.waitForSelector('[data-id]', { timeout: 15000 });
await page.screenshot({ path: '/tmp/page.png', fullPage: true });
```

If the `[data-id]` wait times out, the page genuinely failed to render — surface it as an error. Never fall back to a no-wait capture to "get something."

---

## Step 1 — Manager (create/update feedback bots)

### If first cycle (no personas in `bots/feedback/active/`):

1. Launch Playwright (headless Chromium)

2. Navigate to `$BASE_URL`, browse all pages to understand the **framework's capabilities** (available components, APIs, patterns)

3. **Ignore all existing demo/test pages** — they are developer documentation, not the website

4. **Decide what to build.** This is yours. Pick something specific and write it into `bots/manager/memory.md` as the **canvas direction**. No examples are given here on purpose — earlier versions of this skill enumerated options and the swarm kept picking from the list instead of inventing.

   Before committing the direction, draft three candidates that are genuinely unlike each other, then pick the one that least resembles "an aesthetic generative art object with critics." If all three drift toward that attractor, throw them out and draft again. The convergence warning above is not rhetorical — if you skip this diversification step, the result will be a museum.

5. Choose 5–13 critic perspectives that will react usefully and non-overlappingly to what gets built. "Critic" is unbounded — anything that produces a coherent reaction qualifies. Invent the roster from this canvas, not from a stock list.

   **Anti-pattern roster.** The following names have appeared across enough prior cycles that they no longer add signal and indicate menu-picking rather than invention: *curator, ghost, child, insomniac, formalist, poet, saboteur, vandal, conceptualist, archivist, mystic, glitch, translator*. If a draft persona's name or one-line description matches anything on that list, replace it with something specific to *this* canvas — not a near-synonym.

   Variety of *perspective* matters more than coverage of user demographics. Two critics from overlapping conceptual worlds (both institution-adjacent, both atmosphere-focused, both anti-establishment) is one wasted slot. Before committing, read your draft roster as a flat list and ask: would another instance given only this skill and this canvas arrive at the same set? If yes, perturb it deliberately until the answer is no.

6. For each persona (the persona file can describe any kind of perspective — there is no requirement that it represent a hypothetical user):
   - Run: `npx ugly-app auth:create-bot --slug {slug} --name "{Name}"`

   - Save the JSON output to `bots/feedback/active/{slug}/.env`:

     ```
     BOT_SLUG={slug}
     BOT_USER_ID={userId from output}
     BOT_TOKEN={token from output}
     ```

   - Write `bots/feedback/active/{slug}/persona.md`:

     ```markdown
     ---
     name: Display Name
     slug: slug-name
     ---

     # Display Name

     ## Who You Are

     [Personality, perspective, what they care about]

     ## What You Notice

     [Types of observations this persona makes]

     ## Feedback Style

     [Tone, specificity, format of their feedback]
     ```

   - Write empty `bots/feedback/active/{slug}/memory.md`

7. Write `bots/manager/memory.md` with the canvas direction, initial roster, and any notes on what kinds of reactions you expect

8. Commit: `[bot] manager: initial roster — {comma-separated persona names}`

### If subsequent cycle:

1. Read `bots/manager/memory.md`

2. Read each active persona's `memory.md`

3. Run `npm run feedback` to see recent feedback and resolutions

4. Browse the site with Playwright to see current state

5. For each persona decide: **keep** / **revise** / **retire**
   - Keep: no changes needed

   - Revise: rewrite their `persona.md` to sharpen or shift focus

   - Retire: `mv bots/feedback/active/{slug} bots/feedback/retired/{slug}`

6. Create new personas if coverage gaps exist (same account creation flow as first run)

7. Update `bots/manager/memory.md`:

   ```markdown
   # Feedback Manager Memory

   ## Last Updated

   [date]

   ## Canvas Direction

   [What is this becoming? — keep it short, this is the through-line, not a spec]

   ## Active Roster

   [list with one-line descriptions]

   ## Perspective Coverage

   Well-represented: [perspectives that have a voice in the swarm]
   Gaps: [angles nobody is reacting from yet]

   ## Recent Decisions

   [last 3 cycles of keep/revise/retire/create decisions with reasons]

   ## History

   [compressed older entries when exceeding ~4000 tokens]
   ```

8. Commit changes: `[bot] manager: {summary of changes}`

---

## Step 2 — Feedback Bots (parallel)

**Use the shipped driver — do NOT write your own.** The template includes a pre-validated Playwright driver at `bots/feedback/run-bot.mjs` that handles everything mechanical: launching headless Chromium, setting the bot auth cookie, screenshotting + element-mapping each page, and submitting via `npx ugly-app feedback:submit`. Earlier cycles wasted 20+ minutes mid-run rebuilding this from scratch and debugging the playwright spawn — the bundled script is the contract. Don't rewrite it.

The driver has three modes; in this step we use `--capture` then `--submit` so the persona can **actually see the page** before authoring findings:

```bash
node bots/feedback/run-bot.mjs <slug> --capture  # crawl + screenshots only
node bots/feedback/run-bot.mjs <slug> --submit   # post findings.json (no Playwright)
```

Dispatch ALL active personas as **parallel subagents** (`delegate_parallel`). If your harness does not expose `delegate_parallel` (e.g. ugly-studio's coding agent today), run each persona as a discrete sequential loop — capture → vision → author → submit — completed in full **before** moving to the next persona. Never batch-author findings for multiple personas in one pass: that is the failure mode this step is designed to prevent. Each subagent does:

1. **READ persona.** Open `bots/feedback/active/{slug}/persona.md` and `memory.md` to get into character.

   Optionally override which routes the persona crawls by writing `bots/feedback/active/{slug}/pages.json` (default: `["/"]`):

   ```json
   ["/", "/inbox", "/settings"]
   ```

2. **CAPTURE current state.** Run the driver in capture-only mode:

   ```bash
   node bots/feedback/run-bot.mjs {slug} --capture
   ```

   This writes fresh PNGs + element maps to `bots/journal/cycles/screenshots/{slug}/<page>.png` and `<page>.element-map.json` reflecting the CURRENT site. **The driver also writes one `UglyInspectReport` per interaction** — `<page>.mount.ux-report.json`, `<page>.hover-first.ux-report.json`, `<page>.scroll-deep.ux-report.json`, `<page>.focus-input.ux-report.json` — each capturing layout shift, animation jank, overlapping interactive controls, safe-area violations, and mobile keyboard coverage during a measurement window driven by the named action script. The legacy `<page>.ux-report.json` is kept as an alias for the `mount` window. A persona that cares about a different interaction set can write `bots/feedback/active/{slug}/interactions.json` (same action schema as `inspect_ux` and `ugly-app inspect:ux`); see [run-bot.mjs](bots/feedback/run-bot.mjs) for the default list. No feedback is submitted yet.

3. **LOOK at each page AND READ every UX report.** For each PNG under `bots/journal/cycles/screenshots/{slug}/`, inspect it using vision — the persona **must actually see** the page before writing findings — AND read **every** sibling `<page>.<interaction>.ux-report.json` (mount + hover-first + scroll-deep + focus-input by default) to ground the visual critique in measured defects across each interaction window:

   - If `analyze_image` is available (ugly-studio coding-agent):

     ```
     analyze_image(
       path="bots/journal/cycles/screenshots/{slug}/<page>.png",
       query="<persona-specific question about layout, contrast,
              copy, mobile fit, image rendering, overlap, etc.>"
     )
     ```

     Run multiple targeted queries per image — `analyze_image` is bounded (Haiku) and each call is cheap. Vague one-shots like "describe everything" waste tokens; specific questions like "is the hero CTA legible against the background" / "list any overlapping text in the masthead" / "what does the empty-library state actually look like" produce usable answers.

   - If running under claude-code CLI or any vision-capable model: Read the PNG path with the Read tool — the model sees it inline.

   - Cross-reference with the matching `<page>.element-map.json` to resolve specific `dataId` / source-file references when you find something worth reporting.

   - **Mine every `<page>.<interaction>.ux-report.json`** for objective defects the screenshot alone cannot show. Treat each of these as a finding worth a feedback row — quote the offending selector AND the interaction window in the message so the maintain bot can reproduce:
     - `safeAreaViolations[]` → `{ "type": "bug", "message": "<selector> spills outside iOS safe area on <side> edge (mount)" }`
     - `overlaps[]` → `{ "type": "design", "message": "<a.selector> and <b.selector> overlap by Npx during <interaction> — likely a z-index or layout bug" }`
     - `keyboard.coveredInputs[]` → `{ "type": "bug", "message": "<selector> is covered by the on-screen keyboard when focused (focus-input)" }`
     - `cls.total > 0.1` → `{ "type": "design", "message": "page shifts significantly during <interaction>: <cls.total> across N spikes" }`
     - `animations[].droppedFrames > 2` → `{ "type": "bug", "message": "<element> animation drops M frames over Tms during <interaction>" }`
     - `popups[].droppedFrames > 0` or `popups[].mountMs > 200` → `{ "type": "bug", "message": "<selector> popup entry drops M frames / takes Tms to mount during <interaction>" }`
     - `longTasks[]` with `duration > 100` → `{ "type": "bug", "message": "<duration>ms long task during <during> blocks main thread" }`

     Visual critique still flows from the screenshot — the structured signals add the movement-and-mobile dimension a single frame can't show. **Animations specifically are invisible in a static PNG; the per-interaction ux-report is the only signal you have on them.**

   **Hard rule #1 — vision (no exceptions, including cycle 001):** every active persona must perform ≥1 vision call (`analyze_image` or Read on a PNG) against its **own** captured screenshots before its findings.json is written. Writing findings.json for a persona without a logged vision call for that same persona is a **cycle failure** — stop the cycle and surface it. "All bots see the same blank canvas, I'll just author findings in a batch" is the exact shortcut this rule exists to prevent: feedback authored from imagination instead of what the persona actually saw is dead weight that pollutes the swarm's signal.

   **Hard rule #2 — ux-report (no exceptions):** every active persona must perform ≥1 Read on each `<page>.<interaction>.ux-report.json` under its own screenshot directory before its findings.json is written. The default config produces four reports per route (`mount`, `hover-first`, `scroll-deep`, `focus-input`); skipping any of them is a **cycle failure**. Vague hand-wave findings like "the page feels janky" without a quoted selector + interaction from a report are the failure mode this rule prevents — measured input was the whole point of writing the reports. Telemetry from `ws_6zyk6bv3mpvtimky:sess_9dnxh2b8mpvtimky` (2026-06-01) caught the previous version of this skill in the exact failure: 37 vision calls, **one** ux-report read across 10 personas, **zero** animation findings — even though the reports captured real overlap defects.

4. **AUTHOR findings.json.** Write 1–5 findings to `bots/feedback/active/{slug}/findings.json`:

   ```json
   [
     { "type": "feature", "message": "..." },
     { "type": "design",  "message": "..." },
     { "type": "bug",     "message": "..." }
   ]
   ```

   Each `message` must reference something the persona actually saw — layout reality, contrast, copy, image rendering, overlap, broken animation. Vague feature wishes that could have been written without looking at the page are wasted feedback; rewrite them with a visual hook ("when I see X on /capture, Y is wrong because…").

5. **SUBMIT findings.** Run the driver in submit-only mode:

   ```bash
   node bots/feedback/run-bot.mjs {slug} --submit
   ```

   This posts one feedback row per finding via `submitFeedbackBot` (data-proxy `db.captureFeedback`) with the captured screenshot + element map attached as `context.screenshotPath` / `context.elementMap`.

6. **Update memory.** Edit `bots/feedback/active/{slug}/memory.md`:

   ```markdown
   ## Cycle [YYYY-MM-DD]

   **Submitted:** [list of feedback items with types]
   **Previous feedback resolved:** [what changed since last visit]
   **Previous feedback declined:** [what was not built and why]
   **Canvas direction observed:** [how is the work evolving?]
   **Evolving opinion:** [what do you think about where this is going?]
   [compress entries older than 3 cycles into History block when > ~4000 tokens]
   ```

**Be unrestrained.** React from inside your persona. You can request anything, declare anything, refuse to engage, derail the project, demand new pages or rip out existing ones, propose redesigns, or ask for entirely new directions. There is no "right" feedback. The maintain bot will deal with whatever you say.

**Timeout**: 20 minutes per bot. Failed bots do not block others.
Record which bots succeeded and which failed/timed out.

---

## Step 2b — Motion Probe

**Once per cycle, not once per persona.** The persona pass measures the default interaction set baked into [run-bot.mjs](bots/feedback/run-bot.mjs); the motion probe targets specific, code-aware interactions that the maintain bot built or modified this cycle. It exists because animation and entry jank are invisible in a static screenshot and almost always invisible in the default `mount` window too — they only show up when a user actually triggers the transition.

1. **Pick 3–5 motion-bearing interactions** worth measuring this cycle. The rule of thumb: anything that animates, slides, fades, scroll-links, mounts a popup, or reveals a keyboard. Concrete candidates:
   - Popup/modal entry (`{ click: "[data-id=open-modal]" }, { wait: 600 }`)
   - Drawer / accordion expand
   - Hover-state primary CTA (`{ hover: "[data-id=primary-cta]" }, { wait: 400 }`)
   - Mobile keyboard reveal on the main input (`{ focus: "[data-id=composer]" }, { simulate_keyboard: true }, { wait: 400 }`) on `device: ios`
   - Scroll-linked hero animation (`{ scroll: { to: 2000 } }, { wait: 1200 }`)
   - SPA route transition (`{ navigate: "/settings" }, { wait: 800 }`)

   If the maintain bot built nothing motion-bearing this cycle, skip the probe and note it in the journal — do not synthesize fake motion findings.

2. **Run the probe.** Two equivalent surfaces — pick whichever your harness exposes:

   - **Studio coding-agent** (this skill running inside `ugly-studio`): call the `inspect_ux` tool directly with the actions list.

     ```
     inspect_ux({ url_path: "/", device: "ios",
                  actions: [{ click: "[data-id=open-modal]" }, { wait: 600 }] })
     ```

   - **claude-code CLI, copilot, or anywhere else**: shell out to `npx ugly-app inspect:ux`. The action schema is identical.

     ```bash
     npx ugly-app inspect:ux \
       --path / --device ios \
       --actions '[{"click":"[data-id=open-modal]"},{"wait":600}]' \
       --out bots/journal/cycles/screenshots/_motion/open-modal-ios.ux-report.json
     ```

   Both surfaces return the same `UglyInspectReport` and call the same `window.__uglyInspect()` probe — the only difference is whether the report lands in your tool result or on disk.

3. **Convert real defects into feedback rows.** Submit findings via `npx ugly-app feedback:submit --type bug --token <BOT_TOKEN> ...` (use the manager's `BOT_TOKEN`, not a persona's — the motion probe is the manager's voice, not a critic's). Concrete thresholds:
   - any `animations[].droppedFrames > 2` → `bug`
   - any `popups[].droppedFrames > 0` or `popups[].mountMs > 200` → `bug`
   - any `cls.spikes[]` triggered by this interaction (`cls.total > 0` AND happened after the action) → `design`
   - any `longTasks[]` with `duration > 100` → `bug`
   - any `keyboard.coveredInputs[]` on the mobile profiles → `bug`

   Quote the action, the selector, and the measured value in the feedback message so the maintain bot can reproduce.

4. **Verify in Step 5.** After the restart loop reports healthy, re-run the same interactions list with `inspect_ux` / `inspect:ux` and compare `droppedFrames` / `popups[].mountMs` / `cls.total` before vs after. The maintain bot's claim that the fix worked must be backed by a measured improvement, not a fresh screenshot.

**Why this is its own step, not per-persona work**: personas describe what they *feel*; the motion probe produces what is *measured*. Putting the probe under the manager makes it a single decisive pass per cycle instead of N redundant probes, and it lets the manager target the maintain bot's actual diff (popups added today, scroll-linked animation built today) instead of the generic-static set baked into run-bot.mjs.

---

## Step 3 — Maintain Bot

Run sequentially in one session. No questions. Make autonomous decisions.

**AMBITION MANDATE: The maintain bot builds everything. There is no "too complex," "too risky," or "would require significant changes." If a critic asked for it, you build it. New pages, new endpoints, new collections, migrations, full redesigns, multi-file refactors — all fair game. The only valid decline reason is a direct contradiction of a Critical Rule in CLAUDE.md. Everything else gets built, no matter how many files it touches or how large the change is.**

**BLANK CANVAS RULE: On the first cycle, the maintain bot MUST remove or replace the template's demo/test pages (TodoDemo, UIComponents, AuthDemo, AITest, AudioTest, ScrollTest, KagiTest, SearchPage, UserPage, ChatDemo, ChatTest, CollabTest, EmailTest, ErrorTest, PushTest, SafeAreaTest, StringsTest, TestIndex, ThreeTest, UploadTest, VideoRoomTest, WorkerTest) with whatever the canvas direction needs. The demo pages are scaffolding — delete them as the real thing is built. Update&#x20;\*\***shared/pages.ts\***\*,&#x20;\*\***client/allPages.ts\***\*, and remove unused page components.**

**Verification of the rule — runs before declaring `Maintain: success`:**

```bash
# List remaining test/demo pages. Output MUST be empty.
ls client/pages/ 2>/dev/null \
  | grep -iE '^(AITest|AudioTest|AuthDemo|ChatDemo|ChatTest|CollabTest|EmailTest|ErrorTest|KagiTest|PushTest|SafeAreaTest|ScrollTest|SearchPage|StringsTest|TestIndex|ThreeTest|TodoDemo|UIComponents|UploadTest|UserPage|VideoRoomTest|WorkerTest)Page\.tsx$' \
  || echo OK
```

If that grep prints any filenames, the cycle has NOT satisfied the rule — keep deleting until the check prints `OK`, then re-run [Step 4 — Journal Bot] and [Step 5 — Restart Loop]. The journal bot must call this check too before writing `Maintain: success` to the cycle file.

1. Read `bots/maintain/memory.md` for feature inventory and context

2. Mark all `new` feedback as `captured` to prevent double-processing:
   - Run `npm run feedback --json` to get all feedback.

   - Use the batch resolve CLI — one process, one auth context, one line per item. Pipe the new items as a JSON array of `{ id, status, resolution }` into `feedback:resolve --batch -`:

     ```bash
     npm run feedback --json \
       | jq '[.[] | select(.status == "new") | { id: ._id, status: "resolved", resolution: "captured for processing" }]' \
       | npx ugly-app feedback:resolve --batch -
     ```

   - **Do NOT muzzle this CLI with `2>/dev/null > /dev/null`.** If a resolve call fails, you need to see it. A silent failure here leaves feedback at `status: new`, so the next cycle re-processes the same items as duplicates and the persona memory diverges from reality. `feedback:resolve --batch` processes every item even on partial failure but exits non-zero if any item failed — treat any non-zero exit as a cycle-breaking error: surface it, stop the loop, and do not claim `Maintain: success`.

3. Invoke `/fix-feedback local` — run completely unattended:
   - Do not ask which environment. Use `local`.

   - For each feedback item: implement the fix or feature. **Build it, no matter how large.**

   - **Never decline feedback because it's "complex" or "ambitious."** If you're unsure how, read existing code and the ugly-app API reference, then figure it out.

   - If feedback requires new pages: add routes in `shared/pages.ts`, components in `client/pages/`, mappings in `client/allPages.ts`.

   - If feedback requires new endpoints: add to `shared/api.ts` and `server/index.ts`.

   - If feedback requires new collections: add to `shared/collections.ts`, run `npm run db:schema-gen` then `npm run db:migrate`.

   - If feedback requires images: use `npm run imageGen -- "prompt" --output client/assets/<name>.png`.

   - If feedback requires schema changes: write a migration in `server/migrations/`.

   - Resolve each item via CLI. Prefer the single-call batch form once all fixes are in — it's faster than one process per item, and partial failures still surface (exit non-zero, per-item lines):

     ```bash
     # All resolved in one process (preferred at end of the maintain pass):
     printf '%s\n' "$BATCH_JSON" | npx ugly-app feedback:resolve --batch -
     ```

     Single-item form remains available for the rare one-off:

     ```bash
     npx ugly-app feedback:resolve --id "<id>" --status resolved --resolution "Built: description"
     # Or decline (only for Critical Rule violations):
     npx ugly-app feedback:resolve --id "<id>" --status declined --resolution "Reason"
     ```

   - Commit each change: `[bot] fix: ...` or `[bot] feat: ...`

4. Invoke `/fix-code` — run completely unattended:
   - Fix all TypeScript errors, lint warnings, test failures.

   - Commit: `[bot] fix: build errors`

5. Invoke `/fix-perf local` — run completely unattended:
   - Do not ask which environment. Use `local`.

   - Fix any performance issues found.

   - Commit: `[bot] perf: ...`

6. Update `bots/maintain/memory.md`:

   ```markdown
   # Maintain Bot Memory

   ## Last Updated

   [date]

   ## What Exists Now

   [what's on the canvas at this point]

   ## Recurring Critiques

   [what kinds of reactions keep coming up]

   ## Recurring Issues

   [errors or perf problems that keep appearing]

   ## What's Emerging

   [where this seems to be going — patterns, instincts, drift]

   ## Cycle History

   [last 3 cycles, compress older entries when > ~4000 tokens]
   ```

---

## Step 4 — Journal Bot

1. Count existing `.md` files in `bots/journal/cycles/` to determine cycle number (NNN, zero-padded to 3 digits)

2. Take Playwright screenshots of every accessible page, save to `bots/journal/cycles/screenshots/{NNN}-{page-slug}.png`

3. Gather cycle data:
   - Manager decisions from Step 1

   - Feedback bot results from Step 2 (which succeeded, what was submitted)

   - Maintain bot changes from Step 3 (git log of `[bot]` commits since last cycle)

4. Write `bots/journal/cycles/YYYY-MM-DD-NNN.md`:

   ```markdown
   # Cycle NNN — YYYY-MM-DD

   ## Outcomes

   - Manager: [status] — [roster changes]
   - Feedback: [N/M bots succeeded] — [top themes]
   - Maintain: [status] — [N commits, N feedback resolved, N declined]
   - Restart: [pending — filled in by Step 5]

   ## Feedback Submitted

   [summary of all feedback items across all bots this cycle]

   ## Changes Deployed

   [git log --oneline of [bot] commits from this cycle]

   ## Screenshots

   ![page-name](screenshots/NNN-page-slug.png)
   [one per page]

   ## Observations

   [patterns, emerging direction, concerns, what's working, what's not]
   ```

5. Update `bots/journal/README.md` — overwrite with a one-paragraph running summary of the project's evolution so far

6. Commit: `[bot] journal: cycle NNN`

---

## Step 5 — Restart Loop

1. Stop the dev server (find and kill the `npx ugly-app dev` process group)

2. Run `npm install` (maintain bot may have added packages in Step 3)

3. Run `npm run build`

4. **If build fails:**
   - Read the full error output

   - Identify the root cause in the source code

   - Fix it

   - Commit: `[bot] fix: build errors`

   - Run `npm run build` again

   - **Repeat until build succeeds. Do not stop. Do not ask for help.**

5. Start `npx ugly-app dev` in the background (no `--watch`)

6. Wait for the server to be ready — poll `$(npx ugly-app url)` with up to 60 retries (1s apart)

7. **If server fails to start or crashes:**
   - Read the error output and/or `npm run error`

   - Fix the code

   - Commit: `[bot] fix: startup errors`

   - Kill and restart `npx ugly-app dev`

   - **Repeat until server is healthy. Do not stop. Do not ask for help.**

8. **Visually verify the maintain bot's changes actually rendered.** Take a fresh screenshot of `$BASE_URL/` using the [Screenshot recipe](#screenshot-recipe--always-wait-for-the-spa-to-hydrate), then run `analyze_image` (or Read the PNG under claude-code CLI) against it. If the result says "blank", "white page", "no visible content", or otherwise indicates the redesign didn't render, the cycle is **not** complete:
   - Check `dev_server_errors` and the browser console (`dev_server_logs --type console`)

   - Fix the underlying issue (hydration crash, missing route, dist not rebuilt, vite cache stale)

   - Commit: `[bot] fix: render after restart`

   - Re-screenshot and re-verify

   **Never declare restart success against a blank verification screenshot.** A passing API curl is not a substitute — the user-visible page must render.

9. **Re-run the Step 2b motion probe interactions** against the now-restarted server and diff against the pre-fix run. If `cls.total`, `animations[].droppedFrames`, or `popups[].mountMs` regressed for any interaction the maintain bot touched this cycle, restart is **not** complete — surface the regression as a bug feedback row and let the next cycle pick it up (do not silently move on). If all measured interactions are within tolerance or improved, note the before/after numbers in the journal under the Restart section.

10. Once healthy, visually verified, and motion-verified: update the journal cycle file's Restart outcome to `success` or note any fixes made

11. Commit any remaining changes: `[bot] fix: restart issues`

**The restart loop has no retry limit.** It runs until clean or until externally killed. If a human has to intervene, the bots have failed.

---

## Completion

Output a one-line summary:

```
Cycle NNN complete. Manager: {status}. Bots: {N}/{M}. Maintain: {status}. Journal: {status}. Restart: {status}.
```
