// A stateful, node-side mock of `window.UglyNative` — the unified native protocol
// (`{ platform, invoke, subscribe }`) that `ugly-app/native` resolves via
// `installUglyNative()` (it returns `globalThis.UglyNative` as-is when present).
//
// This is the vitest analog of ugly-app's Playwright `installUglyNativeMock`: it
// lets the REAL `native` wrapper + the REAL contract run against an in-memory
// filesystem + scripted process, so the agent's tool dispatcher is tested through
// the exact same protocol production uses — no bespoke shim. Mirrors the
// in-memory UglyHost the ugly-studio tool tests run against.

import type { HostDirent } from 'ugly-app/native';

export interface ProcResult {
  stdout?: string;
  stderr?: string;
  code?: number | null;
  error?: string;
}
export type ProcFn = (cmd: string, args: string[]) => ProcResult;

const defaultProc: ProcFn = (cmd, args) => ({
  stdout: `${cmd} ${args.join(' ')}`.trim() + '\n',
  code: 0,
});

interface MockState {
  files: Map<string, string>;
  proc: ProcFn;
  calls: { channel: string; payload: unknown }[];
  listeners: Map<string, ((d: unknown) => void)[]>;
  seq: number;
}

const state: MockState = {
  files: new Map(),
  proc: defaultProc,
  calls: [],
  listeners: new Map(),
  seq: 0,
};

/** Reconfigure the mock for a test (call in beforeEach). */
export function resetMock(opts: { files?: Record<string, string>; proc?: ProcFn } = {}): void {
  state.files = new Map(Object.entries(opts.files ?? {}));
  state.proc = opts.proc ?? defaultProc;
  state.calls = [];
  state.listeners = new Map();
  state.seq = 0;
}

export const mockFiles = (): Map<string, string> => state.files;
export const mockCalls = (): { channel: string; payload: unknown }[] => state.calls;

function emit(event: string, data: unknown): void {
  (state.listeners.get(event) ?? []).forEach((cb) => cb(data));
}

/** Normalize a dir path to a prefix for readdir: '' (root), 'src/', or an
 *  absolute '/proj/src/'. Preserves a leading slash so absolute paths (which
 *  fs.readFile/writeFile store verbatim) match here too. */
function dirPrefix(p: string): string {
  const t = p.replace(/^\.\/?/, '').replace(/\/+$/, '');
  return t === '' || t === '.' ? '' : t + '/';
}

const invoke = (channel: string, payload: unknown): Promise<unknown> => {
  state.calls.push({ channel, payload });
  const p = (payload ?? {}) as Record<string, unknown>;
  switch (channel) {
    case 'permissions.request':
    case 'permissions.query':
      return Promise.resolve({ granted: { fs: 'full', process: 'full' } });

    case 'fs.readFile': {
      const path = String(p.path);
      if (!state.files.has(path)) return Promise.reject(new Error(`ENOENT: no such file ${path}`));
      return Promise.resolve({ content: state.files.get(path) });
    }
    case 'fs.writeFile':
      state.files.set(String(p.path), String(p.content ?? ''));
      return Promise.resolve(undefined);
    case 'fs.mkdir':
      return Promise.resolve(undefined);
    case 'fs.rm':
      state.files.delete(String(p.path));
      return Promise.resolve(undefined);
    case 'fs.rename': {
      const from = String(p.from);
      const to = String(p.to);
      const c = state.files.get(from);
      if (c != null) {
        state.files.set(to, c);
        state.files.delete(from);
      }
      return Promise.resolve(undefined);
    }
    case 'fs.exists':
      return Promise.resolve({ exists: state.files.has(String(p.path)) });
    case 'fs.realpath':
      return Promise.resolve({ path: String(p.path) });
    case 'fs.stat': {
      const path = String(p.path);
      const isFile = state.files.has(path);
      return Promise.resolve({
        size: isFile ? state.files.get(path)!.length : 0,
        isDirectory: !isFile,
        isFile,
        mtimeMs: 0,
      });
    }
    case 'fs.readdir': {
      const prefix = dirPrefix(String(p.path));
      const names = new Map<string, boolean>(); // name → isDirectory
      for (const f of state.files.keys()) {
        if (!f.startsWith(prefix)) continue;
        const rest = f.slice(prefix.length);
        if (rest === '') continue;
        const slash = rest.indexOf('/');
        if (slash === -1) names.set(rest, false);
        else names.set(rest.slice(0, slash), true);
      }
      const entries: HostDirent[] = [...names].map(([name, isDir]) => ({
        name,
        isDirectory: isDir,
        isFile: !isDir,
      }));
      return Promise.resolve({ entries });
    }

    case 'process.spawn': {
      const id = `p${state.seq++}`;
      const res = state.proc(String(p.cmd), Array.isArray(p.args) ? p.args.map(String) : []);
      // Emit asynchronously so the facade's post-spawn subscribe() is registered first.
      setTimeout(() => {
        if (res.error) emit(`process.error:${id}`, { err: res.error });
        if (res.stdout) emit(`process.stdout:${id}`, { chunk: res.stdout });
        if (res.stderr) emit(`process.stderr:${id}`, { chunk: res.stderr });
        emit(`process.exit:${id}`, { code: res.code ?? 0 });
      }, 0);
      return Promise.resolve({ id, pid: 1000 + state.seq });
    }
    case 'process.write':
    case 'process.closeStdin':
    case 'process.kill':
      return Promise.resolve(undefined);

    default:
      return Promise.resolve(undefined);
  }
};

const subscribe = (event: string, cb: (d: unknown) => void): (() => void) => {
  const arr = state.listeners.get(event) ?? [];
  arr.push(cb);
  state.listeners.set(event, arr);
  return () => state.listeners.set(event, (state.listeners.get(event) ?? []).filter((f) => f !== cb));
};

/** Install the mock as globalThis.UglyNative. Must run BEFORE ugly-app/native is
 *  imported, because `permissions` captures `platform` at import time (and throws
 *  for 'web'). Wired via vitest setupFiles. */
export function installUglyNativeNodeMock(): void {
  (globalThis as unknown as { UglyNative: unknown }).UglyNative = {
    platform: 'desktop',
    invoke,
    subscribe,
  };
}
