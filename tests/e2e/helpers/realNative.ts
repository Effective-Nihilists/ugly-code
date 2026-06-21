import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import { isAbsolute, join, resolve } from 'node:path';
import type { Page } from '@playwright/test';

/**
 * Installs a `window.UglyNative` backed by the REAL filesystem + real child
 * processes, confined to `root` (a temp project dir). Unlike
 * `installUglyNativeMock` (canned results), this lets the coding agent actually
 * read/write files and spawn processes — so a test can assert that code is
 * really changed ON DISK, and that the workspace panels run their real
 * native-backed queries. Must be called before `page.goto()`. All paths are
 * sandboxed to `root`; a path that escapes it throws.
 */
export async function installRealNative(page: Page, root: string): Promise<void> {
  const rp = (p: string): string => {
    const r = resolve(isAbsolute(p) ? p : join(root, p));
    if (!r.startsWith(resolve(root))) throw new Error(`path escapes project root: ${p}`);
    return r;
  };

  await page.exposeFunction('__nfsReadFile', (p: string) => fs.readFileSync(rp(p), 'utf8'));
  await page.exposeFunction('__nfsWriteFile', (p: string, c: string) => {
    fs.writeFileSync(rp(p), c ?? '');
    return true;
  });
  await page.exposeFunction('__nfsReaddir', (p: string) =>
    fs
      .readdirSync(rp(p), { withFileTypes: true })
      .map((d) => ({ name: d.name, isDirectory: d.isDirectory(), isFile: d.isFile() })),
  );
  await page.exposeFunction('__nfsMkdir', (p: string) => {
    fs.mkdirSync(rp(p), { recursive: true });
    return true;
  });
  await page.exposeFunction('__nfsRm', (p: string) => {
    fs.rmSync(rp(p), { recursive: true, force: true });
    return true;
  });
  await page.exposeFunction('__nfsRename', (a: string, b: string) => {
    fs.renameSync(rp(a), rp(b));
    return true;
  });
  await page.exposeFunction('__nfsStat', (p: string) => {
    const s = fs.statSync(rp(p));
    return { size: s.size, isDirectory: s.isDirectory(), isFile: s.isFile(), mtimeMs: s.mtimeMs };
  });
  await page.exposeFunction('__nfsExists', (p: string) => {
    try {
      return fs.existsSync(rp(p));
    } catch {
      return false;
    }
  });
  await page.exposeFunction(
    '__nproc',
    (cmd: string, args: string[], cwd: string | undefined, env: Record<string, string> | undefined) =>
      new Promise<{ stdout: string; stderr: string; code: number | null }>((res) => {
        let out = '';
        let err = '';
        const safeCwd = cwd && resolve(cwd).startsWith(resolve(root)) ? cwd : root;
        const proc = spawn(cmd, args ?? [], { cwd: safeCwd, env: { ...process.env, ...(env ?? {}) } });
        proc.stdout?.on('data', (d) => (out += d));
        proc.stderr?.on('data', (d) => (err += d));
        proc.on('error', (e) => res({ stdout: out, stderr: err + String(e), code: 1 }));
        proc.on('close', (code) => res({ stdout: out, stderr: err, code }));
      }),
  );

  // The in-page UglyNative routes the unified protocol to the exposed Node
  // bindings. Process output is collected to completion in Node, then replayed
  // as stdout/exit events after the facade has subscribed to the id-channels.
  await page.addInitScript(() => {
    type Cb = (d: unknown) => void;
    const listeners: Record<string, Cb[]> = {};
    let seq = 0;
    const emit = (e: string, d: unknown): void => (listeners[e] ?? []).forEach((cb) => cb(d));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    w.UglyNative = {
      platform: 'desktop',
      subscribe: (e: string, cb: Cb) => {
        (listeners[e] ??= []).push(cb);
        return () => {
          listeners[e] = (listeners[e] ?? []).filter((f) => f !== cb);
        };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      invoke: async (ch: string, p: any = {}) => {
        switch (ch) {
          case 'permissions.request':
          case 'permissions.query':
            return { granted: { fs: 'full', process: 'full' } };
          case 'fs.readFile':
            return { content: await w.__nfsReadFile(String(p.path)) };
          case 'fs.writeFile':
            await w.__nfsWriteFile(String(p.path), String(p.content ?? ''));
            return {};
          case 'fs.readdir':
            return { entries: await w.__nfsReaddir(String(p.path)) };
          case 'fs.mkdir':
            await w.__nfsMkdir(String(p.path));
            return {};
          case 'fs.rm':
            await w.__nfsRm(String(p.path));
            return {};
          case 'fs.rename':
            await w.__nfsRename(String(p.from ?? p.oldPath), String(p.to ?? p.newPath));
            return {};
          case 'fs.stat':
            return await w.__nfsStat(String(p.path));
          case 'fs.exists':
            return { exists: await w.__nfsExists(String(p.path)) };
          case 'fs.realpath':
            return { path: String(p.path) };
          case 'process.spawn': {
            const id = 'p' + seq++;
            void w
              .__nproc(String(p.cmd), (p.args ?? []).map(String), p.cwd ? String(p.cwd) : undefined, p.env ?? {})
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
          case 'process.write':
          case 'process.closeStdin':
          case 'process.kill':
            return {};
          default:
            return {};
        }
      },
    };
  });
}
