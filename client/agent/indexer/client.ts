/**
 * Indexer client — HTTP wrapper around the singleton-per-machine daemon.
 *
 * Stateless: every call takes the `projectDir` it operates on. The
 * underlying Python sidecar is shared across all callers (and across
 * all node processes on this machine — see `daemon.ts`); this client
 * never spawns it, only discovers it.
 */

import { request } from 'node:http';
import {
  getDaemonPort,
  getDaemonPortIfReady,
  invalidateDaemonCache,
} from './daemon.js';

export type IndexerState =
  | 'idle'
  | 'starting'
  | 'indexing'
  | 'ready'
  | 'error'
  | 'closed';

export type IndexerPhase = 'scanning' | 'chunking' | 'embedding' | 'committing';

export interface IndexerStatus {
  status: 'idle' | 'scanning' | 'indexing' | 'ready' | 'error';
  indexed_at: number | null;
  project_dir: string | null;
  total_chunks: number;
  total_files: number;
  indexed_chunks: number;
  indexed_files: number;
  error: string | null;
  /** Null once the run settles. */
  phase?: IndexerPhase | null;
  /** Wall time for the whole run — daemon-side monotonic clock. */
  elapsed_seconds?: number;
  /** Throughput measured over the embedding window ONLY. Omitted until some
   *  chunk has actually been embedded, so a warm resume (everything reused off
   *  disk) reports no rate and no ETA rather than an absurd one. */
  chunks_per_sec?: number;
  files_per_sec?: number;
  eta_seconds?: number;
}

export interface SearchResult {
  file_path: string;
  start_line: number;
  end_line: number;
  content: string;
  language: string;
  parent_scope: string;
  score: number;
}

export type SearchMode = 'grep' | 'fts' | 'semantic' | 'mixed';

/** A search hit with retrieval provenance (which retriever(s) matched + their
 *  sub-scores) so a UI can show WHY a result ranked where. */
export interface SearchHit extends SearchResult {
  mode: SearchMode;
  fts_rank?: number;
  semantic_score?: number;
  rerank_score?: number | null;
}

/** Discriminated search result — never a silent empty list. */
export type SearchResponse =
  | { status: 'ready'; results: SearchHit[] }
  | { status: 'indexing' | 'provisioning' | 'downloading-model' }
  | { status: 'unavailable'; error: string };

const REQUEST_TIMEOUT_MS = 120_000;
// Indexing a large codebase can take 20+ minutes (chunking + embed).
const INDEX_TIMEOUT_MS = 20 * 60_000;

/**
 * Why `node:http` and not global `fetch`.
 *
 * `/index` is a SYNCHRONOUS Flask handler: it does not respond until the whole
 * repo is chunked and embedded. Node's global fetch is undici, whose default
 * `headersTimeout` is 300s — so any index taking longer than five minutes would
 * abort with UND_ERR_HEADERS_TIMEOUT even though our own deadline is 20 minutes.
 * ugly-studio avoided this with a custom `undici.Agent({headersTimeout: 0})`,
 * but undici is not a dependency here. `node:http` has no default client-side
 * timeout at all, so the only deadline is the one we set explicitly.
 */
