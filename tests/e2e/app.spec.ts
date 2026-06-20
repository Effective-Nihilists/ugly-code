import { expect, test } from '@playwright/test';

test.describe('App startup', () => {
  test('home page is the IDE (Ugly Code)', async ({ page }) => {
    await page.goto('/');
    // The home route is the IDE (CodeEditorPage). In a plain browser without
    // the Ugly Studio native bridge it renders the "open in Studio" fallback.
    await expect(page.getByText('Ugly Code')).toBeVisible();
  });

  test('home page tells unbridged browsers to open in Ugly Studio', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('[data-id="no-native"]')).toBeVisible();
    await expect(page.locator('[data-id="no-native"]')).toContainText('Ugly Studio');
  });

  test('navigating to a non-existent route returns 404', async ({ page }) => {
    const response = await page.goto('/this-route-does-not-exist');
    // Framework serves 404 for unmatched routes (see App.ts page route handler).
    // Client-side routing only applies to paths registered in shared/pages.ts.
    expect(response?.status()).toBe(404);
  });
});

test.describe('Auth flow', () => {
  test('auth-demo page shows login prompt when unauthenticated', async ({ page }) => {
    await page.goto('/auth-demo');
    await expect(page.getByText('You are not logged in.')).toBeVisible();
    await expect(page.getByText('Login with ugly.bot')).toBeVisible();
  });

  test('login button opens OAuth popup', async ({ page, context }) => {
    await page.goto('/auth-demo');

    // Listen for a new page (popup) when clicking login
    const popupPromise = context.waitForEvent('page');
    await page.getByText('Login with ugly.bot').click();
    const popup = await popupPromise;

    // The popup should navigate to the ugly.bot login page. AuthDemoPage opens
    // /oauth which redirects to /loginOAuth on ugly.bot.
    expect(popup.url()).toContain('ugly.bot/');
    expect(popup.url().toLowerCase()).toContain('oauth');
    await popup.close();
  });

  test('auth/verify endpoint rejects invalid code', async ({ request }) => {
    const response = await request.post('/auth/verify', {
      data: { code: 'invalid-code-12345' },
    });
    // Should not return 200 for an invalid OAuth code
    expect(response.status()).not.toBe(200);
  });
});
