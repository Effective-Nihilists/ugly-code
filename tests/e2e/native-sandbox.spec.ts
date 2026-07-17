import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installGatedNative } from './helpers/gatedNative';

/**
 * The per-project sandbox CONTRACT the client depends on: `sandbox.status` /
 * `initialize` / `teardown` round-trip, and `process.spawn` carries the
 * `opts.sandbox` context through to the daemon boundary. The real OS-user
 * enforcement is daemon-side (unit-tested in ugly-studio + verified on a Mac);
 * here we prove the client/daemon wire contract end-to-end in the browser.
 */
async function invoke(
  page: import('@playwright/test').Page,
  ch: string,
  payload: unknown,
): Promise<unknown> {
  return page.evaluate(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ([c, p]) => (window as any).UglyNative.invoke(c, p),
    [ch, payload] as [string, unknown],
  );
}

let root: string;
test.beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sbx-e2e-'));
});
test.afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

test('sandbox lifecycle: status → initialize → status flips → teardown', async ({
  page,
}) => {
  await installGatedNative(page, { root });
  await page.goto('/');

  const before = (await invoke(page, 'sandbox.status', {
    projectId: 'proj1',
  })) as {
    supported: boolean;
    initialized: boolean;
    username: string | null;
  };
  expect(before).toMatchObject({
    supported: true,
    initialized: false,
    username: 'ugs-proj1',
  });

  expect(
    await invoke(page, 'sandbox.initialize', {
      projectId: 'proj1',
      projectDir: '/p',
    }),
  ).toEqual({ ok: true });

  const after = (await invoke(page, 'sandbox.status', {
    projectId: 'proj1',
  })) as { initialized: boolean };
  expect(after.initialized).toBe(true);

  expect(
    await invoke(page, 'sandbox.teardown', {
      projectId: 'proj1',
      projectDir: '/p',
    }),
  ).toEqual({ ok: true });
  expect(
    (
      (await invoke(page, 'sandbox.status', { projectId: 'proj1' })) as {
        initialized: boolean;
      }
    ).initialized,
  ).toBe(false);
});

test('an unsupported host reports supported:false and refuses initialize', async ({
  page,
}) => {
  await installGatedNative(page, { root, sandboxSupported: false });
  await page.goto('/');

  expect(
    await invoke(page, 'sandbox.status', { projectId: 'p' }),
  ).toMatchObject({ supported: false, username: null });
  expect(
    await invoke(page, 'sandbox.initialize', {
      projectId: 'p',
      projectDir: '/p',
    }),
  ).toMatchObject({ ok: false });
});

test('process.spawn carries opts.sandbox to the daemon boundary', async ({
  page,
}) => {
  await installGatedNative(page, { root });
  await page.goto('/');
  await invoke(page, 'permissions.request', {
    fs: 'scoped',
    process: ['bash'],
  });

  // A sandboxed tool spawn — the daemon would drop it to ugs-<projectId>.
  await invoke(page, 'process.spawn', {
    cmd: 'bash',
    args: ['-lc', 'true'],
    opts: { sandbox: { projectId: 'proj1', mode: 'edit', projectDir: root } },
  });

  const spawns = (await page.evaluate(
    () => (window as { __sandboxSpawns?: unknown }).__sandboxSpawns,
  )) as Array<{
    cmd: string;
    sandbox: { projectId: string; mode: string };
  }>;
  expect(spawns).toHaveLength(1);
  expect(spawns[0]).toMatchObject({
    cmd: 'bash',
    sandbox: { projectId: 'proj1', mode: 'edit' },
  });
});
