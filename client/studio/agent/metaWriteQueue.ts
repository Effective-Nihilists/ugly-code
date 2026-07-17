// Serialize a session's metadata writes.
//
// Why: the session doc's status was written fire-and-forget from two places —
// `persistMeta(…, 'running')` on every assistant message, and `persistMeta(…, 'idle')`
// on the terminal event. Two un-awaited HTTP requests issued microseconds apart have NO
// ordering guarantee, so whenever the earlier 'running' landed AFTER the terminal 'idle'
// it clobbered it and the session was stuck "THINKING" forever — with nothing to ever
// write again. Reported by four eval personas and a real user ("This session stopped
// thinking with no reason"); intermittent, because it's a network race.
//
// Fix: chain each session's writes so they're APPLIED in the order they were ISSUED.
// The last write issued for a turn is the terminal one, so the terminal status wins.

type Writer = () => Promise<unknown>;

const chains = new Map<string, Promise<unknown>>();

/**
 * Queue `write` for `key`, guaranteeing it runs after every earlier write for the same
 * key. Never throws (a failed write must not break the chain or the turn); `onError`
 * gets the failure so it isn't silent.
 */
export function queueWrite(key: string, write: Writer, onError?: (e: unknown) => void): Promise<void> {
  const prev = chains.get(key) ?? Promise.resolve();
  const next: Promise<void> = prev
    .catch(() => undefined) // a prior failure must not poison later writes
    .then(async () => { await write(); })
    .catch((e: unknown) => { onError?.(e); });
  chains.set(key, next);
  // Drop the chain once it's fully drained so the map doesn't grow per session forever.
  void next.finally(() => {
    if (chains.get(key) === next) chains.delete(key);
  });
  return next;
}

/** Test/teardown helper: forget any pending chains. */
export function resetWriteQueues(): void {
  chains.clear();
}

/** Pending chain count — for tests. */
export function pendingWriteQueues(): number {
  return chains.size;
}
