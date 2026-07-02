import { describe, it, expect } from 'vitest';
import { parseCodebaseReadinessEvent } from '../../client/studio/agent/codebaseReadinessEvent';

// The producer emits `event.payload = { payload: <readiness> }`; the consumer passes that
// `event.payload` straight in. These tests pin the double-unwrap + validation contract that
// keeps a malformed/older-host push from crashing the header pill.
const wrap = (readiness: unknown) => ({ payload: readiness });

describe('parseCodebaseReadinessEvent', () => {
  it('unwraps and returns a well-formed readiness (indexing)', () => {
    const r = {
      architecture: { status: 'building', filesAnalyzed: 3, filesTotal: 10 },
      indexer: { status: 'indexing', indexedChunks: 5, totalChunks: 42 },
    };
    expect(parseCodebaseReadinessEvent(wrap(r))).toEqual(r);
  });

  it('returns the ready shape verbatim', () => {
    const r = { architecture: { status: 'ready' }, indexer: { status: 'ready', totalChunks: 100 } };
    expect(parseCodebaseReadinessEvent(wrap(r))).toEqual(r);
  });

  it('returns null for a bad indexer status (older/mismatched host)', () => {
    const r = { architecture: { status: 'ready' }, indexer: { status: 'bogus' } };
    expect(parseCodebaseReadinessEvent(wrap(r))).toBeNull();
  });

  it('returns null when the inner payload is missing entirely', () => {
    expect(parseCodebaseReadinessEvent({})).toBeNull();
    expect(parseCodebaseReadinessEvent(undefined)).toBeNull();
  });

  it('returns null when required sub-objects are absent', () => {
    expect(parseCodebaseReadinessEvent(wrap({ indexer: { status: 'ready' } }))).toBeNull();
    expect(parseCodebaseReadinessEvent(wrap({ architecture: { status: 'ready' } }))).toBeNull();
  });
});
