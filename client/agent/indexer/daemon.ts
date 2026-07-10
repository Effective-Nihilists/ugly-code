/**
 * Indexer daemon launcher — singleton-per-machine.
 *
 * One Python sidecar serves all node processes on this box. The daemon's
 * port is published via a portfile at `~/.ugly-studio/indexer/daemon.json`;
 * concurrent launchers race for the lockfile at `~/.ugly-studio/indexer/daemon.lock`,
 * the winner spawns the daemon detached, the rest poll the portfile.
 *
 * Lifecycle:
 *   - Daemon outlives any individual node process (`spawn` with detached:true).
 *   - We never `kill` the daemon on our own teardown — it's a shared resource.
 *   - Stale portfile (PID dead OR /ping fails) → we re-spawn under lock.
 *
 * Logs go to `~/.ugly-studio/indexer/daemon.log`, rotated to `daemon.log.prev`
 * on respawn so a crash's traceback survives the restart.
 *
 * This is the node-only build for ugly-code's coding task: it uses the global
 * `fetch` (no undici dispatcher), materializes the Python sources via
 * `./assets.ts`, and provisions its toolchain via `../binaries/resolve.ts`
 * (uv) plus a uv-managed CPython venv. The daemon's own bookkeeping files
 * (portfile/lock/log/venv) live under `~/.ugly-studio/indexer/`; the Python
 * writes its model cache under `UGLY_STUDIO_CACHE` (= `cacheRoot()`).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describeDaemonHealth, type DaemonHealth } from './daemonHealth.js';
import { ensureUv } from '../binaries/resolve.js';
import { cacheRoot, ensureIndexerSources, requirementsHash } from './assets.js';

interface PortFile {
  port: number;
  pid: number;
  started_at: number;
}

const STARTUP_TIMEOUT_MS = 30_000;
const LOCK_WAIT_TIMEOUT_MS = 60_000;
const PING_TIMEOUT_MS = 1_500;

function daemonDir(): string {
  // `~/.ugly-studio/indexer/` — created lazily. Holds the daemon's own
  // bookkeeping (portfile, lock, logs, venv, requirements sentinel), NOT the
  // Python model cache (that follows UGLY_STUDIO_CACHE / cacheRoot()).
  return path.join(os.homedir(), '.ugly-studio', 'indexer');
}

function portFilePath(): string {
  return path.join(daemonDir(), 'daemon.json');
}

function lockFilePath(): string {
  return path.join(daemonDir(), 'daemon.lock');
}

function logFilePath(): string {
  return path.join(daemonDir(), 'daemon.log');
}

/** The log of the PREVIOUS daemon run. Kept because the current log is truncated
 *  on every respawn — so a daemon that dies and gets restarted would otherwise
 *  erase the only evidence of why it died. */
function prevLogFilePath(): string {
  return path.join(daemonDir(), 'daemon.log.prev');
}

function ensureDaemonDir(): void {
  fs.mkdirSync(daemonDir(), { recursive: true });
}

