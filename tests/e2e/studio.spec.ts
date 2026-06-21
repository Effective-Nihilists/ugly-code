import { expect, test } from '@playwright/test';
import { loadDevAuth } from './helpers/auth';
import { enterStudioShell } from './helpers/studio';

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

  test('Create Project scaffolds via initProject and opens the project', async ({ page }) => {
    // Mock the OS process the scaffold spawns; we drive it to success below.
    const mock = await enterStudioShell(page, auth!, {
      'process.spawn': { id: 'init1', pid: 4242 },
    });

    // 'New Project' is the default active action.
    await page.getByPlaceholder('my-side-project').fill('e2e-demo-project');
    await page.getByRole('button', { name: /Create Project/ }).click();

    // No longer dead: the button enters the creating state and the real
    // initProject handler spawns the scaffold (bash -lc "npx … ugly-app init").
    await expect(page.getByRole('button', { name: /Creating/ })).toBeVisible();
    await mock.expectInvoked('process.spawn');

    // Drive the mocked scaffold to success: print the resolved abs path, exit 0.
    await page.waitForTimeout(400); // let the process facade subscribe to id-channels
    await mock.emit('process.stdout:init1', { chunk: '/tmp/e2e-demo-project\n' });
    await mock.emit('process.exit:init1', { code: 0 });

    // initProject resolves → onProjectOpen → StudioProjectPage mounts.
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
  // POST /api/agentTurn → ugly.bot /v1/ai → assistant reply. Needs a real session
  // + a DB-backed dev server (DATABASE_URL). The assertion uses a computed answer
  // NOT present in the prompt, so it can't pass on the user-message echo.
  test('agent chat returns a real model reply in an opened project', async ({ page }) => {
    test.skip(!REAL_AI, 'Set RUN_REAL_SMOKE=1 (+ DATABASE_URL on the dev server) to hit live ugly.bot AI');

    // Capture the real /api/agentTurn reply — the model's answer is the source
    // of truth (robust to streaming-render timing in the DOM). A computed answer
    // (17×3=51) NOT present in the prompt rules out matching the user echo.
    let reply = '';
    page.on('response', (res) => {
      if (!res.url().includes('/api/agentTurn')) return;
      void res
        .json()
        .then((j: { result?: { content?: Array<{ type?: string; text?: string }> } }) => {
          for (const p of j.result?.content ?? []) if (p.type === 'text') reply += p.text ?? '';
        })
        .catch(() => undefined);
    });

    await enterStudioShell(page, auth!);
    await page.getByRole('button', { name: /Open Folder/ }).first().click();
    await page.getByPlaceholder('/path/to/project').fill('/tmp/demo-project');
    await page.getByRole('button', { name: /Open Folder →/ }).click();

    const prompt = page.locator('[data-id=home-prompt-input]');
    await expect(prompt).toBeVisible();
    await prompt.fill('Respond with only the result of 17 times 3 as digits.');
    await page.locator('[data-id=home-start-session]').click();

    // The real model, reached through the real UI send (NewSessionHero →
    // codingAgentChatSend → /api/agentTurn → ugly.bot /v1/ai), returns the
    // computed answer. This is the definitive end-to-end proof the agent works.
    await expect.poll(() => reply, { timeout: 60_000, message: 'agentTurn reply' }).toContain('51');
  });

  // STILL BROKEN (out of scope — user chose create+open+chat, not eval): "Run
  // eval" opens EvalPickerModal which loads evalListTasks, stubbed to
  // `{tasks:[]}` with no eval task data in the repo → blank picker. Asserts the
  // correct behavior; un-`fixme` once eval tasks are wired.
  test.fixme('Run eval lists at least one eval task', async ({ page }) => {
    await enterStudioShell(page, auth!);
    await page.getByText('Run eval').click();
    await expect(page.getByText(/difficulty|bug-fix|feature|planning/i).first()).toBeVisible({
      timeout: 8_000,
    });
  });
});
