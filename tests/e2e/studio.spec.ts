import { expect, test } from '@playwright/test';
import { loadDevAuth } from './helpers/auth';
import { enterStudioShell } from './helpers/studio';

// REAL-APP e2e for the Studio shell — drives HomeGate → StudioShell →
// ProjectOnboarding exactly as the user does (no synthetic fixture page, no
// scripted model). Requires a real session (~/.ugly-bot/auth.json); skips
// otherwise so CI without a login stays green.
//
// These are the tests that SHOULD have existed: they render the real home and
// exercise its primary actions, so a dead "Create Project" / blank "Run eval"
// fails loudly instead of hiding behind a green fixture.

const auth = loadDevAuth();

test.describe('Studio shell — real app', () => {
  test.skip(!auth, 'No ~/.ugly-bot/auth.json — run logged in to a real session');

  test('home renders the real project picker with restored styles', async ({ page }) => {
    await enterStudioShell(page, auth!);

    // The real ProjectOnboarding picker — its primary actions.
    await expect(page.getByRole('button', { name: /Create Project/ })).toBeVisible();
    await expect(page.getByText('Run eval')).toBeVisible();

    // Style regression guard, in the REAL home (not a fixture): the "Dream big."
    // hero must be big + use the heading font, and body must not fall back to
    // browser-default serif.
    const hero = page.getByText('Dream big.', { exact: false }).first();
    await expect(hero).toBeVisible();
    const heroStyle = await hero.evaluate((el) => {
      const cs = getComputedStyle(el.closest('h1') ?? el);
      return { fontFamily: cs.fontFamily, fontSizePx: parseFloat(cs.fontSize) };
    });
    expect(heroStyle.fontFamily.toLowerCase()).toContain('jakarta');
    expect(heroStyle.fontSizePx).toBeGreaterThan(40);

    const bodyFont = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
    expect(bodyFont.toLowerCase()).toContain('inter');
  });

  // KNOWN-BROKEN (StudioShell is a Phase-1 stub): clicking "Create Project"
  // calls projects.beginProjectCreation, which only flips the active tab to a
  // `creating` state expecting an "EditorInner" to swap in
  // <ProjectCreationProgress> — but StudioShell renders ProjectOnboarding
  // directly and never reacts, and `initProject` isn't wired in nativeRequest.
  // So nothing happens. This test asserts the CORRECT behavior; it will pass
  // once the create flow is wired. Remove `.fixme` then.
  test.fixme('clicking Create Project starts project creation', async ({ page }) => {
    await enterStudioShell(page, auth!);
    await page.getByPlaceholder('my-side-project').fill('e2e-demo-project');
    await page.getByRole('button', { name: /Create Project/ }).click();
    // Expect to leave the picker for a creation/progress or the opened project.
    await expect(page.getByRole('button', { name: /Create Project/ })).toBeHidden({
      timeout: 8_000,
    });
  });

  // KNOWN-BROKEN (Phase-1 stub): "Run eval" opens EvalPickerModal, which loads
  // socket.request('evalListTasks') — wired but stubbed to `{ tasks: [] }`, and
  // there is no eval task data in the repo. So the picker is empty/blank.
  // Asserts the CORRECT behavior; un-`fixme` once eval tasks are wired.
  test.fixme('Run eval lists at least one eval task', async ({ page }) => {
    await enterStudioShell(page, auth!);
    await page.getByText('Run eval').click();
    // The picker should list selectable tasks.
    await expect(page.getByText(/difficulty|bug-fix|feature|planning/i).first()).toBeVisible({
      timeout: 8_000,
    });
  });
});
