import { useEffect, useState } from 'react';

const electronAPI = (
  window as unknown as {
    electronAPI?: { getAppVersion?(): Promise<string> };
  }
).electronAPI;

/**
 * Bottom manifesto bar shared by every top-level studio panel
 * (login, project home, onboarding). Keeping the layout in one
 * place avoids the wrap/gap/version drift that crept in when each
 * panel inlined its own copy.
 */
export function ManifestoFooter(): React.ReactElement {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    void electronAPI?.getAppVersion?.().then(setVersion);
  }, []);

  return (
    <footer
      style={{
        flexShrink: 0,
        borderTop: '1px solid var(--border)',
        padding: '22px 40px',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        fontFamily: 'var(--font-label)',
        fontSize: 11,
        letterSpacing: '0.2em',
        textTransform: 'uppercase',
        color: 'var(--text-muted)',
        fontWeight: 600,
        flexWrap: 'wrap',
        gap: 14,
        background: 'var(--bg-primary)',
      }}
    >
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        <span style={{ color: 'var(--text-primary)' }}>One engineer.</span>
        <span>No investors.</span>
        <span>No sugarcoating.</span>
      </div>
      <div style={{ opacity: 0.7 }}>
        ugly.bot/studio{version ? ` · v${version}` : ''}
      </div>
    </footer>
  );
}
