import React from 'react';
import { native, isNativeAvailable, permissions } from 'ugly-app/native';
import { NativeHostRequired } from '../common/NativeHostRequired';
import {
  sessionPort,
  getSessionWorkspace,
  sessionWorktreeDir,
} from '../agent/sessionWorkspace';
import { devServerSpawn } from './devServerCmd';
import { persistDevLog, flushDevLog, readDevLog } from './devServerLog';
import { readDevControl } from './devServerControl';
import { ansiToNodes, stripAnsi } from './ansi';
import { registerFeedbackContextProvider } from 'ugly-app/client';

import { GitRepoSelector, useActiveRepoPath } from './GitRepoSelector';
import { resolveIsUglyApp } from './findGitRepos';
import { getActiveProjectPath } from '../projectPath';

// The desktop daemon gates `native.process.spawn` on (a) the binary being bundled
// and (b) a granted `process` capability with the binary allowlisted. Without an
// up-front grant the dev-server spawn (`bash -lc 'pnpm dev'`) is denied / can't
// resolve `bash` — on Windows that left the Preview blank (dev server never
// booted). Request the tools once, exactly as the scaffold + publish flows do.
const DEV_TOOLS = ['bash', 'node', 'pnpm', 'npm', 'yarn', 'git', 'cloudflared'];
let devToolsGrant: Promise<void> | null = null;
function ensureDevToolsGranted(): Promise<void> {
  if (!devToolsGrant) {
    type GrantReq = Parameters<typeof permissions.request>[0];
    devToolsGrant = permissions
      .request({ fs: 'full', process: [...DEV_TOOLS] } as unknown as GrantReq)
      .then(() => undefined)
      .catch(() => undefined);
  }
  return devToolsGrant;
}

// A live preview of the running dev server, in an iframe. Each session gets a
// unique PORT (set in the env of its run_command spawns, so `pnpm dev` binds it),
// and the preview defaults to http://localhost:<that port>. The Start/Restart
// control boots the project's dev server (`pnpm dev`) on that port directly.

const keyFor = (sid: string | null): string =>
  `ugly-studio:previewUrl:${sid ?? 'none'}`;

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
  // Monotonic per-start id. Bumped at each startDev(); the async tool-grant
  // continuation checks it so a superseding start/stop cancels the stale spawn.
  startToken: number;
  subs: Set<() => void>;
}
const devServers = new Map<string, DevServer>();
function getDev(key: string, port: number): DevServer {
  let d = devServers.get(key);
  if (!d) {
    d = {
      proc: null,
      running: false,
      stopping: false,
      port,
      log: '',
      tunnelProc: null,
      tunnelUrl: null,
      startToken: 0,
      subs: new Set(),
    };
    devServers.set(key, d);
  }
  return d;
}
function notify(d: DevServer): void {
  for (const fn of d.subs) fn();
}

const TUNNEL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

/** A trycloudflare quick-tunnel URL gets a fresh random subdomain every run, so a
 *  persisted one is dead on the next launch (→ blank preview). Never restore it. */
const isTunnelUrl = (u: string): boolean => u.includes('.trycloudflare.com');

/** Expose localhost:port at a public https URL via a cloudflared quick tunnel (no CF account),
 *  so the mobile preview can reach the host's dev server. Best-effort — if cloudflared isn't
 *  present the preview just stays on localhost (works on the desktop host). */
function startTunnel(d: DevServer, projectPath: string, port: number): void {
  if (d.tunnelProc) {
    try {
      d.tunnelProc.kill();
    } catch {
      /* already gone */
    }
  }
  d.tunnelUrl = null;
  try {
    const t = native.process.spawn(
      'cloudflared',
      [
        'tunnel',
        '--url',
        `http://localhost:${port}`,
        // Rewrite the origin Host to localhost — Vite (`pnpm dev`) 403s "Blocked request"
        // for the trycloudflare hostname otherwise (server.allowedHosts). Applies to the HMR
        // websocket too, so live reload keeps working over the tunnel.
        '--http-host-header',
        `localhost:${port}`,
        '--no-autoupdate',
      ],
      { cwd: projectPath },
    );
    d.tunnelProc = t;
    const onOut = (c: string) => {
      d.log = (d.log + c).slice(-12000);
      if (!d.tunnelUrl) {
        const m = TUNNEL_RE.exec(c);
        if (m) {
          d.tunnelUrl = m[0];
          d.log = (d.log + `\n[tunnel: ${m[0]}]\n`).slice(-12000);
        }
      }
      notify(d);
    };
    t.onStdout(onOut);
    t.onStderr(onOut); // cloudflared prints the quick-tunnel URL to stderr
    t.onError((e) => {
      d.log = (d.log + `\n[tunnel unavailable: ${e}]\n`).slice(-12000);
      d.tunnelProc = null;
      notify(d);
    });
    t.onExit(() => {
      d.tunnelProc = null;
      notify(d);
    });
  } catch (e) {
    d.log = (d.log + `[tunnel unavailable: ${(e as Error).message}]\n`).slice(
      -12000,
    );
    notify(d);
  }
}

