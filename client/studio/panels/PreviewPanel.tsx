import React from 'react';
import { sessionPort } from '../agent/sessionWorkspace';

// A live preview of the running dev server, in an iframe. Each session gets a
// unique PORT (set in the env of its run_command spawns, so `pnpm dev` binds it),
// and the preview defaults to http://localhost:<that port>. The user can still
// override the URL; it's persisted per session.

const keyFor = (sid: string | null): string => `ugly-studio:previewUrl:${sid ?? 'none'}`;

export function PreviewPanel({ sessionId }: { sessionId?: string | null }): React.ReactElement {
  const defaultUrl = `http://localhost:${sessionId ? sessionPort(sessionId) : 4321}`;
  const [url, setUrl] = React.useState<string>(() => {
    try { return localStorage.getItem(keyFor(sessionId ?? null)) ?? defaultUrl; } catch { return defaultUrl; }
  });
  const [committed, setCommitted] = React.useState<string>(url);
  const [reloadKey, setReloadKey] = React.useState(0);

  React.useEffect(() => {
    try {
      const saved = localStorage.getItem(keyFor(sessionId ?? null));
      if (saved) { setUrl(saved); setCommitted(saved); }
    } catch { /* ignore */ }
  }, [sessionId]);

  const commit = React.useCallback(() => {
    const u = url.trim();
    if (!u) return;
    setCommitted(u);
    setReloadKey((k) => k + 1);
    try { localStorage.setItem(keyFor(sessionId ?? null), u); } catch { /* ignore */ }
  }, [url, sessionId]);

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
