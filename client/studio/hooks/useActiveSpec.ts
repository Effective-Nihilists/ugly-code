import { useEffect, useState } from 'react';
import { onCustomMessage, useSocket } from './useSocket';

export interface ActiveSpec {
  id: string;
  title: string;
}

/**
 * Tracks the currently-active spec (what the user is viewing in the
 * Specs tab, or whatever the agent's `spec_create` / `spec_active`
 * tool last touched). Seeds once via `getActiveSpec`, then listens
 * on the shared WebSocket for `activeSpec:changed` broadcasts from
 * the sidecar so updates land without polling.
 */
export function useActiveSpec(): ActiveSpec | null {
  const socket = useSocket();
  const [spec, setSpec] = useState<ActiveSpec | null>(null);

  useEffect(() => {
    let cancelled = false;
    socket
      .request('getActiveSpec', {})
      .then((res) => {
        if (!cancelled) setSpec(res.spec);
      })
      .catch(() => {
        /* not connected yet — the ws message will fill it in */
      });

    const off = onCustomMessage((msg) => {
      if (msg.type !== 'activeSpec:changed') return;
      const next = msg.spec as ActiveSpec | null | undefined;
      setSpec(next ?? null);
    });

    return () => {
      cancelled = true;
      off();
    };
  }, [socket]);

  return spec;
}
