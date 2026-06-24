/**
 * Poll `enumTasks` until task `id` reports `running` — i.e. its bundle has loaded and its
 * `defineTask({ onCall })` handlers are registered. Throws if the task errors/exits first.
 *
 * Why this exists: `native.task.start` resolves as soon as the child is SPAWNED, but the task
 * runner then fetches + imports the bundle over https. Calling a method in that window races
 * the load and throws "unknown task method: send". Callers must await this before the first
 * `task.call`. Dependency-injected (enum + sleep) so the race is unit-testable with no host.
 */
export async function waitForTaskRunning(
  id: string,
  enumTasks: () => Promise<{ id: string; status: string }[]>,
  opts: { tries?: number; sleepMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  const tries = opts.tries ?? 200;
  const sleepMs = opts.sleepMs ?? 100;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let i = 0; i < tries; i++) {
    const t = (await enumTasks()).find((x) => x.id === id);
    if (t?.status === 'running') return;
    if (t && (t.status === 'error' || t.status === 'exited')) throw new Error('coding task failed to start: ' + t.status);
    await sleep(sleepMs);
  }
  throw new Error('coding task did not become ready in time');
}
