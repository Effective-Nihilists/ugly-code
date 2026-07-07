// In-process boot of the coding-agent for the CLI — mirrors coding-task.ts's setup
// (Node UglyNative + /api/* fetch shim + session store) but runs in the CLI process
// instead of a task child. No Electron, no Studio host.
import { createNodeUglyNative, permissions } from 'ugly-app/native';
import { setActiveProjectPath } from '../studio/projectPath';
import { runClientAgentTurn } from '../studio/agent/clientAgent';
import { isClaudeCliModel, runClaudeCliTurn } from '../studio/agent/claudeCliAgent';
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
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- DOM lib types localStorage as always-present, but this runs in a Node CLI where it's genuinely undefined.
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
  // Debug telemetry for the agent's LLM calls: log every /api/agentTurn|agentStep
  // request's HTTP status + timing, the ERROR BODY on non-2xx (the actual provider
  // error), and network-level rejections. Retries surface here as repeated requests
  // (runAgent retries with exponential backoff via a stable msgId), so the count of
  // rows for one turn = the retry count. Written to session/<id>/fetch.jsonl.
  const fetchDbgDir = `${cfg.storeRoot}/${cfg.sessionId.replace(/[^a-zA-Z0-9_.:-]/g, '_')}`;
  const fetchDbg: Record<string, unknown>[] = [];
  const flushFetchDbg = (): void => {
    void import('node:fs/promises')
      .then((fs) => fs.mkdir(fetchDbgDir, { recursive: true }).then(() => fs.writeFile(`${fetchDbgDir}/fetch.jsonl`, fetchDbg.map((e) => JSON.stringify(e)).join('\n') + '\n')))
      .catch(() => { /* debug logging never breaks a run */ });
  };
  const logFetch = (rec: Record<string, unknown>): void => { fetchDbg.push({ ts: Date.now(), ...rec }); flushFetchDbg(); };

  const realFetch = globalThis.fetch.bind(globalThis);
  (globalThis as { fetch: typeof fetch }).fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (typeof input === 'string' && input.startsWith('/')) {
      const headers = new Headers(init?.headers);
      if (!headers.has('Cookie')) headers.set('Cookie', `auth_token=${cfg.token}`);
      const p = realFetch(cfg.origin + input, { ...init, headers });
      if (input.startsWith('/api/agentTurn') || input.startsWith('/api/agentStep')) {
        const t0 = Date.now();
        return p.then(
          (res) => {
            const rec = { path: input.split('?')[0], status: res.status, ok: res.ok, ms: Date.now() - t0 };
            // Capture the error body on failure (the real provider error) via clone()
            // so the streaming SSE body the agent reads is not consumed.
            if (!res.ok) res.clone().text().then((body) => { logFetch({ ...rec, body: body.slice(0, 800) }); }).catch(() => { logFetch(rec); });
            else logFetch(rec);
            return res;
          },
          (err: unknown) => {
            logFetch({ path: input.split('?')[0], networkError: err instanceof Error ? `${err.name}: ${err.message}` : String(err), ms: Date.now() - t0 });
            throw err;
          },
        );
      }
      return p;
    }
    return realFetch(input, init);
  });
}

export async function runTurn(
  sessionId: string,
  text: string,
  onMsg: (m: unknown) => void,
  selection?: Parameters<typeof runClientAgentTurn>[3],
): Promise<void> {
  // Baseline dispatch: a claude-cli model runs the local Claude Code CLI as the
  // agent (its own tools); anything else runs the ugly.bot agent core. Both write
  // cost/turns to the fs session store, so the comparison metrics stay uniform.
  const model = (selection)?.model;
  if (model && isClaudeCliModel(model)) {
    await runClaudeCliTurn(sessionId, text, model, onMsg);
    return;
  }
  await runClientAgentTurn(sessionId, text, onMsg, selection);
}
