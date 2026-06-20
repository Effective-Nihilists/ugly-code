---
name: check-perf
description: Query performance logs for slow operations from the project's PROD Neon DB
user-invocable: true
---

# Checking Performance Logs (prod)

Perf logs are written only by the **deployed Worker** into its Neon DB, so this
command is production-only — it always reads the prod connection string the
publish flow persisted (no `DATABASE_URL` / local dev DB involved).

```bash
npx ugly-app perf                 # most recent 50
npx ugly-app perf --limit 100
npx ugly-app perf --json          # machine-readable
```

If it reports "No prod Neon DB found", the app hasn't been published yet — run
`ugly-app publish` first.

# Notes
<!-- Claude: append observations here -->
