---
name: fix-perf
description: Fetch prod performance issues and optimize slow paths
user-invocable: true
---

Fetch performance issues from the project's **production** Cloudflare D1 and optimize
the slow paths.

Perf logs are written only by the deployed Worker, so this is prod-only:

```bash
npx ugly-app perf            # add --limit <n> as needed
```

If it reports "No prod Cloudflare D1 found", the app hasn't been deployed yet — run
`npm run deploy` first.

For each slow path:
1. Find the source of the slowdown
2. Optimize the code (avoid blocking operations, add caching, etc.)
3. Run `npm run build` to verify
