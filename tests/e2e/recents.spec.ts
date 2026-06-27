import { expect, test } from '@playwright/test';
import { loadDevAuth } from './helpers/auth';
import { enterStudioShell } from './helpers/studio';

// REAL-APP e2e for cross-device recent projects. Drives the real Studio shell
// (HomeGate → StudioShell → ProjectOnboarding) against the real ugly-app socket
// + dev DB; only the OS native layer is mocked. proxy.self is stubbed to a fixed
// desktop identity so opens get stamped + recorded, exactly as on a real machine.
//
// Verifies the whole sync path: open → recordRecentProject (real socket) →
// recentProject row (real DB) → trackDocs fan-out → the picker's list, badged
// "This device" because the row's stamped deviceId matches proxy.self.
//
// Requires a real session (~/.ugly-bot/auth.json); skips otherwise.

const auth = loadDevAuth();
const DEVICE = { deviceId: 'e2e-device-1', deviceLabel: 'E2E MacBook' };

test.describe('Recent projects — cross-device sync', () => {
  test.skip(!auth, 'No ~/.ugly-bot/auth.json — run logged in to a real session');

  test('opening a project records it (stamped with this device) and it syncs to the picker', async ({ page }) => {
    page.on('console', (m) => {
      if (m.type() === 'error') console.log('[browser:error]', m.text());
    });
    await enterStudioShell(page, auth!, { 'proxy.self': DEVICE });

    const projectPath = `/tmp/e2e-recents-${Date.now()}`;

    // Open a folder → StudioShell.openProject → recordRecentProject over the REAL
    // ugly-app socket → recentProject row in the dev DB → trackDocs fans out.
    await page.getByRole('button', { name: /Open Folder/ }).first().click();
    await page.getByPlaceholder(/project$/).fill(projectPath);
    await page.getByRole('button', { name: /Open Folder →/i }).click();
    await page.locator('[data-id=home-prompt-input]').waitFor();
    // Let the async record (proxy.self → socket.request) land before navigating —
    // a full reload would cancel the in-flight request.
    await page.waitForTimeout(1_000);

    // Back to the picker IN-APP (keeps the live socket) — the synced list should
    // now include the project, badged "This device" (stamped deviceId ===
    // proxy.self deviceId).
    await page.locator('[data-id=back-to-projects]').click();
    const row = page.locator(`[data-id="recent-project-${projectPath}"]`);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).toContainText(/This device/i);

    // Delete it, then re-enter the picker fresh and confirm it's gone. We assert
    // on a fresh snapshot rather than a live delta because local dev has no NATS
    // (trackDocs serves the initial query but not live updates); the persisted
    // removal is what we're verifying here.
    await page.locator(`[data-id="recent-project-delete-${projectPath}"]`).click();
    await page.waitForTimeout(1_000); // let the remove request land
    await page.goto('/');
    await expect(page.locator(`[data-id="recent-project-${projectPath}"]`)).toHaveCount(0, {
      timeout: 15_000,
    });
  });
});
