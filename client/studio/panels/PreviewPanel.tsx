import React from 'react';
import { native, isNativeAvailable } from 'ugly-app/native';
import { NativeHostRequired } from '../common/NativeHostRequired';
import { sessionPort, getSessionWorkspace } from '../agent/sessionWorkspace';
import { getActiveProjectPath } from '../hooks/useSocket';
import { devServerSpawn } from './devServerCmd';
import { persistDevLog, flushDevLog } from './devServerLog';
import { readDevControl } from './devServerControl';

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
  // Set right before an intentional stopDev()/kill so the proc's onExit can tell a
  // user-requested shutdown from a real crash and not log the former to telemetry.
  stopping: boolean;
  port: number;
  log: string;
  // cloudflared quick tunnel exposing localhost:port at a public https URL, so the MOBILE
  // preview can reach the host's dev server. `tunnelUrl` is the trycloudflare.com URL once
  // cloudflared prints it (null until then, or if cloudflared is unavailable → localhost).
  tunnelProc: { kill: (sig?: string) => void } | null;
  tunnelUrl: string | null;
  subs: Set<() => void>;
}
const devServers = new Map<string, DevServer>();
function getDev(key: string, port: number): DevServer {
  let d = devServers.get(key);
  if (!d) { d = { proc: null, running: false, stopping: false, port, log: '', tunnelProc: null, tunnelUrl: null, subs: new Set() }; devServers.set(key, d); }
  return d;
}
function notify(d: DevServer): void { for (const fn of d.subs) fn(); }

const TUNNEL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

/** Expose localhost:port at a public https URL via a cloudflared quick tunnel (no CF account),
 *  so the mobile preview can reach the host's dev server. Best-effort — if cloudflared isn't
 *  present the preview just stays on localhost (works on the desktop host). */
function startTunnel(d: DevServer, projectPath: string, port: number): void {
  if (d.tunnelProc) { try { d.tunnelProc.kill(); } catch { /* already gone */ } }
  d.tunnelUrl = null;
  try {
    const t = native.process.spawn(
      'cloudflared',
      [
        'tunnel',
        '--url', `http://localhost:${port}`,
        // Rewrite the origin Host to localhost — Vite (`pnpm dev`) 403s "Blocked request"
        // for the trycloudflare hostname otherwise (server.allowedHosts). Applies to the HMR
        // websocket too, so live reload keeps working over the tunnel.
        '--http-host-header', `localhost:${port}`,
        '--no-autoupdate',
      ],
      { cwd: projectPath },
    );
    d.tunnelProc = t;
    const onOut = (c: string) => {
      d.log = (d.log + c).slice(-12000);
      if (!d.tunnelUrl) {
        const m = TUNNEL_RE.exec(c);
        if (m) { d.tunnelUrl = m[0]; d.log = (d.log + `\n[tunnel: ${m[0]}]\n`).slice(-12000); }
      }
      notify(d);
    };
    t.onStdout(onOut);
    t.onStderr(onOut); // cloudflared prints the quick-tunnel URL to stderr
    t.onError((e) => { d.log = (d.log + `\n[tunnel unavailable: ${e}]\n`).slice(-12000); d.tunnelProc = null; notify(d); });
    t.onExit(() => { d.tunnelProc = null; notify(d); });
  } catch (e) {
    d.log = (d.log + `[tunnel unavailable: ${(e as Error).message}]\n`).slice(-12000);
    notify(d);
  }
}

