---
name: check-errors
description: Query recent error logs from the project's PROD Neon DB
user-invocable: true
---

# Checking Error Logs (prod)

Error logs are written only by the **deployed Worker** into its Neon DB, so this
command is production-only — it always reads the prod connection string the
publish flow persisted (no `DATABASE_URL` / local dev DB involved).

```bash
npx ugly-app errors                 # most recent 50
npx ugly-app errors --limit 100
npx ugly-app errors --level error   # filter by level
npx ugly-app errors --json          # machine-readable
```

If it reports "No prod Neon DB found", the app hasn't been published yet — run
`ugly-app publish` first.

## Tips
- `source: 'server'` = server-side error, `source: 'browser'` = client-side
- `context.recentLogs` holds the console history captured right before a browser error
- Check the `stack` field for the full trace
- `userId: null` means an unauthenticated user

# Notes
<!-- Claude: append observations here -->
