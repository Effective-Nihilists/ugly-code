import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installGatedNative } from './helpers/gatedNative';

/**
 * Proves the UglyNative TEST harness enforces the SAME restricted-space +
 * permission model as the real Ugly Studio daemon — it now drives the ACTUAL
 * `CapabilityGate` from `ugly-app/native/server` (the exact class the daemon
 * constructs), so a test can no longer go green against an unrestricted host
 * (which is exactly how the `bash`-not-bundled Create Project bug shipped: the
 * old harness ran real bash with no gate).
 *
 * Each test drives `window.UglyNative` directly so it asserts the gate, not the
 * app. The backing fs/process are REAL but authorized + confined by the gate.
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

/** Spawn + collect output/exit over the subscribe() event protocol. */
async function spawnAndWait(
  page: import('@playwright/test').Page,
  cmd: string,
  args: string[],
): Promise<{ id: string; out: string; code: number | null }> {
  return page.evaluate(
    ([c, a]) =>
      new Promise((resolveP, rejectP) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const w = window as any;
        let out = '';
        // Subscribe FIRST (the spawn emits on a later tick), then await the id.
        // invoke() rejects if the gate denies — surface that to the test.
        void w.UglyNative.invoke('process.spawn', { cmd: c, args: a })
          .then(({ id }: { id: string }) => {
            w.UglyNative.subscribe(
              'process.stdout:' + id,
              (d: { chunk: string }) => (out += d.chunk),
            );
            w.UglyNative.subscribe(
              'process.stderr:' + id,
              (d: { chunk: string }) => (out += d.chunk),
            );
            w.UglyNative.subscribe(
              'process.exit:' + id,
              (d: { code: number | null }) =>
                resolveP({ id, out, code: d.code }),
            );
          })
          .catch(rejectP);
      }),
    [cmd, args] as [string, string[]],
  ) as Promise<{ id: string; out: string; code: number | null }>;
}

let root: string;
test.beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gated-native-'));
});
test.afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

test('spawning a bundled tool WITHOUT requesting the process permission is denied', async ({
  page,
}) => {
  await installGatedNative(page, { root });
  await page.goto('/');

  // No permissions.request → the real gate's CapabilityGate.checkProcess path.
  await expect(
    invoke(page, 'process.spawn', { cmd: 'bash', args: ['-lc', 'echo hi'] }),
  ).rejects.toThrow(/tool not granted/i);
});

test('a NON-bundled tool is denied even after it is requested ("not a bundled tool")', async ({
  page,
}) => {
  await installGatedNative(page, { root });
  await page.goto('/');

  await invoke(page, 'permissions.request', { fs: 'full', process: ['rm'] });
  await expect(
    invoke(page, 'process.spawn', { cmd: 'rm', args: ['-rf', '/'] }),
  ).rejects.toThrow(/not a bundled tool/i);
});

test('fs is denied until the fs capability is granted, then confined to the scoped folder', async ({
  page,
}) => {
  await installGatedNative(page, { root });
  await page.goto('/');

  // No fs grant → the real gate's resolveFsPath denies ('no filesystem permission').
  await expect(
    invoke(page, 'fs.writeFile', { path: 'a.txt', content: 'x' }),
  ).rejects.toThrow(/no filesystem permission/i);

  // Granted scoped → reads/writes succeed THROUGH the gate (confined to the
  // origin's scope folder; we read back through the gate, not the raw fs).
  await invoke(page, 'permissions.request', { fs: 'scoped', process: [] });
  await invoke(page, 'fs.writeFile', { path: 'a.txt', content: 'hello' });
  const back = (await invoke(page, 'fs.readFile', { path: 'a.txt' })) as {
    content: string;
  };
  expect(back.content).toBe('hello');

  // Escaping the scope is rejected by the real ScopeViolation confinement.
  await expect(
    invoke(page, 'fs.readFile', { path: '../../etc/hosts' }),
  ).rejects.toThrow(/escapes scoped folder/i);
});

test('once bundled AND granted, a real process runs (confined)', async ({
  page,
}) => {
  await installGatedNative(page, { root });
  await page.goto('/');

  await invoke(page, 'permissions.request', {
    fs: 'scoped',
    process: ['bash'],
  });
  const res = await spawnAndWait(page, 'bash', ['-lc', 'echo gated-ok']);
  expect(res.code).toBe(0);
  expect(res.out).toContain('gated-ok');
});

test("REGRESSION: with the daemon's OLD allowlist (no bash), Create Project's spawn is denied", async ({
  page,
}) => {
  // The pre-fix BUNDLED_BINARIES. This is the test that would have caught the
  // shipped bug: the scaffold shells out via `bash`, which wasn't bundled.
  const OLD_BUNDLED = [
    'node',
    'git',
    'gh',
    'python',
    'uv',
    'ffmpeg',
    'imagemagick',
    'rg',
  ];
  await installGatedNative(page, { root, bundledBinaries: OLD_BUNDLED });
  await page.goto('/');

  await invoke(page, 'permissions.request', {
    fs: 'full',
    process: ['bash', 'npx', 'pnpm'],
  });
  await expect(
    invoke(page, 'process.spawn', {
      cmd: 'bash',
      args: ['-lc', 'npx ugly-app init x'],
    }),
  ).rejects.toThrow(/not a bundled tool/i);
});
