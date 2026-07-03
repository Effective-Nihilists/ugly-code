# LSP Restoration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Restore Language Server Protocol support (go-to-definition, references, implementation, hover, status) — deleted in ugly-studio `f5a74c2` "delete the coding backend" — re-homed **client-side in ugly-code** over the UglyNative facade.

**Architecture:** The recovered `LspClient` (spawned `typescript-language-server --stdio` via Node `child_process`/`fs`, server-side) is adapted to run in ugly-code's browser handlers using `native.process.spawn` + `native.fs` (proxied to the host). The orphaned `lsp*` request handlers in `client/studio/shared/api.ts` get real implementations registered in `client/studio/hooks/useSocket.ts`.

**Tech Stack:** TypeScript, ugly-app UglyNative (`native.process`/`native.fs`), `typescript-language-server` (via `npx` on the now-provisioned node), JSON-RPC over stdio, vitest.

## Global Constraints

- The client runs in the **browser** (useSocket handlers) — NO Node builtins (`child_process`, `fs`, `EventEmitter` from `node:events`). Use `native.process` / `native.fs` from `ugly-app/native`; `path` is fine (pure). Replace `EventEmitter` with a tiny local listener set.
- `native.process.spawn(cmd, args, opts)` returns a handle with `onStdout(cb)`, `onStderr(cb)`, `onExit(cb)`, `onError(cb)`, `write(data)`, `closeStdin()`, `kill(sig?)`. JSON-RPC framing (`Content-Length` headers) is unchanged.
- `native.fs.readFile(path)` is **async** — every former `readFileSync` becomes `await`.
- `typescript-language-server` is NOT a dependency and must not be spawned by absolute node_modules path. Spawn it as `npx --yes typescript-language-server --stdio` (node/npx are provisioned by the bundled-binary system) OR add it as an explicit dependency and resolve via `npx` from that install. Python LSP (pyright) is OUT OF SCOPE (typescript only for v1; keep the `LspLanguage` type but only wire `'typescript'`).
- Recovered source of truth: `git show f5a74c2^:server/coding-agent/lsp/client.ts` (1150 lines) and `f5a74c2^:server/lsp/registry.ts` in the ugly-studio repo.
- API contract (already in `client/studio/shared/api.ts`, keep unchanged):
  - `lspDefinition` / `lspImplementation` / `lspReferences`: input `{path, line, character, cwd?}` → output `{results: [{path, line, character, preview?}]}`
  - `lspHover`: input `{path, line, character, cwd?}` → (verify output in api.ts)
  - `lspStatus` snapshot: `{state: 'initializing'|'ready'|'error'|'disabled'|'closed'|'idle', errors, warnings, lastUpdatedAt, lastMessage?}`

---

### Task 1: Recover the client + registry into ugly-code (verbatim, not yet compiling)

**Files:**
- Create: `client/studio/agent/lsp/client.ts` ← `git show f5a74c2^:server/coding-agent/lsp/client.ts` (from the **ugly-studio** repo)
- Create: `client/studio/agent/lsp/registry.ts` ← adapt `f5a74c2^:server/lsp/registry.ts` (import path → `./client.js`)

- [ ] **Step 1:** From the ugly-studio checkout, `git show f5a74c2^:server/coding-agent/lsp/client.ts > <ugly-code>/client/studio/agent/lsp/client.ts` and the registry similarly.
- [ ] **Step 2:** Commit the raw recovery UNCHANGED (a clean baseline diff for the adaptation): `git add client/studio/agent/lsp && git commit -m "chore(lsp): recover deleted LspClient + registry (pre-adaptation baseline)"`. Expect tsc to FAIL (Node builtins) — that's the starting point.

---

### Task 2: Replace the process layer (child_process → native.process)

**Files:** Modify `client/studio/agent/lsp/client.ts`

**Interfaces:**
- Consumes: `native` from `ugly-app/native` (`native.process.spawn`).
- Produces: the `LspClient` spawns via `native.process.spawn(this.binaryPath, ['--stdio'], { cwd })` and reads/writes over the returned handle.

- [ ] **Step 1: Write the failing test** — `tests/lsp/framing.test.ts`: feed two concatenated JSON-RPC messages (`Content-Length: N\r\n\r\n{json}`) into the client's stdout-chunk parser and assert both parse. (Extract the parser to a pure exported `parseMessages(buffer): {messages, rest}` so it's testable without a real process.)
- [ ] **Step 2: Run — Expected: FAIL.**
- [ ] **Step 3: Implement** — swap `spawn(bin, ['--stdio'], {cwd})` → `native.process.spawn(...)`; `proc.stdout.on('data', ...)` → `proc.onStdout(...)`; `proc.stderr.on('data', ...)` → `proc.onStderr(...)`; `proc.stdin.write(payload)` → `proc.write(payload)`; `proc.on('exit', ...)` → `proc.onExit(...)`; `proc.kill()` → `proc.kill()`. Extract `parseMessages`.
- [ ] **Step 4: Run — Expected: PASS.**
- [ ] **Step 5: Commit** — `feat(lsp): spawn the language server via native.process`

---

### Task 3: Replace the fs layer (readFileSync → async native.fs) + EventEmitter

**Files:** Modify `client/studio/agent/lsp/client.ts`

- [ ] **Step 1:** Replace `import fs` usages: `fs.readFileSync(p, 'utf8')` → `await native.fs.readFile(p)`; `fs.existsSync(p)` → a `native.fs.stat(p).then(()=>true).catch(()=>false)` helper. Thread `async`/`await` through the callers (definition/references preview reads especially).
- [ ] **Step 2:** Replace `EventEmitter` with a minimal `Set<(d)=>void>` emitter (the client uses it for diagnostics/state events) — a ~15-line local `Emitter` class with `on`/`off`/`emit`.
- [ ] **Step 3:** `npx tsc --noEmit` — resolve remaining Node-builtin type errors. Expected: clean.
- [ ] **Step 4: Commit** — `feat(lsp): async native.fs + local emitter (browser-safe client)`

