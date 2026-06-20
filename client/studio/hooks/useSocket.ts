/**
 * Phase 1 of the Studio-IDE-on-UglyNative rebuild: a drop-in replacement for
 * the renderer's sidecar `/rpc` socket. Instead of a WebSocket to a privileged
 * Node sidecar, `request(name, input)` dispatches to handlers backed by
 * `window.UglyNative` (native.fs / native.process) — the same unified protocol
 * the rest of ugly-code uses. Same export surface as the original
 * `client/hooks/useSocket.ts` (useSocket / onCustomMessage / isConnected) so the
 * vendored IDE components import it unchanged.
 *
 * The file/process subset is wired first; everything else rejects with a clear
 * "not yet wired" error (callers in the shell all `.catch`, so the UI degrades
 * gracefully). Later phases fill in LSP, PTY, dev-server, and the agent.
 */

import { useContext, useMemo } from 'react';
import type { AppSocket } from 'ugly-app/client';
import { native } from 'ugly-app/native';
import type { AppRegistry } from '../shared/api';
import { ProjectScopeContext } from '../state/ProjectScopeContext';

type Input = Record<string, unknown>;
type Handler = (input: Input) => Promise<unknown>;
type CustomMessageHandler = (msg: { type: string; [key: string]: unknown }) => void;

const customMessageHandlers = new Set<CustomMessageHandler>();
export function onCustomMessage(handler: CustomMessageHandler): () => void {
  customMessageHandlers.add(handler);
  return () => {
    customMessageHandlers.delete(handler);
  };
}
/** The native transport is always "connected" (no remote handshake). */
export function isConnected(): boolean {
  return true;
}

// Studio user settings persist locally in the browser for now (later: a native
// settings file under the app's scoped dir).
const SETTINGS_KEY = 'ugly-studio:settings';
function loadSettings(): Record<string, unknown> {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as Record<string, unknown>;
  } catch {
    return {};
  }
}
function saveSetting(key: string, value: unknown): void {
  const s = loadSettings();
  s[key] = value;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

const handlers: Record<string, Handler> = {
  // ── mount reads — safe empties so the shell renders without a sidecar ──
  listOpenProjects: () =>
    Promise.resolve({ projects: [], activePath: null, activeLayoutContent: null }),
  getOpenProjectAggregates: () => Promise.resolve({ aggregates: {} }),
  getStudioUserSettings: () => Promise.resolve({ entries: loadSettings() }),
  setStudioUserSetting: (i) => {
    saveSetting(String(i.key), i.value);
    return Promise.resolve({});
  },
  listRecentProjects: () => Promise.resolve({ projects: [] }),
  // ── project-page (session sidebar) reads ──
  codingAgentListSessions: () => Promise.resolve({ sessions: [] }),
  gitStatus: () => Promise.resolve({ branch: 'main', remote: null, files: [] }),
  deleteCodingAgentSession: () => Promise.resolve({}),
  evalListTasks: () => Promise.resolve({ tasks: [] }),
  evalListHistory: () => Promise.resolve({ runs: [] }),
  evalDeleteRun: () => Promise.resolve({}),
  openProject: (i) => {
    const path = String(i.path ?? '').replace(/\/+$/, '');
    const name = path.split('/').pop() || path || 'project';
    return Promise.resolve({ name, path });
  },
  closeProject: () => Promise.resolve({}),
  setActiveProject: () => Promise.resolve({}),
  cancelTask: () => Promise.resolve({}),

  // ── filesystem subset over window.UglyNative (the Phase-1 keystone) ──
  readFile: async (i) => ({ content: await native.fs.readFile(String(i.path)) }),
  writeFile: async (i) => {
    await native.fs.writeFile(String(i.path), String(i.content ?? ''));
    return {};
  },
  deleteFile: async (i) => {
    await native.fs.rm(String(i.path), { recursive: true, force: true });
    return {};
  },
  renameFile: async (i) => {
    await native.fs.rename(String(i.from ?? i.oldPath), String(i.to ?? i.newPath));
    return {};
  },
  listDirectory: async (i) => {
    const entries = await native.fs.readdir(String(i.path));
    return {
      entries: entries.map((e) => ({
        name: e.name,
        isDirectory: e.isDirectory,
        isFile: e.isFile,
      })),
    };
  },
};

/** Bare request dispatch — used by both the socket shim and components that
 *  fetched `/api/*` directly (e.g. ProjectOnboarding's `apiRequest`). */
export function nativeRequest(name: string, input?: unknown): Promise<unknown> {
  const h = handlers[name];
  if (h) return h((input ?? {}) as Input);
  return Promise.reject(
    new Error(`[studio] '${name}' is not yet wired to window.UglyNative (Phase 1)`),
  );
}

const nativeSocket = {
  request: (name: string, input?: unknown) => nativeRequest(name, input),
  connect: (_token?: string) => Promise.resolve(),
  send: () => {},
  emit: () => {},
};

export function useSocket(): AppSocket<AppRegistry> {
  // projectPath scoping is a no-op here (native handlers take explicit paths).
  useContext(ProjectScopeContext);
  return useMemo(() => nativeSocket as unknown as AppSocket<AppRegistry>, []);
}
