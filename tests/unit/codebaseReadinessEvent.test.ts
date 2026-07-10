import { describe, it, expect } from 'vitest';
import { parseCodebaseReadinessEvent } from '../../client/studio/agent/codebaseReadinessEvent';

// The producer emits `event.payload = { payload: <readiness> }`; the consumer passes that
// `event.payload` straight in. These tests pin the double-unwrap + validation contract that
// keeps a malformed push from crashing the header pill. Readiness is indexer-only now
// (the architecture-doc surface was removed).
const wrap = (readiness: unknown) => ({ payload: readiness });

describe('parseCodebaseReadinessEvent', () => {
  it('unwraps and returns a well-formed readiness (indexing)', () => {
    const r = {
      indexer: { status: 'indexing', indexedChunks: 5, totalChunks: 42, phase: 'embedding' },
    };
    expect(parseCodebaseReadinessEvent(wrap(r))).toEqual(r);
  });

  it('returns the ready shape verbatim', () => {
    const r = { indexer: { status: 'ready', totalChunks: 100 } };
    expect(parseCodebaseReadinessEvent(wrap(r))).toEqual(r);
  });

  it('carries the daemon-down diagnostics through', () => {
    const r = {
      indexer: { status: 'indexing' },
      diagnostics: { message: 'The indexer daemon has not been started yet.', lastError: null, logTail: '' },
    };
    expect(parseCodebaseReadinessEvent(wrap(r))).toEqual(r);
  });

  it('returns null for a bad indexer status (mismatched producer)', () => {
    expect(parseCodebaseReadinessEvent(wrap({ indexer: { status: 'bogus' } }))).toBeNull();
  });

  it('returns null when the inner payload is missing entirely', () => {
    expect(parseCodebaseReadinessEvent({})).toBeNull();
    expect(parseCodebaseReadinessEvent(undefined)).toBeNull();
  });

  it('returns null when the indexer sub-object is absent', () => {
    expect(parseCodebaseReadinessEvent(wrap({ diagnostics: { message: 'x' } }))).toBeNull();
  });
});
