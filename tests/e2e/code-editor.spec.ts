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

test('runs a command via native.process and streams output', async ({ page }) => {
  await installUglyNativeMock(page, {
    platform: 'desktop',
    results: {
      'permissions.request': { granted: { fs: 'full', process: 'full' } },
      'permissions.query': { granted: { fs: 'full', process: 'full' } },
      'fs.readdir': { entries: [] },
    },
  });
  // `native.process` is a facade on window.UglyDesktop (not window.UglyNative),
  // so inject a desktop process bridge that echoes the command and exits 0.
  await page.addInitScript(() => {
    const w = window as unknown as { UglyDesktop?: Record<string, unknown> };
    w.UglyDesktop = w.UglyDesktop || {};
    (w.UglyDesktop as { process?: unknown }).process = {
      spawn: (bin: string, args: string[]) => {
        const h: Record<string, ((x: unknown) => void)[]> = { stdout: [], exit: [], stderr: [], error: [] };
        setTimeout(() => {
          h.stdout.forEach((cb) => cb(`${bin} ${args.join(' ')}\n`));
          h.exit.forEach((cb) => cb(0));
        }, 5);
        return {
          onStdout: (cb: (x: unknown) => void) => h.stdout.push(cb),
          onStderr: (cb: (x: unknown) => void) => h.stderr.push(cb),
          onExit: (cb: (x: unknown) => void) => h.exit.push(cb),
          onError: (cb: (x: unknown) => void) => h.error.push(cb),
          write: () => {},
          closeStdin: () => {},
          kill: () => {},
        };
      },
    };
  });

  await page.goto('/');
  await expect(page.locator('[data-id="terminal"]')).toBeVisible();
  await page.locator('[data-id="cmd-input"]').fill('echo functional');
  await page.locator('[data-id="cmd-input"]').press('Enter'); // runs (avoids the fixed feedback-button overlay)

  const out = page.locator('[data-id="terminal-output"]');
  await expect(out).toContainText('$ echo functional');
  await expect(out).toContainText('echo functional'); // stdout streamed from the process bridge
  await expect(out).toContainText('[exit 0]');
});

test('shows the Open-in-Studio fallback when native is unavailable (web)', async ({ page }) => {
  // No native mock installed → window.UglyNative absent → web platform.
  await page.goto('/');
  await expect(page.locator('[data-id="no-native"]')).toBeVisible();
  await expect(page.locator('[data-id="no-native"]')).toContainText('Ugly Studio');
});
