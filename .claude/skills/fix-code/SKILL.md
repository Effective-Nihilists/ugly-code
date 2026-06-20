---
name: fix-code
description: Run build, lint, unit tests, and coverage checks, then fix all issues until everything passes with ≥90% coverage per file
user-invocable: true
---

Run build, all tests, and coverage checks. Fix every issue until everything is green.

## Steps

1. **Build** — `npm run build`
   Fix all TypeScript errors and lint warnings. Re-run until clean.

2. **Unit tests + coverage** — `npm run test:coverage`
   Fix all failing tests. Re-run until all pass.
   Coverage must be ≥90% per file. If a file is below 90%, either:
   - Add tests to cover the missing paths, OR
   - Add an inline comment explaining why lower coverage is acceptable (e.g. CLI entry point, generated code, integration-only path)

3. **E2E tests** — `npm run test:e2e`
   Fix all failing Playwright tests. Re-run until all pass.

Run each step until it passes before moving to the next.
