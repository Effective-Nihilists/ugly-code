// Drives the chat header's codebaseReadiness pill from the client agent (the host task):
// kicks off the host's semantic indexer + architecture doc on session start, then polls
// status and hands each reading back so the session folds it into its session_state stream.
// The INDEXER half now runs locally in the task via `codebaseProvider()` (moved out of
// ugly-studio so it ships with a deploy); the ARCHITECTURE half stays on the host
// `codebase.architecture` channel. `fetchCodebaseStatus` (renderer feedback path) still
// reads the host `codebase.status`.
import { installUglyNative } from 'ugly-app/native';
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
  architecture?: { status?: string; filesAnalyzed?: number; filesTotal?: number; lastWrittenAt?: number; error?: string };
  diagnostics?: { message?: string; lastError?: string | null; logTail?: string };
}

const pollers = new Map<string, ReturnType<typeof setInterval>>();

/** One-shot fresh read of the host indexer/architecture status for a project.
 *  Used to enrich feedback reports (a "codebase: loading" report should carry
 *  the actual indexer state at submit time, not just the last polled snapshot). */
export async function fetchCodebaseStatus(cwd: string): Promise<unknown> {
  return inv('codebase.status', { projectPath: cwd });
}

// The raw UglyNative (with .invoke) — the facade exposes typed namespaces but no generic
// invoke, and `codebase.*` is a host-only channel with no facade method.
const inv = (channel: string, payload: unknown): Promise<unknown> =>
  installUglyNative().invoke(channel as never, payload as never);

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
  // The INDEXER half runs locally in the task (codebaseProvider), so its bug
  // fixes ship with a deploy. The ARCHITECTURE half stays on the host — its
  // generator pulls in the ~7 MB TypeScript compiler, too heavy for the task
  // bundle — and is kicked + read through `codebase.architecture`.
  codebaseProvider().ensureIndex(cwd);
  void inv('codebase.architecture', { projectPath: cwd }).catch(() => undefined);
  const tick = async (): Promise<void> => {
    try {
      const local = await codebaseProvider().indexerReadiness(cwd);
      // `codebase.architecture` returns { architecture } and re-kicks the
      // (deduped) background build; a failure just leaves architecture idle.
      const archRes = (await inv('codebase.architecture', { projectPath: cwd }).catch(
        () => null,
      )) as { architecture?: CodebaseReadiness['architecture'] } | null;
      // Undefined only when the host call FAILED — kept distinct from a real
      // 'idle' so the settle check below matches the original semantics.
      const architecture = archRes?.architecture;

      const r: CodebaseReadiness = {
        indexer: local.indexer,
        architecture: architecture ?? { status: 'idle' },
        ...(local.diagnostics ? { diagnostics: local.diagnostics } : {}),
      };
      onReadiness(r);

      const idx = local.indexer.status;
      if (idx === 'ready' && worktreeRoot && worktreeRoot !== cwd && !reconciled.has(sessionId)) {
        reconciled.add(sessionId);
        codebaseProvider().reconcile(cwd, worktreeRoot);
      }
      // Match the pre-move settle rule exactly: absent (host failed) or a
      // terminal architecture status ends the poll; idle/building keep it alive.
      const arch = architecture?.status;
      const idxDone = idx === 'ready' || idx === 'error';
      const archDone = !arch || arch === 'ready' || arch === 'failed';
      if (idxDone && archDone) stopCodebasePoll(sessionId);
    } catch {
      /* transient (daemon spinning up / forwarding blip) — keep polling */
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

/** Read the host-generated ARCHITECTURE.md for a project (null if absent/not built yet).
 *  Newer hosts write it to the project ROOT (<project>/ARCHITECTURE.md); older hosts
 *  wrote <project>/.ugly-studio/ARCHITECTURE.md — try root first, then fall back so
 *  the pill works across the desktop auto-update lag. */
export async function fetchArchitectureDoc(cwd: string): Promise<string | null> {
  if (!cwd) return null;
  // Follow the cwd's separator style so Windows paths stay all-backslash
  // (a mixed `C:\proj/...` blob is fragile on native.fs).
  const sep = cwd.includes('\\') && !cwd.startsWith('/') ? '\\' : '/';
  const root = cwd.replace(/[\\/]+$/, '');
  const paths = [`${root}${sep}ARCHITECTURE.md`, `${root}${sep}.ugly-studio${sep}ARCHITECTURE.md`];
  for (const path of paths) {
    try {
      const res = (await inv('fs.readFile', { path })) as { content?: string } | undefined;
      const content = res?.content;
      if (content?.trim()) return content;
    } catch {
      /* try next candidate */
    }
  }
  return null;
}
