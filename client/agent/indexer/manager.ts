/**
 * Process-wide accessors over the shared indexer daemon.
 *
 * One singleton-per-machine Python sidecar serves all callers (see
 * `daemon.ts`). This module provides project-keyed entry points used
 * by the coding-agent `codebase_search` tool and session bootstrap.
 *
 * Contract:
 *   - All exports are project-keyed: caller passes the absolute
 *     `projectPath` on every call.
 *   - `ensureIndexStarted(path)` is idempotent and fire-and-forget.
 *     A per-project flag prevents duplicate kickoffs; different
 *     projects index in parallel inside the daemon.
 *   - `search/updateFiles/status` route by `projectPath` to the
 *     daemon, which keeps per-project state.
 *   - `resetIndexer()` does NOT shut down the shared daemon — only
 *     drops local subscriber/watcher state for this node process.
 */

import type {
  IndexerClient,
  IndexerStatus,
  SearchResponse,
  SearchMode,
} from './client.js';

// The daemon's status shape is owned by ./client.ts — alias it rather than
// re-declaring, or every new field has to be added in two places (which is how
// indexed_files/phase/eta went missing here in the first place).
type Status = IndexerStatus;

let client: IndexerClient | null = null;
let pendingClient: Promise<IndexerClient> | null = null;
const indexInFlight = new Set<string>();
const reconcileInFlight = new Set<string>();

async function getClient(): Promise<IndexerClient> {
  if (client) return client;
  if (pendingClient) return pendingClient;
  pendingClient = (async () => {
    const { IndexerClient: Cls } = await import('./client.js');
    const c = new Cls();
    client = c;
    return c;
  })();
  try {
    return await pendingClient;
  } finally {
    pendingClient = null;
  }
}

// ---------------------------------------------------------------------
// Status push: subscribers (per project path) get notified on every
// observed status change. The watcher polls the daemon on the SERVER
// side (one watcher per project, not per browser tab) and dedupes by
// content hash so a "still indexing 0%" tick doesn't fire spurious
// snapshot rebroadcasts.
// ---------------------------------------------------------------------

type StatusListener = (status: Status | null) => void;

const listeners = new Map<string, Set<StatusListener>>();
const watcherTimers = new Map<string, NodeJS.Timeout>();
const lastStatusKey = new Map<string, string>();

const WATCH_INTERVAL_FAST_MS = 1_000;
const WATCH_INTERVAL_IDLE_MS = 5_000;

function statusKey(s: Status | null): string {
  if (!s) return 'null';
  // Progress fields only. `elapsed_seconds` / rates / `eta_seconds` change on
  // EVERY poll — folding them in would defeat this dedupe and fire a
  // session_state rebroadcast once a second for the whole index. The stats
  // modal polls the daemon directly for those.
  return `${s.status}|${s.phase ?? ''}|${s.project_dir ?? ''}|${
    s.indexed_chunks
  }|${s.total_chunks}|${s.indexed_files}|${s.total_files}|${s.error ?? ''}`;
}

function scheduleWatcher(projectPath: string, intervalMs: number): void {
  const existing = watcherTimers.get(projectPath);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    void watcherTick(projectPath);
  }, intervalMs);
  t.unref();
  watcherTimers.set(projectPath, t);
}

async function watcherTick(projectPath: string): Promise<void> {
  const subs = listeners.get(projectPath);
  if (!subs || subs.size === 0) {
    watcherTimers.delete(projectPath);
    lastStatusKey.delete(projectPath);
    return;
  }
  let next: Status | null = null;
  try {
    next = await getIndexerStatus(projectPath);
  } catch {
    next = null;
  }
  const key = statusKey(next);
  if (key !== lastStatusKey.get(projectPath)) {
    lastStatusKey.set(projectPath, key);
    for (const cb of subs) {
      try {
        cb(next);
      } catch {
        /* listener errors must not break other subscribers */
      }
    }
  }
  const interval =
    next?.status === 'indexing' || next?.status === 'scanning' || !next
      ? WATCH_INTERVAL_FAST_MS
      : WATCH_INTERVAL_IDLE_MS;
  scheduleWatcher(projectPath, interval);
}

/**
 * Wait until the indexer for a project reaches a terminal state
 * (`ready` or `error`). Resolves with the final status, or `null` on
 * timeout.
 */
