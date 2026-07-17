// D: a streaming (transient) message append must relay via setDoc({transient}) WITHOUT
// persisting; the final non-transient append at the same seq commits durably. Both hit
// the same _id (`sessionId:seq`) so trackDocs({includeTransient}) merges them into one row.
import { describe, expect, it } from 'vitest';
import { makeCodingSessionHandlers } from '../../server/codingSessionHandlers';

function capturingDb() {
  const calls: { id: string; options: unknown }[] = [];
  return {
    calls,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: {
      getDoc: async () => null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setDoc: async (_c: unknown, doc: any, options: unknown) => {
        calls.push({ id: doc._id, options: options ?? null });
      },
    } as any,
  };
}

const appendOf = (fake: ReturnType<typeof capturingDb>) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  makeCodingSessionHandlers(() => fake.db).codingSessionAppendMessage;

describe('codingSessionAppendMessage transient streaming', () => {
  it('passes {transient:true} for a streaming write and {} for the durable commit', async () => {
    const fake = capturingDb();
    const append = appendOf(fake);
    await append('u1', {
      sessionId: 's1',
      seq: 3,
      role: 'assistant',
      content: 'hel',
      transient: true,
    });
    await append('u1', {
      sessionId: 's1',
      seq: 3,
      role: 'assistant',
      content: 'hello',
      transient: true,
    });
    await append('u1', {
      sessionId: 's1',
      seq: 3,
      role: 'assistant',
      content: 'hello world',
    }); // commit

    expect(fake.calls.map((c) => c.options)).toEqual([
      { transient: true },
      { transient: true },
      {},
    ]);
    // All three target the SAME row id, so streaming frames + commit merge into one doc.
    expect(fake.calls.every((c) => c.id === 's1:3')).toBe(true);
  });
});