function readPortFile(): PortFile | null {
  try {
    const raw = fs.readFileSync(portFilePath(), 'utf8');
    const parsed = JSON.parse(raw) as PortFile;
    if (
      typeof parsed.port === 'number' &&
      typeof parsed.pid === 'number' &&
      typeof parsed.started_at === 'number'
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function writePortFile(p: PortFile): void {
  ensureDaemonDir();
  fs.writeFileSync(portFilePath(), JSON.stringify(p, null, 2));
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH = no such process; EPERM = exists but we can't signal (still alive)
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function pingDaemon(port: number): Promise<boolean> {
  // Global fetch (undici under the hood) — no custom dispatcher; the /ping
  // response is immediate so the default timeouts never come into play, and
  // the AbortController below caps it regardless.
  const ac = new AbortController();
  const timer = setTimeout(() => {
    ac.abort();
  }, PING_TIMEOUT_MS);
  timer.unref();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/ping`, {
      signal: ac.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function isPortFileAlive(p: PortFile): Promise<boolean> {
  if (!pidAlive(p.pid)) return false;
  return pingDaemon(p.port);
}

/**
 * Try to acquire the spawn lock by atomically creating the lockfile.
 * Returns true if we won; false if another process holds it. Stale
 * locks (older than 5 min) are forced — that protects against a
 * crash mid-spawn.
 */
function tryAcquireLock(): boolean {
  ensureDaemonDir();
  try {
    const fd = fs.openSync(lockFilePath(), 'wx');
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, t: Date.now() }));
    fs.closeSync(fd);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    // Lock exists — check staleness.
    try {
      const raw = fs.readFileSync(lockFilePath(), 'utf8');
      const { t, pid } = JSON.parse(raw) as { t: number; pid: number };
      const ageMs = Date.now() - t;
      const stale =
        ageMs > 5 * 60_000 || (typeof pid === 'number' && !pidAlive(pid));
      if (stale) {
        fs.unlinkSync(lockFilePath());
        return tryAcquireLock();
      }
    } catch {
      // Couldn't parse lockfile — treat as stale.
      try {
        fs.unlinkSync(lockFilePath());
      } catch {
        /* ignore */
      }
      return tryAcquireLock();
    }
    return false;
  }
}

function releaseLock(): void {
  try {
    fs.unlinkSync(lockFilePath());
  } catch {
    /* ignore */
  }
}

async function waitForPortFile(deadlineMs: number): Promise<PortFile> {
  while (Date.now() < deadlineMs) {
    const p = readPortFile();
    if (p && (await isPortFileAlive(p))) return p;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timed out waiting for indexer daemon to start');
}

/**
 * Provision (once) a uv-managed CPython venv dedicated to the indexer and
 * return its python executable. The venv lives at `<cacheRoot()>/indexer/venv`
 * — a stable, uv-owned environment we `uv pip install` the daemon's deps into,
 * kept out of the user's own Python (the daemon imports sqlite_vec + onnxruntime
 * that a system interpreter is unlikely to have). Idempotent: if the interpreter
 * already exists we skip the `uv venv` call.
 */
async function ensureIndexerVenvPython(uv: string): Promise<string> {
  const venvDir = path.join(cacheRoot(), 'indexer', 'venv');
  const python =
    process.platform === 'win32'
      ? path.join(venvDir, 'Scripts', 'python.exe')
      : path.join(venvDir, 'bin', 'python3');
  if (fs.existsSync(python)) return python;
  console.warn(`[indexer] creating CPython 3.12 venv at ${venvDir}`);
  const res = await runProcess(uv, ['venv', '--python', '3.12', venvDir], {
    env: { ...process.env },
    timeoutMs: 180_000,
  });
  if (res.code !== 0) {
    throw new Error(
      `failed to create indexer venv (exit ${res.code}): ${res.stderr.trim()}`,
    );
  }
  return python;
}

async function spawnDaemon(): Promise<PortFile> {
  // The indexer ALWAYS uses a uv-managed CPython venv (never the user's system
  // Python) because the daemon imports sqlite_vec + onnxruntime, which we
  // install into that dedicated venv via `uv pip install`. A user's system
  // python is unlikely to have them, so honoring a system interpreter would
  // silently break semantic search.
  console.warn('[indexer] resolving uv toolchain');
  // Ensure uv is available before use — uv manages the indexer's CPython venv
  // (+ sqlite_vec). Idempotent; installs into the shared binaries root on first
  // run. (No separate install-registry gate here — ugly-code has none; ensureUv
  // itself serializes concurrent callers.)
  const uv = await ensureUv();
  // Materialize this build's Python sources (server.py, requirements.txt, …)
  // onto disk — they ship as static assets, not inside the bundled task JS.
  const sourceDir = await ensureIndexerSources();
  // uv owns a dedicated venv for the indexer (installs CPython 3.12 on first run).
  const python = await ensureIndexerVenvPython(uv);
  if (!python || !uv) {
    const err = new Error(
      `uv/python unavailable for indexer daemon (python=${python}, uv=${uv}); ` +
        `semantic search will be disabled until uv provisions the venv.`,
    );
    console.warn(`[indexer] ${err.message}`);
    throw err;
  }
  console.warn(`[indexer] toolchain ready (uv=${uv}, python=${python})`);
  const serverScript = path.join(sourceDir, 'server.py');

  // Plain env: point the daemon (and its uv/python children) at the shared
  // cache root for the embedding-model download, and unbuffer stdout so the
  // port-handshake line arrives promptly.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PYTHONUNBUFFERED: '1',
    UGLY_STUDIO_CACHE: cacheRoot(),
  };

  console.warn('[indexer] installing dependencies (if changed)');
  try {
    await ensureIndexerDepsInstalled(uv, python, sourceDir, env);
    console.warn('[indexer] dependencies ready');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[indexer] dependency install failed: ${msg}`);
    throw err;
  }

  // Rotate the daemon log rather than silently truncating it: when a daemon dies
  // and we respawn, the old log is the ONLY record of why it died. Truncating it
  // is what made a crashed indexer indistinguishable from a healthy one.
  ensureDaemonDir();
  try {
    if (fs.existsSync(logFilePath())) {
      fs.renameSync(logFilePath(), prevLogFilePath());
    }
  } catch {
    /* best-effort rotation; never block a spawn on it */
  }
  const logFd = fs.openSync(logFilePath(), 'w');

  console.warn('[indexer] spawning daemon');
  // stdio: stdout is a pipe so we can capture the port handshake;
  // stderr goes straight to the logfile so we don't have to drain it.
  // detached:true so the daemon outlives our node process.
  const proc = spawn(python, ['-u', serverScript, '--port', '0'], {
    cwd: sourceDir,
    env,
    stdio: ['ignore', 'pipe', logFd],
    detached: true,
    // Windows: without this, a detached console app (python.exe) pops a
    // visible console window that lives as long as the daemon. No-op elsewhere.
    windowsHide: true,
  });

  // Capture the port-handshake JSON line from stdout.
  let port: number;
  let pid: number;
  try {
    const handshake = await new Promise<{ port: number; pid: number }>(
      (resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('indexer daemon startup timed out'));
        }, STARTUP_TIMEOUT_MS);
        timer.unref();

        let buffer = '';
        const onData = (data: Buffer) => {
          buffer += data.toString();
          const newline = buffer.indexOf('\n');
          if (newline >= 0) {
            const line = buffer.slice(0, newline).trim();
            proc.stdout?.removeListener('data', onData);
            clearTimeout(timer);
            try {
              const parsed = JSON.parse(line) as {
                port?: unknown;
                pid?: unknown;
              };
              if (
                typeof parsed.port === 'number' &&
                typeof parsed.pid === 'number'
              ) {
                resolve({ port: parsed.port, pid: parsed.pid });
              } else {
                reject(new Error(`unexpected startup line: ${line}`));
              }
            } catch {
              reject(new Error(`failed to parse startup line: ${line}`));
            }
          }
        };
        proc.stdout?.on('data', onData);
        proc.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
        proc.on('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`indexer daemon exited with code ${code}`));
        });
      },
    );
    port = handshake.port;
    pid = handshake.pid;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[indexer] daemon spawn failed (pid=${proc.pid ?? 'none'}): ${msg}`,
    );
    try {
      fs.closeSync(logFd);
    } catch {
      /* ignore */
    }
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
    throw err;
  }

  // Drop our reference to the daemon — it lives independently.
  proc.stdout?.destroy();
  proc.unref();
  // Don't close logFd: it's now owned by the daemon's stderr.
  // (Closing it here would terminate the daemon's writes to the log.)

  // warn (not log) so a remote install confirms the daemon actually
  // came up — the ugly-app console intercept only persists warn/error
  // to errorLog. Without this we couldn't tell apart "daemon started
  // and is silently working" from "daemon never started" on a tester
  // machine.
  console.warn(`[indexer] daemon spawned pid=${pid} port=${port}`);

  const portFile: PortFile = {
    port,
    pid,
    started_at: Date.now(),
  };
  writePortFile(portFile);
  return portFile;
}

/**
 * Idempotently install the indexer's Python deps into the venv. Skips when the
 * requirements.txt hash matches the sentinel AND `import flask` succeeds
 * (belt-and-braces against a manually wiped venv).
 *
 * Async: uses `child_process.spawn` with promise wrappers, not `spawnSync` —
 * sync spawns would block the Node event loop for the whole `uv pip install`
 * (tens of seconds to minutes on a cold first launch, especially on Windows
 * where `onnxruntime-directml` is a ~200MB download). Callers in the request
 * path need the loop responsive.
 *
 * `onLine` lets callers stream every stdout/stderr line into a progress UI.
 * When omitted, output is silently captured for error reporting only.
 */
export async function ensureIndexerDepsInstalled(
  uv: string,
  python: string,
  sourceDir: string,
  env: NodeJS.ProcessEnv,
  onLine?: (line: string) => void,
): Promise<void> {
  // Auto-pickup: re-run `uv pip install` whenever requirements.txt
  // changes. We hash the file contents and compare to a sentinel
  // written after a successful install. This catches new entries
  // (e.g. adding a provider package), version bumps, and platform-
  // marker changes — not just "is flask importable".
  const requirementsPath = path.join(sourceDir, 'requirements.txt');
  const reqHash = await requirementsHash(sourceDir);
  const sentinelPath = path.join(daemonDir(), 'requirements.sha');
  let installedHash: string | null = null;
  try {
    installedHash = fs.readFileSync(sentinelPath, 'utf8').trim();
  } catch {
    /* no sentinel yet */
  }

  if (installedHash === reqHash) {
    // Belt-and-braces: confirm flask is actually importable. If the
    // venv was wiped between runs the sentinel may be stale.
    const ok = await runProcess(python, ['-c', 'import flask'], {
      env,
      timeoutMs: 10_000,
    });
    if (ok.code === 0) return;
  }

  console.log(
    '[indexer] installing Python dependencies (requirements changed)...',
  );
  const install = await runProcess(
    uv,
    ['pip', 'install', '-r', requirementsPath, '--python', python],
    { env, timeoutMs: 180_000, onLine },
  );

  if (install.code !== 0) {
    throw new Error(
      `Failed to install indexer dependencies (exit ${install.code}): ${install.stderr.trim()}`,
    );
  }
  ensureDaemonDir();
  fs.writeFileSync(sentinelPath, reqHash);
  console.log('[indexer] dependencies installed');
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface RunOptions {
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** Forwarded every line on either stream after ANSI stripping. */
  onLine?: (line: string) => void;
}

// Strip ANSI SGR color escapes from tool output. Defined once (with a rule
// disable) because the sequence literally begins with the ESC control char.
// eslint-disable-next-line no-control-regex -- ANSI SGR escapes start with ESC (0x1b)
const ANSI_SGR_RE = /\x1b\[[0-9;]*m/g;

/**
 * Spawn a child, drain stdout + stderr (Windows pipe buffers are
 * tiny, leaving them undrained deadlocks the child), enforce a
 * timeout, and resolve once the process exits. Lines are forwarded
 * to `onLine` as soon as a newline lands so the UI sees progress
 * in real time rather than at the end.
 */
function runProcess(
  cmd: string,
  args: string[],
  opts: RunOptions,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: opts.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Windows: hide the transient uv/pip console window during provisioning.
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let stdoutBuf = '';
    let stderrBuf = '';
    const flushLines = (which: 'out' | 'err', incoming: string) => {
      if (which === 'out') stdoutBuf += incoming;
      else stderrBuf += incoming;
      const buf = which === 'out' ? stdoutBuf : stderrBuf;
      const lastNl = buf.lastIndexOf('\n');
      if (lastNl < 0) return;
      const ready = buf.slice(0, lastNl);
      if (which === 'out') stdoutBuf = buf.slice(lastNl + 1);
      else stderrBuf = buf.slice(lastNl + 1);
      if (!opts.onLine) return;
      for (const line of ready.split('\n')) {
        const trimmed = line.replace(ANSI_SGR_RE, '').trimEnd();
        if (trimmed) opts.onLine(trimmed);
      }
    };
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      stdout += text;
      flushLines('out', text);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      stderr += text;
      flushLines('err', text);
    });
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, opts.timeoutMs);
    timer.unref();
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      // Flush any trailing partial line to onLine so a final
      // "Installed N packages" message without a trailing \n still
      // surfaces in the UI.
      if (opts.onLine) {
        for (const tail of [stdoutBuf, stderrBuf]) {
          const trimmed = tail.replace(ANSI_SGR_RE, '').trimEnd();
          if (trimmed) opts.onLine(trimmed);
        }
      }
      resolve({ code, stdout, stderr });
    });
  });
}

// In-flight discover promise, so concurrent callers within one node
// process funnel through a single discovery pass.
let _discoveringPromise: Promise<PortFile> | null = null;
let _cachedPortFile: PortFile | null = null;
// Last daemon spawn/provisioning failure, surfaced via codebase.status so a
// "codebase: loading" report carries WHY the indexer never came up (otherwise
// the error is swallowed to a null status and the pill just spins forever).
let _lastDaemonError: string | null = null;

/** The most recent daemon spawn/provisioning error (null if none / recovered). */
export function getLastDaemonError(): string | null {
  return _lastDaemonError;
}

function tailOf(file: string, maxBytes: number): string {
  try {
    const buf = fs.readFileSync(file);
    return buf.subarray(Math.max(0, buf.length - maxBytes)).toString('utf8');
  } catch {
    return '';
  }
}

/**
 * Tail of the daemon log for diagnostics (empty string if unreadable).
 *
 * Falls back to the PREVIOUS run's log when the current one is empty: a daemon
 * that crashed on a later request wrote nothing to the fresh log, so the useful
 * traceback lives in daemon.log.prev.
 */
export function readDaemonLogTail(maxBytes = 4000): string {
  const current = tailOf(logFilePath(), maxBytes).trim();
  if (current) return current;
  const prev = tailOf(prevLogFilePath(), maxBytes).trim();
  return prev ? `(previous daemon run)\n${prev}` : '';
}

/**
 * Diagnose the daemon without spawning it: read the portfile, check the pid, and
 * ping. Cheap enough for the 3s status poll.
 */
export async function daemonHealth(): Promise<DaemonHealth> {
  const pf = readPortFile();
  if (!pf) return describeDaemonHealth(null, false, false, Date.now());
  const alive = pidAlive(pf.pid);
  const responding = alive ? await pingDaemon(pf.port) : false;
  return describeDaemonHealth(pf, alive, responding, Date.now());
}

// Self-heal backoff: a status poll runs every 3s, so a permanently-failing spawn
// must not be retried on every tick.
let _lastRespawnAttempt = 0;
const RESPAWN_BACKOFF_MS = 15_000;

/**
 * Bring the daemon back if it isn't answering. Fire-and-forget, deduped by
 * `getDaemonPort`'s in-flight promise and rate-limited by a backoff.
 *
 * WHY: `getDaemonPortIfReady` (the status path) deliberately never spawns, and
 * `ensureIndexStarted` runs only once per session. A daemon that died mid-session
 * was therefore never revived — the pill sat on "analyzing…" forever.
 */
export function ensureDaemonRunning(): void {
  const now = Date.now();
  if (now - _lastRespawnAttempt < RESPAWN_BACKOFF_MS) return;
  _lastRespawnAttempt = now;
  void getDaemonPort().catch(() => {
    // getDaemonPort already records _lastDaemonError; surfaced via diagnostics.
  });
}

/**
 * Returns the current daemon port (spawning if needed). Cached
 * within this node process; on cache miss we re-validate against
 * the portfile and re-spawn under lock if the daemon is dead.
 */
export async function getDaemonPort(): Promise<number> {
  // Fast path: cached & alive.
  if (_cachedPortFile && (await isPortFileAlive(_cachedPortFile))) {
    return _cachedPortFile.port;
  }
  if (_discoveringPromise) {
    const p = await _discoveringPromise;
    return p.port;
  }
  _discoveringPromise = discoverOrSpawn();
  try {
    const p = await _discoveringPromise;
    _cachedPortFile = p;
    _lastDaemonError = null; // recovered
    return p.port;
  } catch (e) {
    _lastDaemonError = e instanceof Error ? e.message : String(e);
    throw e;
  } finally {
    _discoveringPromise = null;
  }
}

/**
 * Non-spawning variant of getDaemonPort: returns the port ONLY if a daemon is
 * already alive (cached in-process, or an alive portfile on disk). Never spawns
 * and never waits on the in-flight discover — so a *status read* can't block on
 * the heavy first-run provisioning chain (uv + CPython + ONNX deps download,
 * ~200MB on Windows). Returns null while the daemon is still spinning up; the
 * caller renders that as "indexing"/provisioning instead of a frozen "loading".
 * The spawn itself is driven separately by ensureIndexStarted → status().
 */
export async function getDaemonPortIfReady(): Promise<number | null> {
  if (_cachedPortFile && (await isPortFileAlive(_cachedPortFile))) {
    return _cachedPortFile.port;
  }
  const existing = readPortFile();
  if (existing && (await isPortFileAlive(existing))) {
    _cachedPortFile = existing;
    return existing.port;
  }
  return null;
}

async function discoverOrSpawn(): Promise<PortFile> {
  // Check disk portfile first — another process on this machine may
  // have already started the daemon.
  const existing = readPortFile();
  if (existing && (await isPortFileAlive(existing))) {
    return existing;
  }

  // Stale or missing — try to win the lock and spawn.
  if (tryAcquireLock()) {
    try {
      // Re-check after acquiring lock: another process may have
      // spawned a daemon between our portfile read and our lock
      // acquire. (Less likely with O_EXCL but worth defending.)
      const recheck = readPortFile();
      if (recheck && (await isPortFileAlive(recheck))) {
        return recheck;
      }
      return await spawnDaemon();
    } finally {
      releaseLock();
    }
  }

  // Someone else is spawning — wait for them.
  return waitForPortFile(Date.now() + LOCK_WAIT_TIMEOUT_MS);
}

/**
 * Forget the cached portfile so the next getDaemonPort() re-validates.
 * Used when an HTTP call fails with a connection error — the daemon
 * may have crashed.
 */
export function invalidateDaemonCache(): void {
  _cachedPortFile = null;
}
