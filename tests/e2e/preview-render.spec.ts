import { expect, test } from '@playwright/test';

/**
 * The Preview panel renders a project's dev server inside an <iframe>. A purely
 * transport-level check (curl a static page through the tunnel) is NOT enough —
 * it can't catch the real failure mode where a REAL ugly-app boots but then
 * strands the preview:
 *
 *   apex apps (`options.silentSso`) do a TOP-LEVEL redirect to
 *   `ugly.bot/oauth/silent?origin=<dev-origin>&redirect=1` on boot; ugly.bot
 *   400s "Invalid origin" for a localhost / *.trycloudflare.com origin, and the
 *   iframe is stranded on that blank error page → "nothing shows up".
 *
 * This test loads a REAL running dev server in the panel's EXACT iframe config
 * and asserts the app actually mounted (its #root has content) AND that it did
 * not navigate away to /oauth/silent. Fixed by ugly-app's `attemptSilentSso`
 * skipping the redirect for dev/preview origins (isDevPreviewOrigin).
 *
 * Gated on RUN_REAL_PREVIEW=1 — needs a project's dev server already running.
 * Point it at that server with PREVIEW_URL (e.g. a `pnpm dev` on :4567, or the
 * trycloudflare tunnel URL to exercise the mobile path):
 *
 *   RUN_REAL_PREVIEW=1 PREVIEW_URL=http://localhost:4567 \
 *     npx playwright test preview-render --project=chromium
 */
const RUN = process.env['RUN_REAL_PREVIEW'] === '1';
const PREVIEW_URL = process.env['PREVIEW_URL'] ?? 'http://localhost:4321';

// The panel's iframe, verbatim (client/studio/panels/PreviewPanel.tsx).
const IFRAME_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups';

test.describe('Preview panel renders a real dev server (not stranded on auth)', () => {
  test.skip(!RUN, 'set RUN_REAL_PREVIEW=1 + PREVIEW_URL=<running dev server>');
  test.setTimeout(60_000);

  test('the app mounts inside the panel iframe and does not redirect to /oauth/silent', async ({ page }) => {
    const wrapper = `<!doctype html><meta charset=utf8><body style="margin:0">
      <iframe id="pv" src="${PREVIEW_URL}" style="width:100vw;height:100vh;border:none"
              sandbox="${IFRAME_SANDBOX}"></iframe></body>`;
    await page.setContent(wrapper, { waitUntil: 'load' });

    // Wait for the app to actually mount inside the iframe.
    const host = new URL(PREVIEW_URL).host;
    let frame = null;
    for (let i = 0; i < 20 && !frame; i++) {
      // The specific failure: the app did a top-level bounce to ugly.bot's
      // silent-SSO endpoint (which 400s "Invalid origin" for a dev origin), so
      // the iframe navigated AWAY from the dev server. Surface it clearly.
      const stranded = page.frames().find((f) => f.url().includes('/oauth/silent'));
      expect(
        stranded?.url(),
        'preview stranded: the app redirected to ugly.bot/oauth/silent instead of rendering',
      ).toBeUndefined();
      frame = page.frames().find((f) => f.url().includes(host)) ?? null;
      await page.waitForTimeout(1000);
    }
    expect(frame, `iframe never loaded ${PREVIEW_URL}`).toBeTruthy();

    // #root must exist and have real rendered content (React mounted).
    const rootLen = await frame!
      .locator('#root')
      .evaluate((el) => el.innerHTML.length)
      .catch(() => -1);
    expect(rootLen, 'app #root should have rendered content').toBeGreaterThan(200);

    // And we must not be sitting on the "Invalid origin" error text.
    const bodyText = (await frame!.locator('body').innerText().catch(() => '')) || '';
    expect(bodyText).not.toContain('Invalid origin');
  });
});
