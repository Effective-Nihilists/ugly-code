---
name: check-perf
description: Query performance logs for slow operations from the project's PROD Cloudflare D1
user-invocable: true
---

# Checking Performance Logs (prod)

Perf logs are written only by the **deployed Worker** into its Cloudflare D1, so this
command is production-only — it always reads the prod Cloudflare D1 the
deploy flow provisioned (no `DATABASE_URL` / local dev DB involved).

```bash
npx ugly-app perf                 # most recent 50
npx ugly-app perf --limit 100
npx ugly-app perf --json          # machine-readable
```

If it reports "No prod Cloudflare D1 found", the app hasn't been deployed yet — run
`npm run deploy` first.

# Notes
<!-- Claude: append observations here -->
