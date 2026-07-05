# Coding-chat feedback pipeline + glob hardening — Design

Date: 2026-07-05
Repos touched: `ugly-code` (app), `ugly-app` (framework)

## Background / motivation

A user filed a coding-session issue report (title "ABCDE") from the coding chat's
bug icon. Investigating it surfaced two problems:

1. **Reporting path is off-pipeline.** The coding-chat bug button
   ([`ReportSessionIssueButton`](../../../client/studio/panels/ReportSessionIssueButton.tsx))
   writes to the `error_log` D1 table via `/api/errorLogCaptureNoAuth`, not into
   the framework's `feedbackReport` feedback pipeline. Reports therefore don't
   flow through the normal feedback triage/resolution workflow, and the reporter
   never hears back when their issue is addressed.

2. **`glob` could balloon context.** The reported session showed a deepseek
   400 — a trivial "create a simple intro page" session requested ~2M tokens
   because a `glob("*")` returned a full recursive listing including
   `.git/objects/...`. The current [`glob.ts`](../../../client/agent/tools/glob.ts)
   already shells out to ripgrep (`rg --files -g <pattern>`), which respects
   `.gitignore` and skips hidden dirs, so that specific blow-up came from an
   older pre-port build. But the tool applies **no** exclusions of its own, and
   `include_ignored` (`--no-ignore`) or a repo with no `.gitignore` removes all
   protection. We want defense-in-depth.

Separately, we discovered the `ugly-app feedback` **read** CLI queries **Neon**
while feedback is written to **D1** — so the command can never see these reports.

## Goals

- A. Harden `glob` (and `grep`) with always-on path exclusions + a `.globignore`.
- B. Route coding-chat issue reports into the framework `feedbackReport` pipeline,
  stamping the reporter's email so they can be notified later.
- C. Notify the reporter by email when their feedback's status changes
  (resolved/declined), driven by the bot-swarm `ugly-app feedback:resolve` CLI.
- D. Fix `ugly-app feedback` (read CLI) to query D1, so reports are visible.

## Non-goals

- No in-app "your feedback was resolved" UI. Email only.
- No re-inclusion semantics for `.globignore` (excludes only; YAGNI).
- No change to the 30K-char per-tool-result truncation in `engine.ts` (kept as a
  backstop).
- No migration/backfill of historical `error_log` session-issue rows into
  `feedbackReport`.

## Key constraints discovered (drive the design)

- `emailSend` works **only** from the deployed Worker (`env.EMAIL` binding set
  per request in `createWorkersApp`); it throws on local/Node dev. So the
  resolve-and-email must run in Worker request context, not in the CLI.
  (`ugly-app/src/server/Email.ts`, `createWorkersApp.ts` `setEmailBinding`.)
- `emailSend` requires a concrete `to` address; userId→email resolution was
  removed.
- The only userId→email source is the `authIdentity` table, which is **empty
  under the default `uglybot` auth mode** — which ugly-code uses. Therefore we
  cannot rely on a lookup; we **stamp the reporter's email at submit time**
  (`app.user.email` is available client-side, e.g.
  `client/studio/common/NativeHostRequired.tsx:19`).
- `feedbackReportCreateNoAuth` is a **public** request, but the framework still
  stamps `user_id` from the auth cookie/bearer when present
  (`createWorkersApp` `/api/:name` dispatcher). Coding-chat users are
  authenticated, so `user_id` will be populated.
- CLI→deployed-Worker authenticated calls have precedent in `ugly-app log`
  (`src/cli/debugStream.ts` + `resolveProdAuth` in `src/cli/prodDb.ts`). Auth
  mechanism differs by auth mode; in `uglybot` mode the CLI must present an
  owner bearer that `ugly.bot/verify` accepts (owner global token via
  `src/cli/probeAuth.ts`), which then passes the `resolvedIsAdmin`/owner gate.

---

## Part A — glob/grep hardening (ugly-code)

### Components
- [`client/agent/tools/glob.ts`](../../../client/agent/tools/glob.ts)
  - `buildGlobArgs(args)`: after the user pattern, always append hard excludes:
    `-g '!.git'`, `-g '!node_modules'`, `-g '!dist'`, `-g '!build'`, `-g '!.venv'`.
    These are appended **unconditionally**, including when `include_ignored` adds
    `--no-ignore`, because these dirs are never useful for a coding task and are
    exactly what caused the blow-up.
  - `globTool.run`: resolve project root (already available via `projectRoot(ctx)`),
    read `<root>/.globignore` if present via the native fs bridge
    (`native.fs.readFile`, pattern per `client/agent/tools/memory.ts`). Parse
    lines: trim, skip blanks and `#` comments, and translate each into an extra
    `-g '!<pattern>'`. Missing file → no-op (best-effort; never throw).
