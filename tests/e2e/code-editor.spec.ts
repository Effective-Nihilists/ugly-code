import { test, expect } from '@playwright/test';
import { installUglyNativeMock } from 'ugly-app/playwright';

// Verifies the ugly-code IDE drives the local filesystem entirely through the
// UglyNative SDK — list → open → edit → save all bottom out at fs.* invokes,
// which the Studio desktop browser fulfills in production. We mock that transport
// with the uglyNative testing framework, so this runs in plain Chromium.

test('lists, opens, edits and saves files over uglyNative', async ({ page }) => {
  const mock = await installUglyNativeMock(page, {
    platform: 'desktop',
    results: {
      'permissions.request': { granted: { fs: 'full' } },
      'permissions.query': { granted: { fs: 'full' } },
      'fs.readdir': {
        entries: [
          { name: 'src', isDirectory: true, isFile: false },
          { name: 'README.md', isDirectory: false, isFile: true },
        ],
      },
      'fs.readFile': { content: '# Hello from uglyNative' },
      'fs.writeFile': undefined,
    },
  });

  await page.goto('/');

  // The IDE chrome renders (not the web-fallback), and lists the home dir.
  await expect(page.locator('[data-id="cwd"]')).toHaveText('/');
  await expect(page.locator('[data-id="platform"]')).toHaveText('desktop');
  await expect(page.locator('[data-id="fs-entry"]')).toHaveCount(2);
  await mock.expectInvoked('fs.readdir', { path: '/' });

  // Open the file → fs.readFile, content shows in the editor.
  await page.locator('[data-id="fs-entry"][data-name="README.md"]').click();
  await mock.expectInvoked('fs.readFile', { path: '/README.md' });
  const editor = page.locator('[data-id="editor-textarea"]');
  await expect(editor).toHaveValue('# Hello from uglyNative');

  // Edit + save → fs.writeFile with the new content.
  await editor.fill('# Edited via ugly-code');
  await page.locator('[data-id="save-btn"]').click();
  await mock.expectInvoked('fs.writeFile', {
    path: '/README.md',
    content: '# Edited via ugly-code',
  });
  await expect(page.locator('[data-id="status"]')).toContainText('saved /README.md');
});

test('runs a command via native.process over the unified protocol', async ({ page }) => {
  // process is no longer a UglyDesktop bridge — it rides the same window.UglyNative
  // invoke/subscribe the mock provides. spawn → invoke('process.spawn') → {id};
  // output streams as id-keyed events.
  const mock = await installUglyNativeMock(page, {
    platform: 'desktop',
    results: {
      'permissions.request': { granted: { fs: 'full', process: 'full' } },
      'permissions.query': { granted: { fs: 'full', process: 'full' } },
      'fs.readdir': { entries: [] },
      'process.spawn': { id: 'P1', pid: 7 },
    },
  });

  await page.goto('/');
  await expect(page.locator('[data-id="terminal"]')).toBeVisible();
  await page.locator('[data-id="cmd-input"]').fill('echo functional');
  await page.locator('[data-id="cmd-input"]').press('Enter');

  await mock.expectInvoked('process.spawn', { cmd: 'echo' });
  // wait until the facade has wired its id-keyed subscriptions, then stream.
  await page.waitForFunction(
    () => !!(window as unknown as { __uglyNativeListeners?: Record<string, unknown> })
      .__uglyNativeListeners?.['process.stdout:P1'],
  );
  await mock.emit('process.stdout:P1' as never, { chunk: 'functional output\n' } as never);
  await mock.emit('process.exit:P1' as never, { code: 0 } as never);

  const out = page.locator('[data-id="terminal-output"]');
  await expect(out).toContainText('$ echo functional');
  await expect(out).toContainText('functional output'); // stdout streamed over invoke/subscribe
  await expect(out).toContainText('[exit 0]');
});

test('shows the Open-in-Studio fallback when native is unavailable (web)', async ({ page }) => {
  // No native mock installed → window.UglyNative absent → web platform.
  await page.goto('/');
  await expect(page.locator('[data-id="no-native"]')).toBeVisible();
  await expect(page.locator('[data-id="no-native"]')).toContainText('Ugly Studio');
});
