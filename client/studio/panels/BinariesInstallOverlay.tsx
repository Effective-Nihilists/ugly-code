/**
 * Blocks the page while the desktop shell installs the bundled tools this app
 * needs (node / pnpm / git / …). The shell broadcasts per-tool progress via
 * `window.electronAPI.onBinariesProgress` (phase: download → extract → done, or
 * `failed`). Nothing consumed that event before, so the page ran UN-blocked and a
 * slow or failed install was invisible — the user saw "started but nothing shows".
 * This overlay pauses the page and shows exactly what it's waiting on.
 */
import { useEffect, useState, type ReactElement } from 'react';
import { Check, AlertTriangle, RotateCw, Wrench } from 'lucide-react';
import { computeInstallOverlay, type ToolState } from './binariesInstallState';

const LABEL: Record<string, string> = {
  download: 'Downloading',
  extract: 'Extracting',
  done: 'Ready',
  failed: 'Failed',
};

// Calmer palette than the old garish orange-on-brown. Amber accent for active
// work, green for done, red for failure — against a near-black card.
const C = {
  accent: '#e8913c',
  accentDim: '#7a5a34',
  ok: '#4ade80',
  bad: '#f87171',
  ink: '#f3ede1',
  sub: '#a99b83',
  faint: '#6b5f4c',
  track: '#100c07',
  border: '#3a2f22',
} as const;

interface ElectronApi {
  onBinariesProgress?: (
    cb: (e: {
      origin: string;
      name: string;
      phase: string;
      pct: number;
    }) => void,
  ) => () => void;
}

// One-time keyframes for the header spinner, id-guarded so re-mounts don't stack
// <style> tags and so it can't clash with the host page's stylesheet.
const SPIN_CSS = '@keyframes uglyBinSpin{to{transform:rotate(360deg)}}';

