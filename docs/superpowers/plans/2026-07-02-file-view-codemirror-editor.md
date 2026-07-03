# File-View CodeMirror Editor + LSP Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace FilePanel's read-only viewer with an editable CodeMirror 6 editor (editing + manual save) wired to the LSP handlers for hover, go-to-definition, go-to-implementation, and find-references.

**Architecture:** A purpose-built CM6 component (raw `@codemirror/*`) + pure glue modules for language selection, LSP calls, and edit-state decisions, orchestrated by FilePanel. The LSP handlers gain an optional `content` field so the editor can navigate against unsaved edits. Pure logic is unit-tested; the React views (CM6 editor, references panel, FilePanel wiring) are verified by tsc + manual (the repo has no DOM test harness).

**Tech Stack:** TypeScript, React, CodeMirror 6 (`@codemirror/{state,view,commands,language,lang-javascript,lang-python,lang-css,lang-html,lang-markdown,search}`, `@codemirror/theme-one-dark`), the existing LSP handlers (`client/studio/agent/lsp/handlers.ts`), `native.fs`, vitest.

## Global Constraints

- Runs in the **browser** (studio renderer) — no Node builtins; `path` is fine. CM6 is browser-native.
- Tests are **pure-logic only** (vitest, node env, `tests/unit/**`) — the repo has no jsdom/@testing-library. Do NOT add one; verify React views via `npx tsc --noEmit` + manual.
- FilePanel calls the LSP handlers **directly** (same renderer): `import { lspDefinition, lspImplementation, lspReferences, lspHover } from '../agent/lsp/handlers'`.
- LSP positions are **0-indexed** (`{line, character}`); results are 1-indexed (handlers already `+1`). CM6 lines are 1-indexed.
- `LspClient.openFile(filePath, content?)` already supports a content override (didChange). Confirmed at `client/studio/agent/lsp/client.ts:517`.
- Commit after every task. Work on `main` (repo convention).
- Rename (`lspRename`) is OUT OF SCOPE.

---

## File structure

- `client/studio/agent/lsp/handlers.ts` — add optional `content` to `LspLocationInput` + pass to `openFile` (Task 1).
- `client/studio/shared/api.ts` — add `content` to the 4 lsp input schemas (Task 1).
- `client/studio/components/editorLsp.ts` — `languageForPath` + `runDefinition/Implementation/References/Hover` glue (Task 2).
- `client/studio/components/fileEditState.ts` — `isDirty` + `externalChangeAction` (Task 3).
- `client/studio/components/ReferencesPanel.tsx` + `groupReferences` (Task 4).
- `client/studio/components/CodeMirrorFileEditor.tsx` — the CM6 editor (Task 5).
- `client/studio/panels/FilePanel.tsx` — integrate editor + save + dirty + external-change + LSP nav (Task 6).
- `tests/unit/lsp/handlers.test.ts` (extend), `tests/unit/editor/*.test.ts` (new).

---

### Task 1: LSP handlers accept optional `content` (unsaved-buffer accuracy)

**Files:**
- Modify: `client/studio/agent/lsp/handlers.ts` (add `content?` to `LspLocationInput`; pass to `openFile`)
- Modify: `client/studio/shared/api.ts` (add `content` to `lspDefinition`/`lspImplementation`/`lspReferences`/`lspHover` inputs)
- Test: `tests/unit/lsp/handlers.test.ts` (extend)

**Interfaces:**
- Produces: `LspLocationInput` gains `content?: string`. Handlers call `client.openFile(input.path, input.content)`.

- [ ] **Step 1: Write the failing test** — append to `tests/unit/lsp/handlers.test.ts`:

