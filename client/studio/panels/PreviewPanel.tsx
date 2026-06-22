import React from 'react';
import { getActiveProjectPath } from '../hooks/useSocket';

// A live preview of the project's running dev server, in an iframe. The dev URL
// is entered by the user (the daemon runs `npm run dev` via the agent's
// run_command; its port isn't known here) and persisted per project. Session-
// scoped. A reload button + open-in-new for when the iframe is sandboxed.

const keyFor = (path: string | null): string => `ugly-studio:previewUrl:${path ?? 'none'}`;

export function PreviewPanel(): React.ReactElement {
  const projectPath = getActiveProjectPath();
  const [url, setUrl] = React.useState<string>(() => {
    try { return localStorage.getItem(keyFor(projectPath)) ?? 'http://localhost:4321'; } catch { return 'http://localhost:4321'; }
  });
  const [committed, setCommitted] = React.useState<string>(url);
  const [reloadKey, setReloadKey] = React.useState(0);

  React.useEffect(() => {
    try {
      const saved = localStorage.getItem(keyFor(projectPath));
      if (saved) { setUrl(saved); setCommitted(saved); }
    } catch { /* ignore */ }
  }, [projectPath]);

  const commit = React.useCallback(() => {
    const u = url.trim();
    if (!u) return;
    setCommitted(u);
    setReloadKey((k) => k + 1);
    try { localStorage.setItem(keyFor(projectPath), u); } catch { /* ignore */ }
  }, [url, projectPath]);

  return (
    <div style={S.root}>
      <div style={S.bar}>
        <button data-id="preview-reload" style={S.iconBtn} title="Reload" onClick={() => { setReloadKey((k) => k + 1); }}>↻</button>
        <input
          data-id="preview-url"
          style={S.input}
          value={url}
          onChange={(e) => { setUrl(e.target.value); }}
          onKeyDown={(e) => { if (e.key === 'Enter') commit(); }}
          placeholder="http://localhost:4321"
          spellCheck={false}
        />
        <button data-id="preview-go" style={S.goBtn} onClick={commit}>Go</button>
        <a data-id="preview-open" style={S.openBtn} href={committed} target="_blank" rel="noreferrer" title="Open in new tab">↗</a>
      </div>
      <div style={S.frameWrap}>
        {committed ? (
          <iframe
            key={`${reloadKey}:${committed}`}
            src={committed}
            style={S.frame}
            title="Preview"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          />
        ) : (
          <div style={S.empty}>Enter your dev server URL above to preview the app.</div>
        )}
      </div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: 'var(--bg-primary)' },
  bar: { display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderBottom: '1px solid var(--border)', flexShrink: 0, background: 'var(--bg-panel)' },
  iconBtn: { width: 26, height: 26, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer', fontSize: 14 },
  input: { flex: 1, minWidth: 0, height: 26, boxSizing: 'border-box', padding: '0 10px', fontFamily: 'var(--font-mono)', fontSize: 12, background: 'var(--bg-primary)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 6 },
  goBtn: { height: 26, flexShrink: 0, padding: '0 12px', fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 600, background: 'var(--accent-dim)', color: 'var(--accent)', border: '1px solid var(--accent)', borderRadius: 6, cursor: 'pointer' },
  openBtn: { width: 26, height: 26, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 6, textDecoration: 'none', fontSize: 13 },
  frameWrap: { flex: 1, minHeight: 0, position: 'relative', background: '#fff' },
  frame: { width: '100%', height: '100%', border: 'none' },
  empty: { padding: 24, fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--text-muted)' },
};
