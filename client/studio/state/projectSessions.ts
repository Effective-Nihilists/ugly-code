// Per-project coding-agent sessions, persisted in localStorage so the session
// list + main session survive reloads. CodingAgentChat owns the live session
// (it assigns the compositeId on first turn via onSessionCreated); we record
// that here and surface it in the sidebar.

export interface StoredSession {
  compositeId: string;
  title: string;
  /** The always-present canonical session for the project. */
  kind?: 'main';
  updated_at: number;
  model: string;
}

const keyFor = (projectPath: string): string => `ugly-studio:sessions:${projectPath}`;

export function loadSessions(projectPath: string | undefined): StoredSession[] {
  if (!projectPath) return [];
  try {
    const raw = localStorage.getItem(keyFor(projectPath));
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(arr)) return [];
    return arr.filter((s): s is StoredSession => !!s && typeof (s as StoredSession).compositeId === 'string');
  } catch {
    return [];
  }
}

export function saveSessions(projectPath: string | undefined, sessions: StoredSession[]): void {
  if (!projectPath) return;
  try {
    localStorage.setItem(keyFor(projectPath), JSON.stringify(sessions));
  } catch {
    /* best effort */
  }
}