/**
 * Start the dev server, once we've confirmed the target really is an ugly-app project.
 *
 * The ugly-app check is ASYNC and asks the filesystem (resolveIsUglyApp). It used to be a
 * sync lookup in the repo-scan cache, which is false for any path the scan never walked —
 * including every session worktree under `.ugly-studio/`. So Preview refused to boot the
 * agent's own code with "<session dir> is not an ugly-app project" (the message prints the
 * path's last segment, which is why it looked like a session id was being used as a name).
 */
function startDev(
  key: string,
  projectPath: string,
  port: number,
  databaseUrl?: string,
): void {
  const d = getDev(key, port);
  void resolveIsUglyApp(projectPath).then((ok) => {
    if (!ok) {
      d.log =
        `[error] Cannot start dev server: ${projectPath} is not an ugly-app project.\n` +
        `The dev server requires \`pnpm dev\` (ugly-app CLI) to run — no .uglyapp marker or\n` +
        `ugly-app dependency was found there.\n`;
      d.running = false;
      notify(d);
      return;
    }
    startDevChecked(key, projectPath, port, databaseUrl);
  });
}

function startDevChecked(
  key: string,
  projectPath: string,
  port: number,
  databaseUrl?: string,
): void {
  const d = getDev(key, port);
  d.stopping = true; // killing any prior proc below is intentional, not a crash
  if (d.proc) {
    try {
      d.proc.kill();
    } catch {
      /* already gone */
    }
  }
  d.proc = null;
  d.log = '';
  d.running = true;
  d.port = port;
  const myToken = ++d.startToken; // this start's id; a later start/stop invalidates it
  notify(d);
  d.log = `$ pnpm dev  (PORT=${port})\n`;
  d.stopping = false;
  const spec = devServerSpawn(port, databaseUrl);
  const cmdStr = `${spec.cmd} ${spec.args.join(' ')}`;
  // Log the cwd and whether the selected repo differs from the project root
  // so error telemetry captures the exact scenario when the dev server fails
  // after a repo switch. This helps debug "pnpm fails on sub-repo" reports.
  console.log(
    '[PreviewPanel:startDev] key=%s port=%d cwd=%s projectPath=%s',
    key,
    port,
    projectPath,
    getActiveProjectPath(),
  );
  // Grant the process capability (bundles bash/pnpm/... onto the spawn PATH)
  // before spawning — required on Windows, idempotent elsewhere. The grant is
  // async; do the spawn once it resolves so the daemon doesn't deny it.
  void ensureDevToolsGranted().then(() => {
    if (d.startToken !== myToken) return; // superseded by a newer start/stop
    try {
      const p = native.process.spawn(spec.cmd, spec.args, {
        cwd: projectPath,
        env: spec.env,
      });
      d.proc = p;
      p.onStdout((c) => {
        d.log = (d.log + c).slice(-12000);
        notify(d);
        void persistDevLog(projectPath, d.log);
      });
      p.onStderr((c) => {
        d.log = (d.log + c).slice(-12000);
        notify(d);
        void persistDevLog(projectPath, d.log);
      });
      p.onError((e) => {
        if (d.proc !== p) return; // superseded by a restart — ignore the stale proc
        // Ship spawn failures to the error telemetry (browser Logger → errorLog); the
        // in-panel log alone isn't visible when the host is a remote/other machine.
        console.error(
          '[PreviewPanel:dev-server-error]',
          JSON.stringify({ cmd: cmdStr, cwd: projectPath, port, error: e }),
        );
        d.log = (d.log + `\n[error: ${e}]\n`).slice(-12000);
        d.running = false;
        d.proc = null;
        notify(d);
        void flushDevLog(projectPath, d.log);
      });
      p.onExit((code) => {
        if (d.proc !== p) return; // superseded by a restart — ignore the stale proc
        // A non-zero exit we didn't ask for is a real failure — e.g. 127 = `pnpm:
        // command not found` when the host lacks pnpm on PATH. Log it WITH the boot-log
        // tail (carries the shell's error text) so it's debuggable from another machine.
        if (!d.stopping && code !== 0 && code != null) {
          console.error(
            '[PreviewPanel:dev-server-exit]',
            JSON.stringify({
              cmd: cmdStr,
              cwd: projectPath,
              port,
              code,
              logTail: d.log.slice(-1500),
            }),
          );
        }
        d.log = (d.log + `\n[dev server exited ${code ?? ''}]\n`).slice(-12000);
        d.running = false;
        d.proc = null;
        notify(d);
      });
      // Publish it to a public https URL so the mobile preview can reach it.
      startTunnel(d, projectPath, port);
    } catch (e) {
      // Synchronous throw — e.g. NativeUnavailable when no host shell is wired.
      console.error(
        '[PreviewPanel:dev-server-threw]',
        JSON.stringify({
          cmd: cmdStr,
          cwd: projectPath,
          port,
          error: e instanceof Error ? e.message : String(e),
        }),
      );
      d.log += `[error: ${(e as Error).message}]\n`;
      d.running = false;
      notify(d);
    }
  });
}
function stopDev(key: string): void {
  const d = devServers.get(key);
  if (!d) return;
  d.stopping = true; // user-requested shutdown — suppress the onExit failure log
  d.startToken++; // cancel any start whose async tool-grant is still pending
  if (d.proc) {
    try {
      d.proc.kill();
    } catch {
      /* already gone */
    }
  }
  if (d.tunnelProc) {
    try {
      d.tunnelProc.kill();
    } catch {
      /* already gone */
    }
  }
  d.running = false;
  d.proc = null;
  d.tunnelProc = null;
  d.tunnelUrl = null;
  notify(d);
}

