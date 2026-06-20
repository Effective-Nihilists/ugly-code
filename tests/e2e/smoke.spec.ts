import { expect, test } from '@playwright/test';

test('feedback button is present on the home page', async ({ page }) => {
  await page.goto('/');
  const feedbackBtn = page.locator('[data-id="feedback-button"]');
  await expect(feedbackBtn).toBeVisible();
});
