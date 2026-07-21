---
name: check-errors
description: Query recent error logs from the project's PROD Cloudflare D1
user-invocable: true
---

# Checking Error Logs (prod)

Error logs are written only by the **deployed Worker** into its Cloudflare D1, so this
command is production-only — it always reads the prod Cloudflare D1 the
deploy flow provisioned (no `DATABASE_URL` / local dev DB involved).

```bash
npx ugly-app errors                 # most recent 50
npx ugly-app errors --limit 100
npx ugly-app errors --level error   # filter by level
npx ugly-app errors --json          # machine-readable
```

If it reports "No prod Cloudflare D1 found", the app hasn't been deployed yet — run
`npm run deploy` first.

## Tips
- `source: 'server'` = server-side error, `source: 'browser'` = client-side
- `context.recentLogs` holds the console history captured right before a browser error
- Check the `stack` field for the full trace
- `userId: null` means an unauthenticated user

# Notes
<!-- Claude: append observations here -->
