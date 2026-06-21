import { expect, test } from '@playwright/test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authenticate, loadDevAuth } from './helpers/auth';
import { installRealNative } from './helpers/realNative';

// The deepest real-app check: drive the actual coding harness against a REAL
// filesystem (not the canned UglyNative mock) so we can prove the agent really
// changes code on disk and every workspace panel mounts. Gated on RUN_REAL_SMOKE
// (real ugly.bot AI) + a logged-in session + a DB-backed dev server.
//
//   RUN_REAL_SMOKE=1 npx playwright test harness-real --project=chromium

const auth = loadDevAuth();
const REAL_AI = !!process.env['RUN_REAL_SMOKE'];

test.describe('coding harness — real filesystem', () => {
  test.skip(!auth || !REAL_AI, 'Set RUN_REAL_SMOKE=1, be logged in (~/.ugly-bot/auth.json), DB-backed dev server');

  test('agent edits a real file on disk; every workspace tab renders', async ({ page }) => {
    // A real project on real disk.
    const root = fs.mkdtempSync(join(tmpdir(), 'uglycode-harness-'));
    fs.writeFileSync(join(root, 'hello.txt'), 'hello world\n');
    fs.writeFileSync(join(root, '.uglyapp'), JSON.stringify({ projectId: 'harnesstest', title: 'Harness' }));
    fs.writeFileSync(join(root, 'README.md'), '# Harness fixture\n');

    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    try {
      await installRealNative(page, root);
      await authenticate(page, auth!);
      await page.goto('/');

      // Open the real project (openProject echoes the path → StudioProjectPage).
      await page.getByRole('button', { name: /Open Folder/ }).first().click();
      await page.getByPlaceholder('/path/to/project').fill(root);
      await page.getByRole('button', { name: /Open Folder →/ }).click();
      await expect(page.locator('[data-id=home-prompt-input]')).toBeVisible();

      // Start a session that modifies code — the real model runs the real
      // edit_file tool against the real fs.
      await page
        .locator('[data-id=home-prompt-input]')
        .fill(
          'The file hello.txt contains exactly: hello world. Use the edit_file tool to change "hello world" to "goodbye world". Do it now.',
        );
      await page.locator('[data-id=home-start-session]').click();

      // Proof the code actually changed: read the file back from DISK (in Node,
      // not the UI) and assert the new contents.
      await expect
        .poll(() => fs.readFileSync(join(root, 'hello.txt'), 'utf8'), {
          timeout: 60_000,
          message: 'hello.txt on disk should be rewritten by the agent',
        })
        .toContain('goodbye world');

      // Every workspace tab mounts its own panel UI without crashing.
      const panels: Array<[name: string, dataId: string]> = [
        ['Database', 'database-panel'],
        ['Errors', 'errors-panel'],
        ['Events', 'events-panel'],
        ['Workers', 'panel-workers'],
      ];
      for (const [label, id] of panels) {
        await page.getByRole('button', { name: label, exact: true }).click();
        await expect(page.locator(`[data-id=${id}]`).first()).toBeVisible({ timeout: 10_000 });
      }

      expect(errors, `page crashed: ${errors.join('; ')}`).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
