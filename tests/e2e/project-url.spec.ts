import { expect, test } from '@playwright/test';
import { loadDevAuth } from './helpers/auth';
import { enterStudioShell, openProject } from './helpers/studio';

// The open project is reflected in the URL as `?path=<local path>` so the
// workspace is deep-linkable, survives reload, and Back returns to the picker.
// Drives the REAL shell (StudioShell) with the canned native mock — no real AI,
// so these run unconditionally.
const auth = loadDevAuth();
const PROJECT = '/tmp/demo-project';

test.describe('project URL (?path=)', () => {
  test('opening a project reflects its local path in the URL', async ({ page }) => {
    await enterStudioShell(page, auth);
    expect(new URL(page.url()).searchParams.get('path')).toBeNull(); // picker has no path

    await openProject(page, PROJECT);
    await expect.poll(() => new URL(page.url()).searchParams.get('path')).toBe(PROJECT);
  });

  test('a ?path= URL deep-links straight into the workspace', async ({ page }) => {
    await enterStudioShell(page, auth); // lands on the picker at /
    await page.goto(`/?path=${PROJECT}`);

    // No picker interaction — the workspace mounts directly from the URL.
    await page.locator('[data-id=home-prompt-input]').waitFor();
    expect(new URL(page.url()).searchParams.get('path')).toBe(PROJECT);
  });

  test('Back from an open project returns to the picker and clears the path', async ({ page }) => {
    await enterStudioShell(page, auth);
    await openProject(page, PROJECT);

    await page.goBack();
    await page.getByRole('button', { name: /Open Folder/ }).first().waitFor();
    expect(new URL(page.url()).searchParams.get('path')).toBeNull();
  });
});

test.describe('workspace URL (?tab= / ?session=)', () => {
  test('the workspace tab is restored from the URL (survives reload)', async ({ page }) => {
    await enterStudioShell(page, auth);
    // Deep-link straight to the Git view of a project.
    await page.goto(`/?path=${PROJECT}&tab=git`);
    await page.locator('[data-id=git-panel]').waitFor({ timeout: 10_000 });
    expect(new URL(page.url()).searchParams.get('tab')).toBe('git');
  });

  test('selecting a tab writes ?tab= to the URL', async ({ page }) => {
    await enterStudioShell(page, auth);
    await openProject(page, PROJECT);
    await page.getByRole('button', { name: 'Database', exact: true }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('tab')).toBe('database');
  });
});
