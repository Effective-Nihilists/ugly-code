import { expect, test } from '@playwright/test';
import { authenticate, loadDevAuth } from './helpers/auth';

// Proves the "login as me" plumbing end-to-end: injecting the developer's real
// ugly.bot session cookie (~/.ugly-bot/auth.json) makes the dev server treat
// the page as authenticated — the server validates the cookie and injects
// window.__AUTH_TOKEN__, which AuthDemoPage keys its logged-in view off.
//
// Skips (does not fail) when the token file is absent, so fresh checkouts / CI
// without a session still run green.

const auth = loadDevAuth();

test.describe('authenticated session (real cookie)', () => {
  test.skip(
    !auth,
    'No ~/.ugly-bot/auth.json — run inside a logged-in Ugly Studio env',
  );

  test('injected auth cookie renders the logged-in auth-demo view', async ({
    page,
  }) => {
    await authenticate(page, auth!);
    await page.goto('/auth-demo');

    await expect(page.getByText('Logged in')).toBeVisible();
    // The server-validated session exposes our real userId to the client.
    await expect(page.getByText(auth!.userId)).toBeVisible();
    await expect(page.getByText('You are not logged in.')).toHaveCount(0);
  });
});
