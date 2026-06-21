import { expect, test } from '@playwright/test';
import { installUglyNativeMock } from 'ugly-app/playwright';
import { authenticate, loadDevAuth } from './helpers/auth';

// REAL end-to-end smoke for the coding agent: authenticated page + the REAL
// /api/agentStep → ugly.bot textGen (no scripted step override). This exercises
// the whole production path — auth cookie acceptance, the server agent handler,
// real model inference, the client loop, and the UI.
//
// Opt-in + self-skipping: it costs tokens and needs network + a live session,
// so it only runs when RUN_REAL_SMOKE=1 AND ~/.ugly-bot/auth.json exists.
//   RUN_REAL_SMOKE=1 npx playwright test agent.smoke --project=chromium

const auth = loadDevAuth();
const enabled = !!process.env['RUN_REAL_SMOKE'] && !!auth;

test.describe('coding-agent harness (real AI smoke)', () => {
  test.skip(!enabled, 'Set RUN_REAL_SMOKE=1 and be logged in (~/.ugly-bot/auth.json) to run');

  test('a no-tool prompt gets a real model reply through the live loop', async ({ page }) => {
    // Tool channels are mocked so an unexpected tool call still resolves and the
    // loop can't hang; the prompt steers the model to answer in plain text.
    await installUglyNativeMock(page, {
      platform: 'desktop',
      results: {
        'permissions.request': { granted: { fs: 'full', process: 'full' } },
        'fs.readdir': { entries: [] },
        'fs.readFile': { content: '' },
      },
    });
    await authenticate(page, auth!);

    await page.goto('/test/agent');
    await expect(page.locator('[data-id=agent-panel]')).toBeVisible();

    await page
      .locator('[data-id=agent-input]')
      .fill('Reply with exactly the single word PONG and call no tools.');
    await page.locator('[data-id=agent-input]').press('Enter');

    // Real model round-trip — allow generous time, then assert an assistant
    // message arrived (the live AI + loop produced output) and busy cleared.
    const assistant = page.locator('[data-id=agent-assistant]').last();
    await expect(assistant).toBeVisible({ timeout: 45_000 });
    await expect(assistant).toContainText(/pong/i, { timeout: 45_000 });
    await expect(page.locator('[data-id=agent-busy]')).toHaveCount(0);
  });

  test('a tool-using prompt drives a real list_dir through the live model', async ({ page }) => {
    const mock = await installUglyNativeMock(page, {
      platform: 'desktop',
      results: {
        'permissions.request': { granted: { fs: 'full', process: 'full' } },
        'fs.readdir': {
          entries: [
            { name: 'package.json', isFile: true, isDirectory: false },
            { name: 'src', isFile: false, isDirectory: true },
          ],
        },
        'fs.readFile': { content: '{"name":"demo"}' },
      },
    });
    await authenticate(page, auth!);

    await page.goto('/test/agent');
    await page
      .locator('[data-id=agent-input]')
      .fill('Use the list_dir tool on "." to list the workspace, then tell me what is there.');
    await page.locator('[data-id=agent-input]').press('Enter');

    // Lenient: the real model decides tool usage. Assert the loop completed
    // (busy cleared) and produced a final answer; if it chose to list, the mock
    // recorded the call.
    await expect(page.locator('[data-id=agent-assistant]').last()).toBeVisible({ timeout: 45_000 });
    await expect(page.locator('[data-id=agent-busy]')).toHaveCount(0, { timeout: 45_000 });
    const calls = await mock.calls();
    console.log('[real-smoke] native channels invoked:', calls.map((c) => c.channel).join(', ') || '(none)');
  });
});