---

### Task 4: Resolve + spawn typescript-language-server via npx

**Files:** Modify `client/studio/agent/lsp/client.ts` (the `resolveTypescriptBinary` / `resolveBinary` functions)

- [ ] **Step 1: Write the failing test** — `tests/lsp/resolve.test.ts`: assert the spawn spec for `'typescript'` is `{ cmd: 'npx', args: ['--yes', 'typescript-language-server', '--stdio'] }` (or the chosen shape), and `'python'` returns disabled (out of scope).
- [ ] **Step 2: Run — Expected: FAIL.**
- [ ] **Step 3: Implement** — replace `resolveTypescriptBinary` (which probed node_modules) with the npx spawn spec. `binaryPath`='npx', args prefixed accordingly. Keep the `disabled` state when node/npx isn't available (best-effort — LSP degrades to empty results, never throws).
- [ ] **Step 4: Run — Expected: PASS.**
- [ ] **Step 5: Commit** — `feat(lsp): resolve typescript-language-server via npx on bundled node`

---

### Task 5: Editor registry + register the lsp* handlers

**Files:**
- Modify: `client/studio/agent/lsp/registry.ts` (browser-safe: `path` only)
- Modify: `client/studio/hooks/useSocket.ts` (register `lspDefinition`/`lspImplementation`/`lspReferences`/`lspHover` in the `handlers` map)

**Interfaces:**
- Consumes: `getEditorLspClient(workspaceRoot, language)` (registry), `languageIdForPath(path)`.
- Produces: handlers matching the api.ts contract, e.g.
  `lspDefinition: async (i) => { const lang = languageIdForPath(i.path); if (!lang) return { results: [] }; const c = await getEditorLspClient(i.cwd ?? getActiveProjectPath() ?? dir(i.path), lang); await c.openFile(i.path); return { results: await c.definition(i.path, i.line, i.character) }; }`

- [ ] **Step 1: Write the failing test** — `tests/lsp/handlers.test.ts`: mock the registry to return a fake client with a canned `definition()`; call the `lspDefinition` handler and assert it maps `{path,line,character,cwd}` → `{results}` and returns `{results:[]}` for an unknown language.
- [ ] **Step 2: Run — Expected: FAIL.**
- [ ] **Step 3: Implement** the four handlers in `useSocket.ts` (mirror the api.ts shapes; `openFile` before position requests; best-effort empty on error). Registry: keep browser-safe (`path.resolve` is fine).
- [ ] **Step 4: Run — Expected: PASS** + `npx tsc --noEmit` clean.
- [ ] **Step 5: Commit** — `feat(lsp): register editor lsp handlers (definition/references/implementation/hover)`

---

### Task 6: lspStatus surfacing

**Files:** Modify `client/studio/hooks/useCodingAgentChat.ts` (consumes `lspStatus`) + wherever the agent session tracked diagnostics.

- [ ] **Step 1:** Wire the client's state/diagnostics emitter to produce an `LspStatusSnapshot` (`state/errors/warnings/lastUpdatedAt/lastMessage`) and surface it on the existing `lspStatus` chat-header indicator. Verify against the existing consumer in `useCodingAgentChat.ts` (grep `lspStatus`).
- [ ] **Step 2:** `npx tsc --noEmit` clean; manual: the LSP indicator reflects ready/error.
- [ ] **Step 3: Commit** — `feat(lsp): surface LspStatus on the chat header`

---

### Task 7: End-to-end verification

**Files:** Create `tests/lsp/e2e-definition.test.ts` (real `typescript-language-server` on a temp fixture)

- [ ] **Step 1:** Build a temp TS fixture (`a.ts` exporting `foo`, `b.ts` importing + using it). Spawn a real editor LSP client (via npx), `openFile`, request definition on the `foo` usage in `b.ts`, assert it resolves to `a.ts` at the export. Skip if `npx`/node unavailable (mark clearly — no silent skip).
- [ ] **Step 2: Run — Expected: PASS** (allow a long timeout — ts-language-server cold start is ~seconds; npx may download on first run).
- [ ] **Step 3: Commit** — `test(lsp): e2e go-to-definition on a real ts fixture`

---

### Task 8: Ensure typescript-language-server availability

**Files:** Consider adding `typescript-language-server` + `typescript` to ugly-code deps (so `npx` resolves them offline from node_modules rather than downloading), OR document that first LSP use downloads it via npx.

- [ ] **Step 1:** Decide: bundled dep (deterministic, larger install) vs npx-on-demand (smaller, first-use download). If bundled: `pnpm add typescript-language-server typescript` and confirm the spawn resolves from node_modules/.bin via npx.
- [ ] **Step 2:** `npx tsc --noEmit` + full `tests/lsp` suite green.
- [ ] **Step 3: Commit** — `chore(lsp): provision typescript-language-server`

---

## Self-Review

**Coverage:** recover (T1) → process layer (T2) → fs/emitter (T3) → server resolution (T4) → handlers+registry (T5) → status (T6) → e2e (T7) → provisioning (T8). The orphaned `lsp*` API gets real implementations; editor go-to-definition + references + implementation + hover + status restored; python LSP explicitly deferred.

**Risks:** the sync→async fs conversion (T3) is the subtle part — audit every former `*Sync` call. npx cold-start latency (T7) — cache the client per workspace (registry already does). The recovered client may reference other deleted helpers — resolve each against the new native layer during T2/T3.