export function PreviewPanel({
  sessionId,
}: {
  sessionId?: string | null;
}): React.ReactElement {
  const activeRepo = useActiveRepoPath();
  // Prefer the active session's WORKTREE (agent's in-flight change) when it exists, so the dev
  // server runs the worktree checkout — serving the change — instead of `master`. Polled (the
  // worktree is created by the first turn); falls back to the selected repo / project root.
  const [resolvedProj, setResolvedProj] = React.useState<string | null>(
    activeRepo,
  );
  React.useEffect(() => {
    let cancelled = false;
    const resolve = async (): Promise<void> => {
      let dir = activeRepo;
      if (sessionId && activeRepo) {
        const wt = sessionWorktreeDir(activeRepo, sessionId);
        try {
          if (await native.fs.exists(wt)) dir = wt;
        } catch {
          /* fall back to activeRepo */
        }
      }
      if (!cancelled) setResolvedProj(dir);
    };
    void resolve();
    const t = setInterval(() => void resolve(), 5000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [activeRepo, sessionId]);
  const port = sessionId ? sessionPort(sessionId) : 4321;
  const defaultUrl = `http://localhost:${port}`;
  const devKey = sessionId ?? 'root';
  const [url, setUrl] = React.useState<string>(() => {
    try {
      const saved = localStorage.getItem(keyFor(sessionId ?? null));
      return saved && !isTunnelUrl(saved) ? saved : defaultUrl;
    } catch {
      return defaultUrl;
    }
  });
  const [committed, setCommitted] = React.useState<string>(url);
  const [reloadKey, setReloadKey] = React.useState(0);
  // Remember whether the log was open across tab switches + reloads (the log DATA
  // survives in the module map on a tab switch, and is restored from disk on a
  // page reload — see below — but this toggle is component-local, so persist it).
  const showLogKey = `ugly-studio:previewShowLog:${sessionId ?? 'none'}`;
  const [showLog, setShowLog] = React.useState<boolean>(() => {
    try {
      return localStorage.getItem(showLogKey) === '1';
    } catch {
      return false;
    }
  });
  React.useEffect(() => {
    try {
      localStorage.setItem(showLogKey, showLog ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [showLog, showLogKey]);
  // Dev-server log view: resizable height + auto-scroll-to-bottom (pinned unless
  // the user scrolls up to read history).
  const [logHeight, setLogHeight] = React.useState(200);
  // True while dragging the resize handle — disables the iframe's pointer events
  // so it doesn't swallow the mousemove events (the reason the drag "didn't work":
  // once the cursor crossed onto the iframe it captured the events).
  const [resizing, setResizing] = React.useState(false);
  const logRef = React.useRef<HTMLDivElement>(null);
  const logPinnedRef = React.useRef(true);
  const startLogResize = React.useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startY = e.clientY;
      const startH = logHeight;
      setResizing(true);
      const onMove = (ev: MouseEvent): void => {
        // Handle sits above the log (log is at the bottom), so dragging UP grows it.
        setLogHeight(
          Math.min(600, Math.max(80, startH + (startY - ev.clientY))),
        );
      };
      const onUp = (): void => {
        setResizing(false);
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [logHeight],
  );
  // Subscribe to the (module-level) dev-server state for this session.
  const [, forceRender] = React.useReducer((n: number) => n + 1, 0);
  const dev = getDev(devKey, port);
  React.useEffect(() => {
    const d = getDev(devKey, port);
    d.subs.add(forceRender);
    forceRender();
    return () => {
      d.subs.delete(forceRender);
    };
  }, [activeRepo, devKey, port]);

  // Restore the persisted dev-server log on a fresh page load: the module map is
  // wiped on reload, so seed `dev.log` from the on-disk log if it's empty (the
  // running server itself survives on the host). Skipped on a tab switch, where
  // the in-memory log is still present.
  React.useEffect(() => {
    const proj = resolvedProj;
    if (!proj) return;
    const d = getDev(devKey, port);
    if (d.log) return;
    void readDevLog(proj).then((text) => {
      const dd = getDev(devKey, port);
      if (text && !dd.log) {
        dd.log = text;
        notify(dd);
      }
    });
  }, [resolvedProj, devKey, port]);

  // Attach the dev-server log to any feedback filed from the preview tab, so a
  // "preview not working" report carries the actual dev-server output.
  React.useEffect(
    () =>
      registerFeedbackContextProvider(
        'devServerLog',
        (): Record<string, string> => {
          const d = getDev(devKey, port);
          return d.log ? { devServerLog: stripAnsi(d.log).slice(-8000) } : {};
        },
      ),
    [devKey, port],
  );

  React.useEffect(() => {
    try {
      const saved = localStorage.getItem(keyFor(sessionId ?? null));
      if (saved && !isTunnelUrl(saved)) {
        setUrl(saved);
        setCommitted(saved);
      }
    } catch {
      /* ignore */
    }
  }, [sessionId]);

  // The cloudflared tunnel URL is for opening the preview on a PHONE (localhost
  // won't resolve there) — it's surfaced in the log as `[tunnel: …]`. This iframe
  // always runs on the desktop Electron host (browser mode early-returns
  // NativeHostRequired), where localhost is faster and reliable, so we do NOT
  // hijack the iframe onto the tunnel: doing so swapped a working preview for a
  // slower, DNS-flaky trycloudflare URL ("briefly showed the app, then switched
  // to the cloudflare url; DNS issue in the logs"). Stay on localhost.

  const commit = React.useCallback(() => {
    const u = url.trim();
    if (!u) return;
    setCommitted(u);
    setReloadKey((k) => k + 1);
    try {
      localStorage.setItem(keyFor(sessionId ?? null), u);
    } catch {
      /* ignore */
    }
  }, [url, sessionId]);

  // Bridge: honor dev-server start/stop requests the coding agent writes via the
  // control file (devServerControl.ts) — the agent runs in the task context and
  // can't call startDev/stopDev directly. Poll ~3s; act on each new nonce once.
  const lastCtlNonce = React.useRef<string | null>(null);
  React.useEffect(() => {
    const proj = resolvedProj;
    if (!proj) return;
    let cancelled = false;
    // Seed with the current command so a stale pre-mount request isn't replayed.
    void readDevControl(proj).then((c) => {
      if (!cancelled) lastCtlNonce.current = c?.nonce ?? null;
    });
    const id = setInterval(() => {
      void readDevControl(proj).then((c) => {
        if (cancelled || !c || c.nonce === lastCtlNonce.current) return;
        lastCtlNonce.current = c.nonce;
        if (c.cmd === 'stop') stopDev(devKey);
        else
          startDev(
            devKey,
            proj,
            port,
            sessionId ? getSessionWorkspace(sessionId)?.databaseUrl : undefined,
          ); // start | restart
      });
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [resolvedProj, devKey, port, sessionId]);

  // Reload the iframe once the dev server is actually READY. `ugly-app dev` runs
  // Vite in MIDDLEWARE mode, so it never prints Vite's "➜ Local:" / "ready in Nms"
  // banner — the real readiness line is `[App] Server running on port N` (printed
  // right after it starts listening). Match that (plus the Vite banners, for other
  // servers). Keyed off `dev.startToken` so every start/restart re-arms — the old
  // one-shot `bootReloaded` ref meant an agent-triggered restart never reloaded.
  const reloadedTokenRef = React.useRef<number | null>(null);
  const READY_RE =
    /(Local:\s*https?:\/\/|ready in\s+[\d.]+\s*m?s|listening on|Server running on port)/i;
  React.useEffect(() => {
    if (!dev.running) return;
    const token = dev.startToken;
    if (reloadedTokenRef.current === token) return; // already reloaded this run
    if (READY_RE.test(stripAnsi(dev.log))) {
      reloadedTokenRef.current = token;
      setReloadKey((k) => k + 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dev.log, dev.running, dev.startToken]);

  // Fallback while the ready marker hasn't matched yet (unusual dev server, or a
  // reload that landed before the server was listening / mid Vite cold-optimize —
  // the old code latched after ONE early reload and stuck on connection-refused
  // forever). Retry-reload every 6s until the marker fires, capped at ~60s.
  React.useEffect(() => {
    if (!dev.running) return;
    const token = dev.startToken;
    let n = 0;
    const id = setInterval(() => {
      if (reloadedTokenRef.current === token) {
        clearInterval(id);
        return;
      }
      n += 1;
      setReloadKey((k) => k + 1);
      if (n >= 10) clearInterval(id);
    }, 6000);
    return () => {
      clearInterval(id);
    };
  }, [dev.running, dev.startToken]);

  const startOrRestart = React.useCallback(() => {
    const proj = resolvedProj;
    if (!proj) {
      setShowLog(true);
      return;
    }
    startDev(
      devKey,
      proj,
      port,
      sessionId ? getSessionWorkspace(sessionId)?.databaseUrl : undefined,
    );
    setShowLog(true);
    // Point the preview at the dev server; the readiness + retry effects above
    // reload the iframe once the server actually responds (startDev bumps the
    // run token, which re-arms them).
    const target = `http://localhost:${port}`;
    setUrl(target);
    setCommitted(target);
    try {
      localStorage.setItem(keyFor(sessionId ?? null), target);
    } catch {
      /* ignore */
    }
  }, [resolvedProj, devKey, port, sessionId]);

  // Auto-scroll the log to the bottom as new output arrives, while pinned.
  React.useEffect(() => {
    if (!showLog) return;
    const el = logRef.current;
    if (el && logPinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [dev.log, showLog, logHeight]);

  // A browser tab has no host to spawn the dev server on — say so instead of
  // silently showing a blank iframe forever.
  if (!isNativeAvailable())
    return (
      <div style={S.root}>
        <NativeHostRequired feature="Live preview" />
      </div>
    );

  return (
    <div data-id="preview-panel" style={S.root}>
      <div style={S.bar}>
        <button
          data-id="preview-start"
          style={dev.running ? S.restartBtn : S.startBtn}
          title={
            dev.running
              ? 'Restart the dev server'
              : 'Start the dev server (pnpm dev)'
          }
          onClick={startOrRestart}
        >
          {dev.running ? '⟳ Restart app' : '▶ Start app'}
        </button>
        {dev.running && (
          <button
            data-id="preview-stop"
            style={S.iconBtn}
            title="Stop the dev server"
            onClick={() => {
              stopDev(devKey);
            }}
          >
            ■
          </button>
        )}
        <span
          style={{
            ...S.dot,
            background: dev.running
              ? 'var(--accent-success, #10b981)'
              : 'var(--text-muted)',
          }}
          title={dev.running ? `running on :${dev.port}` : 'stopped'}
        />
        <button
          data-id="preview-reload"
          style={S.iconBtn}
          title="Reload preview"
          onClick={() => {
            setReloadKey((k) => k + 1);
          }}
        >
          ↻
        </button>
        <GitRepoSelector />
        <input
          data-id="preview-url"
          style={S.input}
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
          }}
          placeholder="http://localhost:4321"
          spellCheck={false}
        />
        <button data-id="preview-go" style={S.goBtn} onClick={commit}>
          Go
        </button>
        <button
          data-id="preview-logs"
          style={{ ...S.iconBtn, ...(showLog ? S.iconBtnActive : {}) }}
          title="Dev server logs"
          onClick={() => {
            setShowLog((s) => !s);
          }}
        >
          ⌗
        </button>
        <a
          data-id="preview-open"
          style={S.openBtn}
          href={committed}
          target="_blank"
          rel="noreferrer"
          title="Open in new tab"
        >
          ↗
        </a>
      </div>
      <div style={S.frameWrap}>
        {committed ? (
          <iframe
            key={`${reloadKey}:${committed}`}
            src={committed}
            style={{
              ...S.frame,
              ...(resizing ? { pointerEvents: 'none' as const } : {}),
            }}
            title="Preview"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          />
        ) : (
          <div style={S.empty}>
            Enter your dev server URL above to preview the app.
          </div>
        )}
      </div>
      {showLog && (
        <>
          <div
            data-id="preview-log-resize"
            onMouseDown={startLogResize}
            style={S.logResize}
            title="Drag to resize the log"
          />
          <div
            ref={logRef}
            data-id="preview-devlog"
            style={{ ...S.devlog, height: logHeight }}
            onScroll={(e) => {
              const el = e.currentTarget;
              // Re-pin when the user scrolls back to (near) the bottom.
              logPinnedRef.current =
                el.scrollHeight - el.scrollTop - el.clientHeight < 24;
            }}
          >
            {dev.log
              ? ansiToNodes(dev.log)
              : '(dev server not started — click “Start app”)'}
          </div>
        </>
      )}
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 0,
    background: 'var(--bg-primary)',
  },
  bar: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '6px 10px',
    borderBottom: '1px solid var(--border)',
    flexShrink: 0,
    background: 'var(--bg-panel)',
  },
  startBtn: {
    height: 26,
    flexShrink: 0,
    padding: '0 12px',
    fontFamily: 'var(--font-mono)',
    fontSize: 11,
    fontWeight: 700,
    background: 'var(--accent-success, #10b981)',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    cursor: 'pointer',
  },
  restartBtn: {
    height: 26,
    flexShrink: 0,
    padding: '0 12px',
    fontFamily: 'var(--font-mono)',
    fontSize: 11,
    fontWeight: 600,
    background: 'var(--bg-secondary)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    cursor: 'pointer',
  },
  dot: { width: 8, height: 8, borderRadius: '50%', flexShrink: 0 },
  iconBtn: {
    width: 26,
    height: 26,
    flexShrink: 0,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'var(--bg-secondary)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 13,
  },
  iconBtnActive: {
    background: 'var(--accent-dim)',
    color: 'var(--accent)',
    borderColor: 'var(--accent)',
  },
  input: {
    flex: 1,
    minWidth: 0,
    height: 26,
    boxSizing: 'border-box',
    padding: '0 10px',
    fontFamily: 'var(--font-mono)',
    fontSize: 12,
    background: 'var(--bg-primary)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border)',
    borderRadius: 6,
  },
  goBtn: {
    height: 26,
    flexShrink: 0,
    padding: '0 12px',
    fontFamily: 'var(--font-mono)',
    fontSize: 11,
    fontWeight: 600,
    background: 'var(--accent-dim)',
    color: 'var(--accent)',
    border: '1px solid var(--accent)',
    borderRadius: 6,
    cursor: 'pointer',
  },
  openBtn: {
    width: 26,
    height: 26,
    flexShrink: 0,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'var(--bg-secondary)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    textDecoration: 'none',
    fontSize: 13,
  },
  devlog: {
    flexShrink: 0,
    overflow: 'auto',
    margin: 0,
    padding: '8px 12px',
    borderTop: '1px solid var(--border)',
    background: '#111',
    fontFamily: 'var(--font-mono)',
    fontSize: 11,
    lineHeight: 1.5,
    color: '#ddd',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  logResize: {
    flexShrink: 0,
    height: 6,
    cursor: 'ns-resize',
    background: 'var(--border)',
    borderTop: '1px solid var(--bg-panel)',
  },
  frameWrap: {
    flex: 1,
    minHeight: 0,
    position: 'relative',
    background: '#fff',
  },
  frame: { width: '100%', height: '100%', border: 'none' },
  empty: {
    padding: 24,
    fontFamily: 'var(--font-mono)',
    fontSize: 13,
    color: 'var(--text-muted)',
  },
};
