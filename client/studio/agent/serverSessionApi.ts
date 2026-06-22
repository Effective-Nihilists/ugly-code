/**
 * Server-side coding-session persistence — the fetch layer the clientAgent uses
 * to make sessions survive reload. Talks to the project's own `/api/coding*`
 * endpoints (authReq, owner-scoped; see server/index.ts + shared/collections.ts).
 *
 * Every call is BEST-EFFORT: a persistence failure must never break the agent
 * loop (mirrors SessionLog). The canonical local-disk JSONL log is unaffected.
 */

import { native } from 'ugly-app/native';
import type { ContentPart } from 'ugly-app/agent/client';

async function api<T>(name: string, input: unknown): Promise<T | null> {
  try {
    const res = await fetch('/api/' + name, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ input }),
    });
    const json = (await res.json()) as { result?: T; error?: string };
    if (json.error) throw new Error(json.error);
    return json.result ?? null;
  } catch (e) {
    console.error(`[serverSessionApi] ${name} failed (ignored)`, e);
    return null;
  }
}

// `.uglyapp` carries a stable projectId that survives folder moves; fall back to
// the project path (still a stable per-project key) when it isn't published yet.
const projectIdCache = new Map<string, string>();
export async function resolveProjectId(projectPath: string | null): Promise<string> {
  if (!projectPath) return 'unknown';
  const cached = projectIdCache.get(projectPath);
  if (cached) return cached;
  let id = projectPath;
  try {
    const ua = JSON.parse(await native.fs.readFile(`${projectPath}/.uglyapp`)) as { projectId?: string };
    if (ua.projectId) id = ua.projectId;
  } catch {
    /* no .uglyapp yet — the path is a fine stable key */
  }
  projectIdCache.set(projectPath, id);
  return id;
}

// The JSON payload shapes persisted in `codingSessionMessage.content` (per role).
// A tool row bundles ALL of a turn's results into ONE row so the server
// transcript stays aligned with runAgent's working context (which folds tool
// results into a single user message) — critical for the compaction seq-mapping.
export interface ToolResultPayload { tool_use_id: string; content: string; is_error: boolean }
export interface ToolRowPayload { results: ToolResultPayload[] }

// Assistant rows store the turn content PLUS the model that produced it (so the
// chat can show a per-message model badge after reload). Legacy rows stored a
// bare ContentPart[] — `decodeAssistantPayload` accepts both.
export interface AssistantContentPayload { content: ContentPart[]; model?: string }
export function decodeAssistantPayload(raw: unknown): AssistantContentPayload {
  if (Array.isArray(raw)) return { content: raw as ContentPart[] }; // legacy: bare content
  const p = (raw ?? {}) as Partial<AssistantContentPayload>;
  return { content: p.content ?? [], ...(p.model ? { model: p.model } : {}) };
}

export type StoredRole = 'user' | 'assistant' | 'tool';
export type StoredKind = 'message' | 'summary';

// One entry per currently-uncompacted transcript row, in working-context order.
export interface ActiveRow { seq: number; id: string }

export interface CompactionPlan {
  /** _ids of the rows to flag compacted (originals + any superseded summary). */
  droppedIds: string[];
  /** _id + seq of the new summary row (reuses the boundary seq → idempotent). */
  summaryId: string;
  summarySeq: number;
  /** The post-compaction active set: [summary, ...kept]. */
  newActiveRows: ActiveRow[];
}

/**
 * Pure compaction seq-mapping: drop the oldest `droppedCount` active rows and
 * fold them into one summary positioned at the dropped block's seq. This MUST
 * mirror runAgent's in-loop `[summary, ...recent]` so the server's "normal"
 * query equals the model's post-compaction working context. Returns null when
 * there's nothing to compact.
 */
export function planCompaction(
  activeRows: ActiveRow[],
  droppedCount: number,
  sessionId: string,
): CompactionPlan | null {
  if (droppedCount <= 0 || activeRows.length === 0) return null;
  const dropped = activeRows.slice(0, droppedCount);
  if (dropped.length === 0) return null;
  const kept = activeRows.slice(droppedCount);
  const summarySeq = dropped[0].seq;
  const summaryId = `${sessionId}:summary:${summarySeq}`;
  return {
    droppedIds: dropped.map((d) => d.id),
    summaryId,
    summarySeq,
    newActiveRows: [{ seq: summarySeq, id: summaryId }, ...kept],
  };
}
export interface StoredMessageRow {
  seq: number;
  role: StoredRole;
  kind: StoredKind;
  compacted: boolean;
  /** JSON.stringify of the raw content (parsed per role/kind by the caller). */
  content: string;
}

export interface SessionListRow {
  sessionId: string;
  title: string;
  kind: 'main' | 'session';
  model: string;
  status: 'running' | 'idle' | 'done' | 'error';
  messageCount: number;
  costUsd: number;
  created: number;
  updated: number;
}

export const sessionApi = {
  upsert: (input: {
    sessionId: string;
    projectId: string;
    title?: string;
    kind?: 'main' | 'session';
    model?: string;
    status?: 'running' | 'idle' | 'done' | 'error';
    messageCount?: number;
    costUsd?: number;
  }): Promise<{ ok: boolean } | null> => api('codingSessionUpsert', input),

  appendMessage: (input: {
    sessionId: string;
    seq: number;
    role: StoredRole;
    content: string;
  }): Promise<{ ok: boolean } | null> => api('codingSessionAppendMessage', input),

  compact: (input: {
    sessionId: string;
    droppedIds: string[];
    summaryId: string;
    summarySeq: number;
    summaryText: string;
  }): Promise<{ ok: boolean } | null> => api('codingSessionCompact', input),

  listMessages: (input: {
    sessionId: string;
    limit?: number;
    includeCompacted?: boolean;
  }): Promise<{ messages: StoredMessageRow[] } | null> => api('codingSessionListMessages', input),

  list: (input: { projectId: string }): Promise<{ sessions: SessionListRow[] } | null> =>
    api('codingSessionList', input),

  archive: (input: { sessionId: string }): Promise<{ ok: boolean } | null> =>
    api('codingSessionArchive', input),
};
