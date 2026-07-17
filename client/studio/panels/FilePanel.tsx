import React from 'react';
import hljs from 'highlight.js/lib/common';
import 'highlight.js/styles/github.css';
import { native } from 'ugly-app/native';
import { MdastViewer } from 'ugly-app/markdown/client';
import { getActiveProjectPath } from '../hooks/useSocket';
import { sessionWorktreeDir } from '../agent/sessionWorkspace';
import { useTheme } from '../theme/ThemeProvider';
import { OpenUriContext } from '../components/LinkifiedText';
import { useIsMobile } from '../hooks/useIsMobile';
import { FileIcon } from './navIcons';
import { CodeMirrorFileEditor, type CmEditorHandle } from '../components/CodeMirrorFileEditor';
import { ReferencesPanel } from '../components/ReferencesPanel';
import { GitBranch } from 'lucide-react';
import { CodebaseSearch } from './CodebaseSearch';
import {
  runDefinition,
  runImplementation,
  runReferences,
  runHover,
  type LspResult,
  type EditorPos,
} from '../components/editorLsp';
import { isDirty, externalChangeAction } from '../components/fileEditState';
import { ContextMenu, ConfirmDialog, type ContextMenuItem } from '../system';
import { revealInFinder, trashPath } from '../native/fsActions';
import { useIsLocalProject } from '../state/recentProjects';
import { fileManagerName } from '../utils/platform';

const MAX_EDITABLE_BYTES = 1_000_000;

function isMarkdown(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return ext === 'md' || ext === 'markdown';
}

type MediaKind = 'image' | 'video' | 'audio';
const MEDIA_EXT: Record<string, { kind: MediaKind; mime: string }> = {
  png: { kind: 'image', mime: 'image/png' }, jpg: { kind: 'image', mime: 'image/jpeg' },
  jpeg: { kind: 'image', mime: 'image/jpeg' }, gif: { kind: 'image', mime: 'image/gif' },
  webp: { kind: 'image', mime: 'image/webp' }, bmp: { kind: 'image', mime: 'image/bmp' },
  ico: { kind: 'image', mime: 'image/x-icon' }, avif: { kind: 'image', mime: 'image/avif' },
  svg: { kind: 'image', mime: 'image/svg+xml' },
  mp4: { kind: 'video', mime: 'video/mp4' }, webm: { kind: 'video', mime: 'video/webm' },
  mov: { kind: 'video', mime: 'video/quicktime' }, m4v: { kind: 'video', mime: 'video/x-m4v' },
  ogv: { kind: 'video', mime: 'video/ogg' },
  mp3: { kind: 'audio', mime: 'audio/mpeg' }, wav: { kind: 'audio', mime: 'audio/wav' },
  ogg: { kind: 'audio', mime: 'audio/ogg' }, m4a: { kind: 'audio', mime: 'audio/mp4' },
  aac: { kind: 'audio', mime: 'audio/aac' }, flac: { kind: 'audio', mime: 'audio/flac' },
};
/** Media type for a path by extension, or null for a normal (text) file. */
function mediaInfo(path: string): { kind: MediaKind; mime: string } | null {
  return MEDIA_EXT[path.split('.').pop()?.toLowerCase() ?? ''] ?? null;
}

/** Rendered markdown via ugly-app's MdastViewer (needs an explicit measured width;
 *  mirrors CodingAgentChat's ChatMarkdown so it renders identically + safely). */
