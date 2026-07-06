// In-process boot of the coding-agent for the CLI — mirrors coding-task.ts's setup
// (Node UglyNative + /api/* fetch shim + session store) but runs in the CLI process
// instead of a task child. No Electron, no Studio host.
import { createNodeUglyNative, permissions } from 'ugly-app/native';
import { setActiveProjectPath } from '../studio/projectPath';
import { runClientAgentTurn } from '../studio/agent/clientAgent';
import { setSessionStore } from '../studio/agent/sessionStore';
import { makeFsSessionStore } from '../studio/agent/fsSessionStore';

export interface DriverCfg { projectPath: string; sessionId: string; origin: string; token: string; storeRoot: string }

export async function bootDriver(cfg: DriverCfg): Promise<void> {
  const g = globalThis as typeof globalThis & { UglyNative?: unknown; localStorage?: unknown };
  g.UglyNative = createNodeUglyNative();
  // The Node UglyNative gates process/fs behind the permission system; grant full
  // access for the CLI (a trusted local process). `process: 'full'` (not a name
  // allowlist) is required because python_exec / grep spawn RESOLVED ABSOLUTE
  // binary paths (e.g. ~/.ugly-bot/binaries/.../uv) a name-based grant can't match.
  type GrantReq = Parameters<typeof permissions.request>[0];
  await permissions.request({ fs: 'full', process: 'full' } as unknown as GrantReq).catch(() => undefined);
  if (!g.localStorage) {
    const mem = new Map<string, string>();
    g.localStorage = {
      getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
      setItem: (k: string, v: string) => { mem.set(k, v); },
      removeItem: (k: string) => { mem.delete(k); },
      clear: () => { mem.clear(); },
      key: (i: number) => [...mem.keys()][i] ?? null,
      get length() { return mem.size; },
    };
  }
  setActiveProjectPath(cfg.projectPath);
  setSessionStore(makeFsSessionStore(cfg.storeRoot));
  const realFetch = globalThis.fetch.bind(globalThis);
  (globalThis as { fetch: typeof fetch }).fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (typeof input === 'string' && input.startsWith('/')) {
      const headers = new Headers(init?.headers);
      if (!headers.has('Cookie')) headers.set('Cookie', `auth_token=${cfg.token}`);
      return realFetch(cfg.origin + input, { ...init, headers });
    }
    return realFetch(input, init);
  }) as typeof fetch;
}

export async function runTurn(sessionId: string, text: string, onMsg: (m: unknown) => void): Promise<void> {
  await runClientAgentTurn(sessionId, text, onMsg);
}
