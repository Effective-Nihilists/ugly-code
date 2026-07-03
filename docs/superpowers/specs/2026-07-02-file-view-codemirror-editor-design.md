# File-View CodeMirror Editor + LSP Navigation — Design

**Status:** approved design, pre-plan
**Date:** 2026-07-02
**Author:** brainstormed with the user

## Goal

Replace FilePanel's read-only highlight.js viewer with an editable **CodeMirror 6**
editor (editing + manual save) wired to the existing LSP handlers for **hover,
go-to-definition, go-to-implementation, and find-references**. This is "SP-A" —
the file-view half of the original ask, following the LSP restoration (which
built the handlers this consumes) and the agent-tool restoration.

## Background / current state

- `client/studio/panels/FilePanel.tsx` — a tree + read-only viewer. `openFile(path)`
  reads via `native.fs.readFile` and renders highlighted HTML (non-markdown) or
  `MdastViewer` (markdown). No editing.
- `client/studio/components/CodeEditor.tsx` — a `<textarea>`+highlight.js box used
  ONLY by the Database panel (JSON/SQL). Not reused here.
- LSP handlers exist and are proven: `client/studio/agent/lsp/handlers.ts` exports
  `lspDefinition`/`lspImplementation`/`lspReferences`/`lspHover`, driving the
  registry `LspClient` over `native.process`/`native.fs`. FilePanel runs in the
  **same renderer**, so it calls these functions directly (no socket round-trip).
- CodeMirror 6 is already bundled (`@codemirror/{state,view,commands,language,
  lang-javascript,lang-python,lang-css,lang-html,lang-markdown,autocomplete,lint,
  search,theme-one-dark}`). ugly-app's `CodeMirrorEditor` export is too high-level
  (value/onChange only) for LSP glue — build a purpose-built component on the raw
  packages.

## Architecture

Three new focused components + one small contract addition; FilePanel orchestrates.

### `client/studio/components/CodeMirrorFileEditor.tsx`
A purpose-built CM6 editor.
- Props: `{ path: string; value: string; onChange(next: string): void; onSave(): void;
  onDefinition(pos: EditorPos): void; onImplementation(pos: EditorPos): void;
  onReferences(pos: EditorPos): void; onHover(pos: EditorPos): Promise<string | null>;
  readOnly?: boolean }` where `EditorPos = { line: number; character: number }`
  (0-indexed, LSP convention).
- Extensions: `languageForPath(path)` (`.ts/.tsx/.js/.jsx/.mjs/.cjs`→lang-javascript
  (typescript config), `.py`→python, `.css/.scss`→css, `.html`→html, `.md`→markdown,
  else none), light/dark theme from `ThemeProvider` (oneDark in dark mode), line
  numbers, history, search, default keymap. Custom keymap: `Cmd/Ctrl-S`→onSave,
  `F12`→onDefinition, `Cmd/Ctrl-F12`→onImplementation, `Shift-F12`→onReferences.
  `hoverTooltip` extension → `onHover` (renders returned markdown/text).
- Owns the `EditorView`; reconfigures language/theme on change; `value` prop drives
  external reloads (dispatch a full-doc replace when it differs from the doc).
- Exposes an imperative handle (`scrollToLine(line1)`, `flashLine(line1)`) so
  FilePanel can navigate after go-to-definition.

### `client/studio/components/editorLsp.ts`
Pure glue between the editor and the handlers. Functions:
- `toLspResults(raw: LspLocation[]): {path,line,character,preview?}[]` (identity/format).
- `runDefinition(path, pos, content, projectPath)` → `lspDefinition({path, line, character, cwd, content}, projectPath)`; same for implementation/references/hover.
- These pass the **live buffer `content`** (see §Unsaved-buffer accuracy). Pure
  argument-shaping + result-formatting is unit-tested with mocked handlers.

