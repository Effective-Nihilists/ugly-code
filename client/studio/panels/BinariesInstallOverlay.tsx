/**
 * Blocks the page while the desktop shell installs the bundled tools this app
 * needs (node / pnpm / git / …). The shell broadcasts per-tool progress via
 * `window.electronAPI.onBinariesProgress` (phase: download → extract → done, or
 * `failed`). Nothing consumed that event before, so the page ran UN-blocked and a
 * slow or failed install was invisible — the user saw "started but nothing shows".
 * This overlay pauses the page and shows exactly what it's waiting on.
 */
import { useEffect, useState, type ReactElement } from 'react';

interface ToolState {
  phase: string;
  pct: number;
}

const LABEL: Record<string, string> = {
  download: 'Downloading',
  extract: 'Extracting',
  done: 'Ready',
  failed: 'Failed',
};

type ElectronApi = {
  onBinariesProgress?: (
    cb: (e: { origin: string; name: string; phase: string; pct: number }) => void,
  ) => () => void;
};

export default function BinariesInstallOverlay(): ReactElement | null {
  const [tools, setTools] = useState<Record<string, ToolState>>({});
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const api = (window as unknown as { electronAPI?: ElectronApi }).electronAPI;
    if (!api?.onBinariesProgress) return;
    return api.onBinariesProgress((e) => {
      setDismissed(false);
      setTools((prev) => ({ ...prev, [e.name]: { phase: e.phase, pct: e.pct } }));
    });
  }, []);

  const entries = Object.entries(tools);
  const failed = entries.some(([, t]) => t.phase === 'failed');
  const installing = entries.some(([, t]) => t.phase !== 'done' && t.phase !== 'failed');

  // Clear shortly after every tool has finished successfully.
  useEffect(() => {
    if (entries.length > 0 && entries.every(([, t]) => t.phase === 'done')) {
      const id = setTimeout(() => setTools({}), 700);
      return () => clearTimeout(id);
    }
    return undefined;
  }, [tools]);

  if (dismissed || (!installing && !failed)) return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100000,
        background: 'rgba(15, 12, 8, 0.72)',
        backdropFilter: 'blur(3px)',
        display: 'grid',
        placeItems: 'center',
        // Block all interaction with the page underneath.
        pointerEvents: 'all',
      }}
    >
      <div
        style={{
          width: 380,
          maxWidth: '90vw',
          background: '#1c1710',
          border: '1px solid #473a2d',
          borderRadius: 12,
          padding: 18,
          color: '#e9e2d6',
          boxShadow: '0 24px 60px -20px rgba(0,0,0,.7)',
          fontFamily: 'ui-monospace, monospace',
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 800 }}>
          {failed ? 'Tool install failed' : 'Setting up tools…'}
        </div>
        <div style={{ fontSize: 11.5, color: '#9c8e76', marginTop: 4, lineHeight: 1.4 }}>
          {failed
            ? 'Some tools this app needs could not be installed (check your connection). Retry, or dismiss to continue without them.'
            : 'This page is paused until the tools it needs finish downloading.'}
        </div>
        <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 9 }}>
          {entries.map(([name, t]) => (
            <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ width: 92, fontSize: 12, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {name}
              </div>
              <div style={{ flex: 1, height: 7, borderRadius: 5, background: '#0f0c08', border: '1px solid #473a2d', overflow: 'hidden' }}>
                <div
                  style={{
                    height: '100%',
                    width: `${Math.max(0, Math.min(100, t.pct))}%`,
                    transition: 'width .25s ease',
                    background: t.phase === 'failed' ? '#ef4444' : t.phase === 'done' ? '#22c55e' : '#e8590c',
                  }}
                />
              </div>
              <div style={{ width: 74, textAlign: 'right', fontSize: 10, letterSpacing: '.06em', textTransform: 'uppercase', color: t.phase === 'failed' ? '#ef4444' : t.phase === 'done' ? '#22c55e' : '#9c8e76' }}>
                {LABEL[t.phase] ?? t.phase}
              </div>
            </div>
          ))}
        </div>
        {failed && (
          <button
            type="button"
            onClick={() => setDismissed(true)}
            style={{
              marginTop: 14,
              width: '100%',
              padding: '8px 10px',
              borderRadius: 8,
              border: '1px solid #473a2d',
              background: 'transparent',
              color: '#e9e2d6',
              cursor: 'pointer',
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            Dismiss
          </button>
        )}
      </div>
    </div>
  );
}