```ts
describe('unsaved-buffer content passthrough', () => {
  it('lspHover syncs the live buffer via openFile(path, content)', async () => {
    const out = await lspHover(
      { path: '/proj/a.ts', line: 2, character: 5, cwd: '/proj', content: 'const edited = 1;' },
      '/proj',
    );
    expect(out).toEqual({ contents: '```ts\nfunction foo(): void\n```' });
    expect(fakeClient.openFile).toHaveBeenCalledWith('/proj/a.ts', 'const edited = 1;');
  });
  it('lspDefinition without content opens from disk (content undefined)', async () => {
    await lspDefinition({ path: '/proj/b.ts', line: 0, character: 2, cwd: '/proj' }, '/proj');
    expect(fakeClient.openFile).toHaveBeenCalledWith('/proj/b.ts', undefined);
  });
});
```

(`fakeClient.openFile` is the existing mock in this file — it already records calls.)

- [ ] **Step 2: Run — Expected: FAIL** (openFile called with 1 arg). `npx vitest run tests/unit/lsp/handlers.test.ts`

- [ ] **Step 3: Implement** — in `handlers.ts`, add `content?: string;` to `interface LspLocationInput`. In `locations(...)` and `lspHover(...)`, change `await client.openFile(input.path);` → `await client.openFile(input.path, input.content);`. In `api.ts`, add `content: z.string().optional(),` to each of the 4 lsp input `z.object({...})` blocks (definition, implementation, references, hover).

- [ ] **Step 4: Run — Expected: PASS** + `npx tsc --noEmit` clean.
- [ ] **Step 5: Commit** — `feat(lsp): handlers accept optional buffer content for unsaved-edit accuracy`

---

### Task 2: `editorLsp` — language selection + LSP glue

**Files:**
- Create: `client/studio/components/editorLsp.ts`
- Test: `tests/unit/editor/editorLsp.test.ts`

**Interfaces:**
- Consumes: `lspDefinition`/`lspImplementation`/`lspReferences`/`lspHover` from `../agent/lsp/handlers`.
- Produces:
  - `languageForPath(path: string): 'javascript' | 'python' | 'css' | 'html' | 'markdown' | null`
  - `type EditorPos = { line: number; character: number }` (0-indexed)
  - `runDefinition(path, pos, content, projectPath): Promise<LspResult[]>` (and `runImplementation`, `runReferences`); `runHover(path, pos, content, projectPath): Promise<string | null>`
  - `type LspResult = { path: string; line: number; character: number; preview?: string }`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/editor/editorLsp.test.ts
import { describe, it, expect, vi } from 'vitest';
vi.mock('../../../client/studio/agent/lsp/handlers', () => ({
  lspDefinition: vi.fn(async () => ({ results: [{ path: '/p/a.ts', line: 3, character: 5, preview: 'export function foo' }] })),
  lspImplementation: vi.fn(async () => ({ results: [] })),
  lspReferences: vi.fn(async () => ({ results: [{ path: '/p/b.ts', line: 9, character: 2 }] })),
  lspHover: vi.fn(async () => ({ contents: '```ts\nfoo\n```' })),
}));
import { languageForPath, runDefinition, runHover } from '../../../client/studio/components/editorLsp';
import { lspDefinition, lspHover } from '../../../client/studio/agent/lsp/handlers';

describe('languageForPath', () => {
  it('maps extensions to CM languages', () => {
    expect(languageForPath('a.ts')).toBe('javascript');
    expect(languageForPath('a.tsx')).toBe('javascript');
    expect(languageForPath('a.py')).toBe('python');
    expect(languageForPath('a.css')).toBe('css');
    expect(languageForPath('a.md')).toBe('markdown');
    expect(languageForPath('a.rs')).toBeNull();
  });
});

describe('editorLsp glue', () => {
  it('runDefinition passes content + cwd and returns results', async () => {
    const out = await runDefinition('/p/x.ts', { line: 3, character: 9 }, 'BUF', '/p');
    expect(lspDefinition).toHaveBeenCalledWith(
      { path: '/p/x.ts', line: 3, character: 9, cwd: '/p', content: 'BUF' }, '/p',
    );
    expect(out[0]).toMatchObject({ path: '/p/a.ts', line: 3 });
  });
  it('runHover returns the contents string', async () => {
    const s = await runHover('/p/x.ts', { line: 1, character: 1 }, 'BUF', '/p');
    expect(s).toMatch(/foo/);
    expect(lspHover).toHaveBeenCalledWith({ path: '/p/x.ts', line: 1, character: 1, cwd: '/p', content: 'BUF' }, '/p');
  });
});
```

- [ ] **Step 2: Run — Expected: FAIL.**
- [ ] **Step 3: Implement**

```ts
// client/studio/components/editorLsp.ts
import { lspDefinition, lspImplementation, lspReferences, lspHover } from '../agent/lsp/handlers';

