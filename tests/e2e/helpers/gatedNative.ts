import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import type { Page } from '@playwright/test';
import {
  CapabilityGate,
  GrantStore,
  originScopeDir,
} from 'ugly-app/native/server';

/**
 * Bundled-tool allowlist — MIRROR of the Ugly Studio daemon's BUNDLED_BINARIES
 * (ugly-studio/electron/ugly-register.ts). The GATE logic itself is no longer
 * mirrored: this harness imports the REAL `CapabilityGate` from the framework
 * (`ugly-app/native/server`) — the exact class the daemon constructs — so a test
 * enforces precisely what production does. (Only the allowlist VALUE still lives
 * in the host; the daemon owns its own list.)
 */
export const DAEMON_BUNDLED_BINARIES = [
  'node',
  'git',
  'gh',
  'python',
  'uv',
  'ffmpeg',
  'imagemagick',
  'rg',
  'bash',
  'npm',
  'npx',
  'pnpm',
];

/** The origin the harness drives as — the real first-party IDE origin. */
const ORIGIN = 'https://code.ugly.bot';

export interface GatedNativeOpts {
  /** Base dir for the gate's per-origin scoped folders (a temp dir in tests). */
  root: string;
  /** The bundled-tool allowlist (defaults to the daemon's list). */
  bundledBinaries?: readonly string[];
  /** Whether the in-memory sandbox backend reports supported (default true). */
  sandboxSupported?: boolean;
}

/**
 * A `window.UglyNative` whose fs/process are REAL but pass through the ACTUAL
 * `CapabilityGate` the Ugly Studio daemon uses — same class, same allowlist
 * semantics, same scope confinement. `permissions.request` commits the grant
 * (mirroring the trusted-origin auto-commit); every fs/process op is then
 * authorized + resolved by the gate before the real syscall runs, so a denial
 * here is byte-for-byte the denial production would raise.
 *
 * Returns the resolved scope root so a test can read what was written.
 */
