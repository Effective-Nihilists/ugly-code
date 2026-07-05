// Headless coding-session task bundle. Built to a standalone JS file (build:coding-task)
// and loaded by Ugly Studio's task runner into a sandboxed Node child via
//   native.task.start({ entry: '<origin>/coding-task.js', kind: 'coding', params })
// The session runs here — outliving the window and reachable from any device over the
// Ugly Proxy — instead of in the renderer. Drives the SAME agent loop (runClientAgentTurn);
// its emitCustom-style events become task events (task.event:<id>) via uglyTask.emit.
import { defineTask, taskContext, createNodeUglyNative } from 'ugly-app/native';
import { setActiveProjectPath } from '../projectPath';
import { runClientAgentTurn, abortClientAgent, clearClientAgentSession, ensureCodebaseAnalysis, type AgentSelection } from './clientAgent';
import { installTaskErrorLog } from './taskErrorLog';
import {
  abandonSession,
  aheadCount,
  behindCount,
  mergeFinished,
  refreshSession,
  runFinish,
  stopFinish,
  type FinishEventPayload,
  type FinishStage,
} from './finish';
import { answerPendingAskUser } from './askUserBroker';

const g = globalThis as typeof globalThis & { UglyNative?: unknown; localStorage?: unknown };

// Node-backed window.UglyNative so the agent's tools (native.fs / native.process) resolve to
// node:fs / child_process. ugly-app's permissions read platform lazily, so this body-level
// install (after the imports) is respected.
g.UglyNative = createNodeUglyNative();

// sessionWorkspace persists worktree prefs to localStorage; give it an in-memory shim.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- DOM lib types localStorage as always-present, but this runs in a Node task child where it is genuinely undefined.
if (!g.localStorage) {
  const mem = new Map<string, string>();
  g.localStorage = {
    getItem: (k: string) => (mem.has(k) ? (mem.get(k)!) : null),
    setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); },
    clear: () => { mem.clear(); },
    key: (i: number) => [...mem.keys()][i] ?? null,
    get length() { return mem.size; },
  };
}

const t = taskContext<{ projectPath?: string; sessionId?: string; origin?: string; authToken?: string }>();
setActiveProjectPath(t.params.projectPath ?? null);
const sessionId = t.params.sessionId ?? t.id ?? 'cs:task';

// 3. The agent loop fetches the project's /api/* with relative URLs + cookie creds — both
//    unavailable in a Node child. Absolutize against the app origin and carry the session
//    token as a Cookie so /api/agentTurn authenticates. Prefer the host-injected token
//    (UGLY_AUTH_TOKEN — read from the cookie host-side, works even when HttpOnly + over the
//    mobile proxy); fall back to the token the renderer forwarded in params.
const origin = t.params.origin ?? '';
const authToken = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.UGLY_AUTH_TOKEN
  ?? t.params.authToken ?? '';
if (origin) {
  const realFetch = globalThis.fetch.bind(globalThis);
  (globalThis as { fetch: typeof fetch }).fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (typeof input === 'string' && input.startsWith('/')) {
      const headers = new Headers(init?.headers);
      if (authToken && !headers.has('Cookie')) headers.set('Cookie', `auth_token=${authToken}`);
      return realFetch(origin + input, { ...init, headers });
    }
    return realFetch(input, init);
  });
}

// Route this background task's console.error/warn to the app's own errorLog
// (this Node child installs no browser Logger, so its errors were invisible).
installTaskErrorLog({ origin, sessionId });

