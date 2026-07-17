// Detailed codebase-analysis stats, opened by clicking the header's
// "Codebase: …" pill.
//
// Data comes from the live `seed` prop — the readiness the coding task streams
// through `session_state` from its own poll (now backed by the LOCAL indexer, so
// diagnostics + self-heal ship with a deploy). It deliberately does NOT poll the
// host `codebase.status` channel itself: on an installed Studio that is the
// pre-fix code and shows an empty Diagnostics box.
import React from 'react';
import { isNativeAvailable } from 'ugly-app/native';
import { Modal } from '../system/modal/Modal';

type Readiness = import('../shared/api').SessionSnapshot['codebaseReadiness'];

/** The daemon's phases, in the order it walks them. */
const PHASES = ['scanning', 'chunking', 'embedding', 'committing'] as const;
type Phase = (typeof PHASES)[number];

const PHASE_LABEL: Record<Phase, string> = {
  scanning: 'Scanning',
  chunking: 'Chunking',
  embedding: 'Embedding',
  committing: 'Committing',
};

function fmtDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}m ${String(rem).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

function fmtRate(n: number | undefined, unit: string): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${n >= 10 ? n.toFixed(0) : n.toFixed(1)}/s ${unit}`;
}

// ── Small presentational pieces ──────────────────────────────────────────────

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        gap: 16,
        padding: '5px 0',
      }}
    >
      <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{label}</span>
      <span
        style={{
          color: 'var(--text-primary)',
          fontSize: 12,
          fontFamily: 'var(--font-mono, monospace)',
        }}
      >
        {value}
      </span>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div
        style={{
          fontFamily: 'var(--font-label)',
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--text-secondary)',
          marginBottom: 6,
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function ProgressBar({ pct }: { pct: number }) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <div
        style={{
          flex: 1,
          height: 6,
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border)',
          overflow: 'hidden',
        }}
        role="progressbar"
        aria-valuenow={Math.round(clamped)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          style={{
            width: `${clamped}%`,
            height: '100%',
            background: 'var(--accent, #f0a000)',
            transition: 'width 300ms linear',
          }}
        />
      </div>
      <span
        style={{
          fontSize: 12,
          fontFamily: 'var(--font-mono, monospace)',
          color: 'var(--text-primary)',
          minWidth: 40,
          textAlign: 'right',
        }}
      >
        {clamped.toFixed(0)}%
      </span>
    </div>
  );
}

function PhaseStepper({ active }: { active: Phase | undefined }) {
  const idx = active ? PHASES.indexOf(active) : -1;
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {PHASES.map((p, i) => {
        const done = idx > i;
        const now = idx === i;
        return (
          <span
            key={p}
            style={{
              fontSize: 11,
              padding: '3px 9px',
              border: '1px solid var(--border)',
              borderColor: now ? 'var(--accent, #f0a000)' : 'var(--border)',
              color: now
                ? 'var(--accent, #f0a000)'
                : done
                  ? 'var(--text-primary)'
                  : 'var(--text-muted)',
              opacity: idx === -1 ? 0.5 : 1,
              whiteSpace: 'nowrap',
            }}
          >
            {done ? '✓ ' : ''}
            {PHASE_LABEL[p]}
          </span>
        );
      })}
    </div>
  );
}

// ── Modal ────────────────────────────────────────────────────────────────────

export function CodebaseStatsModal({
  open,
  onClose,
  seed,
}: {
  open: boolean;
  onClose: () => void;
  /** Last reading from the session stream, so the modal paints instantly. */
  seed: Readiness | null;
}): React.ReactElement {
  const nativeMissing = !isNativeAvailable();
  // Reflect the live `seed` — the readiness the coding task streams from its own
  // poll (now backed by the LOCAL indexer, so its diagnostics + self-heal ship
  // with a deploy). No independent poll here: the previous one hit the host
  // `codebase.status` channel directly, which on an installed Studio is the
  // pre-fix code and shows an empty Diagnostics box. The task poll runs (and
  // keeps emitting) as long as the index is unsettled — i.e. exactly while a
  // daemon is down or busy — which is when this modal has anything to say.
  const live = seed ?? null;

  const indexer = live?.indexer;
  const diagnostics = live?.diagnostics;

  const pct = (() => {
    if (!indexer) return 0;
    if (indexer.status === 'ready') return 100;
    if (indexer.totalChunks)
      return ((indexer.indexedChunks ?? 0) / indexer.totalChunks) * 100;
    if (indexer.totalFiles)
      return ((indexer.indexedFiles ?? 0) / indexer.totalFiles) * 100;
    return 0;
  })();

  // The daemon is down / starting when the host couldn't read a status at all.
  // It reports that as `status: 'indexing'` with no counts, which is otherwise
  // indistinguishable from a healthy daemon mid-index — so key off the message
  // the host now sends, not off the status.
  const daemonMessage = diagnostics?.message;
  const noProgressYet = !indexer?.totalChunks && !indexer?.totalFiles;
  const daemonDown = !!daemonMessage && noProgressYet;

  // Only render the diagnostics block when it actually contains something. It
  // used to appear (empty) merely because `diagnostics` existed.
  // Note `||` is deliberate in spirit but expressed field-by-field: every value
  // here is a string, and an EMPTY string must count as "nothing to show".
  const hasDiagnostics = [
    daemonMessage,
    diagnostics?.lastError,
    diagnostics?.logTail?.trim(),
    indexer?.error,
  ].some((v) => typeof v === 'string' && v.length > 0);

  const pctKnown = indexer?.status === 'ready' || !noProgressYet;

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="md"
      ariaLabel="Codebase analysis"
    >
      <Modal.Header>Codebase analysis</Modal.Header>
      <Modal.Body>
        {nativeMissing ? (
          <p
            style={{
              fontSize: 13,
              color: 'var(--text-secondary)',
              lineHeight: 1.6,
              margin: 0,
            }}
          >
            Codebase analysis runs on your machine. Open this project in the
            Ugly Studio desktop app to enable semantic search — a browser tab
            has no host to run the indexer.
          </p>
        ) : !live ? (
          <p
            style={{
              fontSize: 13,
              color: 'var(--text-secondary)',
              lineHeight: 1.6,
              margin: 0,
            }}
          >
            The host indexer is starting up. On first use it downloads a Python
            runtime and an embedding model, which can take a few minutes.
          </p>
        ) : (
          <>
            <Section title="Semantic index">
              {daemonDown ? (
                <p
                  style={{
                    fontSize: 13,
                    color: 'var(--text-secondary)',
                    lineHeight: 1.6,
                    margin: '0 0 4px',
                  }}
                >
                  {daemonMessage}
                </p>
              ) : (
                <>
                  {indexer?.phase && (
                    <div style={{ marginBottom: 10 }}>
                      <PhaseStepper active={indexer.phase} />
                    </div>
                  )}
                  {pctKnown && (
                    <div style={{ marginBottom: 10 }}>
                      <ProgressBar pct={pct} />
                    </div>
                  )}
                </>
              )}
              <Row
                label="Status"
                value={daemonDown ? 'starting' : (indexer?.status ?? '—')}
              />
              {!!indexer?.totalFiles && (
                <Row
                  label="Files"
                  value={`${indexer.indexedFiles ?? 0} / ${indexer.totalFiles}`}
                />
              )}
              {!!indexer?.totalChunks && (
                <Row
                  label="Chunks"
                  value={`${indexer.indexedChunks ?? 0} / ${indexer.totalChunks}`}
                />
              )}
              {/* Rates and ETA only exist once embedding has started. Rendering
                  four "—" rows next to an "estimating…" was the bulk of the
                  modal's empty-looking body. */}
              {indexer?.filesPerSec != null && (
                <Row
                  label="Files / sec"
                  value={fmtRate(indexer.filesPerSec, 'files')}
                />
              )}
              {indexer?.chunksPerSec != null && (
                <Row
                  label="Chunks / sec"
                  value={fmtRate(indexer.chunksPerSec, 'chunks')}
                />
              )}
              {(indexer?.status === 'ready' || indexer?.etaSeconds != null) && (
                <Row
                  label="Estimated finish"
                  value={
                    indexer.status === 'ready'
                      ? 'done'
                      : fmtDuration(indexer.etaSeconds ?? 0)
                  }
                />
              )}
              {indexer?.elapsedSeconds != null && (
                <Row
                  label="Elapsed"
                  value={fmtDuration(indexer.elapsedSeconds)}
                />
              )}
            </Section>

            {hasDiagnostics && (
              <Section title="Diagnostics">
                {daemonMessage && !daemonDown && (
                  <p
                    style={{
                      fontSize: 12,
                      color: 'var(--text-secondary)',
                      margin: '0 0 8px',
                    }}
                  >
                    {daemonMessage}
                  </p>
                )}
                {indexer?.error && (
                  <p
                    style={{
                      fontSize: 12,
                      color: '#e53935',
                      margin: '0 0 8px',
                    }}
                  >
                    {indexer.error}
                  </p>
                )}
                {diagnostics?.lastError && (
                  <p
                    style={{
                      fontSize: 12,
                      color: '#e53935',
                      margin: '0 0 8px',
                    }}
                  >
                    {diagnostics.lastError}
                  </p>
                )}
                {diagnostics?.logTail && (
                  <pre
                    style={{
                      fontSize: 11,
                      fontFamily: 'var(--font-mono, monospace)',
                      background: 'var(--bg-secondary)',
                      border: '1px solid var(--border)',
                      padding: 10,
                      maxHeight: 220,
                      overflow: 'auto',
                      whiteSpace: 'pre-wrap',
                      margin: 0,
                      color: 'var(--text-secondary)',
                    }}
                  >
                    {diagnostics.logTail}
                  </pre>
                )}
              </Section>
            )}
          </>
        )}
      </Modal.Body>
    </Modal>
  );
}
