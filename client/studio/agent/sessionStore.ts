// The session-persistence seam. `sessionApi` (serverSessionApi.ts) delegates
// here so the surface (studio → server, CLI → filesystem) can be swapped without
// touching the agent loop. The server impl is registered as the default.
import type {
  StoredRole,
  StoredMessageRow,
  SessionListRow,
} from './serverSessionApi';
import type { SessionConfig } from '../../../shared/sessionConfig';

export interface SessionStore {
  upsert(i: {
    sessionId: string;
    projectId: string;
    title?: string;
    model?: string;
    status?: 'running' | 'idle' | 'done' | 'error';
    messageCount?: number;
    costUsd?: number;
    /** The session's strictly-typed run config (server-persisted, per session). */
    config?: SessionConfig;
    /** The git branch this session operates on (server-persisted for cross-browser visibility). */
    branch?: string;
    /** Last-turn failure text: non-empty sets it, '' clears it, omitted preserves. Diagnosable by session id. */
    lastError?: string;
    // Cumulative token usage, persisted so analyzeRun/scorecards can report
    // cache-hit rate + tokens (the CLI fs store keeps these; the server store
    // may ignore them). Optional — not every agent path tracks tokens.
    promptTokens?: number;
    completionTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    /** Context-pressure meter (doc-driven). */
    contextTokens?: number;
    contextWindow?: number;
    contextBudget?: number;
  }): Promise<{ ok: boolean } | null>;
  appendMessage(i: {
    sessionId: string;
    seq: number;
    role: StoredRole;
    content: string;
    /** Streaming write: relay the in-progress row to trackDocs({includeTransient})
     *  subscribers WITHOUT persisting. A later non-transient append at the same seq
     *  commits it durably. The CLI fs store ignores this (it commits every write). */
    transient?: boolean;
  }): Promise<{ ok: boolean } | null>;
  compact(i: {
    sessionId: string;
    droppedIds: string[];
    summaryId: string;
    summarySeq: number;
    summaryText: string;
  }): Promise<{ ok: boolean } | null>;
  listMessages(i: {
    sessionId: string;
    limit?: number;
    includeCompacted?: boolean;
  }): Promise<{ messages: StoredMessageRow[] } | null>;
  list(i: {
    projectId: string;
  }): Promise<{ sessions: SessionListRow[] } | null>;
  archive(i: { sessionId: string }): Promise<{ ok: boolean } | null>;
  clearMessages(i: {
    sessionId: string;
  }): Promise<{ ok: boolean; deleted: number } | null>;
}

let activeStore: SessionStore | undefined;
export function setSessionStore(s: SessionStore): void {
  activeStore = s;
}
export function getSessionStore(): SessionStore {
  if (!activeStore) throw new Error('session store not initialised');
  return activeStore;
}
