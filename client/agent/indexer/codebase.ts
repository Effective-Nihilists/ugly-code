// In-process façade over the local semantic indexer — the replacement for the
// host `codebase.*` native channel, for callers that run INSIDE the coding task
// (the grep tool, the readiness poll). It imports daemon.ts/manager.ts, which
// use node:child_process, so it MUST NOT be imported from any renderer/worker
// bundle — only from task-only modules.
//
// The indexer half was moved out of ugly-studio so bug fixes ship with a deploy
// instead of a Studio rebuild. The ARCHITECTURE-doc half stays on the host
// (its generator pulls in the ~7 MB TypeScript compiler); readiness callers
// merge that in separately via the host channel.
//
// Output shapes are byte-for-byte what ugly-studio's `routeCodebase` returned,
// so the wire schema (CodebaseReadinessSchema) and every consumer are unchanged.

import {
  ensureIndexStarted,
  getIndexerStatus,
  indexerSearch,
  indexerUpdateFiles,
  reconcileWorktreeOverlay,
} from './manager.js';
import {
  daemonHealth,
  ensureDaemonRunning,
  getLastDaemonError,
  readDaemonLogTail,
} from './daemon.js';
import type { SearchMode, SearchResponse } from './client.js';
import type { CodebaseProvider, IndexerReadiness, CodebaseDiagnostics, SearchOpts } from './provider.js';

/** Kick indexing for this project (fire-and-forget; spawns the daemon). */
export function ensureIndex(projectPath: string): void {
  ensureIndexStarted(projectPath);
}

/**
 * The indexer half of `codebase.status`, plus diagnostics + self-heal.
 *
 * Mirrors ugly-studio `routeCodebase`'s `codebase.status` case exactly:
 *   - snake_case → camelCase, hiding the transient 'scanning' flash as 'ready';
 *   - a null status (daemon down/spinning up) is reported as `indexing`, AND
 *     triggers a restart — the status read is non-spawning, and the once-per-
 *     session kickoff never revives a daemon that died mid-session;
 *   - diagnostics carry a plain-language `message` for the down case and the
 *     daemon log tail (which survives a respawn via daemon.log.prev).
 */
export async function indexerReadiness(
  projectPath: string,
): Promise<{ indexer: IndexerReadiness; diagnostics?: CodebaseDiagnostics }> {
  const idx = await getIndexerStatus(projectPath);
  const indexer: IndexerReadiness = idx
    ? {
        status: idx.status === 'scanning' ? 'ready' : idx.status,
        indexedChunks: idx.indexed_chunks,
        totalChunks: idx.total_chunks,
        totalFiles: idx.total_files,
        indexedFiles: idx.indexed_files,
        ...(idx.phase ? { phase: idx.phase } : {}),
        ...(idx.elapsed_seconds != null ? { elapsedSeconds: idx.elapsed_seconds } : {}),
        ...(idx.chunks_per_sec != null ? { chunksPerSec: idx.chunks_per_sec } : {}),
        ...(idx.files_per_sec != null ? { filesPerSec: idx.files_per_sec } : {}),
        ...(idx.eta_seconds != null ? { etaSeconds: idx.eta_seconds } : {}),
        ...(idx.error ? { error: idx.error } : {}),
      }
    : { status: 'indexing' };

  if (!idx) ensureDaemonRunning();

  const diagnostics: CodebaseDiagnostics | undefined =
    idx && idx.status !== 'error'
      ? undefined
      : {
          ...(idx ? {} : { message: (await daemonHealth()).message }),
          lastError: getLastDaemonError(),
          logTail: readDaemonLogTail(),
        };

  return diagnostics ? { indexer, diagnostics } : { indexer };
}

/** Index-backed search (fts / semantic / mixed). `grep` mode is client-side. */
export async function search(
  projectPath: string,
  query: string,
  limit: number,
  mode: SearchMode,
  opts?: SearchOpts,
): Promise<SearchResponse> {
  if (mode === 'grep') {
    return { status: 'unavailable', error: 'grep runs client-side' };
  }
  return indexerSearch(
    projectPath,
    query,
    limit,
    opts?.scope,
    opts?.extensions,
    opts?.worktreeRoot,
    mode,
  );
}

/** Incremental re-index of files the agent just edited (search freshness). */
export async function update(
  projectPath: string,
  files: string[],
  worktreeRoot?: string,
): Promise<void> {
  if (files.length) await indexerUpdateFiles(projectPath, files, worktreeRoot);
}

/** Repair a worktree overlay against on-disk state (session start). */
export function reconcile(projectPath: string, worktreeRoot?: string): void {
  if (worktreeRoot) reconcileWorktreeOverlay(projectPath, worktreeRoot);
}

/** The local, in-process implementation the coding task installs at boot. */
export const localCodebaseProvider: CodebaseProvider = {
  ensureIndex,
  indexerReadiness,
  search,
  update,
  reconcile,
};