export function waitForIndexerReady(
  projectPath: string,
  timeoutMs = 120_000,
): Promise<Status | null> {
  return new Promise((resolve) => {
    let done = false;
    let unsub: (() => void) | null = null;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      unsub?.();
      resolve(null);
    }, timeoutMs);
    timer.unref();
    unsub = subscribeIndexerStatus(projectPath, (status) => {
      if (done) return;
      if (
        status?.project_dir === projectPath &&
        (status.status === 'ready' || status.status === 'error')
      ) {
        done = true;
        clearTimeout(timer);
        unsub?.();
        resolve(status);
      }
    });
  });
}

/**
 * Subscribe to status changes for a project.
 */
export function subscribeIndexerStatus(
  projectPath: string,
  cb: StatusListener,
): () => void {
  let set = listeners.get(projectPath);
  if (!set) {
    set = new Set();
    listeners.set(projectPath, set);
  }
  set.add(cb);
  if (!watcherTimers.has(projectPath)) {
    void watcherTick(projectPath);
  }
  return () => {
    const s = listeners.get(projectPath);
    if (!s) return;
    s.delete(cb);
    if (s.size === 0) {
      listeners.delete(projectPath);
      const timer = watcherTimers.get(projectPath);
      if (timer) clearTimeout(timer);
      watcherTimers.delete(projectPath);
      lastStatusKey.delete(projectPath);
    }
  };
}

/**
 * Returns the shared client (lazily resolves the daemon on first call).
 */
export async function getIndexerClient(): Promise<IndexerClient> {
  return getClient();
}

/**
 * Kick off a full index for the given project in the background.
 * Fire-and-forget. Per-project guard prevents duplicate kickoffs;
 * different projects index in parallel inside the daemon.
 */
