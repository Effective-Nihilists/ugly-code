// Drives the chat header's codebaseReadiness pill from the client agent (the host task):
// kicks off the host's semantic indexer + architecture doc on session start, then polls
// status and hands each reading back so the session folds it into its session_state stream.
// `codebase.*` is a host-only native channel (server/coding-agent/codebaseNative.ts); the
// task reaches it directly on desktop and via the host bridge on the proxy.
import { installUglyNative } from 'ugly-app/native';

/** SessionSnapshot.codebaseReadiness shape (kept loose to avoid a cross-package type dep). */
export interface CodebaseReadiness {
  indexer?: { status?: string; indexedChunks?: number; totalChunks?: number; totalFiles?: number };
  architecture?: { status?: string; filesAnalyzed?: number; filesTotal?: number };
}

const pollers = new Map<string, ReturnType<typeof setInterval>>();

// The raw UglyNative (with .invoke) — the facade exposes typed namespaces but no generic
// invoke, and `codebase.*` is a host-only channel with no facade method.
const inv = (channel: string, payload: unknown): Promise<unknown> =>
  installUglyNative().invoke(channel as never, payload as never);

/** Kick off indexing + poll readiness every 1.5s until both surfaces settle. */
export function startCodebasePoll(
  sessionId: string,
  cwd: string,
  onReadiness: (r: CodebaseReadiness) => void,
): void {
  if (!cwd || pollers.has(sessionId)) return;
  void inv('codebase.ensureIndex', { projectPath: cwd }).catch(() => undefined);
  const tick = async (): Promise<void> => {
    try {
      const r = (await inv('codebase.status', { projectPath: cwd })) as CodebaseReadiness;
      onReadiness(r);
      const idx = r?.indexer?.status;
      const arch = r?.architecture?.status;
      const idxDone = idx === 'ready' || idx === 'error';
      const archDone = !arch || arch === 'ready' || arch === 'failed';
      if (idxDone && archDone) stopCodebasePoll(sessionId);
    } catch {
      /* transient (daemon spinning up / forwarding blip) — keep polling */
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), 1500);
  pollers.set(sessionId, timer);
}

export function stopCodebasePoll(sessionId: string): void {
  const t = pollers.get(sessionId);
  if (t) {
    clearInterval(t);
    pollers.delete(sessionId);
  }
}

/** Read the host-generated ARCHITECTURE.md for a project (null if absent/not built yet).
 *  The architecture manager writes it to <project>/.ugly-studio/ARCHITECTURE.md. */
export async function fetchArchitectureDoc(cwd: string): Promise<string | null> {
  if (!cwd) return null;
  try {
    const path = `${cwd.replace(/\/+$/, '')}/.ugly-studio/ARCHITECTURE.md`;
    const res = (await inv('fs.readFile', { path })) as { content?: string };
    const content = res?.content;
    return content?.trim() ? content : null;
  } catch {
    return null;
  }
}
