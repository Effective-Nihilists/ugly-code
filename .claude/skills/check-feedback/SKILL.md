---
name: check-feedback
description: Query user feedback from the project's PROD Cloudflare D1
user-invocable: true
---

# Checking Feedback Logs (prod)

Feedback is written only by the **deployed app** into its Cloudflare D1, so this
command is production-only — it always reads the prod Cloudflare D1 the
deploy flow provisioned (no `DATABASE_URL` / local dev DB involved).

```bash
npx ugly-app feedback               # most recent 50
npx ugly-app feedback --limit 100
npx ugly-app feedback --json        # machine-readable
```

If it reports "No prod Cloudflare D1 found", the app hasn't been deployed yet — run
`npm run deploy` first.

## Types: `bug`, `design`, `feature`
- Each report includes the `url`/`page`, `userId` (null = logged out), and the
  recent console logs captured when it was filed.
- A `screenshotUri` is shown when one was attached.

# Notes
<!-- Claude: append observations here -->
