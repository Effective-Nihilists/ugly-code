import React from 'react';
import { native } from 'ugly-app/native';
import { sessionPort } from '../agent/sessionWorkspace';
import { getActiveProjectPath } from '../hooks/useSocket';
import { devServerSpawn } from './devServerCmd';

// A live preview of the running dev server, in an iframe. Each session gets a
// unique PORT (set in the env of its run_command spawns, so `pnpm dev` binds it),
// and the preview defaults to http://localhost:<that port>. The Start/Restart
// control boots the project's dev server (`pnpm dev`) on that port directly.

const keyFor = (sid: string | null): string => `ugly-studio:previewUrl:${sid ?? 'none'}`;

// ── Dev-server registry (module-level so a running server survives tab switches /
//    panel remounts within the Studio session; the panel subscribes for updates). ──
interface DevServer {
  proc: { kill: (sig?: string) => void } | null;
  running: boolean;
  port: number;
  log: string;
  subs: Set<() => void>;
}
const devServers = new Map<string, DevServer>();
function getDev(key: string, port: number): DevServer {
  let d = devServers.get(key);
  if (!d) { d = { proc: null, running: false, port, log: '', subs: new Set() }; devServers.set(key, d); }
  return d;
}
function notify(d: DevServer): void { for (const fn of d.subs) fn(); }

function startDev(key: string, projectPath: string, port: number): void {
  const d = getDev(key, port);
  if (d.proc) { try { d.proc.kill(); } catch { /* already gone */ } }
  d.log = '';
  d.running = true;
  d.port = port;
  notify(d);
  d.log = `$ pnpm dev  (PORT=${port})\n`;
  try {
    const spec = devServerSpawn(port);
    const p = native.process.spawn(spec.cmd, spec.args, { cwd: projectPath, env: spec.env });
    d.proc = p;
    p.onStdout((c) => { d.log = (d.log + c).slice(-12000); notify(d); });
    p.onStderr((c) => { d.log = (d.log + c).slice(-12000); notify(d); });
    p.onError((e) => { d.log = (d.log + `\n[error: ${e}]\n`).slice(-12000); d.running = false; d.proc = null; notify(d); });
    p.onExit((code) => { d.log = (d.log + `\n[dev server exited ${code ?? ''}]\n`).slice(-12000); d.running = false; d.proc = null; notify(d); });
  } catch (e) {
    d.log += `[error: ${(e as Error).message}]\n`;
    d.running = false;
    notify(d);
  }
}
function stopDev(key: string): void {
  const d = devServers.get(key);
  if (!d) return;
  if (d.proc) { try { d.proc.kill(); } catch { /* already gone */ } }
  d.running = false;
  d.proc = null;
  notify(d);
}

export function PreviewPanel({ sessionId }: { sessionId?: string | null }): React.ReactElement {
  const port = sessionId ? sessionPort(sessionId) : 4321;
  const defaultUrl = `http://localhost:${port}`;
  const devKey = sessionId ?? 'root';
  const [url, setUrl] = React.useState<string>(() => {
    try { return localStorage.getItem(keyFor(sessionId ?? null)) ?? defaultUrl; } catch { return defaultUrl; }
  });
  const [committed, setCommitted] = React.useState<string>(url);
  const [reloadKey, setReloadKey] = React.useState(0);
  const [showLog, setShowLog] = React.useState(false);
  // Subscribe to the (module-level) dev-server state for this session.
  const [, forceRender] = React.useReducer((n: number) => n + 1, 0);
  const dev = getDev(devKey, port);
  React.useEffect(() => {
    const d = getDev(devKey, port);
    d.subs.add(forceRender);
    forceRender();
    return () => { d.subs.delete(forceRender); };
  }, [devKey, port]);

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

  const startOrRestart = React.useCallback(() => {
    const proj = getActiveProjectPath();
    if (!proj) { setShowLog(true); return; }
    startDev(devKey, proj, port);
    setShowLog(true);
    // Give the dev server a moment to bind, then point the preview at it + reload.
    const target = `http://localhost:${port}`;
    setUrl(target);
    setCommitted(target);
    try { localStorage.setItem(keyFor(sessionId ?? null), target); } catch { /* ignore */ }
    setTimeout(() => setReloadKey((k) => k + 1), 2500);
  }, [devKey, port, sessionId]);

  return (
    <div data-id="preview-panel" style={S.root}>
      <div style={S.bar}>
        <button
          data-id="preview-start"
          style={dev.running ? S.restartBtn : S.startBtn}
          title={dev.running ? 'Restart the dev server' : 'Start the dev server (pnpm dev)'}
          onClick={startOrRestart}
        >
          {dev.running ? '⟳ Restart app' : '▶ Start app'}
        </button>
        {dev.running && (
          <button data-id="preview-stop" style={S.iconBtn} title="Stop the dev server" onClick={() => stopDev(devKey)}>■</button>
        )}
        <span style={{ ...S.dot, background: dev.running ? 'var(--accent-success, #10b981)' : 'var(--text-muted)' }} title={dev.running ? `running on :${dev.port}` : 'stopped'} />
        <button data-id="preview-reload" style={S.iconBtn} title="Reload preview" onClick={() => { setReloadKey((k) => k + 1); }}>↻</button>
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
        <button data-id="preview-logs" style={{ ...S.iconBtn, ...(showLog ? S.iconBtnActive : {}) }} title="Dev server logs" onClick={() => setShowLog((s) => !s)}>⌗</button>
        <a data-id="preview-open" style={S.openBtn} href={committed} target="_blank" rel="noreferrer" title="Open in new tab">↗</a>
      </div>
      {showLog && (
        <pre data-id="preview-devlog" style={S.devlog}>{dev.log || '(dev server not started — click “Start app”)'}</pre>
      )}
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
  startBtn: { height: 26, flexShrink: 0, padding: '0 12px', fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700, background: 'var(--accent-success, #10b981)', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' },
  restartBtn: { height: 26, flexShrink: 0, padding: '0 12px', fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 600, background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer' },
  dot: { width: 8, height: 8, borderRadius: '50%', flexShrink: 0 },
  iconBtn: { width: 26, height: 26, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer', fontSize: 13 },
  iconBtnActive: { background: 'var(--accent-dim)', color: 'var(--accent)', borderColor: 'var(--accent)' },
  input: { flex: 1, minWidth: 0, height: 26, boxSizing: 'border-box', padding: '0 10px', fontFamily: 'var(--font-mono)', fontSize: 12, background: 'var(--bg-primary)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 6 },
  goBtn: { height: 26, flexShrink: 0, padding: '0 12px', fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 600, background: 'var(--accent-dim)', color: 'var(--accent)', border: '1px solid var(--accent)', borderRadius: 6, cursor: 'pointer' },
  openBtn: { width: 26, height: 26, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 6, textDecoration: 'none', fontSize: 13 },
  devlog: { flexShrink: 0, maxHeight: 160, overflow: 'auto', margin: 0, padding: '8px 12px', borderBottom: '1px solid var(--border)', background: 'var(--bg-secondary)', fontFamily: 'var(--font-mono)', fontSize: 11, lineHeight: 1.5, color: 'var(--text-primary)', whiteSpace: 'pre-wrap' },
  frameWrap: { flex: 1, minHeight: 0, position: 'relative', background: '#fff' },
  frame: { width: '100%', height: '100%', border: 'none' },
  empty: { padding: 24, fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--text-muted)' },
};
