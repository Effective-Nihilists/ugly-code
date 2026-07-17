// E: the doc-triggered task. The UI writes a run-request (create); the owning host
// CAS-claims a pending one (exactly one host runs it) and completes it. These handlers
// are the server foundation — the host sync-engine subscriber that reacts + drives the
// TaskManager is wired separately (needs ugly-studio runtime).
import { describe, expect, it } from 'vitest';
import { makeCodingSessionHandlers } from '../../server/codingSessionHandlers';

function memDb() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const store = new Map<string, any>();
  return {
    store,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: {
      getDoc: async (_c: unknown, id: string) => store.get(id) ?? null,
      getDocs: async () => [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setDoc: async (_c: unknown, doc: any) => {
        store.set(doc._id, doc);
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setDocFields: async (_c: unknown, id: string, fields: any) => {
        const d = { ...(store.get(id) ?? {}), ...fields };
        store.set(id, d);
        return d;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      deleteDoc: async (_c: unknown, id: string) => {
        store.delete(id);
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  };
}
const H = (fake: ReturnType<typeof memDb>) =>
  makeCodingSessionHandlers(() => fake.db);

describe('codingRunRequest — doc-triggered task lifecycle + CAS claim', () => {
  it('create → pending, with idempotent _id = run:<sessionId>:<seq>', async () => {
    const fake = memDb();
    const { id } = await H(fake).codingRunRequestCreate('u1', {
      sessionId: 'cs:a',
      projectId: 'p1',
      seq: 0,
      prompt: 'hi',
      buildId: 'b1',
    });
    expect(id).toBe('run:cs:a:0');
    expect(fake.store.get('run:cs:a:0')).toMatchObject({
      status: 'pending',
      userId: 'u1',
      projectId: 'p1',
      prompt: 'hi',
      buildId: 'b1',
    });
  });

  it('claim succeeds once (pending→claimed); a second claim is rejected', async () => {
    const fake = memDb();
    await H(fake).codingRunRequestCreate('u1', {
      sessionId: 'cs:a',
      projectId: 'p1',
      seq: 1,
      prompt: 'go',
      buildId: 'b1',
    });
    expect(
      await H(fake).codingRunRequestClaim('u1', {
        id: 'run:cs:a:1',
        host: 'dev-1',
      }),
    ).toEqual({ claimed: true });
    expect(fake.store.get('run:cs:a:1')).toMatchObject({
      status: 'claimed',
      host: 'dev-1',
    });
    expect(
      await H(fake).codingRunRequestClaim('u1', {
        id: 'run:cs:a:1',
        host: 'dev-2',
      }),
    ).toEqual({ claimed: false });
    expect(fake.store.get('run:cs:a:1').host).toBe('dev-1'); // not stolen
  });

  it("refuses to claim another user's request, or a missing one", async () => {
    const fake = memDb();
    await H(fake).codingRunRequestCreate('u1', {
      sessionId: 'cs:a',
      projectId: 'p1',
      seq: 2,
      prompt: 'x',
      buildId: 'b1',
    });
    expect(
      await H(fake).codingRunRequestClaim('u2', {
        id: 'run:cs:a:2',
        host: 'h',
      }),
    ).toEqual({ claimed: false });
    expect(
      await H(fake).codingRunRequestClaim('u1', {
        id: 'run:missing:9',
        host: 'h',
      }),
    ).toEqual({ claimed: false });
  });

  it('complete DELETES the request (GC) once terminal; wrong-user cannot', async () => {
    const fake = memDb();
    await H(fake).codingRunRequestCreate('u1', {
      sessionId: 'cs:a',
      projectId: 'p1',
      seq: 3,
      prompt: 'x',
      buildId: 'b1',
    });
    await H(fake).codingRunRequestClaim('u1', { id: 'run:cs:a:3', host: 'h' });
    // Another user can't complete it (guarded before delete).
    expect(
      await H(fake).codingRunRequestComplete('u2', {
        id: 'run:cs:a:3',
        status: 'done',
      }),
    ).toEqual({ ok: false });
    expect(fake.store.has('run:cs:a:3')).toBe(true);
    // The owner completes → the row is deleted (no terminal row left to accumulate).
    expect(
      await H(fake).codingRunRequestComplete('u1', {
        id: 'run:cs:a:3',
        status: 'error',
        error: 'boom',
      }),
    ).toEqual({ ok: true });
    expect(fake.store.has('run:cs:a:3')).toBe(false);
  });

  it('interaction lifecycle: put (question/command) → respond → resolve; wrong-user guarded', async () => {
    const fake = memDb();
    const H1 = H(fake);
    // Agent posts an ask_user QUESTION.
    const { id } = await H1.codingInteractionPut('u1', {
      id: 'int:cs:ask:t1',
      sessionId: 'cs',
      kind: 'ask_user',
      toolCallId: 't1',
      question: JSON.stringify({ question: 'which?', options: [] }),
    });
    expect(id).toBe('int:cs:ask:t1');
    expect(fake.store.get('int:cs:ask:t1')).toMatchObject({
      status: 'pending',
      kind: 'ask_user',
      toolCallId: 't1',
    });
    // Client answers → answered + response (the host then forwards it).
    expect(
      await H1.codingInteractionRespond('u1', {
        id: 'int:cs:ask:t1',
        response: JSON.stringify({ answer: 'B' }),
      }),
    ).toEqual({ ok: true });
    expect(fake.store.get('int:cs:ask:t1')).toMatchObject({
      status: 'answered',
      response: JSON.stringify({ answer: 'B' }),
    });
    // Host resolves after forwarding → the interaction is DELETED (GC).
    expect(
      await H1.codingInteractionResolve('u1', { id: 'int:cs:ask:t1' }),
    ).toEqual({ ok: true });
    expect(fake.store.has('int:cs:ask:t1')).toBe(false);
    // A client STOP command starts pending (host forwards it).
    await H1.codingInteractionPut('u1', {
      id: 'int:cs:stop:9',
      sessionId: 'cs',
      kind: 'stop',
    });
    expect(fake.store.get('int:cs:stop:9')).toMatchObject({
      status: 'pending',
      kind: 'stop',
    });
    // Another user can't respond to / resolve someone else's interaction.
    expect(
      await H1.codingInteractionRespond('u2', {
        id: 'int:cs:ask:t1',
        response: 'x',
      }),
    ).toEqual({ ok: false });
    expect(
      await H1.codingInteractionResolve('u2', { id: 'int:cs:stop:9' }),
    ).toEqual({ ok: false });
  });

  it('get reflects lifecycle for the client watchdog (pending → claimed → error); null for others', async () => {
    const fake = memDb();
    await H(fake).codingRunRequestCreate('u1', {
      sessionId: 'cs:a',
      projectId: 'p1',
      seq: 4,
      prompt: 'x',
      buildId: 'b1',
    });
    // Still pending → the watchdog treats this as "no host claimed it yet".
    expect(
      await H(fake).codingRunRequestGet('u1', { id: 'run:cs:a:4' }),
    ).toEqual({ status: 'pending' });
    await H(fake).codingRunRequestClaim('u1', {
      id: 'run:cs:a:4',
      host: 'dev-1',
    });
    expect(
      await H(fake).codingRunRequestGet('u1', { id: 'run:cs:a:4' }),
    ).toEqual({ status: 'claimed', host: 'dev-1' });
    // complete GC-deletes → get now returns null (the watchdog already stopped at 'claimed').
    await H(fake).codingRunRequestComplete('u1', {
      id: 'run:cs:a:4',
      status: 'done',
    });
    expect(
      await H(fake).codingRunRequestGet('u1', { id: 'run:cs:a:4' }),
    ).toBeNull();
    // Not the caller's / missing → null.
    expect(
      await H(fake).codingRunRequestGet('u2', { id: 'run:cs:a:4' }),
    ).toBeNull();
    expect(
      await H(fake).codingRunRequestGet('u1', { id: 'run:missing:9' }),
    ).toBeNull();
  });
});
