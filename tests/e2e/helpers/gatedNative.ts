import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import { isAbsolute, join, resolve } from 'node:path';
import type { Page } from '@playwright/test';

/**
 * Bundled-tool allowlist — MIRROR of the Ugly Studio daemon's BUNDLED_BINARIES
 * (ugly-studio/electron/ugly-register.ts). Keep in sync: a tool the daemon won't
 * spawn must be denied here too, or tests give false confidence (exactly how the
 * `bash`-not-bundled Create Project bug shipped — the old harness ran real bash
 * with no gate). The eventual fix is to lift the daemon's CapabilityGate into
 * ugly-app and import it in both places so they can't drift.
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

export interface GatedNativeOpts {
  /** Filesystem sandbox root — every fs/cwd path is confined to this dir. */
  root: string;
  /** The bundled-tool allowlist (defaults to the daemon's list). */
  bundledBinaries?: readonly string[];
  /**
   * Trusted (first-party) origin: a `permissions.request` is auto-granted
   * without a prompt — BUT the app must still CALL request, exactly like the
   * daemon (TRUSTED_ORIGINS auto-commit on request). When false, only what the
   * app explicitly requested is granted.
   */
  trusted?: boolean;
}

/**
 * A `window.UglyNative` backed by the REAL filesystem + real child processes
 * (sandboxed to `root`), but gated by the SAME capability model as the Ugly
 * Studio daemon:
 *   - fs.* requires the `fs` capability (granted via permissions.request).
 *   - process.spawn(bin) requires (a) `bin` in the bundled allowlist
 *     ("not a bundled tool") AND (b) the `process` capability for `bin`
 *     ("requires the process permission") — gh/git also pass via github.
 * So a test can prove the app requested the right capabilities and only spawns
 * bundled tools, instead of silently succeeding against an unrestricted host.
 */
export async function installGatedNative(page: Page, opts: GatedNativeOpts): Promise<void> {
  const root = opts.root;
  const bundled = opts.bundledBinaries ?? DAEMON_BUNDLED_BINARIES;
  const rp = (p: string): string => {
    const r = resolve(isAbsolute(p) ? p : join(root, p));
    if (!r.startsWith(resolve(root))) throw new Error(`path escapes sandbox: ${p}`);
    return r;
  };

  // Node-side REAL fs/process (the gate above decides whether they're reached).
  await page.exposeFunction('__gnReadFile', (p: string) => fs.readFileSync(rp(p), 'utf8'));
  await page.exposeFunction('__gnWriteFile', (p: string, c: string) => (fs.writeFileSync(rp(p), c ?? ''), true));
  await page.exposeFunction('__gnReaddir', (p: string) =>
    fs.readdirSync(rp(p), { withFileTypes: true }).map((d) => ({ name: d.name, isDirectory: d.isDirectory(), isFile: d.isFile() })),
  );
  await page.exposeFunction('__gnMkdir', (p: string) => (fs.mkdirSync(rp(p), { recursive: true }), true));
  await page.exposeFunction('__gnStat', (p: string) => {
    const s = fs.statSync(rp(p));
    return { size: s.size, isDirectory: s.isDirectory(), isFile: s.isFile(), mtimeMs: s.mtimeMs };
  });
  await page.exposeFunction('__gnExists', (p: string) => {
    try {
      return fs.existsSync(rp(p));
    } catch {
      return false;
    }
  });
  await page.exposeFunction(
    '__gnProc',
    (cmd: string, args: string[], cwd: string | undefined) =>
      new Promise<{ stdout: string; stderr: string; code: number | null }>((res) => {
        let out = '';
        let err = '';
        const safeCwd = cwd && resolve(cwd).startsWith(resolve(root)) ? cwd : root;
        const proc = spawn(cmd, args ?? [], { cwd: safeCwd });
        proc.stdout?.on('data', (d) => (out += d));
        proc.stderr?.on('data', (d) => (err += d));
        proc.on('error', (e) => res({ stdout: out, stderr: err + String(e), code: 1 }));
        proc.on('close', (code) => res({ stdout: out, stderr: err, code }));
      }),
  );

  await page.addInitScript(
    ([bundledArg, trustedArg]) => {
      const bundledSet = new Set(bundledArg as string[]);
      const trusted = trustedArg as boolean;
      // Granted capabilities — populated by permissions.request, exactly like the
      // daemon's GrantStore. Trusted origins still must CALL request (auto-grant
      // on call); nothing is granted implicitly.
      const grant: { fs: string | null; process: Set<string> } = { fs: null, process: new Set() };
      const listeners: Record<string, Array<(d: unknown) => void>> = {};
      let seq = 0;
      const emit = (e: string, d: unknown): void => (listeners[e] ?? []).forEach((cb) => cb(d));
      const deny = (cap: string, res: string, reason: string): never => {
        throw new Error(`Permission denied (${cap} ${res}): ${reason}`);
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const w = window as any;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
          if (ch === 'permissions.request' || ch === 'permissions.query') {
            if (ch === 'permissions.request' && (trusted || true)) {
              // Auto-commit the request (trusted IDE) — record exactly what was asked.
              if (p.fs) grant.fs = String(p.fs);
              if (Array.isArray(p.process)) for (const b of p.process) grant.process.add(String(b));
            }
            return { granted: { fs: grant.fs ?? 'none', process: [...grant.process] } };
          }
          if (ch.startsWith('fs.')) {
            if (!grant.fs) deny('fs', ch, 'fs permission not granted');
            switch (ch) {
              case 'fs.readFile':
                return { content: await w.__gnReadFile(String(p.path)) };
              case 'fs.writeFile':
                await w.__gnWriteFile(String(p.path), String(p.content ?? ''));
                return {};
              case 'fs.readdir':
                return { entries: await w.__gnReaddir(String(p.path)) };
              case 'fs.mkdir':
                await w.__gnMkdir(String(p.path));
                return {};
              case 'fs.stat':
                return await w.__gnStat(String(p.path));
              case 'fs.exists':
                return { exists: await w.__gnExists(String(p.path)) };
              case 'fs.realpath':
                return { path: String(p.path) };
              default:
                return {};
            }
          }
          if (ch === 'process.spawn') {
            const bin = String(p.cmd);
            if (!bundledSet.has(bin)) deny('process', bin, 'not a bundled tool');
            const githubTool = bin === 'gh' || bin === 'git';
            if (!grant.process.has(bin) && !githubTool) deny('process', bin, 'requires the process permission (not granted)');
            const id = 'p' + seq++;
            void w
              .__gnProc(bin, (p.args ?? []).map(String), p.cwd ? String(p.cwd) : undefined)
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              .then((r: any) =>
                setTimeout(() => {
                  if (r.stdout) emit('process.stdout:' + id, { chunk: r.stdout });
                  if (r.stderr) emit('process.stderr:' + id, { chunk: r.stderr });
                  emit('process.exit:' + id, { code: r.code });
                }, 0),
              );
            return { id, pid: 1000 + seq };
          }
          if (ch === 'process.write' || ch === 'process.closeStdin' || ch === 'process.kill') return {};
          return {};
        },
      };
    },
    [bundled as string[], opts.trusted ?? true] as [string[], boolean],
  );
}
