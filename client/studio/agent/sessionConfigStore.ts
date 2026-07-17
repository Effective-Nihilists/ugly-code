/**
 * Server I/O for a session's `SessionConfig` (model + run modes). The config is
 * stored on the CodingSession doc so any browser opening the session sees the same
 * values (localStorage is NOT the source of truth). A NEW session is seeded from the
 * per-user `sessionDefaults` (the remembered last pick); changing one session never
 * touches another. Pure mapping helpers live in shared/sessionConfig.ts (re-exported
 * here for callers, and importable by the worker without this module's socket dep).
 */
import type { SessionConfig } from '../../../shared/sessionConfig';
import { sessionApi, resolveProjectId } from './serverSessionApi';
import { getActiveProjectPath } from '../hooks/useSocket';

export {
  axesToConfig,
  completeConfig,
  coerceModelMode,
  type AxisState,
} from '../../../shared/sessionConfig';

/** Read a session's persisted config from the server (null if none stored yet). */
export async function readServerConfig(
  sessionId: string,
): Promise<SessionConfig | null> {
  const projectId = await resolveProjectId(getActiveProjectPath() ?? '');
  if (!projectId) return null;
  const data = await sessionApi.list({ projectId });
  const row = data?.sessions.find((s) => s.sessionId === sessionId);
  return row?.config ?? null;
}

/** Persist a session's config to the server (per-session; does NOT touch others). */
export async function writeServerConfig(
  sessionId: string,
  config: SessionConfig,
): Promise<void> {
  const projectId = await resolveProjectId(getActiveProjectPath() ?? '');
  if (!projectId) return;
  await sessionApi.upsert({ sessionId, projectId, config });
}
