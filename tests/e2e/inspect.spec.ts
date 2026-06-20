import { expect, test } from '@playwright/test';
import {
  expectClean,
  inspectWindow,
  setDevice,
  simulateKeyboard,
  waitForApp,
} from 'ugly-app/playwright';

test.describe('inspect helper', () => {
  test('clean fixture page produces empty arrays', async ({ page }) => {
    await page.goto('/test/inspect-fixture');
    await waitForApp(page);
    const r = await inspectWindow(page, async () => {
      await page.waitForTimeout(200);
    });
    expect(r.cls.spikes).toEqual([]);
    expect(r.overlaps).toEqual([]);
    expect(r.safeAreaViolations).toEqual([]);
    await expectClean(page);
  });

  test('captures intentional CLS', async ({ page }) => {
    await page.goto('/test/inspect-fixture?simulate=cls');
    await waitForApp(page);
    const r = await inspectWindow(page, async () => {
      await page.waitForTimeout(1000);
    });
    expect(r.cls.spikes.length).toBeGreaterThan(0);
    expect(r.cls.total).toBeGreaterThan(0);
  });

  test('captures overlapping interactive controls', async ({ page }) => {
    await page.goto('/test/inspect-fixture?simulate=overlap');
    await waitForApp(page);
    const r = await inspectWindow(page, async () => {});
    expect(r.overlaps.length).toBeGreaterThan(0);
    const selectors = r.overlaps[0];
    expect(selectors.a.selector).toMatch(/overlap-[ab]/);
    expect(selectors.b.selector).toMatch(/overlap-[ab]/);
  });

  test('captures safe-area violations on iOS', async ({ page }) => {
    // Seed iOS safe-area insets into localStorage before navigation so
    // the inspect module's readSafeAreaInsets picks them up.
    await page.addInitScript(() => {
      localStorage.setItem(
        '__safeAreaInsets',
        JSON.stringify({ top: 59, right: 0, bottom: 34, left: 0 }),
      );
    });
    await page.goto('/test/inspect-fixture?simulate=safearea');
    await setDevice(page, 'ios');
    const r = await inspectWindow(page, async () => {});
    expect(r.safeAreaViolations.length).toBeGreaterThan(0);
    expect(r.safeAreaViolations[0].side).toBe('b');
  });

  test('captures keyboard covering input', async ({ page }) => {
    await page.goto('/test/inspect-fixture?simulate=keyboard');
    await setDevice(page, 'ios');
    const r = await inspectWindow(page, async () => {
      await page.locator('[data-id=fixture-input]').focus();
      await simulateKeyboard(page, 320);
      await page.waitForTimeout(400);
    });
    expect(r.keyboard.coveredInputs.length).toBeGreaterThan(0);
    expect(r.keyboard.coveredInputs[0].selector).toContain('fixture-input');
  });

  test('SPA navigation lands in route.transitions', async ({ page }) => {
    await page.goto('/test/inspect-fixture');
    await waitForApp(page);
    const r = await inspectWindow(page, async () => {
      await page.locator('[data-id=nav-to-other]').click();
      await page.waitForTimeout(600);
    });
    expect(r.route.transitions.length).toBeGreaterThanOrEqual(1);
    expect(r.route.transitions[0].to).toContain('inspect-fixture-other');
  });
});
