import React from 'react';
import { native } from 'ugly-app/native';
import { getActiveProjectPath } from '../hooks/useSocket';

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
  const [loadingFile, setLoadingFile] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

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
    setContent('');
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
    setLoadingFile(true);
    setError(null);
    try {
      const text = await native.fs.readFile(path);
      setContent(text);
    } catch (e) {
      setContent('');
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
      <div style={S.tree}>{renderDir(root, 0)}</div>
      <div style={S.viewer}>
        {selected ? (
          <>
            <div style={S.viewerHeader}>{selected.startsWith(root) ? selected.slice(root.length + 1) : selected}</div>
            <pre style={S.code}>{loadingFile ? 'Loading…' : content || '(empty file)'}</pre>
          </>
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
  row: { display: 'flex', alignItems: 'center', gap: 4, height: 22, padding: '0 8px', cursor: 'pointer', whiteSpace: 'nowrap', color: 'var(--text-primary)' },
  rowActive: { background: 'var(--accent-dim)', color: 'var(--accent)' },
  caret: { width: 12, flexShrink: 0, color: 'var(--text-muted)', fontSize: 10 },
  dirName: { fontWeight: 600 },
  fileName: { color: 'var(--text-secondary)' },
  viewer: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 },
  viewerHeader: { flexShrink: 0, padding: '7px 14px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  code: { flex: 1, minHeight: 0, overflow: 'auto', margin: 0, padding: 14, fontFamily: 'var(--font-mono)', fontSize: 12.5, lineHeight: 1.6, color: 'var(--text-primary)', whiteSpace: 'pre', tabSize: 2 },
  empty: { padding: 24, fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--text-muted)' },
  error: { padding: '8px 14px', fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--error)', borderTop: '1px solid var(--border)' },
};