function startDev(key: string, projectPath: string, port: number, databaseUrl?: string): void {
  const d = getDev(key, port);
  d.stopping = true; // killing any prior proc below is intentional, not a crash
  if (d.proc) { try { d.proc.kill(); } catch { /* already gone */ } }
  d.log = '';
  d.running = true;
  d.port = port;
  notify(d);
  d.log = `$ pnpm dev  (PORT=${port})\n`;
  d.stopping = false;
  const spec = devServerSpawn(port, databaseUrl);
  const cmdStr = `${spec.cmd} ${spec.args.join(' ')}`;
  try {
    const p = native.process.spawn(spec.cmd, spec.args, { cwd: projectPath, env: spec.env });
    d.proc = p;
    p.onStdout((c) => { d.log = (d.log + c).slice(-12000); notify(d); void persistDevLog(projectPath, d.log); });
    p.onStderr((c) => { d.log = (d.log + c).slice(-12000); notify(d); void persistDevLog(projectPath, d.log); });
    p.onError((e) => {
      if (d.proc !== p) return; // superseded by a restart — ignore the stale proc
      // Ship spawn failures to the error telemetry (browser Logger → errorLog); the
      // in-panel log alone isn't visible when the host is a remote/other machine.
      console.error('[PreviewPanel:dev-server-error]', JSON.stringify({ cmd: cmdStr, cwd: projectPath, port, error: String(e) }));
      d.log = (d.log + `\n[error: ${e}]\n`).slice(-12000); d.running = false; d.proc = null; notify(d); void flushDevLog(projectPath, d.log);
    });
    p.onExit((code) => {
      if (d.proc !== p) return; // superseded by a restart — ignore the stale proc
      // A non-zero exit we didn't ask for is a real failure — e.g. 127 = `pnpm:
      // command not found` when the host lacks pnpm on PATH. Log it WITH the boot-log
      // tail (carries the shell's error text) so it's debuggable from another machine.
      if (!d.stopping && code !== 0 && code != null) {
        console.error('[PreviewPanel:dev-server-exit]', JSON.stringify({ cmd: cmdStr, cwd: projectPath, port, code, logTail: d.log.slice(-1500) }));
      }
      d.log = (d.log + `\n[dev server exited ${code ?? ''}]\n`).slice(-12000); d.running = false; d.proc = null; notify(d);
    });
    // Publish it to a public https URL so the mobile preview can reach it.
    startTunnel(d, projectPath, port);
  } catch (e) {
    // Synchronous throw — e.g. NativeUnavailable when no host shell is wired.
    console.error('[PreviewPanel:dev-server-threw]', JSON.stringify({ cmd: cmdStr, cwd: projectPath, port, error: e instanceof Error ? e.message : String(e) }));
    d.log += `[error: ${(e as Error).message}]\n`;
    d.running = false;
    notify(d);
  }
}
function stopDev(key: string): void {
  const d = devServers.get(key);
  if (!d) return;
  d.stopping = true; // user-requested shutdown — suppress the onExit failure log
  if (d.proc) { try { d.proc.kill(); } catch { /* already gone */ } }
  if (d.tunnelProc) { try { d.tunnelProc.kill(); } catch { /* already gone */ } }
  d.running = false;
  d.proc = null;
  d.tunnelProc = null;
  d.tunnelUrl = null;
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

  // Once the cloudflared tunnel is up, point the preview at its public https URL so it works
  // on mobile (localhost only resolves on the desktop host). Reload the iframe onto it.
  React.useEffect(() => {
    const t = dev.tunnelUrl;
    if (t && t !== committed) {
      setUrl(t);
      setCommitted(t);
      setReloadKey((k) => k + 1);
      try { localStorage.setItem(keyFor(sessionId ?? null), t); } catch { /* ignore */ }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dev.tunnelUrl]);

  const commit = React.useCallback(() => {
    const u = url.trim();
    if (!u) return;
    setCommitted(u);
    setReloadKey((k) => k + 1);
    try { localStorage.setItem(keyFor(sessionId ?? null), u); } catch { /* ignore */ }
  }, [url, sessionId]);

  // Bridge: honor dev-server start/stop requests the coding agent writes via the
  // control file (devServerControl.ts) — the agent runs in the task context and
  // can't call startDev/stopDev directly. Poll ~1.5s; act on each new nonce once.
  const lastCtlNonce = React.useRef<string | null>(null);
  React.useEffect(() => {
    const proj = getActiveProjectPath();
    if (!proj) return;
    let cancelled = false;
    // Seed with the current command so a stale pre-mount request isn't replayed.
    void readDevControl(proj).then((c) => { if (!cancelled) lastCtlNonce.current = c?.nonce ?? null; });
    const id = setInterval(() => {
      void readDevControl(proj).then((c) => {
        if (cancelled || !c || c.nonce === lastCtlNonce.current) return;
        lastCtlNonce.current = c.nonce;
        if (c.cmd === 'stop') stopDev(devKey);
        else startDev(devKey, proj, port, sessionId ? getSessionWorkspace(sessionId)?.databaseUrl : undefined); // start | restart
      });
    }, 1500);
    return () => { cancelled = true; clearInterval(id); };
  }, [devKey, port, sessionId]);

  // Reload the iframe once the dev server is actually READY, instead of guessing.
  // The old code blind-reloaded after a fixed 2500ms; a slower boot (install +
  // Vite cold start) left the first load pointing at a not-yet-listening port —
  // connection refused → blank preview until a manual reload. We watch the boot
  // log for the "server ready" marker (Vite's "Local:" / "ready in Nms") and
  // reload then; a longer fallback still fires once in case the marker changes.
  const bootReloaded = React.useRef(false);
  React.useEffect(() => {
    if (!dev.running || bootReloaded.current) return;
    // Vite: "➜  Local:   http://localhost:5173/" and "VITE vX ready in 412 ms".
    // ugly-app dev wraps Vite, so these markers still appear in the captured log.
    if (/(Local:\s*https?:\/\/|ready in\s+[\d.]+\s*m?s|listening on)/i.test(dev.log)) {
      bootReloaded.current = true;
      setReloadKey((k) => k + 1);
    }
  }, [dev.log, dev.running]);

  const startOrRestart = React.useCallback(() => {
    const proj = getActiveProjectPath();
    if (!proj) { setShowLog(true); return; }
    bootReloaded.current = false; // arm the readiness-reload for this boot
    startDev(devKey, proj, port, sessionId ? getSessionWorkspace(sessionId)?.databaseUrl : undefined);
    setShowLog(true);
    // Point the preview at the dev server; the readiness effect above reloads the
    // iframe once the server responds. A long fallback covers the case where the
    // ready marker never matches (unusual dev server) — only if not already reloaded.
    const target = `http://localhost:${port}`;
    setUrl(target);
    setCommitted(target);
    try { localStorage.setItem(keyFor(sessionId ?? null), target); } catch { /* ignore */ }
    setTimeout(() => { if (!bootReloaded.current) { bootReloaded.current = true; setReloadKey((k) => k + 1); } }, 10000);
  }, [devKey, port, sessionId]);

  // A browser tab has no host to spawn the dev server on — say so instead of
  // silently showing a blank iframe forever.
  if (!isNativeAvailable()) return <div style={S.root}><NativeHostRequired feature="Live preview" /></div>;

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
          <button data-id="preview-stop" style={S.iconBtn} title="Stop the dev server" onClick={() => { stopDev(devKey); }}>■</button>
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
        <button data-id="preview-logs" style={{ ...S.iconBtn, ...(showLog ? S.iconBtnActive : {}) }} title="Dev server logs" onClick={() => { setShowLog((s) => !s); }}>⌗</button>
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
