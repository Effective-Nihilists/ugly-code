# Coding-chat feedback pipeline + glob hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route coding-chat issue reports into the framework feedback pipeline and email the reporter when their feedback is resolved/declined, and harden the `glob`/`grep` tools against dumping `.git`/`node_modules` into model context.

**Architecture:** Four parts across two repos. In `ugly-code`: (A) `glob`/`grep` gain always-on path exclusions + a `.globignore`; (B) the coding-chat bug button submits framework feedback (`feedbackReportCreateNoAuth`) with the reporter's email stamped into `context`. In `ugly-app`: (C) a new admin-scoped `feedbackReportResolve` operation updates the D1 row (incl. `resolved_at`) and emails the reporter from Worker context; the `feedback:resolve` CLI calls it instead of a raw D1 `UPDATE`. (D) the `feedback` read CLI's stale "Neon" description is corrected (it already reads D1).

**Tech Stack:** TypeScript, ripgrep (bundled), Cloudflare D1 + Workers, Cloudflare Email Service binding, vitest.

## Global Constraints

- Package manager: **pnpm** (never npm) in both repos.
- ugly-code tools run client-side and shell to the bundled `rg` via `native.process.spawn` — no Node `fs`/`child_process`; filesystem reads go through `native.fs.*`.
- Framework (ugly-app) email works **only** on the deployed Worker (`env.EMAIL` binding); local/Node dev has no binding. Email is **best-effort** — resolve must succeed even when no email is sent.
- `emailSend` requires a concrete `to` address (userId→email resolution was removed).
- ugly-code auth mode is default **`uglybot`** (`.uglyapp` has no `auth` block). CLI→Worker admin calls must use the AUTH_SECRET operator channel that `ugly-app log` uses (`src/cli/debugStream.ts` + `resolveProdAuth`), NOT an `/api/` bearer (rejected in `uglybot` mode).
- Bump the ugly-app version on any publish; do not release ugly-app concurrently with other work.
- Work on `main`, commit directly, frequent commits.

---

# PART A — glob/grep hardening (repo: ugly-code)

## Task A1: Shared hard-exclude list

**Files:**
- Create: `client/agent/tools/pathExcludes.ts`
- Test: `tests/unit/tools/pathExcludes.test.ts`

**Interfaces:**
- Produces: `export const HARD_EXCLUDES: string[]` — directory names excluded unconditionally by both `glob` and `grep`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/tools/pathExcludes.test.ts
import { describe, it, expect } from 'vitest';
import { HARD_EXCLUDES } from '../../../client/agent/tools/pathExcludes';

