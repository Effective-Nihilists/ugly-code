import { expect, test } from '@playwright/test';
import { installUglyNativeMock } from 'ugly-app/playwright';
import type { AgentMessage } from '../../shared/agent';

// DETERMINISTIC coding-harness e2e. Drives the REAL AgentPanel loop end-to-end
// in a browser with NO server and NO AI:
//   - `installUglyNativeMock` provides an in-page window.UglyNative so the tool
//     dispatcher (native.fs.*) resolves against canned results.
//   - `window.__uglyCodeAgentStep` (AgentPanel's test seam) is a scripted model:
//     it returns pre-baked turns, so the loop's tool dispatch + tool_result
//     feedback + final answer all run offline and reproducibly.
// This exercises AgentPanel UI → engine.runAgent → dispatchTool → UglyNative,
// the whole client-side harness, on every CI run for free.

/** Serialize scripted model turns into an init script that defines the seam. */
function scriptModel(turns: AgentMessage[]): string {
  return `
    window.__agentTurns = ${JSON.stringify(turns)};
    window.__agentTurnIdx = 0;
    window.__uglyCodeAgentStep = function () {
      var t = window.__agentTurns[window.__agentTurnIdx++];
      return Promise.resolve({ message: t });
    };
  `;
}

test.describe('coding-agent harness (deterministic)', () => {
  test('runs a multi-tool turn: list_dir → read_file → final answer', async ({ page }) => {
    const mock = await installUglyNativeMock(page, {
      platform: 'desktop',
      results: {
        'permissions.request': { granted: { fs: 'full', process: 'full' } },
        'fs.readdir': {
          entries: [
            { name: 'README.md', isFile: true, isDirectory: false },
            { name: 'src', isFile: false, isDirectory: true },
          ],
        },
        'fs.readFile': { content: '# Ugly Code\nThe IDE, as a web app.' },
      },
    });

    await page.addInitScript(
      scriptModel([
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Listing the workspace.' },
            { type: 'tool_use', id: 'tu1', name: 'list_dir', input: { path: '.' } },
          ],
        },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu2', name: 'read_file', input: { path: 'README.md' } }],
        },
        { role: 'assistant', content: 'Done — this is Ugly Code; it has a README and a src/ directory.' },
      ]),
    );

    await page.goto('/test/agent');
    await expect(page.locator('[data-id=agent-panel]')).toBeVisible();

    await page.locator('[data-id=agent-input]').fill('List the files and read the README.');
    // Submit via Enter (AgentPanel sends on Enter w/o Shift). Avoids the global
    // fixed FeedbackButton in the bottom-right corner intercepting a send click.
    await page.locator('[data-id=agent-input]').press('Enter');

    // User bubble echoes the prompt.
    await expect(page.locator('[data-id=agent-user]')).toContainText('read the README');
    // Both tools were dispatched and rendered (each tool yields a call row +
    // a result row; .first() picks the call row to dodge strict-mode).
    await expect(page.locator('[data-id=agent-tool][data-tool=list_dir]').first()).toBeVisible();
    await expect(page.locator('[data-id=agent-tool][data-tool=read_file]').first()).toBeVisible();
    // The list_dir result row shows the success marker.
    await expect(page.locator('[data-id=agent-tool][data-tool=list_dir]').last()).toContainText('✓');
    // Final assistant answer rendered and the busy indicator cleared.
    await expect(page.locator('[data-id=agent-assistant]').last()).toContainText('Ugly Code');
    await expect(page.locator('[data-id=agent-busy]')).toHaveCount(0);

    // The tool dispatcher really hit the native protocol (not a UI-only fake).
    await mock.expectInvoked('fs.readdir', { path: '.' });
    await mock.expectInvoked('fs.readFile', { path: 'README.md' });
  });

  test('renders a tool error and the model recovers', async ({ page }) => {
    await installUglyNativeMock(page, {
      platform: 'desktop',
      results: { 'permissions.request': { granted: { fs: 'full', process: 'full' } } },
    });

    await page.addInitScript(
      scriptModel([
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'e1', name: 'bogus_tool', input: {} }],
        },
        { role: 'assistant', content: 'Recovered after the unknown tool.' },
      ]),
    );

    await page.goto('/test/agent');
    await page.locator('[data-id=agent-input]').fill('do the thing');
    // Submit via Enter (AgentPanel sends on Enter w/o Shift). Avoids the global
    // fixed FeedbackButton in the bottom-right corner intercepting a send click.
    await page.locator('[data-id=agent-input]').press('Enter');

    // Unknown tool → dispatchTool throws → engine feeds the error back →
    // the tool row renders the ✗ failure marker, then the model recovers.
    // The result row (last of the call+result pair) carries the ✗ + message.
    const errorRow = page.locator('[data-id=agent-tool][data-tool=bogus_tool]').last();
    await expect(errorRow).toContainText('✗');
    await expect(errorRow).toContainText('Unknown tool');
    await expect(page.locator('[data-id=agent-assistant]').last()).toContainText('Recovered');
    await expect(page.locator('[data-id=agent-busy]')).toHaveCount(0);
  });
});
