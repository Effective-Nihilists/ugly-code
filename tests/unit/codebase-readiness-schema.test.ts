// Guards the strict-parse trap: CodebaseReadinessSchema drops unknown keys and
// REJECTS a reading missing a required key. Both failure modes are silent at
// runtime (the pill just never updates), so they're pinned here instead.
import { describe, expect, it } from 'vitest';
import { CodebaseReadinessSchema } from '../../client/studio/shared/api';

/** Shape emitted by ugly-studio's codebaseNative.ts `codebase.status`. */
const indexing = {
  indexer: {
    status: 'indexing',
    phase: 'embedding',
    indexedChunks: 600,
    totalChunks: 1000,
    indexedFiles: 120,
    totalFiles: 200,
    elapsedSeconds: 10.5,
    chunksPerSec: 50,
    filesPerSec: 10,
    etaSeconds: 8,
  },
  architecture: { status: 'building', filesAnalyzed: 12, filesTotal: 40 },
};

describe('CodebaseReadinessSchema', () => {
  it('parses a full indexing reading, preserving progress + rate + ETA', () => {
    const r = CodebaseReadinessSchema.safeParse(indexing);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.indexer.phase).toBe('embedding');
    expect(r.data.indexer.indexedFiles).toBe(120);
    expect(r.data.indexer.etaSeconds).toBe(8);
    expect(r.data.indexer.chunksPerSec).toBe(50);
  });

  it('accepts an OLDER host that emits none of the new fields', () => {
    // The whole point of making them .optional(): a Studio build predating the
    // status work must still drive the pill rather than failing the parse.
    const r = CodebaseReadinessSchema.safeParse({
      indexer: {
        status: 'ready',
        indexedChunks: 40,
        totalChunks: 40,
        totalFiles: 40,
      },
      architecture: { status: 'ready' },
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.indexer.phase).toBeUndefined();
    expect(r.data.indexer.etaSeconds).toBeUndefined();
  });

  it('surfaces daemon diagnostics instead of dropping them', () => {
    // This is why a stuck "Codebase: loading" never said why: the old schema had
    // no `diagnostics`, so the strict parse discarded the daemon's error blob.
    const r = CodebaseReadinessSchema.safeParse({
      indexer: { status: 'indexing' },
      architecture: { status: 'idle' },
      diagnostics: {
        lastError: 'uv pip install failed',
        logTail: 'Traceback...\nOSError',
      },
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.diagnostics?.lastError).toBe('uv pip install failed');
    expect(r.data.diagnostics?.logTail).toContain('OSError');
  });

  it('rejects an unknown indexer phase rather than silently coercing it', () => {
    const bad = {
      ...indexing,
      indexer: { ...indexing.indexer, phase: 'reticulating' },
    };
    expect(CodebaseReadinessSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a reading with no indexer status (the required key)', () => {
    const r = CodebaseReadinessSchema.safeParse({
      indexer: { indexedChunks: 1 },
      architecture: { status: 'ready' },
    });
    expect(r.success).toBe(false);
  });
});

describe('daemon-down payload (the real bug)', () => {
  // Captured verbatim from `routeCodebase('codebase.status')` with a dead daemon.
  const daemonDown = {
    indexer: { status: 'indexing' },
    architecture: { status: 'idle' },
    diagnostics: {
      message:
        'The indexer daemon (pid 24174, started 3h ago) is no longer running — it crashed, was killed, or the machine slept. Restarting it.',
      lastError: null,
      logTail: '',
    },
  };

  it('parses, keeping the explanatory message', () => {
    const r = CodebaseReadinessSchema.safeParse(daemonDown);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.diagnostics?.message).toContain('no longer running');
  });

  it('accepts a null lastError (the daemon died AFTER a successful spawn)', () => {
    // `.optional()` alone rejected null here, which would have dropped the whole
    // reading and left the pill on "analyzing…" with no diagnostics at all.
    expect(CodebaseReadinessSchema.safeParse(daemonDown).success).toBe(true);
  });

  it('is distinguishable from a healthy daemon that is genuinely indexing', () => {
    const healthy = CodebaseReadinessSchema.parse({
      indexer: {
        status: 'indexing',
        phase: 'embedding',
        indexedChunks: 10,
        totalChunks: 100,
      },
      architecture: { status: 'building' },
    });
    const down = CodebaseReadinessSchema.parse(daemonDown);
    // Both report status 'indexing'. The ONLY signal is diagnostics.message +
    // absent counts — which is exactly what the modal keys off.
    expect(healthy.indexer.status).toBe(down.indexer.status);
    expect(healthy.diagnostics).toBeUndefined();
    expect(down.diagnostics?.message).toBeTruthy();
    expect(down.indexer.totalChunks).toBeUndefined();
  });
});