defineTask({
  onCall: {
    // Run one agent turn. The loop's emitCustom-shaped frames stream to listeners as the
    // 'msg' task event; the UI adapter feeds them to its existing onCustomMessage handler.
    send: async (p: { text: string; selection?: AgentSelection }) => {
      await runClientAgentTurn(sessionId, p.text, (msg) => { t.emit('msg', msg); }, p.selection);
      return { ok: true };
    },
    // Interrupt the running turn (chatStop → task.call('interrupt')).
    // eslint-disable-next-line @typescript-eslint/require-await -- defineTask onCall handlers must return a Promise (RPC contract)
    interrupt: async () => { abortClientAgent(sessionId); return { ok: true }; },
    // `/clear`: drop the in-memory agent context (keeps the worktree); the renderer
    // wipes the persisted transcript separately so the next turn starts empty.
    // eslint-disable-next-line @typescript-eslint/require-await -- defineTask onCall handlers must return a Promise (RPC contract)
    clear: async () => { clearClientAgentSession(sessionId); return { ok: true }; },
    // Identity/state for a freshly-attached UI (history itself is read from the server
    // via codingSessionListMessages, same as before).
    // eslint-disable-next-line @typescript-eslint/require-await -- defineTask onCall handlers must return a Promise (RPC contract)
    getState: async () => ({ sessionId, projectPath: t.params.projectPath ?? null }),

    // ── Finish-session pipeline (ported into the task so it runs against the
    //    worktree with real host git via createNodeUglyNative). Emits
    //    finish_event envelopes (rendered inline in chat) and returns the
    //    FinishResult that drives the review modal. See ./finish/.
    finish: (p: {
      runTypecheck?: boolean;
      runLint?: boolean;
      runTests?: boolean;
      commitDirtyMainBeforeMerge?: boolean;
      pauseBeforeSquash?: boolean;
    }) =>
      runFinish({
        sessionId,
        projectPath: t.params.projectPath ?? null,
        opts: {
          runTypecheck: !!p.runTypecheck,
          runLint: !!p.runLint,
          runTests: !!p.runTests,
          ...(p.commitDirtyMainBeforeMerge ? { commitDirtyMainBeforeMerge: true } : {}),
          ...(p.pauseBeforeSquash ? { pauseBeforeSquash: true } : {}),
        },
        sessionTitle: null,
        firstUserMessageText: null,
        emit: emitFinish,
      }),
    // The squash-merge tail after the review modal is accepted.
    merge: (p: { commitMessage?: string }) =>
      mergeFinished({
        sessionId,
        projectPath: t.params.projectPath ?? null,
        commitMessage: p.commitMessage ?? '',
        emit: emitFinish,
      }),
    // Stop an in-flight validation gate (tsc/lint/tests).
    // eslint-disable-next-line @typescript-eslint/require-await -- onCall handlers return a Promise (RPC contract)
    finishStop: async (p: { stage?: FinishStage }) => ({ ok: stopFinish(sessionId, p.stage ?? 'tsc') }),
    // Discard the worktree + branch without merging.
    abandon: () => abandonSession(sessionId, t.params.projectPath ?? null),
    // Pull from parent: merge the parent branch into the worktree.
    refreshWorktree: () => refreshSession(sessionId, t.params.projectPath ?? null),
    // Commit counts for the chat header's ahead/behind badges.
    worktreeAhead: async () => ({ ahead: await aheadCount(sessionId, t.params.projectPath ?? null) }),
    worktreeBehind: async () => ({ behind: await behindCount(sessionId, t.params.projectPath ?? null) }),

    // ── Interactive turn controls (C1) ─────────────────────────────────
    // The chat renders ask-user / step-review cards from `session_state`
    // SNAPSHOTS (it ignores the granular ask_user_request/step_review_request
    // events — see useCodingAgentChat.ts). This task-based agent loop
    // (clientAgent.runClientAgentTurn) does not yet emit those snapshots, and the
    // ugly-app agent framework's AgentController exposes no manual compaction.
    // So these are safe acknowledgements: they keep the shim names wired (no
    // "not yet wired" reject) and answer cleanly. Full interactivity needs the
    // session_state snapshot-emission subsystem (pendingAskUsers/
    // pendingStepReviews) + broker + hot-path tool gating — tracked as a
    // follow-up. answerAskUser resolves a broker request if one is pending.
    // eslint-disable-next-line @typescript-eslint/require-await -- onCall handlers return a Promise (RPC contract)
    answerAskUser: async (p: { toolCallId?: string; answer?: string }) => ({
      ok: answerPendingAskUser(p.toolCallId ?? '', p.answer ?? ''),
    }),
    // eslint-disable-next-line @typescript-eslint/require-await -- onCall handlers return a Promise (RPC contract)
    answerStepReview: async () => ({ ok: true }),
    // eslint-disable-next-line @typescript-eslint/require-await -- onCall handlers return a Promise (RPC contract)
    compact: async () => ({ ok: true }),
    // eslint-disable-next-line @typescript-eslint/require-await -- onCall handlers return a Promise (RPC contract)
    restoreCheckpoint: async () => ({ ok: true }),
  },
});

// Wrap a FinishEventPayload in the AgentEvent envelope the chat expects
// (event.type='finish_event' → payload.payload = the FinishEventPayload). Mirrors
// the monolith's emitFinishEvent so stage_output chunks stream into the UI.
function emitFinish(e: FinishEventPayload): void {
  t.emit('msg', {
    type: 'codingAgent:event',
    sessionId,
    event: { type: 'finish_event', payload: { type: 'updated', payload: { ...e, session_id: sessionId } } },
  });
}

t.setSnapshot({ turn: 'idle', sessionId });

// Kick the host's semantic index + architecture analysis at BOOT (not on the first turn) so the
// chat header's codebase pill tracks indexing the moment the session opens. Without this the pill
// sat on "Codebase: loading…" until the user sent a message — a deadlock when they were waiting
// for it to go "ready" before typing. Readiness streams as standalone `codebase_readiness` events
// (see ensureCodebaseAnalysis); the poll self-stops once the index settles.
if (t.params.projectPath) {
  ensureCodebaseAnalysis(sessionId, (msg) => { t.emit('msg', msg); });
}
