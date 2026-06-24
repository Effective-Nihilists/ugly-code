import { describe, it, expect, vi } from 'vitest';
import { waitForTaskRunning } from '../../client/studio/hooks/taskReady';

// Regression for the coding-session "unknown task method: send" race.
//
// native.task.start resolves when the child is SPAWNED, but the runner then fetches +
// imports the bundle over https; its defineTask handlers aren't registered until that
// completes. Calling task.call('send') in that window throws "unknown task method".
// ensureCodingTask now awaits waitForTaskRunning before the first call.
//
// The Playwright e2e couldn't catch this — its native mock returns task.enum / task.call
// STATICALLY (frozen 'running', call always {ok:true}), so it can't model the
// starting→running lifecycle or a pre-ready call failing. These tests model it directly.
describe('waitForTaskRunning', () => {
  const noSleep = (): Promise<void> => Promise.resolve();

  it('waits through starting → running before resolving (the real load lifecycle)', async () => {
    const seq = [
      [{ id: 'coding:s', status: 'starting' }],
      [{ id: 'coding:s', status: 'starting' }],
      [{ id: 'coding:s', status: 'running' }],
    ];
    const enumTasks = vi.fn(() => Promise.resolve(seq.shift() ?? [{ id: 'coding:s', status: 'running' }]));
    await waitForTaskRunning('coding:s', enumTasks, { sleep: noSleep });
    // It must have polled past the 'starting' frames, not returned on the first check.
    expect(enumTasks).toHaveBeenCalledTimes(3);
  });

  it('resolves immediately for an already-running (reused) task', async () => {
    const enumTasks = vi.fn(() => Promise.resolve([{ id: 'coding:s', status: 'running' }]));
    await waitForTaskRunning('coding:s', enumTasks, { sleep: noSleep });
    expect(enumTasks).toHaveBeenCalledTimes(1);
  });

  it('throws when the task errors before becoming ready (no silent hang)', async () => {
    const enumTasks = vi.fn(() => Promise.resolve([{ id: 'coding:s', status: 'error' }]));
    await expect(waitForTaskRunning('coding:s', enumTasks, { sleep: noSleep })).rejects.toThrow(/failed to start/);
  });

  it('throws if it never becomes ready (bounded, not infinite)', async () => {
    const enumTasks = vi.fn(() => Promise.resolve([{ id: 'coding:s', status: 'starting' }]));
    await expect(waitForTaskRunning('coding:s', enumTasks, { sleep: noSleep, tries: 5 })).rejects.toThrow(/not become ready/);
    expect(enumTasks).toHaveBeenCalledTimes(5);
  });
});
