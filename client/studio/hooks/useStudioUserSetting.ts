import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { onCustomMessage, useSocket } from './useSocket';

/**
 * Disk-backed UI preferences. Replaces every `localStorage` write the
 * studio used to do — values now live in `~/.ugly-studio/settings.json`
 * via the `getStudioUserSettings` / `setStudioUserSetting` RPCs.
 *
 * The module owns a lazily-hydrated in-memory cache so consumers can
 * read synchronously after first hydration. A subscriber list lets
 * `useStudioUserSetting` re-render any component reading a key when
 * a write lands (locally or pushed from another tab — see the
 * `studioUserSettings:changed` broadcast wired up in
 * `server/index.ts`).
 *
 * Hydration policy:
 *   - `useStudioUserSetting(key, default)` returns the in-memory
 *     value when present, the default otherwise. Initial render on
 *     a cold cache returns the default; the cache fetch fires on
 *     mount and triggers a re-render once it lands.
 *   - The first hook invocation kicks off the fetch; concurrent
 *     mounts share the same in-flight promise.
 *   - Setters are fire-and-forget — they update the cache
 *     synchronously and dispatch the RPC; the server's debounced
 *     write means rapid toggles coalesce.
 */

type SettingValue = unknown;
let cache: Map<string, SettingValue> | null = null;
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

function ensureHydration(socket: ReturnType<typeof useSocket>): Promise<void> {
  if (cache) return Promise.resolve();
  if (hydrating) return hydrating;
  hydrating = socket
    .request('getStudioUserSettings', {})
    .then((r) => {
      cache = new Map(Object.entries(r.entries));
      hydrating = null;
      notify();
    })
    .catch((err: unknown) => {
      console.warn(
        '[studioUserSettings] hydrate failed:',
        (err as Error).message,
      );
      cache = new Map();
      hydrating = null;
      notify();
    });
  return hydrating;
}

/**
 * Cross-tab sync. The server broadcasts a `studioUserSettings:changed`
 * message after every successful `setStudioUserSetting` so a second
 * studio window stays in lockstep with the first. Wired here once at
 * module load; consumers don't have to do anything.
 */
let crossTabWired = false;
function wireCrossTab(): void {
  if (crossTabWired) return;
  crossTabWired = true;
  onCustomMessage((msg) => {
    if (msg.type !== 'studioUserSettings:changed') return;
    const key = msg.key as string | undefined;
    const value = msg.value;
    if (!cache || typeof key !== 'string') return;
    if (value === null || value === undefined) cache.delete(key);
    else cache.set(key, value);
    notify();
  });
}

/**
 * Sync read. Returns `undefined` before the cache hydrates — pair
 * with a default at the call site, or use `useStudioUserSetting`
 * which re-renders once hydration lands.
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- T is a caller-supplied cast for the untyped settings cache (e.g. `<boolean>`); part of the public API and used by external call sites.
export function getStudioUserSettingSync<T = SettingValue>(
  key: string,
): T | undefined {
  return cache?.get(key) as T | undefined;
}

/**
 * Async write. Updates the in-memory cache immediately so subsequent
 * sync reads see the new value, then dispatches the RPC. Errors are
 * swallowed — the local cache still reflects the user's intent and
 * the next reconnect will replay the value.
 */
export function setStudioUserSetting(
  socket: ReturnType<typeof useSocket>,
  key: string,
  value: SettingValue,
): void {
  cache ??= new Map();
  if (value === undefined || value === null) cache.delete(key);
  else cache.set(key, value);
  notify();
  socket
    .request('setStudioUserSetting', { key, value: value ?? null })
    .catch((err: unknown) => {
      console.warn(
        '[studioUserSettings] write failed:',
        (err as Error).message,
      );
    });
}

/**
 * Subscribe-style hook. Returns the current value (or the default
 * when the cache hasn't hydrated or the key is unset) and a setter
 * that writes through to disk.
 */
export function useStudioUserSetting<T extends SettingValue>(
  key: string,
  defaultValue: T,
): [T, (next: T) => void] {
  const socket = useSocket();
  useEffect(() => {
    wireCrossTab();
    void ensureHydration(socket);
  }, [socket]);
  const subscribe = useCallback((onChange: () => void) => {
    subscribers.add(onChange);
    return () => {
      subscribers.delete(onChange);
    };
  }, []);
  const getSnapshot = useCallback(() => {
    return (cache?.get(key) as T | undefined) ?? defaultValue;
  }, [key, defaultValue]);
  const value = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const set = useCallback(
    (next: T) => {
      setStudioUserSetting(socket, key, next);
    },
    [key, socket],
  );
  return [value, set];
}

/**
 * Imperative read hook for the rare call sites that need a value
 * once at mount but don't want to subscribe for updates (e.g.
 * `Editor.tsx` peeking at the global default model when starting a
 * fresh session). Triggers hydration on mount; the returned promise
 * resolves once the cache is ready.
 */
export function useEnsureStudioUserSettingsLoaded(): void {
  const socket = useSocket();
  useEffect(() => {
    wireCrossTab();
    void ensureHydration(socket);
  }, [socket]);
}

/**
 * Returns `true` once the settings cache has hydrated from disk
 * (success OR failure — see the catch branch of `ensureHydration`,
 * which installs an empty cache so consumers don't wait forever on
 * an offline socket). Pair with `useStudioUserSetting` when a
 * consumer needs to distinguish "default returned because cache
 * isn't loaded yet" from "default is the real persisted value".
 */
export function useStudioUserSettingsHydrated(): boolean {
  const socket = useSocket();
  useEffect(() => {
    wireCrossTab();
    void ensureHydration(socket);
  }, [socket]);
  const subscribe = useCallback((onChange: () => void) => {
    subscribers.add(onChange);
    return () => {
      subscribers.delete(onChange);
    };
  }, []);
  const getSnapshot = useCallback(() => cache !== null, []);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
