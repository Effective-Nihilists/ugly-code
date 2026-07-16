// Per-project coding-agent sessions, persisted in localStorage so the session
// list + main session survive reloads. CodingAgentChat owns the live session
// (it assigns the compositeId on first turn via onSessionCreated); we record
// that here and surface it in the sidebar.

export interface StoredSession {
  compositeId: string;
  title: string;
  updated_at: number;
  /**
   * Created timestamp (ms). Drives sidebar ordering (newest-created on top);
   * `updated_at` is only used for the per-row "time ago" label. Server-sourced
   * and transient — stripped before persisting to localStorage, same as status.
   */
  created_at?: number;
  model: string;
  /** Branch name (server-persisted, not saved to localStorage). */
  branch?: string;
  /**
   * Live run status (server-persisted, not saved to localStorage). Drives the
   * "thinking" indicator in the session list — re-fetched by the project page's
   * session poll, transient so it's stripped before persisting.
   */
  status?: 'running' | 'idle' | 'done' | 'error';
  /**
   * Last-turn / crash failure text (server-persisted `lastError`). Transient like
   * `status` — server-sourced, stripped before localStorage. Feeds the reopened
   * session's durable error bubble + the ERROR pill tooltip.
   */
  lastError?: string;
  /**
   * Cumulative token usage (prompt+completion) and USD cost, from the synced
   * `codingSession` doc. Server-sourced + transient (stripped before localStorage);
   * feed the sidebar's tokens·cost line (which previously showed 0/`—`).
   */
  totalTokens?: number;
  totalCost?: number;
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
    // Strip branch + status + created_at + lastError before persisting to
    // localStorage — all are server-persisted (branch for cross-browser visibility,
    // status + lastError are live + transient, created_at drives ordering), so a
    // stale localStorage copy must never shadow the poll.
    const stripped = sessions.map(({ branch: _b, status: _s, created_at: _c, lastError: _e, ...rest }) => rest);
    localStorage.setItem(keyFor(projectPath), JSON.stringify(stripped));
  } catch {
    /* best effort */
  }
}