export async function installGatedNative(
  page: Page,
  opts: GatedNativeOpts,
): Promise<{ scopeRoot: string }> {
  const bundled = opts.bundledBinaries ?? DAEMON_BUNDLED_BINARIES;
  const store = new GrantStore([ORIGIN]); // trusted origin
  const gate = new CapabilityGate({
    store,
    baseDir: opts.root,
    bundledBinaries: bundled,
  });
  const scopeRoot = originScopeDir(opts.root, ORIGIN);
  mkdirSync(scopeRoot, { recursive: true }); // the origin's sandbox folder must exist

  // ── Node side: every handler runs the REAL gate, then the real op. ──
  // permissions.request → commit the grant (trusted origins auto-commit).
  await page.exposeFunction('__gnRequest', (req: unknown) => {
    store.grant(ORIGIN, (req ?? {}) as Parameters<GrantStore['grant']>[1]);
    const g = store.query(ORIGIN);
    return { fs: g.fs, process: [...g.process] };
  });
  // fs.* → gate.resolveFsPath authorizes + confines, then the real syscall.
  await page.exposeFunction(
    '__gnFs',
    (op: string, path: string, content: string) => {
      const abs = gate.resolveFsPath(ORIGIN, path); // throws PermissionDenied on deny/escape
      switch (op) {
        case 'readFile':
          return { content: fs.readFileSync(abs, 'utf8') };
        case 'writeFile':
          fs.writeFileSync(abs, content ?? '');
          return {};
        case 'readdir':
          return {
            entries: fs.readdirSync(abs, { withFileTypes: true }).map((d) => ({
              name: d.name,
              isDirectory: d.isDirectory(),
              isFile: d.isFile(),
            })),
          };
        case 'mkdir':
          fs.mkdirSync(abs, { recursive: true });
          return {};
        case 'exists':
          return { exists: fs.existsSync(abs) };
        default:
          return {};
      }
    },
  );
  // process.spawn → gate.checkProcess (allowlist + grant) + resolveProcessCwd
  // (confinement), then the real child process. Resolves after exit with the
  // collected output (commands under test are short).
  await page.exposeFunction(
    '__gnSpawn',
    (cmd: string, args: string[], cwd: string | undefined) =>
      new Promise<{ stdout: string; stderr: string; code: number | null }>(
        (res, rej) => {
          try {
            gate.checkProcess(ORIGIN, cmd); // throws PermissionDenied if not allowed
            const safeCwd = gate.resolveProcessCwd(ORIGIN, cwd); // throws on escape
            mkdirSync(safeCwd, { recursive: true });
            let out = '';
            let err = '';
            const proc = spawn(cmd, args ?? [], { cwd: safeCwd });
            proc.stdout?.on('data', (d) => (out += d));
            proc.stderr?.on('data', (d) => (err += d));
            proc.on('error', (e) =>
              res({ stdout: out, stderr: err + String(e), code: 1 }),
            );
            proc.on('close', (code) => res({ stdout: out, stderr: err, code }));
          } catch (e) {
            rej(e as Error); // gate denial → page-side invoke rejects
          }
        },
      ),
  );

  await page.addInitScript((sandboxSupported: boolean) => {
    const listeners: Record<string, Array<(d: unknown) => void>> = {};
    let seq = 0;
    const emit = (e: string, d: unknown): void =>
      (listeners[e] ?? []).forEach((cb) => cb(d));
    // In-memory sandbox state (the real OS-user backend lives in the daemon —
    // here we mirror the contract so the client's pill + tool wiring is testable).
    const sbInit = new Set<string>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    // Spawns that carried a sandbox context, for assertions.
    w.__sandboxSpawns = [];

    w.UglyNative = {
      platform: 'desktop',
      subscribe: (e: string, cb: (d: unknown) => void) => {
        (listeners[e] ??= []).push(cb);
        return () => {
          listeners[e] = (listeners[e] ?? []).filter((f) => f !== cb);
        };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      invoke: async (ch: string, p: any = {}) => {
        if (ch === 'permissions.request')
          return { granted: await w.__gnRequest(p) };
        if (ch === 'permissions.query')
          return { granted: await w.__gnRequest({}) };
        if (ch === 'fs.readFile')
          return w.__gnFs('readFile', String(p.path), '');
        if (ch === 'fs.writeFile')
          return w.__gnFs('writeFile', String(p.path), String(p.content ?? ''));
        if (ch === 'fs.readdir') return w.__gnFs('readdir', String(p.path), '');
        if (ch === 'fs.mkdir') return w.__gnFs('mkdir', String(p.path), '');
        if (ch === 'fs.exists') return w.__gnFs('exists', String(p.path), '');
        if (ch === 'fs.realpath') return { path: String(p.path) };
        // ── sandbox (per-project OS-user isolation) ──
        if (ch === 'sandbox.status') {
          const id = String(p.projectId);
          return {
            supported: sandboxSupported,
            initialized: sbInit.has(id),
            platform: sandboxSupported ? 'macos' : 'unsupported',
            username: sandboxSupported ? 'ugs-' + id : null,
          };
        }
        if (ch === 'sandbox.initialize') {
          if (!sandboxSupported)
            return { ok: false, error: 'sandbox not supported on unsupported' };
          sbInit.add(String(p.projectId));
          return { ok: true };
        }
        if (ch === 'sandbox.teardown') {
          sbInit.delete(String(p.projectId));
          return { ok: true };
        }
        if (ch === 'process.spawn') {
          // The facade sends { cmd, args, opts }; cwd + sandbox live on opts.
          const opts = p.opts ?? p;
          if (opts?.sandbox)
            w.__sandboxSpawns.push({
              cmd: String(p.cmd),
              sandbox: opts.sandbox,
            });
          const id = 'p' + seq++;
          // __gnSpawn rejects (gate denial) → this await throws → invoke rejects.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const r: any = await w.__gnSpawn(
            String(p.cmd),
            (p.args ?? []).map(String),
            opts?.cwd ? String(opts.cwd) : undefined,
          );
          setTimeout(() => {
            if (r.stdout) emit('process.stdout:' + id, { chunk: r.stdout });
            if (r.stderr) emit('process.stderr:' + id, { chunk: r.stderr });
            emit('process.exit:' + id, { code: r.code });
          }, 0);
          return { id, pid: 1000 + seq };
        }
        if (
          ch === 'process.write' ||
          ch === 'process.closeStdin' ||
          ch === 'process.kill'
        )
          return {};
        return {};
      },
    };
  }, opts.sandboxSupported ?? true);

  return { scopeRoot };
}