### `client/studio/components/ReferencesPanel.tsx`
Bottom results panel. Props `{ results: {path,line,character,preview?}[]; onPick(r): void; onClose(): void }`. Groups rows by file, renders `path:line — preview`. Row click → `onPick` (FilePanel navigates). Collapsible; empty state hidden.

### FilePanel integration (`FilePanel.tsx`)
- File state gains: `dirty`, `savedValue`, `diskMtime`, `references` (list + open flag).
- Render: non-markdown → `CodeMirrorFileEditor`; markdown keeps `MdastViewer`
  rendered view with the existing Preview/Raw toggle, where **Raw = the CM6 editor**
  (editable, savable). A size guard (>1MB) renders read-only.
- `onDefinition`/`onImplementation`: call `editorLsp.runDefinition(...)`; on a hit,
  `openFile(targetPath)` (existing), then `scrollToLine`+`flashLine` on the editor.
- `onReferences`: fill `references`, open `ReferencesPanel`; row pick navigates.
- Header: file path + a **dirty dot** + Save affordance; the external-change banner
  when applicable.

## Save, dirty state & external changes

- `dirty` = current doc ≠ `savedValue`. `Cmd/Ctrl-S` (or a Save button) →
  `native.fs.writeFile(path, value)`, set `savedValue`, refresh `diskMtime`, clear dirty.
- While a file is open, poll `native.fs.stat(path).mtimeMs` every ~2s. If it differs
  from `diskMtime` (an external write, e.g. the agent):
  - **clean buffer** → auto-reload (re-read + replace doc + update mtime).
  - **dirty buffer** → show a banner: "Changed on disk — [Reload] [Keep mine]".
    Reload discards local edits; Keep mine updates `diskMtime` so the banner clears
    (next save overwrites). No silent overwrite either way.

## Unsaved-buffer LSP accuracy

The handlers `openFile(path)` from disk, so navigation on unsaved edits would be
stale. Add an **optional `content: string`** to the `lspDefinition`,
`lspImplementation`, `lspReferences`, and `lspHover` input schemas in
`client/studio/shared/api.ts`. In `handlers.ts`, when `content` is present the
handler calls `client.openFile(path, content)` (the client already supports a
content override → didChange) before the position request. The editor passes the
live buffer; the agent's grep/lsp tools pass nothing (disk, unchanged behavior).
Backward-compatible; the only place SP-A touches the LSP contract.

## Testing

- **Unit (pure logic):**
  - `languageForPath` — extension → CM language (+ plain fallback).
  - position mapping — CM offset ↔ `{line,character}` round-trips.
  - `editorLsp` — argument shaping (passes `content`, `cwd`) + result formatting,
    against mocked handlers.
  - dirty/save transitions — edit→dirty, save→clean+mtime.
  - external-change decision — `(clean|dirty, mtime changed?)` → `reload|banner|noop`.
  - handler `content` passthrough — `lspHover({...,content})` calls
    `client.openFile(path, content)` (extend `tests/unit/lsp/handlers.test.ts`).
- **Component smoke:** `CodeMirrorFileEditor` mounts, renders `value`, fires `onSave`
  on Cmd-S (jsdom/Testing Library).
- **Deferred to manual/e2e:** live in-editor hover/go-to-definition against a real
  language server (the CM6 view + real LSP), mirroring the existing
  `tests/unit/lsp/e2e-definition.test.ts` pattern — a follow-up, not blocking.

## Risks & open questions

- CM6 view lifecycle in React (create once, dispatch updates; avoid re-creating on
  every render) — the component must manage the `EditorView` imperatively.
- `path` module usage in the browser bundle is already fine (LSP restoration proved
  it). CM6 is browser-native.
- The mtime poll is a simple interval; if it proves chatty, switch to a native fs
  watch later (out of scope now).
- Rename (`lspRename`) is intentionally **out of scope** for SP-A (its own inline-UI
  + multi-file-apply follow-up).

## Out of scope

- Symbol rename, multi-tab editing, diff view, and a native file watcher.
- Wiring LSP into the agent tools (done separately in the tool restoration).