- [`client/agent/tools/grep.ts`](../../../client/agent/tools/grep.ts): apply the
  same hard-exclude set for parity (same `include_ignored` footgun).

### Data flow
`glob(pattern, path?, include_ignored?)` → `buildGlobArgs` produces
`['--files', '-g', pattern, (…--no-ignore), <hard excludes…>, <.globignore excludes…>, (path?)]`
→ `spawnCollect('rg', args, {cwd: root})` → stdout returned verbatim → capped to
30K by `engine.ts` before reaching the model.

### Error handling
- `.globignore` read failure or absence: ignored silently, hard excludes still apply.
- ripgrep non-zero exit / stderr: unchanged from today's behavior.

### Testing
- `tests/unit/tools/glob.test.ts`: update `buildGlobArgs` assertions to expect the
  hard excludes; add cases for `include_ignored` (excludes still present) and for
  `.globignore` lines being translated to `-g '!…'` (comments/blanks skipped).
- grep test parity if one exists.

---

## Part B — coding-chat report → framework feedback (ugly-code)

### Components
- [`client/studio/panels/ReportSessionIssueButton.tsx`](../../../client/studio/panels/ReportSessionIssueButton.tsx)
  - Replace the `fetch('/api/errorLogCaptureNoAuth', …)` call with a framework
    feedback submit to `feedbackReportCreateNoAuth` (via the app's request helper,
    or `fetch('/api/feedbackReportCreateNoAuth', { credentials: 'include', … })`
    so the auth cookie is sent and `user_id` is stamped).
  - Request payload:
    - `description`: the user's message (existing textarea; framework caps at 5000
      chars — enforce/trim client-side to match).
    - `type`: the existing bug/feature/design toggle → framework feedback `type`.
    - `context`: the existing capped session bundle (`capBundle({ compositeId,
      issueType, description, reportId, userAgent, ...getBundle() })`) **plus
      `reporterEmail: app.user?.email ?? null`**.
    - `page`, `url`, `userAgent`: as available.
  - Keep `capBundle` (700KB) as our own guard (framework imposes no explicit
    context cap; D1 value limits apply).
  - Success UI unchanged (show the generated report id / confirmation).

### Data flow
Button submit → `feedbackReportCreateNoAuth` (public, cookie→user_id) →
`recordFeedback` → `insertLogRows('feedbackReport', …)` → D1 `feedback_report`
row with `status:'new'`, `user_id`, `context.reporterEmail`.

### Error handling
- Submit failure surfaces in the popover exactly as today.
- Anonymous user (no `app.user.email`): `reporterEmail: null` — allowed; that
  report just won't be emailable on resolve.

### Testing
- Component/unit test asserting the submit targets the feedback request with
  `reporterEmail` in `context` and the correct `type`.

---

## Part C — email the reporter on feedback status change (ugly-app framework)

### Components
- **New owner-scoped request `feedbackReportResolve`**
  - Schema in `src/shared/FrameworkRequests.ts`: `authReq` (or admin-gated), input
    `{ id: string, status: 'resolved'|'declined', resolution: string }`, output
    `{ ok: boolean, emailed: boolean }`.
  - Handlers in both `src/server/App.ts` (Node) and
    `src/server/adapter/workers/createWorkersApp.ts` (Workers), following the
    `adminGetPerfLogs` owner-gate shape (`resolvedIsAdmin(userId)` /
    `userId === maintainBotUserId`, else throw "Not authorized").
  - Handler steps:
    1. `UPDATE feedback_report SET status=?, resolution=?, resolved_at=? WHERE id=?`
       (set `resolved_at` = now — currently never set). Use the framework's D1
       telemetry access.
    2. `SELECT user_id, context, message, type FROM feedback_report WHERE id=?`.
    3. Resolve recipient email: `context.reporterEmail` → else `authIdentity`
       lookup by `user_id` (`data->>'email' WHERE data->>'userId' = ?`) → else null.
    4. If email present: `emailSend({ id: 'fbresolve:'+id, to, subject, html })`
       via the per-request `EMAIL` binding. Best-effort: catch+log send failures,
       still return `ok:true` with `emailed:false`.
- **New email template** (e.g. `src/server/feedbackResolveTemplate.ts`, parallel
  to `magicLinkTemplate.ts`): subject "Your feedback was {resolved|declined}";
  body includes the resolution note and a short snippet of the original
  `description`/`message`.
