# Project — ugly-app

Full API reference: https://www.npmjs.com/package/ugly-app

## Stack
- `server/index.ts` — Express + WebSocket server
- Database: PostgreSQL (JSONB) + Qdrant (vector search), MongoDB (legacy, being migrated)
- `client/main.tsx` — React SPA entry
- `shared/` — API definitions, types, collections (used by both sides)
- CLI: see `package.json` scripts

## Commands
- `npm run dev` — Start everything (Docker, server, Vite, tsc watch, eslint watch)
- `npm run build` — Production build
- `npm run db:migrate` — Run pending migrations
- `npm run db:schema-gen` — Generate migration files for schema changes
- `npm run db:schema-status` — Show current schema drift status
- `npm run db:migrate-postgres` — Migrate data from MongoDB to PostgreSQL
- `npm run textGen -- "your prompt"` — Generate text using AI from the CLI
- `npm run imageGen -- "your prompt"` — Generate an image using AI (prints URL)
- `npm run error:dev` / `npm run error:prod` — Query error logs (your dev-tunnel sessions / production)
- `npm run perf:dev` / `npm run perf:prod` — Query perf logs (your dev-tunnel sessions / production)
- `npm run feedback:dev` / `npm run feedback:prod` — Query feedback (your dev-tunnel sessions / production)
  - All commands go through the HTTP API and require `ugly-app login`. `:dev` filters by your devTunnelId.
- `npm run dev-logs` — Show local dev logs from JSONL files
- `npx ugly-app url` — Print the local dev server URL (from `.uglyapp` config)
- `npx ugly-app feedback:submit` — Submit feedback to local server (use `--help` for flags)
- `npx ugly-app feedback:resolve` — Resolve/decline a feedback item (use `--help` for flags)
- `npx ugly-app deploy` — Build and deploy to production infrastructure
- `npx ugly-app prod --buildId <id>` — Promote a build to production
- `npx ugly-app versions` — List deployed versions with status
- `npx ugly-app versions:prune` — Clean up non-production versions and old artifacts
- `npx ugly-app infra:destroy` — Tear down all project infrastructure

## Adding an endpoint
1. Define in `shared/api.ts` using `req()` (public) or `authReq()` (authenticated) + Zod schemas
2. Add handler to the `requests` object in `server/index.ts` (typed with `satisfies RequestHandlers<typeof requests>`)
3. Import `db`, `storage`, `textGen(userId)`, `imageGen(userId)`, etc. from `'ugly-app/server'` directly

### Handler signatures
```typescript
// req() — public, userId may be null
getPublicData: async (userId: string | null, input) => { ... }

// authReq() — authenticated, 401 auto-enforced, userId always a string
submitFeedback: async (userId: string, input) => { ... }
```

### Optional per-endpoint rate limiting
```typescript
submitFeedback: authReq({
  input: z.object({ ... }),
  output: z.object({ ... }),
  rateLimit: { max: 20, window: 60 },  // 20 requests per 60 seconds
})
```

Every endpoint is accessible via both WebSocket (`socket.request(name, input)`) and HTTP (`POST /api/:name { input }`).

## Adding a collection
1. Define the Zod schema and derive the type in `shared/collections.ts`:
   ```typescript
   export const TodoSchema = z.object({ userId: z.string(), text: z.string(), done: z.boolean() });
   export type Todo = InferDocType<typeof TodoSchema>;
   ```
2. Add the collection to `defineCollections()` with `schema: TodoSchema`
3. Run `npm run db:schema-gen` to generate a migration, fix any `REPLACE_ME` values, then run `npm run db:migrate`
- Optional: add `search: { fields: ['title', 'body'] }` to collection meta for full-text search
- Optional: add `vector: { dimensions: 512, source: 'body' }` to collection meta for vector search

## Changing a collection schema
1. Update the Zod schema in `shared/collections.ts`
2. Run `npm run db:schema-gen` — generates a migration file with compile-blocking placeholders
3. Fix all `REPLACE_ME` values in the generated migration
4. Run `npm run db:migrate` to apply the migration
5. The app will refuse to start until the migration is applied

## Pages & routing
- Define routes in `shared/pages.ts` with `definePage()` / `definePages()`
- Map routes to components in `client/allPages.ts` using `lazyPage()` or `lazyPageLoader()`
- Navigate: `useRouter().push('route-key', params)`
- Popups: always use `useRouter().openPopup(<Component />, { mode: 'transient' })` — never custom fixed overlays

### Home page is the primary surface
- The home route is `''` in `shared/pages.ts`, rendered by `client/pages/HomePage.tsx`.
- When building or customizing the app's main functionality, **edit `HomePage.tsx`** — replace its body with the requested UI. Do not add a new route just to land the user on it.
- Only add new pages for secondary navigation the user explicitly asks for (settings, detail views, multi-screen flows). One screen ⇒ home page edit. Multiple screens ⇒ home page + extra routes.
- Demo/test pages under `client/pages/` (`AuthDemoPage`, `TodoDemoPage`, `*TestPage`, etc.) are scaffolding — delete the ones you don't need as you build the real app.

