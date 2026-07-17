// The observability half of the z-ai proxy incident: a failed turn's error was
// renderer-only (the `⚠` bubble) and never hit the transcript, so a broken
// session was undiagnosable from its id. `codingSessionUpsert` now persists
// `lastError` on the session doc. The semantics are load-bearing:
//   • non-empty string → set the failure text
//   • '' (empty)       → clear it (a recovered turn)
//   • omitted          → preserve the stored value
// (matches how clientAgent.persistMeta drives it: '' on success, text on error.)
import { describe, expect, it } from 'vitest';
import { makeCodingSessionHandlers } from '../../server/codingSessionHandlers';
import { collections, type CodingSession } from '../../shared/collections';

// A tiny in-memory stand-in for the per-request TypedDB — only the methods the
// upsert path touches (getDoc / getDocs / setDoc).
function fakeDb() {
  const store = new Map<string, CodingSession>();
  return {
    store,
    db: {
      getDoc: async (_c: unknown, id: string) => store.get(id) ?? null,
      getDocs: async () => [] as CodingSession[],
      setDoc: async (_c: unknown, doc: CodingSession) => {
        store.set(doc._id, doc);
      },
    },
  };
}

const upsertOf = (fake: ReturnType<typeof fakeDb>) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  makeCodingSessionHandlers(() => fake.db as any).codingSessionUpsert;

const base = { sessionId: 's1', projectId: 'p1' };
const stored = (fake: ReturnType<typeof fakeDb>) => fake.store.get('s1');

describe('codingSessionUpsert lastError (session-level diagnostics)', () => {
  it('sets the failure text when a turn errors', async () => {
    const fake = fakeDb();
    await upsertOf(fake)('u1', {
      ...base,
      status: 'error',
      lastError: 'z.ai key read failed',
    });
    expect(stored(fake)?.lastError).toBe('z.ai key read failed');
    expect(stored(fake)?.status).toBe('error');
  });

  it("clears the error on a recovered turn (lastError: '')", async () => {
    const fake = fakeDb();
    await upsertOf(fake)('u1', { ...base, status: 'error', lastError: 'boom' });
    await upsertOf(fake)('u1', { ...base, status: 'idle', lastError: '' });
    expect(stored(fake)?.lastError).toBeUndefined();
    expect(stored(fake)?.status).toBe('idle');
  });

  it('preserves the stored error when lastError is omitted', async () => {
    const fake = fakeDb();
    await upsertOf(fake)('u1', {
      ...base,
      status: 'error',
      lastError: 'still broken',
    });
    // e.g. a title-only or running-status upsert that doesn't carry the field.
    await upsertOf(fake)('u1', { ...base, status: 'running' });
    expect(stored(fake)?.lastError).toBe('still broken');
  });
});

describe('codingSessionUpsert token usage (were silently dropped at the API boundary)', () => {
  it('persists the four token fields', async () => {
    const fake = fakeDb();
    await upsertOf(fake)('u1', {
      ...base,
      status: 'idle',
      costUsd: 0.12,
      promptTokens: 1000,
      completionTokens: 200,
      cacheReadTokens: 5000,
      cacheCreationTokens: 300,
    });
    const s = stored(fake);
    expect(s).toMatchObject({
      promptTokens: 1000,
      completionTokens: 200,
      cacheReadTokens: 5000,
      cacheCreationTokens: 300,
    });
  });

  it('preserves stored token counts when a later upsert omits them', async () => {
    const fake = fakeDb();
    await upsertOf(fake)('u1', {
      ...base,
      promptTokens: 42,
      completionTokens: 7,
    });
    // A branch-only / status-only upsert that doesn't carry token usage.
    await upsertOf(fake)('u1', { ...base, status: 'running' });
    expect(stored(fake)).toMatchObject({
      promptTokens: 42,
      completionTokens: 7,
    });
  });
});