- **CLI change** `src/cli/feedbackResolve.ts`:
  - Replace the raw `execTelemetryD1('UPDATE feedback_report …')` with a call to
    the deployed Worker `feedbackReportResolve` request, authenticated with an
    owner bearer resolved from publish state (mirror `debugStream`/`resolveProdAuth`
    + `probeAuth` owner token; select the correct auth per auth mode).
  - Preserve single (`--id/--status/--resolution`) and batch (`--batch`) modes and
    the fail-loud partial-failure semantics.
  - If the deployed Worker is unreachable or email can't be resolved, the resolve
    still succeeds (email is best-effort) — but a hard auth/endpoint failure must
    still surface as a non-zero exit (don't silently leave rows at `new`).

### Data flow
`ugly-app feedback:resolve --id X --status resolved --resolution "…"` → owner
bearer → deployed Worker `feedbackReportResolve` → D1 update + email → filer inbox.

### Error handling / edge cases
- Local/dev (no EMAIL binding): resolve updates D1, `emailed:false`. Acceptable.
- `user_id` null AND no `reporterEmail`: resolve succeeds, no email.
- Old rows (pre-Part-B) without `reporterEmail`: no email unless authIdentity
  has it (empty in uglybot mode) — acceptable; documented limitation.
- Duplicate resolves: idempotent update; email may resend — key `emailSend` `id`
  on the report id + status to dedupe if the sender supports it.

### Testing
- Unit: handler gate rejects non-owner; recipient resolution precedence
  (reporterEmail > authIdentity > null); `resolved_at` set; `emailed` reflects
  whether a send occurred.
- CLI: `feedbackResolve.test.ts` updated to assert it calls the Worker endpoint
  (mocked) rather than execTelemetryD1, for both single and batch.

---

## Part D — `ugly-app feedback` read CLI → D1 (ugly-app framework)

### Components
- `src/cli/index.ts` `feedback` command (currently
  `queryServerLogsApi('feedbackReport', …)` against Neon): repoint to read the D1
  `feedback_report` table via `execTelemetryD1` (mirror the `errors` command,
  which already reads D1). Preserve `--limit`, `--json`; add `--since` parity if
  cheap. Update the command `.description` (drop "PROD Neon DB").
- Verify the bot-swarm list path (whatever enumerates feedback to resolve) reads
  D1; if it shares `queryServerLogsApi`, repoint it too.

### Testing
- Manual: `ugly-app feedback --json` returns the D1 rows (including the ABCDE-style
  reports once Part B lands).

---

## Sequencing / rollout

Single spec, single plan, but land in dependency order:
1. **A** (glob/grep hardening) — independent, ship anytime.
2. **D** (read CLI → D1) — independent, small; makes B verifiable.
3. **B** (coding-chat → feedback pipeline, with `reporterEmail`).
4. **C** (framework email-on-resolve + CLI change) — depends on B for the email
   source; ships with an ugly-app release.

Framework changes (C, D) require an ugly-app release; coordinate per the
"don't release ugly-app concurrently" rule and bump the version.

## Revision 2026-07-05 — final architecture (post-spike)

The C4 spike + ugly-bot investigation changed Parts B and C. Superseding decisions:

- **Email is sent by each ugly-app from its own domain** via the framework
  `emailSend` (Cloudflare `EMAIL` binding) — exactly how ugly-bot's magic-link
  handler sends auth mail. We do **not** route the email through ugly-bot and do
  **not** add a ugly-bot email op. ("Add email support to every ugly-app just
  like ugly-bot.")
- **ugly-bot is used only to resolve `user_id → email`** via its existing
  `POST /v1/users/email` (`userEmailHandler`, 3-tier fallback). No new ugly-bot op.
- **Part B drops `reporterEmail` stamping.** The button just routes to
  `feedbackReportCreateNoAuth`; `user_id` is stamped server-side from the session
  and is the key the resolve step uses to look up the address. (Implemented.)
- **Part C resolve runs in the child Worker.** `feedbackReportResolve` (admin
  gated) updates the D1 row (incl. `resolved_at`), resolves the reporter address
  via ugly-bot `/v1/users/email`, and sends via the app's own `emailSend`. No cron.
- **CLI `feedback:resolve` triggers the child-Worker handler over the operator
  socket** (`connectOperator` + AUTH_SECRET JWT — the transport `ugly-app log`
  uses). Residual risk: the operator-socket admin-gate identity is unverified
  from static reading and must be confirmed against the deployed app.
- **Part D** is a description-only fix — the read CLI already queries D1. (Implemented.)

Status: Parts A, B, D implemented + committed. Part C pending (needs an ugly-app
release + child adopt + end-to-end verification).

## Open risks

- **CLI→Worker auth by mode.** The resolve CLI must pick owner-token auth that
  `ugly.bot/verify` accepts in `uglybot` mode; confirm during implementation
  against `probeAuth`/`resolveProdAuth`.
- **Email deliverability** depends on `CLOUDFLARE_EMAIL_SENDING_DOMAIN`
  (`code.ugly.bot`) being a verified sender — verify before relying on it.
