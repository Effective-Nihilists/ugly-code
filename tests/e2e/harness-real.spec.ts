import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
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

  // Per-session worktree isolation: the FIRST session is "main" (edits the
  // project itself); a SECOND, non-main session must run in its own git worktree
  // so its edits land under .ugly-studio/worktrees/<id> on a session branch,
  // leaving the project's own copy untouched.
  test('a non-main session is isolated in its own git worktree', async ({ page }) => {
    // A REAL git repo (worktrees need a committed HEAD). No package.json → no
    // pnpm install, so the test stays fast (we assert isolation, not deps).
    const root = fs.mkdtempSync(join(tmpdir(), 'uglycode-worktree-'));
    const git = (...args: string[]): void => { execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' }); };
    fs.writeFileSync(join(root, 'isolated.txt'), 'original\n');
    fs.writeFileSync(join(root, '.uglyapp'), JSON.stringify({ projectId: 'worktreetest', title: 'WT' }));
    git('init');
    git('config', 'user.email', 't@t.t');
    git('config', 'user.name', 'T');
    git('add', '-A');
    git('commit', '-m', 'init');

    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    try {
      await installRealNative(page, root);
      await authenticate(page, auth!);
      await page.goto('/');
      await page.getByRole('button', { name: /Open Folder/ }).first().click();
      await page.getByPlaceholder('/path/to/project').fill(root);
      await page.getByRole('button', { name: /Open Folder →/ }).click();
      await expect(page.locator('[data-id=home-prompt-input]')).toBeVisible();

      // Session 1 (becomes the MAIN session) — a trivial turn to establish it.
      await page.locator('[data-id=home-prompt-input]').fill('Reply with exactly: OK');
      await page.locator('[data-id=home-start-session]').click();
      await expect.poll(() => fs.existsSync(join(root, '.ugly-studio')) , { timeout: 60_000 }).toBeTruthy();

      // Session 2 (NON-main) — edits isolated.txt; this must go to a worktree.
      await page.getByRole('button', { name: /New session/ }).first().click();
      await expect(page.locator('[data-id=home-prompt-input]')).toBeVisible();
      await page.locator('[data-id=home-prompt-input]').fill(
        'The file isolated.txt contains exactly: original. Use edit_file to change "original" to "WORKTREE-EDIT". Do it now.',
      );
      await page.locator('[data-id=home-start-session]').click();

      // A worktree dir is created under .ugly-studio/worktrees, the edit lands
      // THERE, and the project's own copy is left untouched (isolation).
      const wtDir = join(root, '.ugly-studio', 'worktrees');
      await expect
        .poll(() => {
          if (!fs.existsSync(wtDir)) return '';
          for (const d of fs.readdirSync(wtDir)) {
            const f = join(wtDir, d, 'isolated.txt');
            if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8');
          }
          return '';
        }, { timeout: 90_000, message: 'isolated.txt inside a worktree should be rewritten' })
        .toContain('WORKTREE-EDIT');

      // The project's own copy is unchanged — proof the second session was isolated.
      expect(fs.readFileSync(join(root, 'isolated.txt'), 'utf8')).toContain('original');
      // A session branch exists.
      const branches = execFileSync('git', ['-C', root, 'branch', '--list', 'ugly-studio/session/*'], { encoding: 'utf8' });
      expect(branches.trim().length, 'a ugly-studio/session/* branch should exist').toBeGreaterThan(0);

      expect(errors, `page crashed: ${errors.join('; ')}`).toEqual([]);
    } finally {
      // Clean up worktrees before removing the repo so git doesn't leave locks.
      try { execFileSync('git', ['-C', root, 'worktree', 'prune'], { stdio: 'ignore' }); } catch { /* ignore */ }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
