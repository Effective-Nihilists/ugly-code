// Recent-projects list — synced across all of the user's devices and sessions
// via the `recentProject` collection (trackDocs), replacing the old per-browser
// localStorage list. Each row is stamped with the desktop (`deviceId` +
// `deviceLabel`) that physically holds the files, so a phone can reconnect to the
// right host. Recording happens only on a desktop (where `proxy.self` resolves) —
// a phone/web client has no local filesystem to host, so it only reads the list.

import { useEffect, useState } from 'react';
import { useAppOptional } from 'ugly-app/client';
import { installUglyNative, isNativeAvailable } from 'ugly-app/native';
import type { RecentProject } from '../../../shared/collections';

export type { RecentProject };

// Minimal structural view of the app socket for the calls we make. The context
// socket from useApp() is typed to framework requests only; recordRecentProject /
// removeRecentProject are app-specific, and trackDocs is a runtime method — so we
// reach them through this narrow interface rather than fighting the registry type.
interface RecentSocket {
  request(name: string, input: unknown): Promise<unknown>;
  trackDocs(
    collection: string,
    params: { keys?: Record<string, string> },
    cb: (docs: unknown[]) => void,
  ): () => void;
}

/** This device's stable proxy identity, or null off a native desktop host. */
async function selfDevice(): Promise<{
  deviceId: string;
  deviceLabel: string;
} | null> {
  if (!isNativeAvailable()) return null;
  try {
    // proxy.self rides the low-level UglyNative protocol (not the high-level
    // facade). Cast the invoke: the channel may predate the installed ugly-app's
    // typed contract, and resolves to null off a desktop host anyway.
    const native = installUglyNative();
    const invoke = (channel: string, payload?: unknown): Promise<unknown> =>
      (
        native.invoke as (
          channel: string,
          payload?: unknown,
        ) => Promise<unknown>
      )(channel, payload);
    const r = await invoke('proxy.self');
    if (r && typeof r === 'object') {
      const o = r as { deviceId?: unknown; deviceLabel?: unknown };
      if (typeof o.deviceId === 'string' && o.deviceId) {
        return {
          deviceId: o.deviceId,
          deviceLabel: typeof o.deviceLabel === 'string' ? o.deviceLabel : '',
        };
      }
    }
  } catch {
    /* not a desktop host, or channel unavailable (older shell) — nothing to stamp */
  }
  return null;
}

/**
 * Record (or bump) a recently-opened project for the current user. No-op on a
 * client that isn't a desktop host (the phone reads recents but never creates
 * them). Best-effort: never throws into the open flow.
 */
export async function recordRecentProject(
  socket: unknown,
  name: string,
  path: string,
): Promise<void> {
  if (!socket || !path) return;
  const self = await selfDevice();
  if (!self) return;
  try {
    await (socket as RecentSocket).request('recordRecentProject', {
      deviceId: self.deviceId,
      deviceLabel: self.deviceLabel,
      path,
      name,
    });
  } catch {
    /* recents are best-effort */
  }
}

/**
 * Ask the native proxy layer to (re)connect to a specific desktop host before
 * opening one of its projects. Dispatched as a plain `uglyNative` DOM event, so
 * it needs no proxy import and is simply ignored where no proxy client is
 * installed (e.g. on the desktop itself, where the files are already local, or
 * on an older shell). Best-effort — the open still falls back to the host picker.
 */
export function connectToHost(deviceId: string, label?: string): void {
  if (
    !deviceId ||
    typeof window === 'undefined' ||
    typeof CustomEvent !== 'function'
  )
    return;
  try {
    window.dispatchEvent(
      new CustomEvent('uglyNative', {
        detail: { event: 'proxy:connect', data: { deviceId, label } },
      }),
    );
  } catch {
    /* best-effort */
  }
}

/** Remove a recent project by its synced doc id (the ProjectRow delete button). */
export async function removeRecentProject(
  socket: unknown,
  id: string,
): Promise<void> {
  if (!socket || !id) return;
  try {
    await (socket as RecentSocket).request('removeRecentProject', { id });
  } catch {
    /* best-effort */
  }
}

/**
 * Live, cross-device recent-projects list, most-recent first. Empty until the
 * socket connects (and for logged-out users). Driven by trackDocs, so a project
 * opened on any of the user's desktops appears here within a frame.
 */
export function useRecentProjects(): RecentProject[] {
  const app = useAppOptional();
  const [projects, setProjects] = useState<RecentProject[]>([]);
  useEffect(() => {
    if (!app) return;
    const { socket, userId } = app;
    const unsub = (socket as unknown as RecentSocket).trackDocs(
      'recentProject',
      { keys: { userId } },
      (docs) => {
        const rows = docs as RecentProject[];
        setProjects([...rows].sort((a, b) => b.lastOpened - a.lastOpened));
      },
    );
    return unsub;
  }, [app]);
  return projects;
}

/**
 * True when the project at `path` physically lives on THIS computer — i.e. a
 * recent-projects row matches the path and is stamped with this device's id. Used
 * to gate "Open in Finder" (revealing a remote host's folder would open Finder on
 * a machine the user isn't sitting at). Returns false while the device id is still
 * resolving or when `path` isn't a known recent project.
 */
export function useIsLocalProject(path: string | null): boolean {
  const selfDeviceId = useSelfDeviceId();
  const projects = useRecentProjects();
  if (!path || !selfDeviceId) return false;
  const match = projects.find((p) => p.path === path);
  return !!match && match.deviceId === selfDeviceId;
}

/** This desktop's deviceId (or null on web/phone), for the "This device" badge. */
export function useSelfDeviceId(): string | null {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void selfDevice().then((s) => {
      if (!cancelled) setId(s?.deviceId ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return id;
}
