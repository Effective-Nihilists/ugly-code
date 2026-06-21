import { expect, test } from '@playwright/test';

test.describe('App startup', () => {
  test('logged-out home shows the Studio landing page', async ({ page }) => {
    await page.goto('/');
    // HomeGate: no ugly.bot session → the Ugly Studio landing (download page).
    // (Authenticated visitors get the IDE picker instead.)
    await expect(page.getByText('Stacked, they ship.')).toBeVisible();
  });

  test('landing page offers a download', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText(/Download for/i).first()).toBeVisible();
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
    // The login CTA label is experiment-driven (cta-test → "Get started" |
    // "Try it free"); assert the button exists rather than a fixed string.
    await expect(
      page.getByRole('button', { name: /Get started|Try it free/ }),
    ).toBeVisible();
  });

  test('login button opens OAuth popup', async ({ page, context }) => {
    await page.goto('/auth-demo');

    // Listen for a new page (popup) when clicking the CTA — openLogin() does
    // window.open('https://ugly.bot/oauth?origin=…').
    const popupPromise = context.waitForEvent('page');
    await page.getByRole('button', { name: /Get started|Try it free/ }).click();
    const popup = await popupPromise;

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
