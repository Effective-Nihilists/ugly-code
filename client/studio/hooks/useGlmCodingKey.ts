// The user's Z.ai GLM Coding Plan key, held in the Neon per-user settings doc
// (NOT the host-disk studio settings store — the SERVER must read it to forward
// on each agentStep, so it has to live where the server can see it).
//
// A tiny module-level cache + subscriber set, so the model picker can gate the
// `glm_coding_plan` row on "is a key configured?" without every consumer firing
// its own RPC.
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useAppOptional } from 'ugly-app/client';

// `getUserSettings` / `updateUserSettings` live on the ugly-app app socket, not
// the studio socket. `useAppOptional` (rather than `useApp`) because pickers can
// render outside the AppProvider, where `useApp` throws.
interface SettingsSocket {
  request(name: string, input: unknown): Promise<unknown>;
}

let cached: string | undefined;
let hydrated = false;
let hydrating: Promise<void> | null = null;
const subscribers = new Set<() => void>();

function notify(): void {
  for (const fn of subscribers) {
    try {
      fn();
    } catch {
      /* one bad listener shouldn't break the rest */
    }
  }
}

function hydrate(socket: SettingsSocket): Promise<void> {
  if (hydrated) return Promise.resolve();
  if (hydrating) return hydrating;
  hydrating = socket
    .request('getUserSettings', {})
    .then((r) => {
      cached = (r as { codingAgent?: { glmCodingKey?: string } } | null)?.codingAgent
        ?.glmCodingKey;
      hydrated = true;
      hydrating = null;
      notify();
    })
    .catch(() => {
      // Treat a failed read as "no key": the picker hides the row and the
      // server would reject the turn anyway.
      hydrated = true;
      hydrating = null;
      notify();
    });
  return hydrating;
}

function subscribe(cb: () => void): () => void {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}

export interface GlmCodingKeyApi {
  /** The stored key, or undefined when none is configured / not yet hydrated. */
  key: string | undefined;
  /** True once the settings doc has been read at least once. */
  hydrated: boolean;
  /** Persist a key, or pass null to clear it. */
  save: (next: string | null) => Promise<void>;
}

export function useGlmCodingKey(): GlmCodingKeyApi {
  const app = useAppOptional();
  const socket = app?.socket as unknown as SettingsSocket | undefined;
  const key = useSyncExternalStore(
    subscribe,
    () => cached,
    () => undefined,
  );
  const isHydrated = useSyncExternalStore(
    subscribe,
    () => hydrated,
    () => false,
  );

  useEffect(() => {
    if (socket) void hydrate(socket);
  }, [socket]);

  const save = useCallback(
    async (next: string | null): Promise<void> => {
      if (!socket) throw new Error('Not connected — cannot save the key.');
      // `null` clears (mergeUserSettings treats null as "remove"); '' would be
      // stored verbatim and then read back as a present-but-empty key.
      const trimmed = next === null ? null : next.trim() === '' ? null : next.trim();
      await socket.request('updateUserSettings', {
        codingAgent: { glmCodingKey: trimmed },
      });
      cached = trimmed ?? undefined;
      hydrated = true;
      notify();
    },
    [socket],
  );

  return { key, hydrated: isHydrated, save };
}

/** Read-only, non-reactive: has a key been configured? */
export function hasGlmCodingKey(): boolean {
  return typeof cached === 'string' && cached.length > 0;
}
