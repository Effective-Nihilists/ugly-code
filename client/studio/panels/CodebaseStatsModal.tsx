// Detailed codebase-analysis stats, opened by clicking the header's
// "Codebase: …" pill.
//
// Why this polls on its own: `startCodebasePoll` (agent/codebaseReadiness.ts)
// self-stops the moment the indexer + architecture both settle, and it only
// pushes through `session_state`. A modal opened after that would freeze on the
// last pushed reading, and while indexing it would tick at the poll's 3s. So the
// modal drives its own 1s read of `codebase.status` and stops when settled.
import React from 'react';
import { installUglyNative, isNativeAvailable } from 'ugly-app/native';
import { Modal } from '../system/modal/Modal';
import { getActiveProjectPath } from '../projectPath';
import { CodebaseReadinessSchema } from '../shared/api';

type Readiness = import('../shared/api').SessionSnapshot['codebaseReadiness'];

const POLL_MS = 1000;

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

async function readStatus(projectPath: string): Promise<Readiness | null> {
  const raw = await installUglyNative().invoke(
    'codebase.status' as never,
    { projectPath } as never,
  );
  const parsed = CodebaseReadinessSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

// ── Small presentational pieces ──────────────────────────────────────────────

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, padding: '5px 0' }}>
      <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{label}</span>
      <span style={{ color: 'var(--text-primary)', fontSize: 12, fontFamily: 'var(--font-mono, monospace)' }}>
        {value}
      </span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
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
        style={{ flex: 1, height: 6, background: 'var(--bg-secondary)', border: '1px solid var(--border)', overflow: 'hidden' }}
        role="progressbar"
        aria-valuenow={Math.round(clamped)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div style={{ width: `${clamped}%`, height: '100%', background: 'var(--accent, #f0a000)', transition: 'width 300ms linear' }} />
      </div>
      <span style={{ fontSize: 12, fontFamily: 'var(--font-mono, monospace)', color: 'var(--text-primary)', minWidth: 40, textAlign: 'right' }}>
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
              color: now ? 'var(--accent, #f0a000)' : done ? 'var(--text-primary)' : 'var(--text-muted)',
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
  const [live, setLive] = React.useState<Readiness | null>(seed ?? null);

  // Re-seed whenever the session pushes a fresher reading than we hold.
  React.useEffect(() => {
    if (seed) setLive(seed);
  }, [seed]);

  React.useEffect(() => {
    if (!open || nativeMissing) return;
    const projectPath = getActiveProjectPath();
    if (!projectPath) return;

    // Held in an object so `tick` (defined before the interval exists) can clear
    // it. Safe: `tick` awaits before reaching `stop()`, so the synchronous
    // `run.id = setInterval(...)` below has always executed by then.
    const run: {
      id: ReturnType<typeof setInterval> | undefined;
      cancelled: boolean;
    } = { id: undefined, cancelled: false };

    const stop = (): void => {
      if (run.id !== undefined) {
        clearInterval(run.id);
        run.id = undefined;
      }
    };

    const tick = async (): Promise<void> => {
      try {
        const r = await readStatus(projectPath);
        if (run.cancelled || !r) return;
        setLive(r);
        const idx = r.indexer.status;
        const arch = r.architecture.status;
        const settled =
          (idx === 'ready' || idx === 'error') &&
          (arch === 'ready' || arch === 'failed' || arch === 'idle');
        // Stop once nothing can change again — no point holding a 1s timer open
        // behind an idle modal.
        if (settled) stop();
      } catch {
        /* daemon spinning up / transient forwarding blip — keep polling */
      }
    };

    void tick();
    run.id = setInterval(() => void tick(), POLL_MS);
    return () => {
      run.cancelled = true;
      stop();
    };
  }, [open, nativeMissing]);

  const indexer = live?.indexer;
  const arch = live?.architecture;
  const diagnostics = live?.diagnostics;

  const pct = (() => {
    if (!indexer) return 0;
    if (indexer.status === 'ready') return 100;
    if (indexer.totalChunks) return ((indexer.indexedChunks ?? 0) / indexer.totalChunks) * 100;
    if (indexer.totalFiles) return ((indexer.indexedFiles ?? 0) / indexer.totalFiles) * 100;
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
    arch?.error,
  ].some((v) => typeof v === 'string' && v.length > 0);

  const pctKnown = indexer?.status === 'ready' || !noProgressYet;

  return (
    <Modal open={open} onClose={onClose} size="md" ariaLabel="Codebase analysis">
      <Modal.Header>Codebase analysis</Modal.Header>
      <Modal.Body>
        {nativeMissing ? (
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, margin: 0 }}>
            Codebase analysis runs on your machine. Open this project in the Ugly Studio desktop
            app to enable semantic search and architecture-aware answers — a browser tab has no
            host to run the indexer.
          </p>
        ) : !live ? (
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, margin: 0 }}>
            The host indexer is starting up. On first use it downloads a Python runtime and an
            embedding model, which can take a few minutes.
          </p>
        ) : (
          <>
            <Section title="Semantic index">
              {daemonDown ? (
                <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, margin: '0 0 4px' }}>
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
              <Row label="Status" value={daemonDown ? 'starting' : indexer?.status ?? '—'} />
              {!!indexer?.totalFiles && (
                <Row label="Files" value={`${indexer.indexedFiles ?? 0} / ${indexer.totalFiles}`} />
              )}
              {!!indexer?.totalChunks && (
                <Row label="Chunks" value={`${indexer.indexedChunks ?? 0} / ${indexer.totalChunks}`} />
              )}
              {/* Rates and ETA only exist once embedding has started. Rendering
                  four "—" rows next to an "estimating…" was the bulk of the
                  modal's empty-looking body. */}
              {indexer?.filesPerSec != null && (
                <Row label="Files / sec" value={fmtRate(indexer.filesPerSec, 'files')} />
              )}
              {indexer?.chunksPerSec != null && (
                <Row label="Chunks / sec" value={fmtRate(indexer.chunksPerSec, 'chunks')} />
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
                <Row label="Elapsed" value={fmtDuration(indexer.elapsedSeconds)} />
              )}
            </Section>

            <Section title="Architecture map">
              <Row label="Status" value={arch?.status ?? '—'} />
              {arch?.filesTotal ? (
                <Row label="Files analyzed" value={`${arch.filesAnalyzed ?? 0} / ${arch.filesTotal}`} />
              ) : null}
              {arch?.lastWrittenAt ? (
                <Row label="Last written" value={new Date(arch.lastWrittenAt).toLocaleString()} />
              ) : null}
            </Section>

            {hasDiagnostics && (
              <Section title="Diagnostics">
                {daemonMessage && !daemonDown && (
                  <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '0 0 8px' }}>
                    {daemonMessage}
                  </p>
                )}
                {indexer?.error && (
                  <p style={{ fontSize: 12, color: '#e53935', margin: '0 0 8px' }}>{indexer.error}</p>
                )}
                {arch?.error && (
                  <p style={{ fontSize: 12, color: '#e53935', margin: '0 0 8px' }}>{arch.error}</p>
                )}
                {diagnostics?.lastError && (
                  <p style={{ fontSize: 12, color: '#e53935', margin: '0 0 8px' }}>
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
