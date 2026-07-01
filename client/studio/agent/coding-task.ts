// Headless coding-session task bundle. Built to a standalone JS file (build:coding-task)
// and loaded by Ugly Studio's task runner into a sandboxed Node child via
//   native.task.start({ entry: '<origin>/coding-task.js', kind: 'coding', params })
// The session runs here — outliving the window and reachable from any device over the
// Ugly Proxy — instead of in the renderer. Drives the SAME agent loop (runClientAgentTurn);
// its emitCustom-style events become task events (task.event:<id>) via uglyTask.emit.
import { defineTask, taskContext, createNodeUglyNative } from 'ugly-app/native';
import { setActiveProjectPath } from '../projectPath';
import { runClientAgentTurn, abortClientAgent, clearClientAgentSession, type AgentSelection } from './clientAgent';
import { installTaskErrorLog } from './taskErrorLog';

const g = globalThis as typeof globalThis & { UglyNative?: unknown; localStorage?: unknown };

// Node-backed window.UglyNative so the agent's tools (native.fs / native.process) resolve to
// node:fs / child_process. ugly-app's permissions read platform lazily, so this body-level
// install (after the imports) is respected.
g.UglyNative = createNodeUglyNative();

// sessionWorkspace persists worktree prefs to localStorage; give it an in-memory shim.
if (!g.localStorage) {
  const mem = new Map<string, string>();
  g.localStorage = {
    getItem: (k: string) => (mem.has(k) ? (mem.get(k) as string) : null),
    setItem: (k: string, v: string) => { mem.set(k, String(v)); },
    removeItem: (k: string) => { mem.delete(k); },
    clear: () => mem.clear(),
    key: (i: number) => [...mem.keys()][i] ?? null,
    get length() { return mem.size; },
  };
}

const t = taskContext<{ projectPath?: string; sessionId?: string; origin?: string; authToken?: string }>();
setActiveProjectPath(t.params?.projectPath ?? null);
const sessionId = t.params?.sessionId ?? t.id ?? 'cs:task';

// 3. The agent loop fetches the project's /api/* with relative URLs + cookie creds — both
//    unavailable in a Node child. Absolutize against the app origin and carry the session
//    token as a Cookie so /api/agentTurn authenticates. Prefer the host-injected token
//    (UGLY_AUTH_TOKEN — read from the cookie host-side, works even when HttpOnly + over the
//    mobile proxy); fall back to the token the renderer forwarded in params.
const origin = t.params?.origin ?? '';
const authToken = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.UGLY_AUTH_TOKEN
  ?? t.params?.authToken ?? '';
if (origin) {
  const realFetch = globalThis.fetch.bind(globalThis);
  (globalThis as { fetch: typeof fetch }).fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (typeof input === 'string' && input.startsWith('/')) {
      const headers = new Headers(init?.headers);
      if (authToken && !headers.has('Cookie')) headers.set('Cookie', `auth_token=${authToken}`);
      return realFetch(origin + input, { ...init, headers });
    }
    return realFetch(input, init);
  }) as typeof fetch;
}

// Route this background task's console.error/warn to the app's own errorLog
// (this Node child installs no browser Logger, so its errors were invisible).
installTaskErrorLog({ origin, sessionId });

defineTask({
  onCall: {
    // Run one agent turn. The loop's emitCustom-shaped frames stream to listeners as the
    // 'msg' task event; the UI adapter feeds them to its existing onCustomMessage handler.
    send: async (p: { text: string; selection?: AgentSelection }) => {
      await runClientAgentTurn(sessionId, p.text, (msg) => t.emit('msg', msg), p.selection);
      return { ok: true };
    },
    // Interrupt the running turn (chatStop → task.call('interrupt')).
    interrupt: async () => { abortClientAgent(sessionId); return { ok: true }; },
    // `/clear`: drop the in-memory agent context (keeps the worktree); the renderer
    // wipes the persisted transcript separately so the next turn starts empty.
    clear: async () => { clearClientAgentSession(sessionId); return { ok: true }; },
    // Identity/state for a freshly-attached UI (history itself is read from the server
    // via codingSessionListMessages, same as before).
    getState: async () => ({ sessionId, projectPath: t.params?.projectPath ?? null }),
  },
});

t.setSnapshot({ turn: 'idle', sessionId });
