// Drives the chat header's codebaseReadiness pill from the coding task: kicks off the
// semantic indexer on session start, then polls status and hands each reading back so the
// session folds it into its session_state stream. The indexer runs locally in the task via
// `codebaseProvider()` (moved out of ugly-studio so it ships with a deploy). The
// architecture-doc surface was removed.
import { codebaseProvider } from '../../agent/indexer/provider';

/** SessionSnapshot.codebaseReadiness shape (kept loose to avoid a cross-package type dep).
 *  Mirrors `CodebaseReadinessSchema` in ../shared/api.ts — keep the two in step. */
export interface CodebaseReadiness {
  indexer?: {
    status?: string;
    indexedChunks?: number;
    totalChunks?: number;
    totalFiles?: number;
    phase?: string;
    indexedFiles?: number;
    filesPerSec?: number;
    chunksPerSec?: number;
    etaSeconds?: number;
    elapsedSeconds?: number;
    error?: string;
  };
  diagnostics?: { message?: string; lastError?: string | null; logTail?: string };
}

const pollers = new Map<string, ReturnType<typeof setInterval>>();

// Sessions whose worktree overlay has been reconciled once (on first 'ready').
const reconciled = new Set<string>();

/** Kick off indexing + poll readiness every 1.5s until both surfaces settle.
 *  When a `worktreeRoot` is given, repair its overlay against on-disk state
 *  once the base index reports ready (semantic-search freshness). */
export function startCodebasePoll(
  sessionId: string,
  cwd: string,
  onReadiness: (r: CodebaseReadiness) => void,
  worktreeRoot?: string,
): void {
  if (!cwd || pollers.has(sessionId)) return;
  // The indexer runs locally in the task (codebaseProvider), so its fixes ship
  // with a deploy.
  codebaseProvider().ensureIndex(cwd);
  const tick = async (): Promise<void> => {
    try {
      const local = await codebaseProvider().indexerReadiness(cwd);
      const r: CodebaseReadiness = {
        indexer: local.indexer,
        ...(local.diagnostics ? { diagnostics: local.diagnostics } : {}),
      };
      onReadiness(r);

      const idx = local.indexer.status;
      if (idx === 'ready' && worktreeRoot && worktreeRoot !== cwd && !reconciled.has(sessionId)) {
        reconciled.add(sessionId);
        codebaseProvider().reconcile(cwd, worktreeRoot);
      }
      // Stop once the index settles. A daemon that is down reports 'indexing'
      // (never settling) and self-heals via indexerReadiness, so the poll keeps
      // running until it recovers — which is the point.
      if (idx === 'ready' || idx === 'error') stopCodebasePoll(sessionId);
    } catch {
      /* transient (daemon spinning up) — keep polling */
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), 3000);
  pollers.set(sessionId, timer);
}

export function stopCodebasePoll(sessionId: string): void {
  const t = pollers.get(sessionId);
  if (t) {
    clearInterval(t);
    pollers.delete(sessionId);
  }
  reconciled.delete(sessionId);
}
