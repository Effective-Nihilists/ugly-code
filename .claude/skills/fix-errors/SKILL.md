---
name: fix-errors
description: Fetch prod errors and fix them
user-invocable: true
---

Fetch errors from the project's **production** Cloudflare D1 and fix them.

Error logs are written only by the deployed Worker, so this is prod-only:

```bash
npx ugly-app errors            # add --limit <n> / --level error as needed
```

If it reports "No prod Cloudflare D1 found", the app hasn't been deployed yet — run
`npm run deploy` first.

For each error:
1. Find the relevant source file (`source: 'browser'` errors include
   `context.recentLogs` — the console history right before the error)
2. Understand the root cause
3. Fix the code
4. Run `npm run build` to verify the fix compiles