export default function BinariesInstallOverlay(): ReactElement | null {
  const [tools, setTools] = useState<Record<string, ToolState>>({});
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const api = (window as unknown as { electronAPI?: ElectronApi })
      .electronAPI;
    if (!api?.onBinariesProgress) return;
    return api.onBinariesProgress((e) => {
      setDismissed(false);
      setTools((prev) => ({
        ...prev,
        [e.name]: { phase: e.phase, pct: e.pct },
      }));
    });
  }, []);

  const entries = Object.entries(tools);
  const { failed, allDone, visible } = computeInstallOverlay(tools, dismissed);
  const readyCount = entries.filter(([, t]) => t.phase === 'done').length;

  // Clear shortly after every tool has finished successfully.
  useEffect(() => {
    if (allDone) {
      const id = setTimeout(() => {
        setTools({});
      }, 700);
      return () => {
        clearTimeout(id);
      };
    }
    return undefined;
  }, [allDone]);

  if (!visible) return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100000,
        background: 'rgba(12, 10, 6, 0.62)',
        backdropFilter: 'blur(4px)',
        WebkitBackdropFilter: 'blur(4px)',
        display: 'grid',
        placeItems: 'center',
        // Block all interaction with the page underneath.
        pointerEvents: 'all',
      }}
    >
      <style>{SPIN_CSS}</style>
      <div
        style={{
          width: 400,
          maxWidth: '90vw',
          background: 'linear-gradient(180deg, #1b1610, #141009)',
          border: `1px solid ${C.border}`,
          borderRadius: 14,
          padding: '20px 20px 18px',
          color: C.ink,
          boxShadow:
            '0 28px 70px -22px rgba(0,0,0,.8), inset 0 1px 0 rgba(255,255,255,.03)',
          // System UI for prose; tool NAMES stay monospace (they're identifiers).
          fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
        }}
      >
        {/* Header: icon + title + at-a-glance count */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
          <div
            style={{
              display: 'grid',
              placeItems: 'center',
              width: 30,
              height: 30,
              borderRadius: 8,
              flexShrink: 0,
              background: failed
                ? 'rgba(248,113,113,.12)'
                : 'rgba(232,145,60,.12)',
              border: `1px solid ${failed ? 'rgba(248,113,113,.3)' : 'rgba(232,145,60,.3)'}`,
            }}
          >
            {failed ? (
              <AlertTriangle size={16} color={C.bad} />
            ) : (
              <Wrench
                size={15}
                color={C.accent}
                style={{ animation: 'uglyBinSpin 2.4s linear infinite' }}
              />
            )}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 14.5,
                fontWeight: 650,
                letterSpacing: '-0.01em',
              }}
            >
              {failed ? 'Tool install failed' : 'Setting up tools'}
            </div>
            <div
              style={{
                fontSize: 11.5,
                color: C.sub,
                marginTop: 2,
                lineHeight: 1.35,
              }}
            >
              {failed
                ? 'Some tools could not be installed — check your connection.'
                : 'This page is paused until its tools finish downloading.'}
            </div>
          </div>
          {entries.length > 0 && (
            <div
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: C.sub,
                fontVariantNumeric: 'tabular-nums',
                flexShrink: 0,
                alignSelf: 'flex-start',
              }}
            >
              {readyCount}/{entries.length}
            </div>
          )}
        </div>

        {/* Per-tool rows */}
        <div
          style={{
            marginTop: 16,
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          {entries.map(([name, t]) => {
            const isDone = t.phase === 'done';
            const isFailed = t.phase === 'failed';
            const barColor = isFailed ? C.bad : isDone ? C.ok : C.accent;
            return (
              <div
                key={name}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 11,
                  // Dim finished rows so the eye lands on what's still pending.
                  opacity: isDone ? 0.5 : 1,
                  transition: 'opacity .3s ease',
                }}
              >
                <div
                  style={{
                    width: 78,
                    fontSize: 12,
                    fontWeight: 600,
                    fontFamily:
                      'ui-monospace, SFMono-Regular, Menlo, monospace',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {name}
                </div>
                <div
                  style={{
                    flex: 1,
                    height: 6,
                    borderRadius: 4,
                    background: C.track,
                    overflow: 'hidden',
                    boxShadow: `inset 0 0 0 1px ${C.border}`,
                  }}
                >
                  <div
                    style={{
                      height: '100%',
                      width: `${isFailed ? 100 : Math.max(0, Math.min(100, t.pct))}%`,
                      transition: 'width .3s ease',
                      background: barColor,
                      opacity: isFailed ? 0.35 : 1,
                    }}
                  />
                </div>
                <div
                  style={{
                    width: 68,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'flex-end',
                    gap: 5,
                    fontSize: 10,
                    letterSpacing: '.05em',
                    textTransform: 'uppercase',
                    fontWeight: 600,
                    color: isFailed ? C.bad : isDone ? C.ok : C.sub,
                  }}
                >
                  {isDone ? (
                    <Check size={13} color={C.ok} />
                  ) : isFailed ? (
                    <>
                      <AlertTriangle size={11} color={C.bad} />
                      <span>Failed</span>
                    </>
                  ) : t.phase === 'download' ? (
                    <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                      {Math.round(t.pct)}%
                    </span>
                  ) : (
                    <span>{LABEL[t.phase] ?? t.phase}</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Failed → offer a real Retry (reload re-runs the grant → re-download) + Dismiss */}
        {failed && (
          <div style={{ marginTop: 16, display: 'flex', gap: 9 }}>
            <button
              type="button"
              onClick={() => {
                window.location.reload();
              }}
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 7,
                padding: '9px 10px',
                borderRadius: 9,
                border: 'none',
                background: C.accent,
                color: '#1a1206',
                cursor: 'pointer',
                fontSize: 12.5,
                fontWeight: 700,
              }}
              data-id="retry"
            >
              <RotateCw size={13} />
              Retry
            </button>
            <button
              type="button"
              onClick={() => {
                setDismissed(true);
              }}
              style={{
                flex: 1,
                padding: '9px 10px',
                borderRadius: 9,
                border: `1px solid ${C.border}`,
                background: 'transparent',
                color: C.sub,
                cursor: 'pointer',
                fontSize: 12.5,
                fontWeight: 600,
              }}
              data-id="dismiss"
            >
              Dismiss
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
