import React from 'react';
import { MonitorSmartphone } from 'lucide-react';
import { useAppOptional } from 'ugly-app/client';

/**
 * Shown when a panel needs the native host but none is reachable — either the
 * studio is a plain browser tab, OR (the subtle one) a desktop Studio host IS
 * running but under a DIFFERENT ugly.bot account. `listHosts`/presence is
 * per-account, so a session signed in as account A can't see a host registered by
 * account B; process.spawn then throws "requires a native shell" and the panel
 * would otherwise fail silently (blank preview / empty DB / "Codebase: loading…").
 *
 * We surface the SESSION's account so an account mismatch is obvious: if the
 * desktop app on the machine is signed in as someone else, that's the problem.
 */
export function NativeHostRequired({
  feature,
}: {
  feature: string;
}): React.ReactElement {
  const app = useAppOptional();
  const account =
    (app?.user as { email?: string } | undefined)?.email ?? app?.userId ?? null;
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
      <div
        style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}
      >
        {feature} needs a connected host
      </div>
      <div style={{ fontSize: 12.5, lineHeight: 1.5, maxWidth: 400 }}>
        This runs on your machine, so it needs the{' '}
        <strong>Ugly Studio desktop app</strong> running and signed into{' '}
        <strong>the same ugly.bot account</strong> as this session. A host
        signed into a different account is invisible here — hosts are
        per-account.
      </div>
      {account && (
        <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
          This session is signed in as <strong>{account}</strong> — the desktop
          host must match.
        </div>
      )}
    </div>
  );
}