function MarkdownView({ text }: { text: string }): React.ReactElement {
  const ref = React.useRef<HTMLDivElement>(null);
  const [width, setWidth] = React.useState(0);
  const { mode } = useTheme();
  const openUri = React.useContext(OpenUriContext);
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setWidth(Math.max(200, e.contentRect.width));
    });
    ro.observe(el);
    return () => { ro.disconnect(); };
  }, []);
  const handleOpenUri = React.useMemo(
    () => (openUri ? (uri: string): Promise<void> => { openUri(uri); return Promise.resolve(); } : undefined),
    [openUri],
  );
  return (
    <div ref={ref} className="us-md" style={{ width: '100%', minWidth: 0, overflow: 'auto', padding: 14, flex: 1, minHeight: 0 }}>
      {width > 0 && (
        <MdastViewer width={width} markdown={text} isDark={mode === 'dark'} {...(handleOpenUri ? { openUri: handleOpenUri } : {})} />
      )}
    </div>
  );
}

// Map a file extension → a highlight.js language id (best-effort; falls back to
// auto-detection). Keeps highlighting fast + accurate for the common cases.
const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', css: 'css', scss: 'scss', html: 'xml', xml: 'xml', md: 'markdown', markdown: 'markdown',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp',
  sh: 'bash', bash: 'bash', zsh: 'bash', yml: 'yaml', yaml: 'yaml', toml: 'ini', sql: 'sql', php: 'php', swift: 'swift',
};
const MAX_HIGHLIGHT_BYTES = 400_000; // skip highlighting very large files (perf)

function highlightFile(path: string, text: string): string {
  const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  if (text.length > MAX_HIGHLIGHT_BYTES) return esc(text);
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const lang = EXT_LANG[ext];
  try {
    return lang && hljs.getLanguage(lang)
      ? hljs.highlight(text, { language: lang }).value
      : hljs.highlightAuto(text).value;
  } catch {
    return esc(text);
  }
}

// A read-only file browser for the open project, over the native fs bridge:
// a collapsible directory tree on the left, the selected file's contents on the
// right. Session-scoped (rooted at the open project path). Mirrors the monolith
// Files tab's browse affordance without the full code editor.

interface Entry {
  name: string;
  path: string;
  isDir: boolean;
}

const IGNORED = new Set(['.git', 'node_modules', '.next', 'dist', '.turbo', '.cache']);

