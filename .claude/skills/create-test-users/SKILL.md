---
name: create-test-users
description: Create test users and seed data
user-invocable: true
---

# Creating test users

**There is exactly one supported way, and it is the same one everywhere.** Everything
else that has ever been used here — `POST /auth/register` with a password, hand-signed
JWTs, reusing the project token from `~/.ugly-bot/<projectId>.json`, `mongosh` cleanup —
either no longer exists or produces an account that looks signed in and cannot spend.

## In a Playwright test

```ts
import { testAccount, authenticateAs } from 'ugly-app/playwright';

const acct = await testAccount('checkout-flow');        // idempotent per project+slug
await authenticateAs(page, acct);                        // or a domain: 'myapp.ugly.bot'
await page.goto('/');
```

- `acct` is `{ userId, token, email, payerUserId?, canSpend? }`.
- Add `{ requireSpend: true }` when the spec's point is a real AI response — it fails up
  front with a readable message instead of a 402 three layers deep.
- `testAccountPage(browser, slug, domain?)` does both steps in one call.

## From the CLI (bots, swarms, manual poking)

```bash
npx ugly-app auth:create-bot --slug <slug> --name "<Name>"
# → { userId, token, email, billing: { payerUserId, canSpend, subscribed } }
```

Use `token` as the `auth_token` cookie. Any deployed app accepts it, including default
Mode-A apps.

## What this guarantees

- **A real ugly.bot account**, so `/verify` accepts it everywhere.
- **Billed to you.** The account holds no credit of its own; a `billToUserId` pointer
  routes its AI spend to the app owner. It never shows an "out of credit" banner just for
  being a test account.
- **Not creatable broken.** ugly.bot refuses to mint one when the calling identity isn't a
  real account — the stale/fake-login case — with a message naming the fix
  (`npx ugly-app login`). That failure used to surface hours later as an unexplained 402.
- **Idempotent.** Same project + slug ⇒ same account, run after run. No litter.

## Cleanup

Don't. Accounts are reused across runs, an idle one bills nothing, and a ugly.bot cron
reaps synthetic ones after ~7 days. Never delete users with raw SQL — that orphans rows
in every collection keyed on the userId.

## Seeding data for a test user

Call the app's own API as that account, so the data goes through the same validation real
users do:

```ts
await request.post('/api/<endpoint>', {
  headers: { 'Cookie': `auth_token=${acct.token}`, 'Content-Type': 'application/json' },
  data: { input: { /* ... */ } },
});
```

## Local, hermetic alternative (no ugly.bot, no money)

For tests that don't need real AI or prod data, use test mode instead — it's free and
offline. See `TESTING.md` §1: `UGLY_APP_TEST_MODE=1` plus the `impersonate(userId)`
fixture from `ugly-app/testing`.

# Notes
<!-- Claude: append observations here — record which test users exist -->