export type CmLanguage = 'javascript' | 'python' | 'css' | 'html' | 'markdown';
export interface EditorPos { line: number; character: number }
export interface LspResult { path: string; line: number; character: number; preview?: string }

export function languageForPath(path: string): CmLanguage | null {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].includes(ext)) return 'javascript';
  if (ext === 'py') return 'python';
  if (ext === 'css' || ext === 'scss') return 'css';
  if (ext === 'html' || ext === 'htm' || ext === 'xml') return 'html';
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  return null;
}

function input(path: string, pos: EditorPos, content: string, projectPath: string | null) {
  return { path, line: pos.line, character: pos.character, ...(projectPath ? { cwd: projectPath } : {}), content };
}

async function locate(
  fn: typeof lspDefinition, path: string, pos: EditorPos, content: string, projectPath: string | null,
): Promise<LspResult[]> {
  const { results } = await fn(input(path, pos, content, projectPath), projectPath);
  return results;
}

export const runDefinition = (p: string, pos: EditorPos, c: string, root: string | null) => locate(lspDefinition, p, pos, c, root);
export const runImplementation = (p: string, pos: EditorPos, c: string, root: string | null) => locate(lspImplementation, p, pos, c, root);
export const runReferences = (p: string, pos: EditorPos, c: string, root: string | null) => locate(lspReferences, p, pos, c, root);

export async function runHover(p: string, pos: EditorPos, c: string, root: string | null): Promise<string | null> {
  const { contents } = await lspHover(input(p, pos, c, root), root);
  return contents;
}
```

- [ ] **Step 4: Run — Expected: PASS** + `npx tsc --noEmit` clean.
- [ ] **Step 5: Commit** — `feat(editor): editorLsp glue (language map + LSP calls with buffer content)`

---

### Task 3: `fileEditState` — dirty + external-change decisions

**Files:**
- Create: `client/studio/components/fileEditState.ts`
- Test: `tests/unit/editor/fileEditState.test.ts`

**Interfaces:**
- Produces:
  - `isDirty(current: string, saved: string): boolean`
  - `externalChangeAction(opts: { dirty: boolean; mtimeChanged: boolean }): 'reload' | 'banner' | 'noop'`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/editor/fileEditState.test.ts
import { describe, it, expect } from 'vitest';
import { isDirty, externalChangeAction } from '../../../client/studio/components/fileEditState';

describe('isDirty', () => {
  it('true only when current differs from saved', () => {
    expect(isDirty('a', 'a')).toBe(false);
    expect(isDirty('a ', 'a')).toBe(true);
  });
});

describe('externalChangeAction', () => {
  it('no disk change -> noop', () => {
    expect(externalChangeAction({ dirty: false, mtimeChanged: false })).toBe('noop');
    expect(externalChangeAction({ dirty: true, mtimeChanged: false })).toBe('noop');
  });
  it('disk changed + clean buffer -> reload', () => {
    expect(externalChangeAction({ dirty: false, mtimeChanged: true })).toBe('reload');
  });
  it('disk changed + dirty buffer -> banner', () => {
    expect(externalChangeAction({ dirty: true, mtimeChanged: true })).toBe('banner');
  });
});
```

- [ ] **Step 2: Run — Expected: FAIL.**
- [ ] **Step 3: Implement**

```ts
// client/studio/components/fileEditState.ts
export function isDirty(current: string, saved: string): boolean {
  return current !== saved;
}

export function externalChangeAction(opts: { dirty: boolean; mtimeChanged: boolean }): 'reload' | 'banner' | 'noop' {
  if (!opts.mtimeChanged) return 'noop';
  return opts.dirty ? 'banner' : 'reload';
}
```