describe('HARD_EXCLUDES', () => {
  it('excludes the dirs that blow up model context', () => {
    for (const d of ['.git', 'node_modules', 'dist', 'build', '.venv']) {
      expect(HARD_EXCLUDES).toContain(d);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/tools/pathExcludes.test.ts`
Expected: FAIL — cannot find module `pathExcludes`.

- [ ] **Step 3: Create the module**

```ts
// client/agent/tools/pathExcludes.ts
// Directory names never useful to a coding agent. Excluded unconditionally by
// glob/grep — even under include_ignored (`--no-ignore`), which would otherwise
// resurface .git/objects, node_modules, and build output. A `glob("*")` dumping
// the entire .git tree into the model context (a ~2M-token request) is exactly
// what this prevents.
export const HARD_EXCLUDES: string[] = ['.git', 'node_modules', 'dist', 'build', '.venv'];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/tools/pathExcludes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/agent/tools/pathExcludes.ts tests/unit/tools/pathExcludes.test.ts
git commit -m "feat(tools): shared HARD_EXCLUDES list for glob/grep"
```

## Task A2: glob applies hard excludes + `.globignore`

**Files:**
- Modify: `client/agent/tools/glob.ts`
- Test: `tests/unit/tools/glob.test.ts`

**Interfaces:**
- Consumes: `HARD_EXCLUDES` from Task A1; `native.fs.readFile` from `ugly-app/native`.
- Produces: `buildGlobArgs(args: GlobArgs, extraExcludes?: string[]): string[]`, `parseGlobignore(content: string): string[]`.

- [ ] **Step 1: Write the failing tests** (append to `tests/unit/tools/glob.test.ts`)

```ts
import { buildGlobArgs, parseGlobignore } from '../../../client/agent/tools/glob';

describe('glob hard excludes', () => {
  it('always excludes .git and node_modules, even with include_ignored', () => {
    const a = buildGlobArgs({ pattern: '*', include_ignored: true });
    expect(a).toContain('--no-ignore');
    expect(a).toContain('!.git');
    expect(a).toContain('!node_modules');
  });
  it('appends .globignore patterns as negative globs', () => {
    const a = buildGlobArgs({ pattern: '**/*' }, ['coverage', 'tmp']);
    expect(a).toContain('!coverage');
    expect(a).toContain('!tmp');
  });
});

describe('parseGlobignore', () => {
  it('keeps patterns, drops blanks and # comments', () => {
    expect(parseGlobignore('# a comment\n\ncoverage\n  logs/  \n')).toEqual(['coverage', 'logs/']);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/unit/tools/glob.test.ts`
Expected: FAIL — `parseGlobignore` is not exported; `!.git` not present.

- [ ] **Step 3: Implement** — replace `buildGlobArgs` and augment `run` in `client/agent/tools/glob.ts`

```ts
import { native } from 'ugly-app/native';
import { HARD_EXCLUDES } from './pathExcludes';

/** Map glob args → `rg --files` argv. Pure, exported for test. `extraExcludes`
 *  carries `.globignore` entries. Hard excludes are always applied — including
 *  when include_ignored adds --no-ignore — because `-g '!x'` overrides are honored
 *  regardless of ignore-file parsing. */
export function buildGlobArgs(args: GlobArgs, extraExcludes: string[] = []): string[] {
  const a = ['--files', '-g', args.pattern];
  if (args.include_ignored) a.push('--no-ignore');
  for (const dir of HARD_EXCLUDES) a.push('-g', `!${dir}`);
  for (const pat of extraExcludes) a.push('-g', `!${pat}`);
  if (args.path) a.push(args.path);
  return a;
}

/** Parse a `.globignore`: one glob per line; blank lines and `#` comments dropped.
 *  Pure, exported for test. */
export function parseGlobignore(content: string): string[] {
  return content
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
}

/** Read `<root>/.globignore` if present (best-effort; missing file → no excludes). */
async function readGlobignore(root: string | undefined): Promise<string[]> {
  if (!root) return [];
  try {
    const raw = await native.fs.readFile(`${root}/.globignore`);
    return parseGlobignore(raw);
  } catch {
    return [];
  }
}
```

Then in `globTool.run`, resolve excludes before spawning:

```ts
  async run(input, ctx) {
    const args = input as unknown as GlobArgs;
    const root = projectRoot(ctx) ?? undefined;
    const extraExcludes = await readGlobignore(root);
    const { stdout, stderr, code } = await spawnCollect('rg', buildGlobArgs(args, extraExcludes), {
      ...(root ? { cwd: root } : {}),
    });
    // …unchanged result handling…
  },
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run tests/unit/tools/glob.test.ts`
Expected: PASS (existing `run` tests still pass — the mock ignores the extra args).

- [ ] **Step 5: Commit**

```bash
git add client/agent/tools/glob.ts tests/unit/tools/glob.test.ts
git commit -m "feat(tools): glob hard-excludes .git/node_modules + respects .globignore"
```

## Task A3: grep applies hard excludes

**Files:**
- Modify: `client/agent/tools/grep.ts` (function `buildRgArgs`, line ~83)
- Test: `tests/unit/tools/grep.test.ts` (create if absent)

**Interfaces:**
- Consumes: `HARD_EXCLUDES` from Task A1.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/tools/grep.test.ts (add this describe block; create file if needed)
import { describe, it, expect } from 'vitest';
import { buildRgArgs } from '../../../client/agent/tools/grep';

describe('grep hard excludes', () => {
  it('excludes .git and node_modules even with include_ignored', () => {
    const a = buildRgArgs({ pattern: 'foo', include_ignored: true });
    expect(a).toContain('!.git');
    expect(a).toContain('!node_modules');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/unit/tools/grep.test.ts`
Expected: FAIL — `!.git` not present.

- [ ] **Step 3: Implement** — in `client/agent/tools/grep.ts`, add the import and push excludes inside `buildRgArgs` right after the `--no-ignore` line (currently line 87):

```ts
import { HARD_EXCLUDES } from './pathExcludes';
// …
  if (args.include_ignored) a.push('--no-ignore');
  for (const dir of HARD_EXCLUDES) a.push('-g', `!${dir}`);
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run tests/unit/tools/grep.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/agent/tools/grep.ts tests/unit/tools/grep.test.ts
git commit -m "feat(tools): grep hard-excludes .git/node_modules"
```

---

# PART B — coding-chat report → framework feedback (repo: ugly-code)

## Task B1: Stamp reporter email into the session bundle

**Files:**
- Modify: `client/studio/panels/CodingAgentChat.tsx` (the two `getBundle` closures at ~lines 7327 and 7492)

**Interfaces:**
- Produces: `getBundle()` return now includes `reporterEmail: string | null`.

- [ ] **Step 1: Locate the reporter email accessor.** `NativeHostRequired.tsx:19` reads it as `(app?.user as { email?: string } | undefined)?.email`. Confirm `CodingAgentChat` has the same `app` in scope (it renders these buttons and already builds `getBundle`).

- [ ] **Step 2: Add `reporterEmail` to both `getBundle` closures**

```tsx
// before: getBundle={() => ({ messages, model, reasoningEffort, modelMode, patternMode })}
getBundle={() => ({
  messages, model, reasoningEffort, modelMode, patternMode,
  reporterEmail: (app?.user as { email?: string } | undefined)?.email ?? null,
})}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm tsc -p tsconfig.json --noEmit` (or the repo's typecheck script)
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add client/studio/panels/CodingAgentChat.tsx
git commit -m "feat(studio): include reporterEmail in session-issue bundle"
```

## Task B2: Submit to the feedback pipeline instead of errorLog

**Files:**
- Modify: `client/studio/panels/ReportSessionIssueButton.tsx` (`handleSubmit`, lines 83–130)
- Test: `tests/unit/…/ReportSessionIssueButton.test.tsx` (create; mock `fetch`)

**Interfaces:**
- Consumes: `getBundle()` from Task B1 (carries `reporterEmail`).
- Produces: POST to `/api/feedbackReportCreateNoAuth` with `{ input: { type, description, url, page, userAgent, context } }`.

- [ ] **Step 1: Write the failing test**

```tsx
// mount the button, type a message, click submit, assert fetch target + payload
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import { ReportSessionIssueButton } from '../../client/studio/panels/ReportSessionIssueButton';

describe('ReportSessionIssueButton', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, text: async () => '' }) as never;
  });
  it('submits framework feedback with reporterEmail in context', async () => {
    const { getByTestId } = render(
      <ReportSessionIssueButton compositeId="cs:x" getBundle={() => ({ reporterEmail: 'a@b.co' })} />,
    );
    fireEvent.click(getByTestId('report-session-issue-button'));
    fireEvent.change(getByTestId('report-session-issue-message'), { target: { value: 'tokens wrong' } });
    fireEvent.click(getByTestId('report-session-issue-submit'));
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    const [url, opts] = (globalThis.fetch as unknown as vi.Mock).mock.calls[0];
    expect(url).toBe('/api/feedbackReportCreateNoAuth');
    const body = JSON.parse((opts as { body: string }).body);
    expect(body.input.type).toBe('bug');
    expect(body.input.description).toBe('tokens wrong');
    expect(body.input.context.reporterEmail).toBe('a@b.co');
    expect(body.input.context.compositeId).toBe('cs:x');
  });
});
```

(`data-id` attributes exist; use `getByTestId` via a `data-testid` shim or switch the selectors to `[data-id=…]` with `container.querySelector`. Keep the assertions.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/unit/…/ReportSessionIssueButton.test.tsx`
Expected: FAIL — still POSTs to `/api/errorLogCaptureNoAuth` with the wrong body shape.

- [ ] **Step 3: Implement** — replace the `entry`/`fetch` block in `handleSubmit` (lines 98–115):

```ts
      // Submit through the framework feedback pipeline (feedbackReport D1), with
      // the full session bundle in `context`. reporterEmail (from getBundle) lets
      // the resolve step email the filer even in uglybot auth mode, where the
      // authIdentity table is empty.
      const res = await fetch('/api/feedbackReportCreateNoAuth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          input: {
            type,
            description,
            url: typeof location !== 'undefined' ? location.href : '',
            page: typeof location !== 'undefined' ? location.pathname : '',
            userAgent: navigator.userAgent,
            context: bundle,
          },
        }),
      });
```

Keep the existing `capBundle({...})` call that builds `bundle` (it already includes `compositeId`, `issueType`, `description`, `reportId`, `userAgent`, and the spread `getBundle()` → now also `reporterEmail`). Update the doc comment at the top of the file (lines 1–8) to say it writes to `feedbackReport`, not `errorLog`.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run tests/unit/…/ReportSessionIssueButton.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/studio/panels/ReportSessionIssueButton.tsx tests/unit/…/ReportSessionIssueButton.test.tsx
git commit -m "feat(studio): coding-chat report submits to feedback pipeline (not errorLog)"
```

---

# PART D — fix stale `feedback` CLI description (repo: ugly-app)

The read path already queries D1 (`serverLogQueryApi.ts:401-439`); only the command description is wrong.

## Task D1: Correct the description string

**Files:**
- Modify: `src/cli/index.ts:478`
- Modify: `src/cli/serverLogQueryApi.ts:372-383` (the `queryServerLogsApi` doc comment says "PRODUCTION Neon DB" but the feedback/error branch is D1)

- [ ] **Step 1: Edit** `src/cli/index.ts` line 478:

```ts
  .description("Query feedback from this project's PROD Cloudflare D1 (feedbackReport)")
```

- [ ] **Step 2: Edit** the `queryServerLogsApi` doc comment to note feedback/error read from D1 and only perfLog reads Neon (1-line clarification).

- [ ] **Step 3: Build check**

Run: `pnpm tsc -p tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/cli/index.ts src/cli/serverLogQueryApi.ts
git commit -m "docs(cli): feedback command reads D1, not Neon (description fix)"
```

---

# PART C — email the reporter on resolve (repo: ugly-app)

## Task C1: TelemetryStore — resolve + read-back helper

**Files:**
- Modify: `src/server/TelemetryStore.ts`
- Test: `src/server/TelemetryStore.test.ts` (create; use a fake `D1Like`)

**Interfaces:**
- Produces:
  - Extend `D1PreparedLike` with `first<T>(): Promise<T | null>`.
  - `resolveFeedbackReport(id: string, status: 'resolved'|'declined', resolution: string, resolvedAt: number): Promise<ResolvedFeedbackRow | null>` where
    `interface ResolvedFeedbackRow { userId: string | null; message: string | null; type: string | null; context: unknown }`.
    Returns `null` if no row updated.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { setTelemetryDb, resolveFeedbackReport, type D1Like } from './TelemetryStore.js';

function fakeDb(row: Record<string, unknown> | null, changes: number): D1Like {
  const prepared = {
    _sql: '', bind(..._v: unknown[]) { return prepared; },
    async run() { return { meta: { changes } }; },
    async first<T>() { return row as T | null; },
  };
  return { prepare: (_sql: string) => prepared, batch: async () => undefined } as unknown as D1Like;
}

describe('resolveFeedbackReport', () => {
  it('returns the row on update', async () => {
    setTelemetryDb(fakeDb({ user_id: 'u1', message: 'm', type: 'bug', context: '{"reporterEmail":"a@b.co"}' }, 1));
    const r = await resolveFeedbackReport('id1', 'resolved', 'fixed', 123);
    expect(r?.userId).toBe('u1');
    expect(r?.context).toEqual({ reporterEmail: 'a@b.co' });
  });
  it('returns null when no row changed', async () => {
    setTelemetryDb(fakeDb(null, 0));
    expect(await resolveFeedbackReport('missing', 'declined', 'n/a', 1)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/server/TelemetryStore.test.ts`
Expected: FAIL — `resolveFeedbackReport` not exported.

- [ ] **Step 3: Implement** — add to `src/server/TelemetryStore.ts`:

```ts
// extend the minimal D1 interface with a single-row read
export interface D1PreparedLike {
  bind(...values: unknown[]): D1PreparedLike;
  run(): Promise<unknown>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}

export interface ResolvedFeedbackRow {
  userId: string | null;
  message: string | null;
  type: string | null;
  context: unknown;
}

/** Set status+resolution+resolved_at on one feedback row and read it back for
 *  notification. Returns null when no row matched. Requires a D1 binding (Worker);
 *  throws if unbound so the caller surfaces "not on deployed Worker". */
export async function resolveFeedbackReport(
  id: string,
  status: 'resolved' | 'declined',
  resolution: string,
  resolvedAt: number,
): Promise<ResolvedFeedbackRow | null> {
  const db = _db;
  if (!db) throw new Error('[Telemetry] no D1 binding (resolve only works on the deployed Worker)');
  await ensureSchema(db);
  const upd = (await db
    .prepare('UPDATE feedback_report SET status = ?, resolution = ?, resolved_at = ? WHERE id = ?')
    .bind(status, resolution, resolvedAt, id)
    .run()) as { meta?: { changes?: number } };
  if ((upd?.meta?.changes ?? 0) === 0) return null;
  const row = await db
    .prepare('SELECT user_id, message, type, context FROM feedback_report WHERE id = ?')
    .bind(id)
    .first<Record<string, unknown>>();
  if (!row) return null;
  let context: unknown = row['context'];
  if (typeof context === 'string') { try { context = JSON.parse(context); } catch { /* keep raw */ } }
  return {
    userId: (row['user_id'] as string | null) ?? null,
    message: (row['message'] as string | null) ?? null,
    type: (row['type'] as string | null) ?? null,
    context,
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run src/server/TelemetryStore.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/TelemetryStore.ts src/server/TelemetryStore.test.ts
git commit -m "feat(telemetry): resolveFeedbackReport update+read-back helper"
```

## Task C2: Feedback-resolution email template

**Files:**
- Create: `src/server/feedbackResolveTemplate.ts`
- Test: `src/server/feedbackResolveTemplate.test.ts`

**Interfaces:**
- Produces: `renderFeedbackResolveEmail(input: { status: 'resolved'|'declined'; resolution: string; originalMessage: string | null; type: string | null }): { subject: string; html: string }`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { renderFeedbackResolveEmail } from './feedbackResolveTemplate.js';

describe('renderFeedbackResolveEmail', () => {
  it('resolved subject + includes resolution and original text', () => {
    const { subject, html } = renderFeedbackResolveEmail({
      status: 'resolved', resolution: 'Fixed in 0.2.0', originalMessage: 'tokens wrong', type: 'bug',
    });
    expect(subject).toMatch(/resolved/i);
    expect(html).toContain('Fixed in 0.2.0');
    expect(html).toContain('tokens wrong');
  });
  it('declined subject', () => {
    expect(renderFeedbackResolveEmail({ status: 'declined', resolution: 'wontfix', originalMessage: null, type: null }).subject)
      .toMatch(/declined/i);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run src/server/feedbackResolveTemplate.test.ts` → FAIL (missing module).

- [ ] **Step 3: Implement** (mirror the structure/escaping of `src/server/auth/magicLinkTemplate.ts`):

```ts
// src/server/feedbackResolveTemplate.ts
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function renderFeedbackResolveEmail(input: {
  status: 'resolved' | 'declined';
  resolution: string;
  originalMessage: string | null;
  type: string | null;
}): { subject: string; html: string } {
  const verb = input.status === 'resolved' ? 'resolved' : 'declined';
  const subject = `Your feedback was ${verb}`;
  const orig = input.originalMessage
    ? `<p style="color:#666"><em>Your report${input.type ? ` (${esc(input.type)})` : ''}:</em><br>${esc(input.originalMessage)}</p>`
    : '';
  const html = `
    <div style="font-family:system-ui,sans-serif;max-width:520px">
      <h2>Your feedback was ${verb}</h2>
      ${orig}
      <p>${esc(input.resolution)}</p>
      <p style="color:#999;font-size:12px">You’re receiving this because you filed feedback in the app.</p>
    </div>`.trim();
  return { subject, html };
}
```

- [ ] **Step 4: Run to verify pass** — `pnpm vitest run src/server/feedbackResolveTemplate.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/feedbackResolveTemplate.ts src/server/feedbackResolveTemplate.test.ts
git commit -m "feat(email): feedback-resolution email template"
```

## Task C3: Email-recipient resolution helper

**Files:**
- Create: `src/server/feedbackNotify.ts`
- Test: `src/server/feedbackNotify.test.ts`

**Interfaces:**
- Consumes: `ResolvedFeedbackRow` (Task C1), `emailSend` (`src/server/Email.ts`), `renderFeedbackResolveEmail` (Task C2).
- Produces:
  - `pickReporterEmail(row: ResolvedFeedbackRow): string | null` — returns `context.reporterEmail` if it's a non-empty string, else `null`. (No authIdentity lookup here — that table is empty in uglybot mode; a future self-mode fallback can extend this.)
  - `notifyFeedbackResolved(row, status, resolution): Promise<boolean>` — resolves recipient, sends via `emailSend`, returns whether an email was sent. Best-effort: catches send errors and returns `false`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { pickReporterEmail } from './feedbackNotify.js';

describe('pickReporterEmail', () => {
  it('reads context.reporterEmail', () => {
    expect(pickReporterEmail({ userId: null, message: null, type: null, context: { reporterEmail: 'a@b.co' } })).toBe('a@b.co');
  });
  it('null when missing/blank', () => {
    expect(pickReporterEmail({ userId: 'u', message: null, type: null, context: { reporterEmail: '' } })).toBeNull();
    expect(pickReporterEmail({ userId: 'u', message: null, type: null, context: null })).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure** — FAIL (missing module).

- [ ] **Step 3: Implement**

```ts
// src/server/feedbackNotify.ts
import { emailSend } from './Email.js';
import { renderFeedbackResolveEmail } from './feedbackResolveTemplate.js';
import type { ResolvedFeedbackRow } from './TelemetryStore.js';

export function pickReporterEmail(row: ResolvedFeedbackRow): string | null {
  const ctx = row.context;
  if (ctx && typeof ctx === 'object') {
    const e = (ctx as Record<string, unknown>)['reporterEmail'];
    if (typeof e === 'string' && e.trim()) return e.trim();
  }
  return null;
}

export async function notifyFeedbackResolved(
  row: ResolvedFeedbackRow,
  status: 'resolved' | 'declined',
  resolution: string,
): Promise<boolean> {
  const to = pickReporterEmail(row);
  if (!to) return false;
  const { subject, html } = renderFeedbackResolveEmail({
    status, resolution, originalMessage: row.message, type: row.type,
  });
  try {
    await emailSend({ to, subject, html });
    return true;
  } catch (e) {
    console.error('[feedbackNotify] send failed', { to, error: e instanceof Error ? e.message : String(e) });
    return false;
  }
}
```

- [ ] **Step 4: Run to verify pass** — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/feedbackNotify.ts src/server/feedbackNotify.test.ts
git commit -m "feat(feedback): reporter-email resolution + best-effort notify"
```

## Task C4: SPIKE — locate the operator-request transport

**Files:** none (investigation → decision recorded in the plan/commit message)

The `feedback:resolve` CLI must reach the deployed Worker the way `ugly-app log` does (AUTH_SECRET operator channel — proven for `uglybot`-mode apps like ugly-code). The server handler for `debugStreamStart` is not a plain string in `src/server`; find how operator requests are dispatched.

- [ ] **Step 1:** Trace `connectOperator` (imported in `src/cli/debugStream.ts`) to its module; find the client `sock.request(name, input)` wire format and the **server** side that receives operator requests (grep `src/server/Socket.ts` for the operator/request routing; check how `debugStreamStart` is matched — likely a request-name→handler map or a switch reached via the `/ws` operator connection).
- [ ] **Step 2:** Record: (a) the exact server extension point to register a new operator request `feedbackReportResolve`; (b) how the operator connection authorizes admin/owner (so the new handler gates the same way); (c) whether the per-request Worker bindings (`setTelemetryDb`, `setEmailBinding`) are installed on the operator path — if NOT, note that resolve+email must run where they are.
- [ ] **Step 3:** If the operator path does not have Worker bindings wired, fall back to an `/api/` `authReq` (`feedbackReportResolve`) reached with the owner's ugly.bot token; confirm ugly-code's admin gate (`resolvedIsAdmin`) accepts the owner userId (check whether ugly-code registers `isAdminFn` or relies on `MAINTAIN_BOT_USER_ID`). Record the chosen transport.
- [ ] **Step 4: Commit the decision** (a short note appended to this plan file).

```bash
git commit -am "chore(plan): record feedbackReportResolve transport decision"
```

## Task C5: Server handler `feedbackReportResolve`

**Files:** (paths depend on C4's decision)
- Modify: request schema — `src/shared/FrameworkRequests.ts` (add `feedbackReportResolve` near `feedbackReportCreateNoAuth`, ~line 257) **or** the operator request registry.
- Modify: handler — `src/server/adapter/workers/createWorkersApp.ts` (near `feedbackReportCreateNoAuth`, ~line 1786) and, if the request path is used, `src/server/App.ts` (~line 844).
- Test: handler unit test asserting the admin gate + that it calls `resolveFeedbackReport` then `notifyFeedbackResolved`.

**Interfaces:**
- Consumes: `resolveFeedbackReport` (C1), `notifyFeedbackResolved` (C3), `resolvedIsAdmin`/`maintainBotUserId` (existing, `createWorkersApp.ts:1619`).
- Produces: operation `feedbackReportResolve({ id, status, resolution })` → `{ ok: boolean; emailed: boolean }`, admin-gated.

- [ ] **Step 1: Write the failing test** — assert a non-admin caller is rejected, and an admin caller triggers the update+notify (mock `resolveFeedbackReport`/`notifyFeedbackResolved`).

```ts
// shape (adapt to how handlers are unit-tested in this repo):
// - call handler with userId='not-admin' → throws /authorized/i
// - call with admin userId, mock resolveFeedbackReport → row, notifyFeedbackResolved → true
//   → returns { ok:true, emailed:true }; missing row → { ok:false, emailed:false }
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement** the handler (Workers adapter shape; gate mirrors `adminGetPerfLogs`):

```ts
feedbackReportResolve: async (
  userId: string,
  input: { id: string; status: 'resolved' | 'declined'; resolution: string },
) => {
  if (!(await resolvedIsAdmin(userId))) throw new Error('Not authorized');
  const row = await resolveFeedbackReport(input.id, input.status, input.resolution, Date.now());
  if (!row) return { ok: false, emailed: false };
  const emailed = await notifyFeedbackResolved(row, input.status, input.resolution);
  return { ok: true, emailed };
},
```

Add the schema (if request-path):

```ts
feedbackReportResolve: authReq({
  input: z.object({
    id: z.string().min(1),
    status: z.enum(['resolved', 'declined']),
    resolution: z.string().max(5000),
  }),
  output: z.object({ ok: z.boolean(), emailed: z.boolean() }),
  rateLimit: { max: 120, window: 60 },
}),
```

- [ ] **Step 4: Run to verify pass.**

- [ ] **Step 5: Commit**

```bash
git add src/shared/FrameworkRequests.ts src/server/adapter/workers/createWorkersApp.ts src/server/App.ts src/server/*.test.ts
git commit -m "feat(feedback): admin feedbackReportResolve updates D1 + emails reporter"
```

## Task C6: CLI `feedback:resolve` calls the Worker

**Files:**
- Modify: `src/cli/feedbackResolve.ts` (`resolveOne` — replace the `execTelemetryD1` UPDATE with the transport chosen in C4)
- Modify: `src/cli/feedbackResolve.test.ts`

**Interfaces:**
- Consumes: `resolveProdAuth` (`src/cli/prodDb.ts`) + the operator/request client from C4.
- Preserves: `resolveFeedback`, `resolveFeedbackBatch`, `parseBatchPayload`, `readStdinToString` signatures and fail-loud batch semantics.

- [ ] **Step 1: Update the test** — `resolveOne` should call the Worker transport (mock it), not `execTelemetryD1`. Assert single + batch still surface failures (non-zero exit path unchanged).

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement** — `resolveOne` now: `resolveProdAuth()` → mint the AUTH_SECRET JWT (as `debugStream.ts:77-83`) → send `feedbackReportResolve` over the C4 transport → treat `{ ok:false }` as "no row" (throw, preserving the current "no feedback_report row" error). Keep `resolveFeedback`/`resolveFeedbackBatch` wrappers intact.

- [ ] **Step 4: Run to verify pass** — `pnpm vitest run src/cli/feedbackResolve.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/cli/feedbackResolve.ts src/cli/feedbackResolve.test.ts
git commit -m "feat(cli): feedback:resolve calls Worker (updates D1 + emails reporter)"
```

## Task C7: Release ugly-app + adopt in ugly-code

- [ ] **Step 1:** `pnpm -C /Users/admin/Documents/GitHub/ugly-app build` (compile dist), bump version, run `pnpm -C /Users/admin/Documents/GitHub/ugly-app test`.
- [ ] **Step 2:** Publish ugly-app per its release process (not concurrently with other ugly-app work).
- [ ] **Step 3:** Bump ugly-code's `ugly-app` dependency to the new version; `pnpm -C /Users/admin/Documents/GitHub/ugly-code install`.
- [ ] **Step 4:** Republish ugly-code (`pnpm run publish`) so B's client change and the new CLI ship together.
- [ ] **Step 5: Commit** the version bumps in both repos.

---

## End-to-end verification (after all parts)

- [ ] In the deployed studio, file a coding-chat report → confirm a row lands in `feedback_report` (via `ugly-app feedback --json`) with `context.reporterEmail` set and `user_id` populated.
- [ ] Run `ugly-app feedback:resolve --id <that id> --status resolved --resolution "test"` → command exits 0; `ugly-app feedback --json` shows `status:resolved`, `resolution`, and `resolved_at` set; the reporter receives the email.
- [ ] Resolve a report whose `reporterEmail` is null → command still exits 0, no email (`emailed:false`).
- [ ] Run the coding agent: `glob("*")` in a repo with `node_modules`/`.git` returns no `.git/`/`node_modules/` paths; add a `.globignore` line and confirm those paths drop out.

## Self-review notes

- **Spec coverage:** A→A1-A3; B→B1-B2; C→C1-C7; D→D1. Spec risk "CLI→Worker auth by mode" is addressed by the C4 spike; "email deliverability" is in end-to-end verification.
- **Known spikes (not placeholders):** C4 (operator transport) and B1 Step 1 (confirm `app` accessor) are genuine investigations with recorded decisions, required because the operator dispatch and the panel's user accessor aren't verifiable from static reading alone.
- **Type consistency:** `ResolvedFeedbackRow` defined in C1, consumed in C3/C5; `resolveFeedbackReport`/`notifyFeedbackResolved`/`pickReporterEmail`/`renderFeedbackResolveEmail`/`HARD_EXCLUDES`/`buildGlobArgs`/`parseGlobignore` names are used consistently across tasks.
