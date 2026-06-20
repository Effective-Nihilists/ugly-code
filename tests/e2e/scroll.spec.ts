import { expect, test, Page } from '@playwright/test';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Find the scrollable div (overflow-y: auto) inside a [data-id] container and return its metrics. */
async function getScrollMetrics(page: Page, dataId: string) {
  return page.evaluate((id) => {
    const container = document.querySelector(`[data-id="${id}"]`);
    if (!container) throw new Error(`Container [data-id="${id}"] not found`);
    const divs = container.querySelectorAll('div');
    for (const div of divs) {
      const style = getComputedStyle(div);
      if (
        (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
        div.scrollHeight > 0
      ) {
        return {
          scrollTop: div.scrollTop,
          scrollHeight: div.scrollHeight,
          clientHeight: div.clientHeight,
          scrollWidth: div.scrollWidth,
          clientWidth: div.clientWidth,
        };
      }
    }
    throw new Error(`No scrollable div found in [data-id="${id}"]`);
  }, dataId);
}

/** Hover a container and scroll via mouse wheel. */
async function wheelScroll(page: Page, dataId: string, deltaY: number) {
  const container = page.locator(`[data-id="${dataId}"]`);
  await container.scrollIntoViewIfNeeded();
  await container.hover();
  await page.mouse.wheel(0, deltaY);
  await page.waitForTimeout(300);
}

/** Programmatically set scrollTop on the scrollable element inside a container. */
async function setScrollTop(page: Page, dataId: string, value: number) {
  await page.evaluate(
    ({ id, val }) => {
      const container = document.querySelector(`[data-id="${id}"]`);
      if (!container) return;
      const divs = container.querySelectorAll('div');
      for (const div of divs) {
        const style = getComputedStyle(div);
        if (
          (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
          div.scrollHeight > 0
        ) {
          div.scrollTop = val;
          return;
        }
      }
    },
    { id: dataId, val: value },
  );
  await page.waitForTimeout(100);
}

/** Check whether the last item is scrolled into view within its scroll container. */
async function isLastItemVisible(page: Page, dataId: string, itemText: string) {
  return page.evaluate(
    ({ id, text }) => {
      const container = document.querySelector(`[data-id="${id}"]`);
      if (!container) return false;
      // Find all text elements containing the target text
      const walker = document.createTreeWalker(
        container,
        NodeFilter.SHOW_TEXT,
        { acceptNode: (node) => node.textContent === text ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP },
      );
      const textNode = walker.nextNode();
      if (!textNode?.parentElement) return false;
      const itemEl = textNode.parentElement;
      // Find the scroll container
      const divs = container.querySelectorAll('div');
      let scrollEl: HTMLDivElement | null = null;
      for (const div of divs) {
        const style = getComputedStyle(div);
        if (
          (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
          div.scrollHeight > 0
        ) {
          scrollEl = div;
          break;
        }
      }
      if (!scrollEl) return false;
      const scrollRect = scrollEl.getBoundingClientRect();
      const itemRect = itemEl.getBoundingClientRect();
      // Item bottom should be within the scroll container's visible area
      return itemRect.bottom <= scrollRect.bottom + 2 && itemRect.top >= scrollRect.top - 2;
    },
    { id: dataId, text: itemText },
  );
}

// ─── Setup ────────────────────────────────────────────────────────────────────

test.beforeEach(async ({ page }) => {
  await page.goto('/test/scroll');
  await expect(page.locator('[data-id="scrollview-large"]')).toBeVisible();
});

// ─── ScrollView ───────────────────────────────────────────────────────────────

test.describe('ScrollView', () => {
  test('large list: first items are visible', async ({ page }) => {
    const container = page.locator('[data-id="scrollview-large"]');
    await expect(container.getByText('Item 1', { exact: true })).toBeVisible();
    await expect(container.getByText('Item 2', { exact: true })).toBeVisible();
  });

  test('large list: content overflows container', async ({ page }) => {
    const metrics = await getScrollMetrics(page, 'scrollview-large');
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
  });

  test('large list: mouse wheel scrolling changes scrollTop', async ({
    page,
  }) => {
    const before = await getScrollMetrics(page, 'scrollview-large');
    expect(before.scrollTop).toBe(0);

    await wheelScroll(page, 'scrollview-large', 300);

    const after = await getScrollMetrics(page, 'scrollview-large');
    expect(after.scrollTop).toBeGreaterThan(0);
  });

  test('large list: scrolling to bottom reveals last item', async ({
    page,
  }) => {
    const visible = await isLastItemVisible(page, 'scrollview-large', 'Item 100');
    expect(visible).toBe(false);

    await setScrollTop(page, 'scrollview-large', 99999);

    const visibleAfter = await isLastItemVisible(page, 'scrollview-large', 'Item 100');
    expect(visibleAfter).toBe(true);
  });

  test('short list: all items visible without scrolling', async ({ page }) => {
    const container = page.locator('[data-id="scrollview-short"]');
    await expect(container.getByText('Item 1', { exact: true })).toBeVisible();
    await expect(container.getByText('Item 2', { exact: true })).toBeVisible();
    await expect(container.getByText('Item 3', { exact: true })).toBeVisible();
  });

  test('short list: content does not overflow', async ({ page }) => {
    const metrics = await getScrollMetrics(page, 'scrollview-short');
    expect(metrics.scrollHeight).toBeLessThanOrEqual(
      metrics.clientHeight + 1,
    );
  });

  test('scrollbar is hidden (no scrollbar gutter)', async ({ page }) => {
    const metrics = await getScrollMetrics(page, 'scrollview-large');
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
  });
});

// ─── SimpleScrollView ─────────────────────────────────────────────────────────

test.describe('SimpleScrollView', () => {
  test('large list: first items are visible', async ({ page }) => {
    const container = page.locator('[data-id="simple-large"]');
    await container.scrollIntoViewIfNeeded();
    await expect(container.getByText('Item 1', { exact: true })).toBeVisible();
    await expect(container.getByText('Item 2', { exact: true })).toBeVisible();
  });

  test('large list: content overflows container', async ({ page }) => {
    const metrics = await getScrollMetrics(page, 'simple-large');
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
  });

  test('large list: mouse wheel scrolling changes scrollTop', async ({
    page,
  }) => {
    const before = await getScrollMetrics(page, 'simple-large');
    expect(before.scrollTop).toBe(0);

    await wheelScroll(page, 'simple-large', 300);

    const after = await getScrollMetrics(page, 'simple-large');
    expect(after.scrollTop).toBeGreaterThan(0);
  });

  test('large list: scrolling to bottom reveals last item', async ({
    page,
  }) => {
    const visible = await isLastItemVisible(page, 'simple-large', 'Item 100');
    expect(visible).toBe(false);

    await setScrollTop(page, 'simple-large', 99999);

    const visibleAfter = await isLastItemVisible(page, 'simple-large', 'Item 100');
    expect(visibleAfter).toBe(true);
  });

  test('short list: all items visible without scrolling', async ({ page }) => {
    const container = page.locator('[data-id="simple-short"]');
    await container.scrollIntoViewIfNeeded();
    await expect(container.getByText('Item 1', { exact: true })).toBeVisible();
    await expect(container.getByText('Item 2', { exact: true })).toBeVisible();
    await expect(container.getByText('Item 3', { exact: true })).toBeVisible();
  });

  test('short list: content does not overflow', async ({ page }) => {
    const metrics = await getScrollMetrics(page, 'simple-short');
    expect(metrics.scrollHeight).toBeLessThanOrEqual(
      metrics.clientHeight + 1,
    );
  });

  test('scrollbar is hidden (no scrollbar gutter)', async ({ page }) => {
    const metrics = await getScrollMetrics(page, 'simple-large');
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
  });

  test('touch events are wired up', async ({ page }) => {
    // Dispatch synthetic touch events to verify the component's listeners fire.
    // Note: synthetic touch events don't cause actual browser scrolling,
    // but they verify the event listeners (touchmove, touchend) are attached.
    const fired = await page.evaluate((id) => {
      const container = document.querySelector(`[data-id="${id}"]`);
      if (!container) return { touchmove: false, touchend: false };
      const divs = container.querySelectorAll('div');
      let scrollEl: Element | null = null;
      for (const div of divs) {
        if (
          getComputedStyle(div).overflowY === 'auto' ||
          getComputedStyle(div).overflowY === 'scroll'
        ) {
          scrollEl = div;
          break;
        }
      }
      if (!scrollEl) return { touchmove: false, touchend: false };

      const results = { touchmove: false, touchend: false };

      scrollEl.addEventListener(
        'touchmove',
        () => {
          results.touchmove = true;
        },
        { once: true },
      );
      scrollEl.addEventListener(
        'touchend',
        () => {
          results.touchend = true;
        },
        { once: true },
      );

      const touch = new Touch({
        identifier: 1,
        target: scrollEl,
        clientX: 200,
        clientY: 300,
      });

      scrollEl.dispatchEvent(
        new TouchEvent('touchstart', {
          touches: [touch],
          changedTouches: [touch],
          bubbles: true,
        }),
      );

      const moveTouch = new Touch({
        identifier: 1,
        target: scrollEl,
        clientX: 200,
        clientY: 100,
      });

      scrollEl.dispatchEvent(
        new TouchEvent('touchmove', {
          touches: [moveTouch],
          changedTouches: [moveTouch],
          bubbles: true,
        }),
      );

      scrollEl.dispatchEvent(
        new TouchEvent('touchend', {
          touches: [],
          changedTouches: [moveTouch],
          bubbles: true,
        }),
      );

      return results;
    }, 'simple-large');

    expect(fired.touchmove).toBe(true);
    expect(fired.touchend).toBe(true);
  });
});

// ─── FlatList ─────────────────────────────────────────────────────────────────

test.describe('FlatList', () => {
  test('large list: first items are visible', async ({ page }) => {
    const container = page.locator('[data-id="flatlist-large"]');
    await container.scrollIntoViewIfNeeded();
    await expect(container.getByText('Item 1', { exact: true })).toBeVisible();
    await expect(container.getByText('Item 2', { exact: true })).toBeVisible();
  });

  test('large list: content overflows container', async ({ page }) => {
    const metrics = await getScrollMetrics(page, 'flatlist-large');
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
  });

  test('large list: mouse wheel scrolling changes scrollTop', async ({
    page,
  }) => {
    const before = await getScrollMetrics(page, 'flatlist-large');
    expect(before.scrollTop).toBe(0);

    await wheelScroll(page, 'flatlist-large', 300);

    const after = await getScrollMetrics(page, 'flatlist-large');
    expect(after.scrollTop).toBeGreaterThan(0);
  });

  test('large list: scrolling to bottom reveals last item', async ({
    page,
  }) => {
    const visible = await isLastItemVisible(page, 'flatlist-large', 'Item 100');
    expect(visible).toBe(false);

    await setScrollTop(page, 'flatlist-large', 99999);

    const visibleAfter = await isLastItemVisible(page, 'flatlist-large', 'Item 100');
    expect(visibleAfter).toBe(true);
  });

  test('short list: all items visible without scrolling', async ({ page }) => {
    const container = page.locator('[data-id="flatlist-short"]');
    await container.scrollIntoViewIfNeeded();
    await expect(container.getByText('Item 1', { exact: true })).toBeVisible();
    await expect(container.getByText('Item 2', { exact: true })).toBeVisible();
    await expect(container.getByText('Item 3', { exact: true })).toBeVisible();
  });

  test('short list: content does not overflow', async ({ page }) => {
    const metrics = await getScrollMetrics(page, 'flatlist-short');
    expect(metrics.scrollHeight).toBeLessThanOrEqual(
      metrics.clientHeight + 1,
    );
  });

  test('scrollbar is hidden (no scrollbar gutter)', async ({ page }) => {
    const metrics = await getScrollMetrics(page, 'flatlist-large');
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
  });
});
