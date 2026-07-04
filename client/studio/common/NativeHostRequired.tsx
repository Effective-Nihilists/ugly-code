import React from 'react';
import { MonitorSmartphone } from 'lucide-react';

/**
 * A clear notice shown when a panel needs the native host (Ugly Studio desktop
 * app) but the studio is running in a plain web browser — where `process.spawn`,
 * local Postgres, and the codebase indexer are unavailable (they'd throw
 * "[UglyNative] channel … requires a native shell").
 *
 * Without this, those panels failed SILENTLY — a blank preview, an empty database
 * list, an eternal "Codebase: loading…" — with no hint that the real problem is
 * "no native host". Callers gate on `isNativeAvailable()` and render this instead.
 */
export function NativeHostRequired({ feature }: { feature: string }): React.ReactElement {
  return (
    <div
      data-id="native-host-required"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        height: '100%',
        minHeight: 160,
        padding: 24,
        textAlign: 'center',
        color: 'var(--text-muted)',
        fontFamily: 'var(--font-sans, system-ui)',
      }}
    >
      <MonitorSmartphone size={30} style={{ opacity: 0.7 }} />
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
        {feature} needs the desktop app
      </div>
      <div style={{ fontSize: 12.5, lineHeight: 1.5, maxWidth: 380 }}>
        This runs on your machine, so it needs the <strong>Ugly Studio desktop app</strong> (or a
        browser connected to a running desktop host). A plain browser tab can’t start a local dev
        server, database, or codebase index. Open this project in Ugly Studio to continue.
      </div>
    </div>
  );
}
