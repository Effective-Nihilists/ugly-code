import { test, expect } from '@playwright/test';
import { installUglyNativeMock } from 'ugly-app/playwright';

// The coding agent runs its loop CLIENT-SIDE: each model turn comes from the
// `agentStep` endpoint, and tool_use blocks execute against the native fs/process
// API. Here we (a) mock the native transport with the uglyNative framework and
// (b) inject a scripted `step` via window.__uglyCodeAgentStep, so the WHOLE loop
// runs in plain Chromium with no server or real model — proving the loop wires
// model tool calls → native ops → tool_result → final answer.

test('drives a tool round-trip: tool_use → native fs → tool_result → final answer', async ({
  page,
}) => {
  const mock = await installUglyNativeMock(page, {
    platform: 'desktop',
    results: {
      'permissions.request': { granted: { fs: 'full', process: 'full' } },
      'permissions.query': { granted: { fs: 'full', process: 'full' } },
      // The page lists the home dir on mount; the agent reads a specific file.
      'fs.readdir': { entries: [] },
      'fs.readFile': { content: '{\n  "name": "ugly-code"\n}' },
    },
  });

  // Scripted model: first turn reads package.json, second turn answers.
  await page.addInitScript(() => {
    let n = 0;
    (
      window as unknown as { __uglyCodeAgentStep: unknown }
    ).__uglyCodeAgentStep = () => {
      n += 1;
      if (n === 1) {
        return Promise.resolve({
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Let me read the manifest.' },
              {
                type: 'tool_use',
                id: 't1',
                name: 'read_file',
                input: { path: 'package.json' },
              },
            ],
          },
        });
      }
      return Promise.resolve({
        message: {
          role: 'assistant',
          content: 'This project is named ugly-code.',
        },
      });
    };
  });

  await page.goto('/');

  // The agent pane is part of the IDE chrome (native available).
  await expect(page.locator('[data-id="agent-panel"]')).toBeVisible();

  await page
    .locator('[data-id="agent-input"]')
    .fill('What is this project called?');
  await page.locator('[data-id="agent-send"]').click();

  // Auto-waiting assertions: these only resolve AFTER the loop has dispatched the
  // tool and round-tripped the result back through a second model turn.
  await expect(page.locator('[data-id="agent-user"]')).toContainText(
    'What is this project called?',
  );
  await expect(
    page.locator('[data-id="agent-assistant"]').first(),
  ).toContainText('Let me read the manifest');
  await expect(
    page.locator('[data-id="agent-tool"][data-tool="read_file"]'),
  ).toHaveCount(2); // call + result
  await expect(
    page.locator('[data-id="agent-assistant"]').last(),
  ).toContainText('named ugly-code');

  // The read_file tool bottomed out at the real native fs.readFile invoke.
  await mock.expectInvoked('fs.readFile', { path: 'package.json' });
});