export function FilePanel({
  openTarget,
  onOpened,
  sessionId,
}: {
  /** A file (+ optional line) to open, requested from another panel (e.g. a
   *  clicked tool-card path). Consumed once, then cleared via `onOpened`. */
  openTarget?: { path: string; line?: number } | null;
  onOpened?: () => void;
  /** Active session — the tree must show that session's worktree, like Git/Preview. */
  sessionId?: string | null;
} = {}): React.ReactElement {
  // Root at the SESSION WORKTREE when there is one, exactly as GitPanel does.
  // Previously this panel always rooted at the project, so with a session selected it
  // rendered the untouched main checkout while Git — one click away, same session —
  // listed those same files as modified. Three surfaces disagreed about one file, and
  // the one users trust to answer "did that happen?" was the one showing stale content.
  // Polled: the worktree only appears on the first turn, after this panel may have mounted.
  const projectPath = getActiveProjectPath();
  const [root, setRoot] = React.useState<string | null>(projectPath);
  const [rootIsWorktree, setRootIsWorktree] = React.useState(false);
  React.useEffect(() => {
    let cancelled = false;
    const resolve = async (): Promise<void> => {
      let dir = projectPath;
      let isWt = false;
      if (sessionId && projectPath) {
        const wt = sessionWorktreeDir(projectPath, sessionId);
        try {
          if (await native.fs.exists(wt)) { dir = wt; isWt = true; }
        } catch { /* fall back to the project root */ }
      }
      if (!cancelled) { setRoot(dir); setRootIsWorktree(isWt); }
    };
    void resolve();
    const t = setInterval(() => void resolve(), 5000);
    return () => { cancelled = true; clearInterval(t); };
  }, [projectPath, sessionId]);
  const [open, setOpen] = React.useState<Record<string, Entry[] | undefined>>({});
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  const [selected, setSelected] = React.useState<string | null>(null);
  const [content, setContent] = React.useState<string>('');
  const [contentHtml, setContentHtml] = React.useState<string>('');
  // Object URL for an open image/video/audio file (null for text files). Revoked
  // when the selection changes or the panel unmounts so blobs don't leak.
  const [media, setMedia] = React.useState<{ url: string; kind: MediaKind } | null>(null);
  const mediaUrlRef = React.useRef<string | null>(null);
  const setMediaUrl = React.useCallback((next: { url: string; kind: MediaKind } | null) => {
    if (mediaUrlRef.current) URL.revokeObjectURL(mediaUrlRef.current);
    mediaUrlRef.current = next?.url ?? null;
    setMedia(next);
  }, []);
  React.useEffect(() => () => { if (mediaUrlRef.current) URL.revokeObjectURL(mediaUrlRef.current); }, []);
  const [loadingFile, setLoadingFile] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // Markdown files default to the rendered view, toggleable to raw source.
  const [mdRaw, setMdRaw] = React.useState(false);
  // On mobile the 280px tree would crowd out the viewer, so it collapses into an
  // on-demand drawer (opened via the "Files" button, dismissed when a file is
  // picked). Desktop keeps the persistent side-by-side tree.
  const isMobile = useIsMobile();
  const [treeOpen, setTreeOpen] = React.useState(false);
  // Editing state. `content` holds the last-saved text; `dirtyValue` the live
  // edited buffer (null = clean). `diskMtime` drives external-change detection.
  const [dirtyValue, setDirtyValue] = React.useState<string | null>(null);
  const [diskMtime, setDiskMtime] = React.useState<number | null>(null);
  const [banner, setBanner] = React.useState(false);
  const [refs, setRefs] = React.useState<LspResult[] | null>(null);
  const editorRef = React.useRef<CmEditorHandle>(null);
  const cur = (): string => dirtyValue ?? content;
  const dirty = dirtyValue != null && isDirty(dirtyValue, content);

  // "Open in Finder" reveals a path on the machine we're sitting at; only offer
  // it when the open project physically lives on this same computer.
  const isLocal = useIsLocalProject(root);
  // Right-click / kebab context menu + delete confirmation.
  const [hovered, setHovered] = React.useState<string | null>(null);
  const [menu, setMenu] = React.useState<{ entry: Entry; x: number; y: number } | null>(null);
  const [pendingDelete, setPendingDelete] = React.useState<Entry | null>(null);

  const list = React.useCallback(async (dir: string): Promise<Entry[]> => {
    const ents = await native.fs.readdir(dir);
    return ents
      .filter((e) => !IGNORED.has(e.name) && !e.name.startsWith('.DS_Store'))
      .map((e) => ({ name: e.name, path: `${dir}/${e.name}`, isDir: e.isDirectory }))
      .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
  }, []);

  // Load the root on mount / project change.
  React.useEffect(() => {
    if (!root) return;
    let cancelled = false;
    setExpanded(new Set());
    setSelected(null);
    setContentHtml('');
    void list(root)
      .then((ents) => { if (!cancelled) setOpen({ [root]: ents }); })
      .catch((e: unknown) => { console.error('[FilePanel:loadRoot]', JSON.stringify({ root, error: e instanceof Error ? e.message : String(e) }), e instanceof Error ? e.stack : undefined); if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [root, list]);

  const toggleDir = React.useCallback(async (dir: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir);
      else next.add(dir);
      return next;
    });
    if (!open[dir]) {
      try {
        const ents = await list(dir);
        setOpen((prev) => ({ ...prev, [dir]: ents }));
      } catch (e) {
        console.error('[FilePanel:toggleDir]', JSON.stringify({ dir, error: e instanceof Error ? e.message : String(e) }), e instanceof Error ? e.stack : undefined);
        setError(String(e));
      }
    }
  }, [open, list]);

  const openFile = React.useCallback(async (path: string) => {
    setSelected(path);
    setTreeOpen(false); // mobile: dismiss the file drawer once a file is chosen
    setLoadingFile(true);
    setError(null);
    setDirtyValue(null);
    setBanner(false);
    setRefs(null);
    try {
      const mi = mediaInfo(path);
      if (mi) {
        // Binary media: read bytes and show it as an <img>/<video>/<audio> via an
        // object URL, rather than the utf-8 text path (which renders garbage).
        const bytes = await native.fs.readFileBytes(path);
        const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mi.mime }));
        setMediaUrl({ url, kind: mi.kind });
        setContent('');
        setContentHtml('');
      } else {
        setMediaUrl(null);
        const text = await native.fs.readFile(path);
        setContent(text);
        setContentHtml(highlightFile(path, text));
      }
      setMdRaw(false); // markdown opens in rendered view
      try {
        const s = await native.fs.stat(path);
        setDiskMtime(s.mtimeMs);
      } catch {
        setDiskMtime(null);
      }
    } catch (e) {
      console.error('[FilePanel:openFile]', JSON.stringify({ path, error: e instanceof Error ? e.message : String(e) }), e instanceof Error ? e.stack : undefined);
      setContent('');
      setContentHtml('');
      setMediaUrl(null);
      setError(`Could not read ${path}: ${String(e)}`);
    } finally {
      setLoadingFile(false);
    }
  }, [setMediaUrl]);

  // Open a file requested from another panel (e.g. a clicked tool-card path).
  // Runs whenever the target changes; reveals the requested line, then clears
  // the request so the same file can be re-requested later.
  React.useEffect(() => {
    if (!openTarget) return;
    let cancelled = false;
    void (async () => {
      await openFile(openTarget.path);
      const line = openTarget.line;
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- set true by cleanup across the await; flow analysis can't see the async gap
      if (!cancelled && typeof line === 'number' && line > 0) {
        requestAnimationFrame(() => editorRef.current?.revealLine(line));
      }
      onOpened?.();
    })();
    return () => { cancelled = true; };
  }, [openTarget, openFile, onOpened]);

  const save = React.useCallback(async () => {
    if (!selected || dirtyValue == null) return;
    await native.fs.writeFile(selected, dirtyValue);
    setContent(dirtyValue);
    setContentHtml(highlightFile(selected, dirtyValue));
    setDirtyValue(null);
    try {
      const s = await native.fs.stat(selected);
      setDiskMtime(s.mtimeMs);
    } catch {
      /* ignore */
    }
  }, [selected, dirtyValue]);

  // Detect external writes (e.g. the coding agent editing the open file).
  React.useEffect(() => {
    if (!selected || diskMtime == null) return;
    const id = setInterval(() => {
      void (async () => {
        try {
          const s = await native.fs.stat(selected);
          if (s.mtimeMs === diskMtime) return;
          const action = externalChangeAction({
            dirty: dirtyValue != null && isDirty(dirtyValue, content),
            mtimeChanged: true,
          });
          if (action === 'reload') {
            const text = await native.fs.readFile(selected);
            setContent(text);
            setContentHtml(highlightFile(selected, text));
            setDirtyValue(null);
            setDiskMtime(s.mtimeMs);
          } else if (action === 'banner') {
            setBanner(true);
          }
        } catch {
          /* file gone / unreadable — ignore */
        }
      })();
    }, 2000);
    return () => { clearInterval(id); };
  }, [selected, diskMtime, dirtyValue, content]);

  // ── LSP navigation ──
  const navTo = React.useCallback(
    async (r: LspResult) => {
      if (r.path !== selected) await openFile(r.path);
      // openFile remounts the editor on the new value; reveal after that.
      requestAnimationFrame(() => editorRef.current?.revealLine(r.line));
    },
    [selected, openFile],
  );
  const onDefinition = async (pos: EditorPos): Promise<void> => {
    if (!selected) return;
    const hits = await runDefinition(selected, pos, cur(), root);
    if (hits[0]) await navTo(hits[0]);
  };
  const onImplementation = async (pos: EditorPos): Promise<void> => {
    if (!selected) return;
    const hits = await runImplementation(selected, pos, cur(), root);
    if (hits[0]) await navTo(hits[0]);
  };
  const onReferences = async (pos: EditorPos): Promise<void> => {
    if (!selected) return;
    setRefs(await runReferences(selected, pos, cur(), root));
  };
  const hoverAt = (pos: EditorPos): Promise<string | null> =>
    selected ? runHover(selected, pos, cur(), root) : Promise.resolve(null);

  const reloadFromDisk = React.useCallback(async () => {
    if (!selected) return;
    const mi = mediaInfo(selected);
    if (mi) {
      const bytes = await native.fs.readFileBytes(selected);
      setMediaUrl({ url: URL.createObjectURL(new Blob([bytes as BlobPart], { type: mi.mime })), kind: mi.kind });
    } else {
      const text = await native.fs.readFile(selected);
      setContent(text);
      setContentHtml(highlightFile(selected, text));
    }
    setDirtyValue(null);
    setBanner(false);
    try {
      const s = await native.fs.stat(selected);
      setDiskMtime(s.mtimeMs);
    } catch {
      /* ignore */
    }
  }, [selected, setMediaUrl]);

  const keepMine = React.useCallback(async () => {
    if (!selected) return;
    try {
      const s = await native.fs.stat(selected);
      setDiskMtime(s.mtimeMs);
    } catch {
      /* ignore */
    }
    setBanner(false);
  }, [selected]);

  // Trash an entry, then re-read its parent so the tree drops it. Errors bubble
  // to the ConfirmDialog (it stays open and shows the message).
  const deleteEntry = React.useCallback(async (entry: Entry): Promise<void> => {
    await trashPath(entry.path);
    const slash = entry.path.lastIndexOf('/');
    const parent = slash > 0 ? entry.path.slice(0, slash) : root;
    if (!parent) return;
    const ents = await list(parent).catch(() => [] as Entry[]);
    setOpen((prev) => {
      const next: Record<string, Entry[] | undefined> = { ...prev, [parent]: ents };
      next[entry.path] = undefined; // drop any cached children of a deleted folder
      return next;
    });
    setExpanded((prev) => {
      if (!prev.has(entry.path)) return prev;
      const next = new Set(prev);
      next.delete(entry.path);
      return next;
    });
    if (selected === entry.path || (entry.isDir && selected?.startsWith(`${entry.path}/`))) {
      setSelected(null);
      setContent('');
      setContentHtml('');
      setDirtyValue(null);
    }
  }, [root, list, selected]);

  // Rename a file/folder in place (same parent), then re-read the parent so the
  // tree shows the new name. Follows the rename in the current selection.
  const renameEntry = React.useCallback(async (entry: Entry): Promise<void> => {
    const next = window.prompt(`Rename ${entry.isDir ? 'folder' : 'file'}:`, entry.name);
    if (next == null) return;
    const trimmed = next.trim();
    if (!trimmed || trimmed === entry.name) return;
    if (/[\\/]/.test(trimmed)) { window.alert('Name can’t contain slashes.'); return; }
    const slash = entry.path.lastIndexOf('/');
    const parent = slash > 0 ? entry.path.slice(0, slash) : root;
    const dest = `${parent}/${trimmed}`;
    try {
      await native.fs.rename(entry.path, dest);
    } catch (e) {
      window.alert(`Rename failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (parent) {
      const ents = await list(parent).catch(() => [] as Entry[]);
      setOpen((prev) => ({ ...prev, [parent]: ents, [entry.path]: undefined }));
    }
    if (selected === entry.path) setSelected(dest);
    else if (entry.isDir && selected?.startsWith(`${entry.path}/`)) {
      setSelected(selected.replace(entry.path, dest));
    }
  }, [root, list, selected]);

  const openMenu = (e: React.MouseEvent, entry: Entry): void => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ entry, x: e.clientX, y: e.clientY });
  };

  const menuItems = (entry: Entry): ContextMenuItem[] => [
    {
      label: `Open in ${fileManagerName}`,
      hidden: !isLocal,
      onClick: () => { void revealInFinder(entry.path); },
    },
    {
      label: 'Rename…',
      onClick: () => { void renameEntry(entry); },
    },
    {
      label: 'Delete',
      danger: true,
      onClick: () => { setPendingDelete(entry); },
    },
  ];

  // A right-aligned "⋯" affordance revealed on hover (always shown on touch, where
  // there is no hover or right-click). Opens the same menu as a right-click.
  const kebab = (entry: Entry): React.ReactElement => (
    <button
      type="button"
      data-id={`file-tree-menu-${entry.path}`}
      aria-label={`Actions for ${entry.name}`}
      onClick={(e) => {
        e.stopPropagation();
        const r = e.currentTarget.getBoundingClientRect();
        setMenu({ entry, x: r.left, y: r.bottom + 2 });
      }}
      style={{
        ...S.kebab,
        visibility:
          isMobile || hovered === entry.path || menu?.entry.path === entry.path
            ? 'visible'
            : 'hidden',
      }}
    >
      ⋯
    </button>
  );

  const renderDir = (dir: string, depth: number): React.ReactNode => {
    const ents = open[dir] ?? [];
    return ents.map((e) => {
      if (e.isDir) {
        const isOpen = expanded.has(e.path);
        return (
          <React.Fragment key={e.path}>
            <div
              data-id="file-tree-dir"
              style={{ ...S.row, paddingLeft: 8 + depth * 14 }}
              onClick={() => void toggleDir(e.path)}
              onContextMenu={(ev) => { openMenu(ev, e); }}
              onMouseEnter={() => { setHovered(e.path); }}
              onMouseLeave={() => { setHovered((h) => (h === e.path ? null : h)); }}
            >
              <span style={S.caret}>{isOpen ? '▾' : '▸'}</span>
              <span style={S.dirName}>{e.name}</span>
              <span style={{ flex: 1 }} />
              {kebab(e)}
            </div>
            {isOpen && renderDir(e.path, depth + 1)}
          </React.Fragment>
        );
      }
      return (
        <div
          key={e.path}
          data-id="file-tree-file"
          style={{ ...S.row, paddingLeft: 8 + depth * 14 + 14, ...(selected === e.path ? S.rowActive : {}) }}
          onClick={() => void openFile(e.path)}
          onContextMenu={(ev) => { openMenu(ev, e); }}
          onMouseEnter={() => { setHovered(e.path); }}
          onMouseLeave={() => { setHovered((h) => (h === e.path ? null : h)); }}
        >
          <span style={S.fileName}>{e.name}</span>
          <span style={{ flex: 1 }} />
          {kebab(e)}
        </div>
      );
    });
  };

  if (!root) return <div style={S.empty}>No project open.</div>;

  return (
    <div style={S.root}>
      {/* Desktop: persistent tree column. Mobile: an on-demand drawer (below). */}
      {!isMobile && (
        <div style={S.tree}>
          <CodebaseSearch onOpen={(p) => { void openFile(p); }} />
          {/* Name the tree. Without this the panel can show the session's worktree or the
              main checkout with no way to tell which — and a stale-looking file reads as
              "the agent didn't do it" rather than "you're looking at the other tree". */}
          <div
            data-id="file-tree-scope"
            title={root}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              padding: '3px 8px',
              fontSize: 10,
              fontFamily: 'Inter, sans-serif',
              color: 'var(--text-muted)',
              borderBottom: '1px solid var(--border)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            <GitBranch size={10} style={{ flexShrink: 0 }} />
            {rootIsWorktree ? 'session worktree' : 'main checkout'}
          </div>
          {renderDir(root, 0)}
        </div>
      )}

      {isMobile && treeOpen && (
        <>
          <div style={S.backdrop} data-id="file-tree-backdrop" onClick={() => { setTreeOpen(false); }} />
          <div style={S.treeDrawer} data-id="file-tree-drawer">
            <div style={S.drawerHeader}>
              <span>Files</span>
              <button data-id="file-tree-close" onClick={() => { setTreeOpen(false); }} style={S.drawerClose}>Done</button>
            </div>
            <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>{renderDir(root, 0)}</div>
          </div>
        </>
      )}

      <div style={S.viewer}>
        {(isMobile || selected) && (
          <div style={S.viewerHeader}>
            {isMobile && (
              <button data-id="file-tree-open" onClick={() => { setTreeOpen(true); }} style={S.filesBtn}>
                <FileIcon />
                Files
              </button>
            )}
            {selected ? (
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {selected.startsWith(root) ? selected.slice(root.length + 1) : selected}
                {dirty && <span data-id="file-dirty" title="Unsaved changes" style={{ color: 'var(--accent)', marginLeft: 6 }}>●</span>}
              </span>
            ) : (
              <span style={{ flex: 1 }} />
            )}
            {selected && dirty && (
              <button data-id="file-save" onClick={() => void save()} style={S.saveBtn}>Save ⌘S</button>
            )}
            {selected && isMarkdown(selected) && !loadingFile && (
              <div style={S.segmented}>
                <button data-id="md-view-rendered" onClick={() => { setMdRaw(false); }} style={{ ...S.seg, ...(mdRaw ? {} : S.segActive) }}>Preview</button>
                <button data-id="md-view-raw" onClick={() => { setMdRaw(true); }} style={{ ...S.seg, ...(mdRaw ? S.segActive : {}) }}>Raw</button>
              </div>
            )}
          </div>
        )}
        {banner && selected && (
          <div data-id="file-external-change" style={S.banner}>
            <span>Changed on disk.</span>
            <button data-id="file-reload" onClick={() => void reloadFromDisk()} style={S.bannerBtn}>Reload</button>
            <button data-id="file-keep-mine" onClick={() => void keepMine()} style={S.bannerBtn}>Keep mine</button>
          </div>
        )}
        {selected ? (
          loadingFile ? (
            <pre style={S.code}>Loading…</pre>
          ) : media ? (
            <div style={S.mediaWrap}>
              {media.kind === 'image' ? (
                <img data-id="file-media-image" src={media.url} alt={selected} style={S.mediaImg} />
              ) : media.kind === 'video' ? (
                <video data-id="file-media-video" src={media.url} controls style={S.mediaImg} />
              ) : (
                <audio data-id="file-media-audio" src={media.url} controls style={{ width: '100%', maxWidth: 480 }} />
              )}
            </div>
          ) : isMarkdown(selected) && !mdRaw ? (
            content ? <MarkdownView text={content} /> : <div style={S.empty}>(empty file)</div>
          ) : content.length > MAX_EDITABLE_BYTES ? (
            <pre style={S.code}>
              <code className="hljs" style={{ background: 'transparent', padding: 0 }} dangerouslySetInnerHTML={{ __html: contentHtml || '(empty file)' }} />
            </pre>
          ) : (
            <CodeMirrorFileEditor
              ref={editorRef}
              path={selected}
              value={cur()}
              onChange={(next) => { setDirtyValue(next); }}
              onSave={() => void save()}
              onDefinition={(p) => void onDefinition(p)}
              onImplementation={(p) => void onImplementation(p)}
              onReferences={(p) => void onReferences(p)}
              hoverAt={hoverAt}
            />
          )
        ) : (
          <div style={S.empty}>Select a file to view its contents.</div>
        )}
        {refs && (
          <ReferencesPanel results={refs} onPick={(r) => void navTo(r)} onClose={() => { setRefs(null); }} />
        )}
        {error && <div style={S.error}>{error}</div>}
      </div>

      {menu && (
        <ContextMenu
          anchor={{ x: menu.x, y: menu.y }}
          items={menuItems(menu.entry)}
          onClose={() => { setMenu(null); }}
        />
      )}
      <ConfirmDialog
        open={pendingDelete != null}
        title="Move to Trash"
        message={
          pendingDelete
            ? `Move ${pendingDelete.isDir ? 'folder' : 'file'} "${pendingDelete.name}" to the Trash?`
            : ''
        }
        onConfirm={() => (pendingDelete ? deleteEntry(pendingDelete) : Promise.resolve())}
        onClose={() => { setPendingDelete(null); }}
      />
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  root: { display: 'flex', height: '100%', minHeight: 0, background: 'var(--bg-primary)' },
  mediaWrap: { display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%', overflow: 'auto', padding: 16, boxSizing: 'border-box' },
  mediaImg: { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' },
  tree: { width: 280, flexShrink: 0, overflow: 'auto', borderRight: '1px solid var(--border)', padding: '6px 0', fontFamily: 'var(--font-mono)', fontSize: 12.5 },
  backdrop: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1290 },
  treeDrawer: { position: 'fixed', top: 0, left: 0, bottom: 0, width: 'min(86vw, 320px)', display: 'flex', flexDirection: 'column', background: 'var(--bg-panel)', borderRight: '1px solid var(--border)', zIndex: 1300, boxSizing: 'border-box', paddingTop: 'var(--safe-area-inset-top)', paddingBottom: 'var(--safe-area-inset-bottom)', fontFamily: 'var(--font-mono)', fontSize: 12.5 },
  drawerHeader: { flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--font-label)', fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)' },
  drawerClose: { fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--accent)', background: 'transparent', border: 'none', cursor: 'pointer', padding: 4 },
  filesBtn: { display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-primary)', background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 10px', cursor: 'pointer' },
  row: { display: 'flex', alignItems: 'center', gap: 4, height: 22, padding: '0 8px', cursor: 'pointer', whiteSpace: 'nowrap', color: 'var(--text-primary)' },
  rowActive: { background: 'var(--accent-dim)', color: 'var(--accent)' },
  caret: { width: 12, flexShrink: 0, color: 'var(--text-muted)', fontSize: 10 },
  kebab: { flexShrink: 0, width: 20, height: 18, marginRight: 4, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: 'none', borderRadius: 4, color: 'var(--text-muted)', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: 0 },
  dirName: { fontWeight: 600 },
  fileName: { color: 'var(--text-secondary)' },
  viewer: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 },
  viewerHeader: { flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8, padding: '6px 14px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-muted)' },
  segmented: { display: 'inline-flex', flexShrink: 0, gap: 1, padding: 2, background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 6 },
  seg: { fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', background: 'transparent', border: 'none', borderRadius: 4, padding: '2px 9px', cursor: 'pointer' },
  segActive: { background: 'var(--bg-primary)', color: 'var(--accent)' },
  saveBtn: { flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 600, color: 'var(--accent)', background: 'var(--accent-dim)', border: '1px solid var(--accent)', borderRadius: 6, padding: '2px 10px', cursor: 'pointer' },
  banner: { flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10, padding: '6px 14px', background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border)', fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-primary)' },
  bannerBtn: { fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--accent)', background: 'transparent', border: '1px solid var(--border)', borderRadius: 6, padding: '2px 10px', cursor: 'pointer' },
  code: { flex: 1, minHeight: 0, overflow: 'auto', margin: 0, padding: 14, fontFamily: 'var(--font-mono)', fontSize: 12.5, lineHeight: 1.6, color: 'var(--text-primary)', whiteSpace: 'pre', tabSize: 2 },
  empty: { padding: 24, fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--text-muted)' },
  error: { padding: '8px 14px', fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--error)', borderTop: '1px solid var(--border)' },
};