### Mobile & safe area
`client/index.html` ships `viewport-fit=cover`, so the viewport extends **under the notch, status bar, and home indicator**. Any content at the screen edges WILL be clipped on phones unless it accounts for the safe area.
- `PageLayout` applies the insets automatically (`safeArea="auto"` is the default) — prefer it for normal pages and you get this for free.
- A **custom full-height / full-bleed page** (its own `height: 100%` scroll container, edge-to-edge bands, a fixed header/footer — e.g. a marketing `HomePage`) does NOT get this automatically and **must apply the insets itself.** Add the ready-made `.safe-area` class (from `client/styles.css`) to the scroll container, or pad it manually with the `--safe-area-inset-*` vars / `env(safe-area-inset-*)`:
  ```css
  box-sizing: border-box;
  padding-top: var(--safe-area-inset-top);
  padding-left: var(--safe-area-inset-left);
  padding-right: var(--safe-area-inset-right);
  /* a bottom-anchored footer/bar also needs padding-bottom: var(--safe-area-inset-bottom) */
  ```
- Verify with `window.__uglyInspect()` — any `safeAreaViolations` is a build failure (see UX inspection below).

## Critical rules
- **Never** change a collection schema without running `npm run db:schema-gen` and fixing the generated migration
- **Always** include a `schema: ZodSchema` when defining a collection — it's required
- **Never** use in-memory Maps or module-level variables for per-user state — use NATS KV or PostgreSQL (multi-server)
- **Never** commit `.env`
- **Never** read `process.env` in client code — use `import.meta.env.VITE_*`
- **Always** call `unsub()` on NATS subscriptions
- **Always** declare `rateLimit` in the endpoint def for expensive operations (AI, storage, email)
- **Never** add `any` types — `noExplicitAny` is enforced
- **Always** honor the device safe area on custom full-bleed pages (`viewport-fit=cover` is set) — use `PageLayout`, or add the `.safe-area` class / `env(safe-area-inset-*)` padding to the scroll container. See **Mobile & safe area** above.

## Element identification rules
- **Always** use framework components (Button, Pressable, TabPicker, Pager, ScrollView,
  Input, SelectView, Modal, FlatList) instead of raw HTML elements for interactive UI
- **Always** pass `data-id` on interactive elements — use descriptive kebab-case names
  (e.g., `data-id="save-profile"`, `data-id="tab-settings"`, `data-id="nav-home"`)
- **Never** build custom tab, carousel, scroll, or modal components — use the framework
  versions which include accessibility attributes and element map support
- **Always** set `aria-label` on icon-only buttons and non-text interactive elements

## UX inspection (`window.__uglyInspect()`)

Every page exposes a runtime inspection API installed by `bootstrapApp` at boot. It reports objective UX defects: layout shift (CLS), animation jank, overlapping interactive controls, safe-area violations, mobile keyboard coverage, popup mount cost, SPA route transitions. Observers run continuously from page load and keep a rolling 500-entry ring buffer per signal.

**Call from:**
- **Playwright tests / bots** — `import { inspectWindow, expectClean, setDevice, simulateKeyboard, waitForApp } from 'ugly-app/playwright'`
- **Browser console during dev** — `window.__uglyInspect({ since?: number })` returns a `UglyInspectReport` JSON; `window.__uglyInspectMark()` returns a timestamp for windowed reads
- **Studio coding agent** — call the `inspect_ux` tool with optional `actions[]` to drive navigation/clicks/keyboard before reading

`UglyInspectReport` type and all entry types are exported from `ugly-app/client` and re-exported from `ugly-app/playwright` so tests don't have to reach into client code.

**Rules:**
- **Never** call `page.evaluate('window.__uglyInspect(...)')` directly — use `ugly-app/playwright` so renames and shape changes propagate
- **Treat as build failures** in test code: any `safeAreaViolations`, `overlaps`, `keyboard.coveredInputs`, or `animations[].droppedFrames > 2`
- The expensive scans (overlap, safe-area) only run when `__uglyInspect()` is called — observers themselves are essentially free

## Feedback system
Feedback button is always at `[data-id="feedback-button"]` (bottom-right).
User feedback history: `GET /my_feedback` (requires auth cookie).

## Handling "needs images" feedback
When user feedback mentions missing or needed images:
1. Use `npm run imageGen -- "descriptive prompt" --output client/assets/<name>.png` to generate the image
2. Reference the saved file in the relevant component (`/assets/<name>.png`)
3. Run `npm run build` to verify
