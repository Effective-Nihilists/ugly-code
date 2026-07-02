import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useSocket } from './useSocket';

/**
 * Global tracker for in-flight session deletions.
 *
 * Session deletes (`deleteCodingAgentSession`) tear down a git
 * worktree + branch + transcript and can take 5–30s each; cascading
 * children adds more. Doing this inline blocks whichever panel
 * triggered it (the archived modal, the git panel) for the duration.
 *
 * This tracker decouples the UI from the request lifecycle:
 *
 *   1. Callers `enqueue([...sessions], onComplete?)` and return
 *      immediately — modals close, the user navigates freely.
 *   2. The tracker fires the underlying socket request in the
 *      background with a small concurrency cap (3) so a bulk
 *      "Delete all" doesn't thrash the disk on git worktree
 *      teardowns.
 *   3. Each row reads `isDeleting(compositeId)` and renders a
 *      "Deleting…" badge with its actions disabled until the
 *      server confirms; the row is then removed by the next poll
 *      (driven by the caller's `onComplete` and a global
 *      `ugly-studio:sessions-deleted` event).
 *   4. Failures stay in the tracker as `error` entries for ~6s so
 *      the top-bar `DeletionStatusBadge` can surface a red pill
 *      with the failure list, then auto-clear.
 */

export interface SessionDeletionEntry {
  compositeId: string;
  title: string;
  startedAt: number;
  status: 'pending' | 'error';
  error?: string;
}

export interface SessionDeletionAPI {
  enqueue(
    items: readonly { compositeId: string; title: string }[],
    onComplete?: () => void,
  ): void;
  /** True while a delete for this id is in flight. Used by rows to
   *  render a "Deleting…" state and disable their actions. Errored
   *  entries return `false` (their row is no longer mid-delete; the
   *  badge handles the surfacing). */
  isDeleting(compositeId: string): boolean;
  /** All tracked entries (pending + recently errored), ordered by
   *  insertion. The top-bar badge reads this. */
  entries: readonly SessionDeletionEntry[];
  /** Dismiss an errored entry from the badge popover. */
  dismiss(compositeId: string): void;
}

/** Event dispatched on `window` whenever a deletion batch settles
 *  (success or failure). Lists can subscribe to it to re-poll without
 *  the caller having to thread an `onRefresh` callback through every
 *  enqueue site. */
export const SESSIONS_DELETED_EVENT = 'ugly-studio:sessions-deleted';

/** How long an errored entry stays in the tracker so the badge can
 *  flash a red pill before the entry auto-clears. */
const ERROR_TTL_MS = 6_000;

/** Cap on concurrent in-flight delete requests. Tuned for git worktree
 *  teardowns — 3 keeps the disk reasonably busy without thrashing on a
 *  20-session purge. */
const CONCURRENCY = 3;

const SessionDeletionContext = createContext<SessionDeletionAPI | null>(null);