export function ensureIndexStarted(projectPath: string): void {
  // Use console.warn at each decision point so a remote install's
  // indexer trajectory shows up in errorLog (the ugly-app intercept
  // captures `warn`/`error` but NOT `log` — see
  // node_modules/ugly-app/dist/server/Logging.js#interceptServerConsole).
  // Without this, a silently-no-op indexer on a tester machine looks
  // identical to a working one from our end — we just see zero
  // [indexer] lines either way. The cadence is once per session
  // creation, so the log volume is negligible.
  void (async () => {
    try {
      const c = await getClient();
      if (indexInFlight.has(projectPath)) {
        console.warn(
          `[indexer] kickoff skipped (already in-flight) for ${projectPath}`,
        );
        return;
      }
      const s = await c.status(projectPath);
      console.warn(
        `[indexer] kickoff status-probe for ${projectPath}: status=${
          s.status
        } project_dir=${s.project_dir ?? 'null'} indexed=${s.indexed_chunks}/${
          s.total_chunks
        } files=${s.total_files} err=${s.error ?? 'none'}`,
      );
      if (s.status === 'ready' && s.project_dir === projectPath) {
        console.warn(
          `[indexer] kickoff skipped (already ready) for ${projectPath} — ${s.indexed_chunks}/${s.total_chunks} chunks`,
        );
        return;
      }
      if (
        (s.status === 'indexing' || s.status === 'scanning') &&
        s.project_dir === projectPath
      ) {
        console.warn(
          `[indexer] kickoff skipped (already ${s.status}) for ${projectPath} — ${s.indexed_chunks}/${s.total_chunks}`,
        );
        indexInFlight.add(projectPath);
        return;
      }
      console.warn(
        `[indexer] kickoff calling indexProject for ${projectPath} (sidecar status=${
          s.status
        }, project_dir=${s.project_dir ?? 'null'})`,
      );
      indexInFlight.add(projectPath);
      c.indexProject(projectPath)
        .then((r) => {
          // Suspicious silent-success case: indexer reports "done" but
          // walked zero files. Flag it at warn so it lands in errorLog
          // — the most common cause we see is .gitignore patterns
          // excluding the whole tree, or the projectPath resolving
          // somewhere empty (e.g. a worktree before checkout
          // populated it). Surface it loudly instead of letting the
          // user wonder why search is empty.
          const level = r.files === 0 || r.chunks === 0 ? 'warn' : 'log';
          const msg = `[indexer] indexed ${r.files} files (${r.chunks} chunks) in ${r.time_s}s for ${projectPath}`;
          if (level === 'warn') {
            console.warn(`${msg} — ZERO files/chunks, check .gitignore`);
          } else {
            console.warn(msg);
          }
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[indexer] index failed for ${projectPath}: ${msg}`);
        })
        .finally(() => {
          indexInFlight.delete(projectPath);
        });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[indexer] kickoff failed for ${projectPath}: ${msg}`);
    }
  })();
}

/**
 * Bring a session's worktree overlay up to date with the worktree on
 * disk. Fire-and-forget. Used on session resume to repair the dirty-
 * file state we lose when the node process restarts: edits made in a
 * previous run never reach the overlay via the lazy flush path in
 * `runSemanticSearch`, so the overlay drifts. Reconcile walks the
 * worktree and embeds anything missing.
 *
 * Per-worktree guard prevents duplicate kickoffs; waits for the base
 * index to be ready (reconcile needs base hashes to know what's
 * already covered there).
 */
export function reconcileWorktreeOverlay(
  projectPath: string,
  worktreeRoot: string,
): void {
  if (projectPath === worktreeRoot) return; // no overlay when paths match
  const key = `${projectPath}\0${worktreeRoot}`;
  if (reconcileInFlight.has(key)) return;
  reconcileInFlight.add(key);
  void (async () => {
    try {
      const c = await getClient();
      // Wait for the base index to be ready — /reconcile compares
      // against base hashes, so calling it before /index has run for
      // this project would 400 with "base index not built". The base
      // kickoff runs in parallel via ensureIndexStarted; we just wait
      // it out.
      const baseStatus = await waitForIndexerReady(projectPath, 180_000);
      if (
        baseStatus?.status !== 'ready' ||
        baseStatus.project_dir !== projectPath
      ) {
        console.warn(
          `[indexer] reconcile skipped (base not ready) for ${worktreeRoot} — base status=${
            baseStatus?.status ?? 'null'
          } project_dir=${baseStatus?.project_dir ?? 'null'}`,
        );
        return;
      }
      const r = await c.reconcileOverlay(projectPath, worktreeRoot);
      // Warn on any non-zero result so the recovery shows up in
      // errorLog on remote installs — that's the diagnostic signal
      // that the fix is doing its job.
      const moved = r.embedded > 0 || r.dropped > 0 || r.tombstoned > 0;
      const msg =
        `[indexer] reconcile overlay ${worktreeRoot}: ` +
        `embedded=${r.embedded} dropped=${r.dropped} ` +
        `tombstoned=${r.tombstoned} in ${r.time_s}s`;
      if (moved) console.warn(msg);
      else console.log(msg);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[indexer] reconcile failed for ${worktreeRoot}: ${msg}`);
    } finally {
      reconcileInFlight.delete(key);
    }
  })();
}

/**
 * Read the daemon-side status for the given project. Non-blocking: if the
 * daemon is still spinning up (first-run provisioning), this returns null
 * immediately rather than awaiting the whole spawn chain — that's what kept the
 * codebase-readiness pill frozen on "loading" on fresh (esp. Windows) installs.
 * The spawn is driven separately by `ensureIndexStarted`, so returning null here
 * only affects what the poll reports (rendered as "indexing"/analyzing), never
 * whether indexing actually starts.
 */
export async function getIndexerStatus(
  projectPath: string,
): Promise<Status | null> {
  try {
    const c = await getClient();
    return await c.statusIfReady(projectPath);
  } catch {
    return null;
  }
}

/**
 * Query an existing index. Does NOT trigger indexing.
 */
export async function indexerSearch(
  projectPath: string,
  query: string,
  limit: number,
  scope?: string,
  extensions?: string[],
  worktreeRoot?: string,
  mode: SearchMode = 'mixed',
): Promise<SearchResponse> {
  try {
    const c = await getClient();
    return await c.search(
      projectPath,
      query,
      limit,
      scope,
      extensions,
      worktreeRoot,
      mode,
    );
  } catch (err) {
    // Surface the failure instead of a silent empty list — the caller renders
    // 'unavailable' with the reason rather than "no matches".
    return { status: 'unavailable', error: String(err) };
  }
}

/**
 * Incremental re-index of specific files.
 */
export async function indexerUpdateFiles(
  projectPath: string,
  files: string[],
  worktreeRoot?: string,
): Promise<{ updated: number; deleted: number } | null> {
  try {
    const c = await getClient();
    return await c.updateFiles(projectPath, files, worktreeRoot);
  } catch {
    return null;
  }
}

/**
 * With the shared daemon, "is bound" reduces to "have we resolved a
 * client yet" — we no longer track per-project bindings on the node
 * side. Kept for API stability.
 */
export function isIndexerBound(_projectPath: string): boolean {
  return client !== null;
}

/**
 * Drop local watcher state for this node process. Does NOT stop the
 * shared daemon — that's a system-wide service. If you need to kill
 * the daemon (tests, explicit teardown), use
 * `(await getIndexerClient()).shutdownDaemon()` directly.
 */
export function resetIndexer(): void {
  for (const t of watcherTimers.values()) clearTimeout(t);
  watcherTimers.clear();
  listeners.clear();
  lastStatusKey.clear();
  indexInFlight.clear();
}
