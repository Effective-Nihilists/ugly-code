// The stuck-THINKING race: two fire-and-forget status writes landing out of order.
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  pendingWriteQueues,
  queueWrite,
  resetWriteQueues,
} from '../../client/studio/agent/metaWriteQueue';

afterEach(() => {
  resetWriteQueues();
});

const deferred = <T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe('queueWrite ordering', () => {
  it('applies writes in ISSUE order even when the first request is slower', async () => {
    // This is the bug, exactly: 'running' is issued first but its HTTP call takes
    // longer than the 'idle' issued right after. Unqueued, 'running' lands last and the
    // session is stuck THINKING forever.
    const applied: string[] = [];
    const slow = deferred<void>();
    void queueWrite('s1', async () => {
      await slow.promise;
      applied.push('running');
    });
    void queueWrite('s1', () => {
      applied.push('idle');
      return Promise.resolve();
    });
    slow.resolve();
    await vi.waitFor(() => expect(applied).toEqual(['running', 'idle']));
    // The terminal status is applied last → the pill goes idle.
    expect(applied[applied.length - 1]).toBe('idle');
  });

  it('does not serialize across different sessions', async () => {
    const applied: string[] = [];
    const blocked = deferred<void>();
    void queueWrite('a', async () => {
      await blocked.promise;
      applied.push('a');
    });
    await queueWrite('b', () => {
      applied.push('b');
      return Promise.resolve();
    });
    expect(applied).toEqual(['b']); // 'b' didn't wait behind the stalled 'a'
    blocked.resolve();
    await vi.waitFor(() => expect(applied).toContain('a'));
  });

  it('a failed write does not break the chain — later writes still land', async () => {
    const applied: string[] = [];
    const onError = vi.fn();
    void queueWrite(
      's1',
      () => Promise.reject(new Error('network down')),
      onError,
    );
    await queueWrite('s1', () => {
      applied.push('idle');
      return Promise.resolve();
    });
    expect(applied).toEqual(['idle']);
    expect(onError).toHaveBeenCalledOnce();
  });

  it('surfaces failures instead of swallowing them silently', async () => {
    const onError = vi.fn();
    await queueWrite('s1', () => Promise.reject(new Error('boom')), onError);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'boom' }),
    );
  });

  it('never rejects to the caller (a status write must not break a turn)', async () => {
    await expect(
      queueWrite('s1', () => Promise.reject(new Error('x'))),
    ).resolves.toBeUndefined();
  });

  it('drains its chain map (no unbounded growth per session)', async () => {
    await queueWrite('s1', () => Promise.resolve());
    await vi.waitFor(() => expect(pendingWriteQueues()).toBe(0));
  });
});
