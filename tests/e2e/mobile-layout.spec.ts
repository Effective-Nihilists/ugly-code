import { expect, test } from '@playwright/test';
import { loadDevAuth } from './helpers/auth';
import { enterStudioShell, openProject } from './helpers/studio';

const auth = loadDevAuth();
const PHONE = { width: 390, height: 844 };

test.describe('Mobile workspace — nav drawer', () => {
  test.skip(!auth, 'No ~/.ugly-bot/auth.json — run logged in to a real session');

  test('drawer opens, switches view, and closes; no horizontal overflow', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await enterStudioShell(page, auth!);
    await openProject(page); // mounts StudioProjectPage + chat

    // Desktop chrome is hidden on a phone: the top segmented tab control is gone.
    await expect(page.locator('[data-id="tab-preview"]')).toHaveCount(0);

    // The hamburger is present; the drawer starts closed.
    const toggle = page.locator('[data-id="mobile-nav-toggle"]');
    await expect(toggle).toBeVisible();
    await expect(page.locator('[data-id="mobile-nav-drawer"]')).not.toBeVisible();

    // Open the drawer, switch to Preview, drawer closes and the pane is shown.
    await toggle.click();
    await expect(page.locator('[data-id="mobile-nav-drawer"]')).toBeVisible();
    await page.locator('[data-id="mobile-view-preview"]').click();
    await expect(page.locator('[data-id="mobile-nav-drawer"]')).not.toBeVisible();
    await expect(page.locator('[data-id="preview-panel"]')).toBeVisible();

    // Re-open and dismiss via the scrim.
    await toggle.click();
    await expect(page.locator('[data-id="mobile-nav-drawer"]')).toBeVisible();
    await page.locator('[data-id="mobile-nav-scrim"]').click({ position: { x: 360, y: 400 } });
    await expect(page.locator('[data-id="mobile-nav-drawer"]')).not.toBeVisible();

    // No horizontal overflow of the document at phone width.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1); // allow sub-pixel rounding
  });

  test('database pane does not overflow the viewport at phone width', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await enterStudioShell(page, auth!);
    await openProject(page);
    await page.locator('[data-id="mobile-nav-toggle"]').click();
    await page.locator('[data-id="mobile-view-database"]').click();
    await expect(page.locator('[data-id="mobile-nav-drawer"]')).not.toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test('project picker fits a phone with no horizontal overflow', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await enterStudioShell(page, auth!); // lands on the picker (no project opened)
    await expect(page.getByRole('button', { name: /Create Project/ })).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});

// The landing page renders for non-native browsers, so this needs NO auth.
test.describe('Mobile landing page', () => {
  test('landing has no horizontal overflow at phone width', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.goto('/'); // non-native browser → landing page
    await expect(page.getByText('Three layers.', { exact: false }).first()).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
