import { expect, test } from '@playwright/test';
import { loadDevAuth } from './helpers/auth';
import { enterStudioShell, openProject } from './helpers/studio';

// REAL-APP e2e for the Studio shell — drives HomeGate → StudioShell →
// ProjectOnboarding / StudioProjectPage exactly as the user does (no synthetic
// fixture page, no scripted model). The desktop daemon's OS layer (fs/process)
// is the only mock; every Studio component, handler, route, and the AI are real.
//
// Requires a real session (~/.ugly-bot/auth.json); skips otherwise so CI without
// a login stays green.

const auth = loadDevAuth();
const REAL_AI = !!process.env['RUN_REAL_SMOKE'];

test.describe('Studio shell — real app', () => {
  test.skip(!auth, 'No ~/.ugly-bot/auth.json — run logged in to a real session');

  test('home renders the real project picker with restored styles', async ({ page }) => {
    await enterStudioShell(page, auth!);

    await expect(page.getByRole('button', { name: /Create Project/ })).toBeVisible();
    await expect(page.getByText('Run eval')).toBeVisible();

    // Style regression guard in the REAL home: the "Dream big." hero must be
    // big + use the heading font, and body must not fall back to serif.
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

  test('Create Project shows live progress, streams init output, then opens', async ({ page }) => {
    // Mock the OS process the scaffold spawns; we drive its output below.
    const mock = await enterStudioShell(page, auth!, {
      'process.spawn': { id: 'init1', pid: 4242 },
    });

    // 'New Project' is the default active action.
    await page.getByPlaceholder('my-side-project').fill('e2e-demo-project');
    await page.getByRole('button', { name: /Create Project/ }).click();

    // Hands off to the live progress view, which spawns the scaffold.
    await expect(page.locator('[data-id=project-creation-progress]')).toBeVisible();
    await mock.expectInvoked('process.spawn');

    // CLI output streams into the console as it arrives.
    await page.waitForTimeout(400); // let the process facade subscribe to id-channels
    await mock.emit('process.stdout:init1', {
      chunk: '[ugly-app] Creating project: e2e-demo-project\nInstalling dependencies...\n',
    });
    await expect(page.locator('[data-id=creation-output]')).toContainText('Installing dependencies');

    // The last stdout line is the resolved path; exit 0 → open the project.
    await mock.emit('process.stdout:init1', { chunk: '/tmp/e2e-demo-project\n' });
    await mock.emit('process.exit:init1', { code: 0 });

    await expect(page.getByRole('button', { name: /‹ Projects|Projects/ })).toBeVisible({
      timeout: 8_000,
    });
    await expect(page.getByText('e2e-demo-project').first()).toBeVisible();
  });

  test('opening a project reaches the real agent chat (NewSessionHero)', async ({ page }) => {
    await enterStudioShell(page, auth!);
    // Switch to the Open Folder action, type a path, open it (openProject echoes).
    await page.getByRole('button', { name: /Open Folder/ }).first().click();
    await page.getByPlaceholder('/path/to/project').fill('/tmp/demo-project');
    await page.getByRole('button', { name: /Open Folder →/ }).click();

    // StudioProjectPage → the real coding-agent entry (the New Session hero).
    await expect(page.getByRole('button', { name: /‹ Projects|Projects/ })).toBeVisible();
    await expect(page.locator('[data-id=home-prompt-input]')).toBeVisible();
  });

  // Full real loop: NewSessionHero → codingAgentChatSend → runClientAgentTurn →
  // POST /api/agentTurn → ugly.bot /v1/ai → assistant reply, RENDERED into the
  // transcript. Computed answers (NOT in the prompt) rule out matching the user
  // echo. Needs a real session + a DB-backed dev server (DATABASE_URL).
  //
  // Regression guard: a `session_state` event missing `finishPipeline` used to
  // crash CodingAgentChat (white screen) right after the reply, so the message
  // never rendered. We fail on ANY page error and assert the reply is actually
  // in `chat-messages-list` (not just that /api/agentTurn returned it).
  test('chat renders the user message + assistant reply (no crash)', async ({ page }) => {
    test.skip(!REAL_AI, 'Set RUN_REAL_SMOKE=1 (+ DATABASE_URL on the dev server) to hit live ugly.bot AI');
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await enterStudioShell(page, auth!);
    await openProject(page);

    await page.locator('[data-id=home-prompt-input]').fill('Respond with only the result of 17 times 3 as digits.');
    await page.locator('[data-id=home-start-session]').click();

    const list = page.locator('[data-id=chat-messages-list]');
    await expect(list).toContainText('51', { timeout: 60_000 }); // assistant reply rendered
    await expect(list).toContainText('17 times 3'); // user message is part of history
    expect(errors, `page crashed: ${errors.join('; ')}`).toEqual([]);
  });

  // Chat history must accumulate: a second turn keeps the first turn's prompt +
  // reply in the transcript (the bug above wiped the whole conversation).
  test('chat history accumulates across turns', async ({ page }) => {
    test.skip(!REAL_AI, 'Set RUN_REAL_SMOKE=1 (+ DATABASE_URL on the dev server) to hit live ugly.bot AI');
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await enterStudioShell(page, auth!);
    await openProject(page);
    const list = page.locator('[data-id=chat-messages-list]');

    // Turn 1 via the NewSessionHero.
    await page.locator('[data-id=home-prompt-input]').fill('What is 17 times 3? Reply with digits only.');
    await page.locator('[data-id=home-start-session]').click();
    await expect(list).toContainText('51', { timeout: 60_000 });

    // Turn 2 via the in-session composer (sends on Cmd/Ctrl+Enter).
    await page.locator('[data-id=chat-input]').fill('What is 8 times 9? Reply with digits only.');
    await page.locator('[data-id=chat-input]').press('ControlOrMeta+Enter');
    await expect(list).toContainText('72', { timeout: 60_000 });

    // Both turns persist in the rendered history.
    await expect(list).toContainText('51');
    await expect(list).toContainText('17 times 3');
    await expect(list).toContainText('8 times 9');
    expect(errors, `page crashed: ${errors.join('; ')}`).toEqual([]);
  });

  // "Run eval" loads the 59 ported task defs (client/studio/evals/registry.ts)
  // into the picker, sorted easy → hard. Pure client-side (no AI/native), so it
  // runs in the deterministic suite.
  test('Run eval lists the ported eval tasks', async ({ page }) => {
    await enterStudioShell(page, auth!);
    await page.getByText('Run eval').click();
    // Top-of-list (low difficulty) and a boss task both render.
    await expect(page.getByText('smoke-trivial-fix', { exact: true })).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('boss-chatgpt-clone', { exact: true })).toBeVisible();
  });
});