function httpJson(
  port: number,
  endpoint: string,
  method: 'GET' | 'POST',
  body: Record<string, unknown> | undefined,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: endpoint,
        method,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (text += c));
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          resolve({ ok: status >= 200 && status < 300, status, text });
        });
      },
    );
    // Our ONLY deadline. Fires on socket inactivity, so a daemon that is
    // actively streaming a response keeps the request alive.
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`indexer ${endpoint}: timed out after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export class IndexerClient {
  /**
   * Ensure the daemon is alive and reachable. Spawns it on the first
   * call if no daemon is registered on this machine.
   */
  async ensureRunning(): Promise<void> {
    await getDaemonPort();
  }

  private async _request(
    endpoint: string,
    body?: Record<string, unknown>,
    timeoutMs: number = REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    let port = await getDaemonPort();

    // Retry once on connection failure: the daemon may have crashed
    // since our last cached lookup. invalidateDaemonCache() forces a
    // re-discover (which will re-spawn under lock if needed).
    const deadline = Date.now() + 5_000;
    let lastErr: unknown;
    let attempted = 0;
    for (;;) {
      try {
        const method =
          body !== undefined || endpoint === '/shutdown' ? 'POST' : 'GET';
        const res = await httpJson(port, endpoint, method, body, timeoutMs);
        let data: unknown;
        try {
          data = JSON.parse(res.text);
        } catch {
          throw new Error(`invalid JSON from indexer: ${res.text.slice(0, 200)}`);
        }
        if (!res.ok) {
          const errVal = (data as Record<string, unknown>).error;
          const errMsg = typeof errVal === 'string' ? errVal : res.text;
          throw new Error(`indexer ${endpoint}: ${errMsg}`);
        }
        return data;
      } catch (err) {
        lastErr = err;
        // node:http surfaces the refusal as `err.code`, not a wrapped cause.
        const transient =
          err instanceof Error &&
          ((err as { code?: string }).code === 'ECONNREFUSED' ||
            err.message.includes('ECONNREFUSED') ||
            err.message.includes('fetch failed') ||
            (err as { cause?: { code?: string } }).cause?.code === 'ECONNREFUSED');
        if (!transient || attempted >= 1 || Date.now() >= deadline) throw err;
        attempted += 1;
        invalidateDaemonCache();
        port = await getDaemonPort();
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    // unreachable
    void lastErr;
  }

  /** Full index of a project directory. Blocks until complete. */
  async indexProject(projectDir: string): Promise<{
    chunks: number;
    files: number;
    time_s: number;
  }> {
    return (await this._request(
      '/index',
      { project_dir: projectDir },
      INDEX_TIMEOUT_MS,
    )) as { chunks: number; files: number; time_s: number };
  }

  /**
   * Semantic search across an indexed project.
   *
   * When `worktreeRoot` is provided, the daemon also consults the
   * per-session overlay at `<worktreeRoot>/.ugly-studio/session-index.db`.
   */
  async search(
    projectDir: string,
    query: string,
    limit = 10,
    scope?: string,
    extensions?: string[],
    worktreeRoot?: string,
    mode: SearchMode = 'mixed',
  ): Promise<SearchResponse> {
    return (await this._request('/search', {
      project_dir: projectDir,
      query,
      mode,
      limit,
      ...(scope ? { scope } : {}),
      ...(extensions && extensions.length > 0 ? { extensions } : {}),
      ...(worktreeRoot ? { worktree_root: worktreeRoot } : {}),
    })) as SearchResponse;
  }

  /**
   * Reconcile a worktree overlay with the worktree on disk. Embeds
   * any files that differ from both base and the existing overlay,
   * drops overlay entries the worktree has reverted to base, and
   * tombstones base files the worktree has deleted. Idempotent — a
   * clean state returns zero counts at hash-comparison cost.
   *
   * Use on session resume to repair any dirty-file state that was
   * lost when the node process restarted.
   */
  async reconcileOverlay(
    projectDir: string,
    worktreeRoot: string,
  ): Promise<{
    embedded: number;
    dropped: number;
    tombstoned: number;
    time_s: number;
  }> {
    return (await this._request(
      '/reconcile',
      { project_dir: projectDir, worktree_root: worktreeRoot },
      INDEX_TIMEOUT_MS,
    )) as {
      embedded: number;
      dropped: number;
      tombstoned: number;
      time_s: number;
    };
  }

  /** Incremental re-index of specific files. */
  async updateFiles(
    projectDir: string,
    files: string[],
    worktreeRoot?: string,
  ): Promise<{ updated: number; deleted: number }> {
    return this._request('/update', {
      project_dir: projectDir,
      files,
      ...(worktreeRoot ? { worktree_root: worktreeRoot } : {}),
    }) as Promise<{ updated: number; deleted: number }>;
  }

  /** Get index status for a project. */
  async status(projectDir: string): Promise<IndexerStatus> {
    return this._request('/status', {
      project_dir: projectDir,
    }) as Promise<IndexerStatus>;
  }

  /**
   * Non-blocking status read: returns null when the daemon isn't up yet instead
   * of spawning it and blocking on first-run provisioning. Use this for the
   * readiness poll so the codebase pill can't get stuck on "loading" while the
   * daemon spins up (the spawn is kicked separately by ensureIndexStarted).
   */
  async statusIfReady(projectDir: string): Promise<IndexerStatus | null> {
    const port = await getDaemonPortIfReady();
    if (port == null) return null;
    const ac = new AbortController();
    const timer = setTimeout(() => {
      ac.abort();
    }, REQUEST_TIMEOUT_MS);
    timer.unref();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_dir: projectDir }),
        signal: ac.signal,
      });
      if (!res.ok) return null;
      return (await res.json()) as IndexerStatus;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Stop the shared daemon. Use with care — this affects every node
   * process on this machine that's currently using the indexer.
   * Intended for tests / explicit teardown only.
   */
  async shutdownDaemon(): Promise<void> {
    try {
      await this._request('/shutdown', {}, 5_000);
    } catch {
      /* daemon may have already exited */
    }
    invalidateDaemonCache();
  }
}