export function SessionDeletionProvider({
  children,
}: {
  children: ReactNode;
}): React.ReactElement {
  const socket = useSocket();
  const [entries, setEntries] = useState<SessionDeletionEntry[]>([]);

  // Track of pending error-clear timers so we can cancel on unmount
  // or on explicit dismiss.
  const errorTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );

  // Queue of work items waiting for a worker slot. We push into this
  // and a fixed pool of `CONCURRENCY` workers drains it. Using a
  // shared queue (rather than batching per enqueue call) means a
  // single bulk-delete of 20 sessions and a follow-up single delete
  // share the same concurrency cap — the second caller doesn't blow
  // the cap by spinning up its own pool.
  interface QueuedItem {
    compositeId: string;
    title: string;
    onSettle?: () => void;
  }
  const queueRef = useRef<QueuedItem[]>([]);
  const activeWorkersRef = useRef<number>(0);

  // Pending-batch bookkeeping: for each enqueue call we count down a
  // shared counter as each of its items settles, then invoke
  // `onComplete` exactly once. Keyed by a per-call symbol so two
  // overlapping batches don't share counters.
  interface BatchTicket {
    remaining: number;
    onComplete?: () => void;
  }

  useEffect(() => {
    const timers = errorTimers.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, []);

  const clearErrorTimer = useCallback((compositeId: string) => {
    const t = errorTimers.current.get(compositeId);
    if (t) {
      clearTimeout(t);
      errorTimers.current.delete(compositeId);
    }
  }, []);

  const scheduleErrorClear = useCallback(
    (compositeId: string) => {
      clearErrorTimer(compositeId);
      const t = setTimeout(() => {
        errorTimers.current.delete(compositeId);
        setEntries((prev) => prev.filter((e) => e.compositeId !== compositeId));
      }, ERROR_TTL_MS);
      errorTimers.current.set(compositeId, t);
    },
    [clearErrorTimer],
  );

  const dismiss = useCallback(
    (compositeId: string) => {
      clearErrorTimer(compositeId);
      setEntries((prev) => prev.filter((e) => e.compositeId !== compositeId));
    },
    [clearErrorTimer],
  );

  // Workers loop. Each worker picks the next queued item, fires the
  // request, updates the entry on settle, then loops. The pool stays
  // up to `CONCURRENCY` workers; idle workers exit and are recreated
  // on the next enqueue.
  const startWorkers = useCallback(() => {
    const spawn = () => {
      if (activeWorkersRef.current >= CONCURRENCY) return;
      activeWorkersRef.current += 1;
      void (async () => {
        try {
          for (;;) {
            const item = queueRef.current.shift();
            if (!item) return;
            let ok = false;
            let errMsg: string | undefined;
            try {
              const res = await socket.request('deleteCodingAgentSession', {
                sessionId: item.compositeId,
              });
              if (res.ok) {
                ok = true;
              } else {
                errMsg = res.error ?? 'Unknown error';
              }
            } catch (err) {
              errMsg = (err as Error).message;
            }
            if (ok) {
              // Drop the entry — the row will disappear on the next
              // poll triggered by `onSettle`.
              setEntries((prev) =>
                prev.filter((e) => e.compositeId !== item.compositeId),
              );
            } else {
              setEntries((prev) =>
                prev.map((e) =>
                  e.compositeId === item.compositeId
                    ? { ...e, status: 'error', error: errMsg }
                    : e,
                ),
              );
              scheduleErrorClear(item.compositeId);
            }
            try {
              item.onSettle?.();
            } catch {
              /* swallow caller's refresh errors — not our problem */
            }
          }
        } finally {
          activeWorkersRef.current = Math.max(0, activeWorkersRef.current - 1);
        }
      })();
    };
    const slots = CONCURRENCY - activeWorkersRef.current;
    for (let i = 0; i < slots; i++) spawn();
  }, [socket, scheduleErrorClear]);

  const enqueue = useCallback<SessionDeletionAPI['enqueue']>(
    (items, onComplete) => {
      if (items.length === 0) {
        onComplete?.();
        return;
      }

      // Dedupe: if a session is already pending (or errored — user is
      // retrying), drop the duplicate. Errored entries are cleared
      // first so a retry actually re-runs.
      const seenIds = new Set<string>();
      setEntries((prev) => {
        const pendingIds = new Set(prev.map((e) => e.compositeId));
        const next = [...prev];
        for (const item of items) {
          if (seenIds.has(item.compositeId)) continue;
          seenIds.add(item.compositeId);
          if (pendingIds.has(item.compositeId)) {
            // If errored, clear the error and re-queue as pending.
            const existing = next.find(
              (e) => e.compositeId === item.compositeId,
            );
            if (existing?.status === 'error') {
              clearErrorTimer(item.compositeId);
              existing.status = 'pending';
              delete existing.error;
              existing.startedAt = Date.now();
            } else {
              continue;
            }
          } else {
            next.push({
              compositeId: item.compositeId,
              title: item.title,
              startedAt: Date.now(),
              status: 'pending',
            });
          }
        }
        return next;
      });

      const ticket: BatchTicket = {
        remaining: 0,
        ...(onComplete ? { onComplete } : {}),
      };
      const onSettle = () => {
        ticket.remaining -= 1;
        if (ticket.remaining <= 0) {
          ticket.onComplete?.();
          window.dispatchEvent(new CustomEvent(SESSIONS_DELETED_EVENT));
        }
      };
      const queuedThisCall: QueuedItem[] = [];
      for (const item of items) {
        // Skip items that didn't enter the entry set (duplicates).
        if (!seenIds.has(item.compositeId)) continue;
        queuedThisCall.push({
          compositeId: item.compositeId,
          title: item.title,
          onSettle,
        });
      }
      ticket.remaining = queuedThisCall.length;
      if (queuedThisCall.length === 0) {
        onComplete?.();
        return;
      }
      queueRef.current.push(...queuedThisCall);
      startWorkers();
    },
    [clearErrorTimer, startWorkers],
  );

  const pendingIdSet = useMemo(() => {
    const s = new Set<string>();
    for (const e of entries) if (e.status === 'pending') s.add(e.compositeId);
    return s;
  }, [entries]);

  const isDeleting = useCallback(
    (compositeId: string) => pendingIdSet.has(compositeId),
    [pendingIdSet],
  );

  const value = useMemo<SessionDeletionAPI>(
    () => ({
      enqueue,
      isDeleting,
      entries,
      dismiss,
    }),
    [enqueue, isDeleting, entries, dismiss],
  );

  return (
    <SessionDeletionContext.Provider value={value}>
      {children}
    </SessionDeletionContext.Provider>
  );
}

export function useSessionDeletion(): SessionDeletionAPI {
  const ctx = useContext(SessionDeletionContext);
  if (!ctx) {
    // No provider — return an inert API so consumers outside the
    // Editor shell (e.g. pre-auth screens) don't crash.
    return INERT_API;
  }
  return ctx;
}

const INERT_API: SessionDeletionAPI = {
  enqueue: () => {
    /* no-op outside provider */
  },
  isDeleting: () => false,
  entries: [],
  dismiss: () => {
    /* no-op outside provider */
  },
};