- [ ] **Step 4: Run — Expected: PASS.**
- [ ] **Step 5: Commit** — `feat(editor): fileEditState (dirty + external-change decisions)`

---

### Task 4: `ReferencesPanel` + `groupReferences`

**Files:**
- Create: `client/studio/components/ReferencesPanel.tsx` (exports the pure `groupReferences` + the component)
- Test: `tests/unit/editor/groupReferences.test.ts`

**Interfaces:**
- Consumes: `LspResult` from `./editorLsp`.
- Produces: `groupReferences(results: LspResult[]): { path: string; hits: LspResult[] }[]` (grouped by file, file order = first occurrence). Component `ReferencesPanel({ results, onPick, onClose })`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/editor/groupReferences.test.ts
import { describe, it, expect } from 'vitest';
import { groupReferences } from '../../../client/studio/components/ReferencesPanel';

describe('groupReferences', () => {
  it('groups hits by file preserving first-seen order', () => {
    const g = groupReferences([
      { path: 'b.ts', line: 1, character: 0 },
      { path: 'a.ts', line: 5, character: 2 },
      { path: 'b.ts', line: 9, character: 1 },
    ]);
    expect(g.map((x) => x.path)).toEqual(['b.ts', 'a.ts']);
    expect(g[0].hits).toHaveLength(2);
    expect(g[1].hits).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run — Expected: FAIL.**
- [ ] **Step 3: Implement** — `ReferencesPanel.tsx`:

```tsx
import React from 'react';
import type { LspResult } from './editorLsp';

export function groupReferences(results: LspResult[]): { path: string; hits: LspResult[] }[] {
  const order: string[] = [];
  const by = new Map<string, LspResult[]>();
  for (const r of results) {
    if (!by.has(r.path)) { by.set(r.path, []); order.push(r.path); }
    by.get(r.path)!.push(r);
  }
  return order.map((path) => ({ path, hits: by.get(path)! }));
}

export function ReferencesPanel({
  results, onPick, onClose,
}: { results: LspResult[]; onPick: (r: LspResult) => void; onClose: () => void }): React.ReactElement | null {
  if (results.length === 0) return null;
  const groups = groupReferences(results);
  return (
    <div data-id="references-panel" style={S.root}>
      <div style={S.header}>
        <span>{results.length} reference{results.length === 1 ? '' : 's'}</span>
        <button data-id="references-close" onClick={onClose} style={S.close}>Close</button>
      </div>
      <div style={S.list}>
        {groups.map((g) => (
          <div key={g.path}>
            <div style={S.file}>{g.path}</div>
            {g.hits.map((h, i) => (
              <div key={i} data-id="reference-row" style={S.row} onClick={() => onPick(h)}>
                <span style={S.loc}>{h.line}</span>
                <span style={S.preview}>{h.preview ?? ''}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  root: { flexShrink: 0, maxHeight: 220, display: 'flex', flexDirection: 'column', borderTop: '1px solid var(--border)', background: 'var(--bg-panel)', fontFamily: 'var(--font-mono)', fontSize: 12 },
  header: { flexShrink: 0, display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 12px', color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' },
  close: { background: 'transparent', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: 12 },
  list: { overflow: 'auto' },
  file: { padding: '4px 12px', color: 'var(--text-secondary)', fontWeight: 600, background: 'var(--bg-secondary)' },
  row: { display: 'flex', gap: 10, padding: '3px 12px 3px 24px', cursor: 'pointer', color: 'var(--text-primary)' },
  loc: { color: 'var(--text-muted)', minWidth: 32 },
  preview: { color: 'var(--text-secondary)', whiteSpace: 'pre', overflow: 'hidden', textOverflow: 'ellipsis' },
};
```

- [ ] **Step 4: Run — Expected: PASS** + `npx tsc --noEmit` clean.
- [ ] **Step 5: Commit** — `feat(editor): ReferencesPanel + groupReferences`

---

### Task 5: `CodeMirrorFileEditor` component

**Files:**
- Create: `client/studio/components/CodeMirrorFileEditor.tsx`
- (No unit test — no DOM harness; verify with `npx tsc --noEmit` + manual.)

**Interfaces:**
- Consumes: `languageForPath`, `EditorPos`, `runHover` from `./editorLsp`; `useTheme` from `../theme/ThemeProvider`.
- Produces: `CodeMirrorFileEditor` (forwardRef) with props `{ path; value; onChange(next): void; onSave(): void; onDefinition(pos): void; onImplementation(pos): void; onReferences(pos): void; hoverAt(pos): Promise<string | null>; readOnly?: boolean }` and an imperative handle `{ revealLine(line1: number): void }`.

- [ ] **Step 1: Implement** (create the file):

```tsx
import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, hoverTooltip } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { searchKeymap } from '@codemirror/search';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { markdown } from '@codemirror/lang-markdown';
import { oneDark } from '@codemirror/theme-one-dark';
import { useTheme } from '../theme/ThemeProvider';
import { languageForPath, type CmLanguage, type EditorPos } from './editorLsp';

export interface CmEditorHandle { revealLine(line1: number): void }

interface Props {
  path: string;
  value: string;
  onChange(next: string): void;
  onSave(): void;
  onDefinition(pos: EditorPos): void;
  onImplementation(pos: EditorPos): void;
  onReferences(pos: EditorPos): void;
  hoverAt(pos: EditorPos): Promise<string | null>;
  readOnly?: boolean;
}

function langExt(lang: CmLanguage | null) {
  switch (lang) {
    case 'javascript': return [javascript({ typescript: true, jsx: true })];
    case 'python': return [python()];
    case 'css': return [css()];
    case 'html': return [html()];
    case 'markdown': return [markdown()];
    default: return [];
  }
}

/** CM offset → 0-indexed LSP position. */
function posAt(view: EditorView, offset: number): EditorPos {
  const line = view.state.doc.lineAt(offset);
  return { line: line.number - 1, character: offset - line.from };
}

export const CodeMirrorFileEditor = forwardRef<CmEditorHandle, Props>(function CodeMirrorFileEditor(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const theme = useRef(new Compartment());
  const { mode } = useTheme();
  // Keep the latest callbacks reachable from the (once-built) keymap.
  const cb = useRef(props);
  cb.current = props;

  useImperativeHandle(ref, () => ({
    revealLine(line1: number) {
      const v = viewRef.current;
      if (!v) return;
      const line = v.state.doc.line(Math.max(1, Math.min(line1, v.state.doc.lines)));
      v.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: 'center' }) });
      v.focus();
    },
  }), []);

  // Build the view once per file (path change) — value updates are dispatched below.
  useEffect(() => {
    if (!host.current) return;
    const posOf = (v: EditorView): EditorPos => posAt(v, v.state.selection.main.head);
    const state = EditorState.create({
      doc: props.value,
      extensions: [
        lineNumbers(), highlightActiveLine(), history(),
        keymap.of([
          { key: 'Mod-s', preventDefault: true, run: () => { cb.current.onSave(); return true; } },
          { key: 'F12', preventDefault: true, run: (v) => { cb.current.onDefinition(posOf(v)); return true; } },
          { key: 'Mod-F12', preventDefault: true, run: (v) => { cb.current.onImplementation(posOf(v)); return true; } },
          { key: 'Shift-F12', preventDefault: true, run: (v) => { cb.current.onReferences(posOf(v)); return true; } },
          ...defaultKeymap, ...historyKeymap, ...searchKeymap,
        ]),
        ...langExt(languageForPath(props.path)),
        hoverTooltip(async (v, pos) => {
          const text = await cb.current.hoverAt(posAt(v, pos));
          if (!text) return null;
          return { pos, create: () => { const dom = document.createElement('div'); dom.className = 'cm-lsp-hover'; dom.textContent = text; dom.style.cssText = 'padding:6px 8px;max-width:520px;white-space:pre-wrap;font-family:var(--font-mono);font-size:12px'; return { dom }; } };
        }),
        theme.current.of(mode === 'dark' ? oneDark : []),
        EditorView.editable.of(!props.readOnly),
        EditorView.updateListener.of((u) => { if (u.docChanged) cb.current.onChange(u.state.doc.toString()); }),
      ],
    });
    const view = new EditorView({ state, parent: host.current });
    viewRef.current = view;
    return () => { view.destroy(); viewRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rebuild only on file switch
  }, [props.path]);

  // External value change (reload) → replace the doc when it diverges.
  useEffect(() => {
    const v = viewRef.current;
    if (v && props.value !== v.state.doc.toString()) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: props.value } });
    }
  }, [props.value]);

  // Theme toggle without rebuilding the view.
  useEffect(() => {
    viewRef.current?.dispatch({ effects: theme.current.reconfigure(mode === 'dark' ? oneDark : []) });
  }, [mode]);

  return <div ref={host} data-id="code-editor" style={{ flex: 1, minHeight: 0, overflow: 'auto' }} />;
});
```

- [ ] **Step 2: Verify** — `npx tsc --noEmit` clean; `npx vitest run` (existing tests unaffected).
- [ ] **Step 3: Commit** — `feat(editor): CodeMirrorFileEditor (CM6 view + keymaps + hover)`

---

### Task 6: FilePanel integration — editing, save, external change, LSP nav

**Files:**
- Modify: `client/studio/panels/FilePanel.tsx`
- (No unit test — React view; the logic it uses is tested in Tasks 2-4. Verify with `npx tsc --noEmit` + manual.)

**Interfaces:**
- Consumes: `CodeMirrorFileEditor` + `CmEditorHandle` (Task 5), `ReferencesPanel` (Task 4), `runDefinition`/`runImplementation`/`runReferences`/`runHover`/`languageForPath`/`LspResult`/`EditorPos` (Task 2), `isDirty`/`externalChangeAction` (Task 3), `native.fs`, `getActiveProjectPath`.

- [ ] **Step 1: Implement** — extend `FilePanel.tsx`:
  1. Add state: `const [dirtyValue, setDirtyValue] = React.useState<string | null>(null)` (null = not editing/clean), `const [savedValue, setSavedValue] = React.useState('')`, `const [diskMtime, setDiskMtime] = React.useState<number | null>(null)`, `const [banner, setBanner] = React.useState(false)`, `const [refs, setRefs] = React.useState<LspResult[] | null>(null)`, `const editorRef = React.useRef<CmEditorHandle>(null)`.
  2. In `openFile`, after reading text: `setSavedValue(text); setDirtyValue(null); setBanner(false); setRefs(null);` and `native.fs.stat(path).then((s) => setDiskMtime(s.mtimeMs)).catch(() => setDiskMtime(null));`.
  3. `const cur = () => dirtyValue ?? savedValue;` and `const dirty = dirtyValue != null && isDirty(dirtyValue, savedValue);`.
  4. `save`:

```tsx
const save = React.useCallback(async () => {
  if (!selected || dirtyValue == null) return;
  await native.fs.writeFile(selected, dirtyValue);
  setSavedValue(dirtyValue);
  setDirtyValue(null);
  try { const s = await native.fs.stat(selected); setDiskMtime(s.mtimeMs); } catch { /* ignore */ }
}, [selected, dirtyValue]);
```

  5. External-change poll (only while a non-markdown file is open):

```tsx
React.useEffect(() => {
  if (!selected || diskMtime == null) return;
  const id = setInterval(async () => {
    try {
      const s = await native.fs.stat(selected);
      if (s.mtimeMs === diskMtime) return;
      const action = externalChangeAction({ dirty: dirtyValue != null && isDirty(dirtyValue, savedValue), mtimeChanged: true });
      if (action === 'reload') {
        const text = await native.fs.readFile(selected);
        setSavedValue(text); setDirtyValue(null); setDiskMtime(s.mtimeMs);
      } else if (action === 'banner') {
        setBanner(true);
      }
    } catch { /* file gone; ignore */ }
  }, 2000);
  return () => clearInterval(id);
}, [selected, diskMtime, dirtyValue, savedValue]);
```

  6. LSP nav helpers (project root + navigate):

```tsx
const navTo = React.useCallback(async (r: LspResult) => {
  if (r.path !== selected) await openFile(r.path);
  // openFile is async; reveal after the editor remounts on the new value.
  requestAnimationFrame(() => editorRef.current?.revealLine(r.line));
}, [selected, openFile]);

const onDefinition = async (pos: EditorPos) => { const hits = await runDefinition(selected!, pos, cur(), root); if (hits[0]) await navTo(hits[0]); };
const onImplementation = async (pos: EditorPos) => { const hits = await runImplementation(selected!, pos, cur(), root); if (hits[0]) await navTo(hits[0]); };
const onReferences = async (pos: EditorPos) => { setRefs(await runReferences(selected!, pos, cur(), root)); };
const hoverAt = (pos: EditorPos) => runHover(selected!, pos, cur(), root);
```

  7. Render: for a selected non-markdown file under the size guard, replace the `<pre>` branch with:

```tsx
<CodeMirrorFileEditor
  ref={editorRef}
  path={selected}
  value={cur()}
  onChange={(next) => setDirtyValue(next)}
  onSave={() => void save()}
  onDefinition={(p) => void onDefinition(p)}
  onImplementation={(p) => void onImplementation(p)}
  onReferences={(p) => void onReferences(p)}
  hoverAt={hoverAt}
/>
```

  Add a dirty dot in `S.viewerHeader` (`{dirty && <span title="unsaved">●</span>}`) and, when `banner`, a bar above the editor: "Changed on disk —" with **Reload** (`const t = await native.fs.readFile(selected); setSavedValue(t); setDirtyValue(null); setBanner(false); const s = await native.fs.stat(selected); setDiskMtime(s.mtimeMs);`) and **Keep mine** (`const s = await native.fs.stat(selected); setDiskMtime(s.mtimeMs); setBanner(false);`). Below the editor, render `{refs && <ReferencesPanel results={refs} onPick={(r) => void navTo(r)} onClose={() => setRefs(null)} />}`.
  8. Size guard: `const editable = content.length <= 1_000_000;` — over the limit, keep the read-only highlighted `<pre>`. Markdown keeps the Preview/Raw toggle where **Raw** now renders `CodeMirrorFileEditor` (savable) instead of the read-only `<pre>`.
  9. `const root = getActiveProjectPath();` near the top of the component.

- [ ] **Step 2: Verify** — `npx tsc --noEmit` clean; `npx vitest run` all green.
- [ ] **Step 3: Commit** — `feat(editor): editable FilePanel — CM6 editing, save, external-change banner, LSP navigation`

---

## Self-Review

**Coverage:** spec §Components → Tasks 2 (editorLsp), 4 (ReferencesPanel), 5 (CodeMirrorFileEditor); §FilePanel integration → Task 6; §Save/dirty/external-change → Tasks 3 + 6; §Unsaved-buffer accuracy → Task 1; §Testing → pure-logic tests in Tasks 1-4 (component/view verified by tsc + manual, matching the repo's no-DOM-harness convention). Interactions (hover/def/impl/refs) all wired in Tasks 5-6; rename excluded per spec.

**Types:** `EditorPos`/`LspResult`/`CmLanguage` defined in Task 2 and reused verbatim in Tasks 4-6. `CmEditorHandle.revealLine(line1)` defined in Task 5 and called in Task 6. Handler `content?` added in Task 1 and passed by `editorLsp.input()` in Task 2.

**Risks:** the CM6 keymap captures the latest callbacks via a ref (built once per file); `revealLine` after cross-file nav uses `requestAnimationFrame` to run after the editor remounts on the new `value`. The mtime poll is a 2s interval per open file. These are verified manually; a live in-editor LSP e2e (real server) is a deferred follow-up mirroring `tests/unit/lsp/e2e-definition.test.ts`.
