import React from 'react';
import hljs from 'highlight.js/lib/common';
import 'highlight.js/styles/github.css';
import { native } from 'ugly-app/native';
import { MdastViewer } from 'ugly-app/markdown/client';
import { getActiveProjectPath } from '../hooks/useSocket';
import { useTheme } from '../theme/ThemeProvider';
import { OpenUriContext } from '../components/LinkifiedText';
import { useIsMobile } from '../hooks/useIsMobile';
import { FileIcon } from './navIcons';

function isMarkdown(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return ext === 'md' || ext === 'markdown';
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

export function FilePanel(): React.ReactElement {
  const root = getActiveProjectPath();
  const [open, setOpen] = React.useState<Record<string, Entry[] | undefined>>({});
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  const [selected, setSelected] = React.useState<string | null>(null);
  const [content, setContent] = React.useState<string>('');
  const [contentHtml, setContentHtml] = React.useState<string>('');
  const [loadingFile, setLoadingFile] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // Markdown files default to the rendered view, toggleable to raw source.
  const [mdRaw, setMdRaw] = React.useState(false);
  // On mobile the 280px tree would crowd out the viewer, so it collapses into an
  // on-demand drawer (opened via the "Files" button, dismissed when a file is
  // picked). Desktop keeps the persistent side-by-side tree.
  const isMobile = useIsMobile();
  const [treeOpen, setTreeOpen] = React.useState(false);

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
      .catch((e: unknown) => { if (!cancelled) setError(String(e)); });
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
        setError(String(e));
      }
    }
  }, [open, list]);

  const openFile = React.useCallback(async (path: string) => {
    setSelected(path);
    setTreeOpen(false); // mobile: dismiss the file drawer once a file is chosen
    setLoadingFile(true);
    setError(null);
    try {
      const text = await native.fs.readFile(path);
      setContent(text);
      setContentHtml(highlightFile(path, text));
      setMdRaw(false); // markdown opens in rendered view
    } catch (e) {
      setContent('');
      setContentHtml('');
      setError(`Could not read ${path}: ${String(e)}`);
    } finally {
      setLoadingFile(false);
    }
  }, []);

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
            >
              <span style={S.caret}>{isOpen ? '▾' : '▸'}</span>
              <span style={S.dirName}>{e.name}</span>
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
        >
          <span style={S.fileName}>{e.name}</span>
        </div>
      );
    });
  };

  if (!root) return <div style={S.empty}>No project open.</div>;

  return (
    <div style={S.root}>
      {/* Desktop: persistent tree column. Mobile: an on-demand drawer (below). */}
      {!isMobile && <div style={S.tree}>{renderDir(root, 0)}</div>}

      {isMobile && treeOpen && (
        <>
          <div style={S.backdrop} onClick={() => { setTreeOpen(false); }} />
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
              </span>
            ) : (
              <span style={{ flex: 1 }} />
            )}
            {selected && isMarkdown(selected) && !loadingFile && (
              <div style={S.segmented}>
                <button data-id="md-view-rendered" onClick={() => { setMdRaw(false); }} style={{ ...S.seg, ...(mdRaw ? {} : S.segActive) }}>Preview</button>
                <button data-id="md-view-raw" onClick={() => { setMdRaw(true); }} style={{ ...S.seg, ...(mdRaw ? S.segActive : {}) }}>Raw</button>
              </div>
            )}
          </div>
        )}
        {selected ? (
          loadingFile ? (
            <pre style={S.code}>Loading…</pre>
          ) : isMarkdown(selected) && !mdRaw ? (
            content ? <MarkdownView text={content} /> : <div style={S.empty}>(empty file)</div>
          ) : (
            <pre style={S.code}>
              <code className="hljs" style={{ background: 'transparent', padding: 0 }} dangerouslySetInnerHTML={{ __html: contentHtml || '(empty file)' }} />
            </pre>
          )
        ) : (
          <div style={S.empty}>Select a file to view its contents.</div>
        )}
        {error && <div style={S.error}>{error}</div>}
      </div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  root: { display: 'flex', height: '100%', minHeight: 0, background: 'var(--bg-primary)' },
  tree: { width: 280, flexShrink: 0, overflow: 'auto', borderRight: '1px solid var(--border)', padding: '6px 0', fontFamily: 'var(--font-mono)', fontSize: 12.5 },
  backdrop: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1290 },
  treeDrawer: { position: 'fixed', top: 0, left: 0, bottom: 0, width: 'min(86vw, 320px)', display: 'flex', flexDirection: 'column', background: 'var(--bg-panel)', borderRight: '1px solid var(--border)', zIndex: 1300, boxSizing: 'border-box', paddingTop: 'var(--safe-area-inset-top)', paddingBottom: 'var(--safe-area-inset-bottom)', fontFamily: 'var(--font-mono)', fontSize: 12.5 },
  drawerHeader: { flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--font-label)', fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)' },
  drawerClose: { fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--accent)', background: 'transparent', border: 'none', cursor: 'pointer', padding: 4 },
  filesBtn: { display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-primary)', background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 10px', cursor: 'pointer' },
  row: { display: 'flex', alignItems: 'center', gap: 4, height: 22, padding: '0 8px', cursor: 'pointer', whiteSpace: 'nowrap', color: 'var(--text-primary)' },
  rowActive: { background: 'var(--accent-dim)', color: 'var(--accent)' },
  caret: { width: 12, flexShrink: 0, color: 'var(--text-muted)', fontSize: 10 },
  dirName: { fontWeight: 600 },
  fileName: { color: 'var(--text-secondary)' },
  viewer: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 },
  viewerHeader: { flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8, padding: '6px 14px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-muted)' },
  segmented: { display: 'inline-flex', flexShrink: 0, gap: 1, padding: 2, background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 6 },
  seg: { fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', background: 'transparent', border: 'none', borderRadius: 4, padding: '2px 9px', cursor: 'pointer' },
  segActive: { background: 'var(--bg-primary)', color: 'var(--accent)' },
  code: { flex: 1, minHeight: 0, overflow: 'auto', margin: 0, padding: 14, fontFamily: 'var(--font-mono)', fontSize: 12.5, lineHeight: 1.6, color: 'var(--text-primary)', whiteSpace: 'pre', tabSize: 2 },
  empty: { padding: 24, fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--text-muted)' },
  error: { padding: '8px 14px', fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--error)', borderTop: '1px solid var(--border)' },
};
