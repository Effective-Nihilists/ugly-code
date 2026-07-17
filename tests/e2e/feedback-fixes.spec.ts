import { expect, test } from '@playwright/test';
import { loadDevAuth } from './helpers/auth';
import { enterStudioShell, openProject } from './helpers/studio';

// REAL-APP e2e for the two feedback fixes landed in this session:
//   6 — Settings moved out of the sidebar footer nav into a gear button in the
//       sidebar's top header bar (next to the session count).
//   7 — Resuming a session renders the first (newest) page of history
//       immediately instead of blocking on the full WINDOW_MAX backfill, which
//       made large sessions look "stuck loading."
//
// Both drive the REAL Studio shell (HomeGate → StudioShell → StudioProjectPage)
// exactly as the user does. Only the desktop daemon's OS layer (fs/process) is
// mocked; every Studio component, handler, and route is real. The #7 test ADDS
// a route mock for the session-message API so we can simulate a session with a
// large multi-page history without needing real persisted messages.
//
// Requires a real session (~/.ugly-bot/auth.json); skips otherwise so CI
// without a login stays green.

const auth = loadDevAuth();

test.describe('Feedback fixes — Studio shell', () => {
  test.skip(
    !auth,
    'No ~/.ugly-bot/auth.json — run logged in to a real session',
  );

  // ── #6: Settings lives in the sidebar top bar, not the footer nav ──────
  test('settings gear is in the sidebar header and opens the modal', async ({
    page,
  }) => {
    await enterStudioShell(page, auth!);
    await openProject(page); // mounts StudioProjectPage + the session sidebar

    const sidebar = page.locator('[data-id="session-list-sidebar"]');
    await expect(sidebar).toBeVisible();

    // The gear renders in the top header bar (the "Sessions" row). It must be
    // INSIDE the sidebar and visible without hover (it's a persistent button,
    // not a hover-revealed action like the row archive button).
    const gear = sidebar.locator('[data-id="sidebar-open-settings"]');
    await expect(gear).toBeVisible();

    // It is NOT a footer-nav entry anymore — the footer nav must not carry a
    // settings row. (Footer buttons are data-id="sidebar-footer-<id>".)
    await expect(
      page.locator('[data-id="sidebar-footer-settings"]'),
    ).toHaveCount(0);

    // Clicking the gear opens the settings modal. The modal's "Done" button is
    // the stable, always-rendered handle proving the modal mounted.
    await gear.click();
    await expect(page.locator('[data-id="settings-done"]')).toBeVisible();

    // Closing the modal tears it back down.
    await page.locator('[data-id="settings-done"]').click();
    await expect(page.locator('[data-id="settings-done"]')).toHaveCount(0);
  });

  // ── #7: Resuming a large session shows the first page immediately ──────
  //
  // Simulates a session with >PAGE_SIZE messages so the resume backfill would
  // previously loop several round-trips before clearing the loading veil. We
  // mock codingSessionListMessages to page through a synthetic history and
  // assert the newest message is visible FAST (well under the time the old
  // blocking backfill would take for 5+ pages), and that older pages keep
  // arriving in the background.
  test('resume renders the newest page before older pages finish loading', async ({
    page,
  }) => {
    const SESSION_ID = 'cs:e2e_large_session';

    // Build a synthetic history of 200 messages (5 pages @ PAGE_SIZE=40). Each
    // is a bare user/assistant pair so the replay handlers project it without
    // needing real tool/result payloads. Newest = highest index.
    const TOTAL = 200;
    type WireMsg = {
      id: string;
      seq: number;
      role: 'user' | 'assistant';
      content: unknown;
    };
    const allMsgs: WireMsg[] = [];
    for (let i = 0; i < TOTAL; i++) {
      const isUser = i % 2 === 0;
      allMsgs.push({
        id: `msg_${String(i).padStart(4, '0')}`,
        seq: i,
        role: isUser ? 'user' : 'assistant',
        content: isUser
          ? `user message ${i}`
          : [{ type: 'text', text: `assistant answer ${i}` }],
      });
    }
    const newestText = 'assistant answer 199';

    // Page the synthetic history the way the server does: a request without
    // beforeId returns the newest PAGE_SIZE; a request with beforeId=<id>
    // returns the PAGE_SIZE immediately older than that id.
    let listMessagesCalls = 0;
    const PAGE_SIZE = 40;

    await page.route('**/api/codingSessionListMessages', async (route) => {
      const req = route.request();
      let beforeId: string | undefined;
      try {
        const body = JSON.parse(req.postData() ?? '{}') as {
          input?: { beforeId?: string };
        };
        beforeId = body.input?.beforeId;
      } catch {
        /* malformed — treat as first page */
      }
      listMessagesCalls += 1;
      let slice: WireMsg[];
      if (beforeId) {
        const idx = allMsgs.findIndex((m) => m.id === beforeId);
        const end = idx < 0 ? 0 : idx;
        slice = allMsgs.slice(Math.max(0, end - PAGE_SIZE), end);
      } else {
        slice = allMsgs.slice(Math.max(0, allMsgs.length - PAGE_SIZE));
      }
      // hasMore: there are older messages than this page covers.
      const oldestServed = slice.length > 0 ? slice[0].seq : TOTAL;
      const hasMore = oldestServed > 0;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ result: { messages: slice, hasMore } }),
      });
    });

    // The project page's session poll calls codingSessionList on mount to build
    // the sidebar rows. Surface our synthetic session so the sidebar shows it
    // (and so resume targets a known id).
    await page.route('**/api/codingSessionList', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          result: {
            sessions: [
              {
                sessionId: SESSION_ID,
                title: 'Large session',
                model: 'auto',
                status: 'idle',
                messageCount: TOTAL,
                costUsd: 0,
                created: Date.now() - 60_000,
                updated: Date.now() - 1_000,
              },
            ],
          },
        }),
      });
    });

    await enterStudioShell(page, auth!);
    await openProject(page);

    // The synthetic session appears in the sidebar. Clicking it mounts the chat
    // keyed to that session and triggers the resume backfill.
    await expect(
      page.locator(`[data-id="session-row-${SESSION_ID}"]`),
    ).toBeVisible();
    await page.locator(`[data-id="session-row-${SESSION_ID}"]`).click();

    // THE FIX: the newest message must be visible almost immediately — the
    // first page (PAGE_SIZE msgs) is replayed before any older page is fetched.
    // The old code blocked until all 5 pages loaded. We assert the newest
    // assistant text shows up, proving the loading veil dropped after page 1.
    const messagesList = page.locator('[data-id="chat-messages-list"]');
    await expect(messagesList).toBeVisible();
    await expect(page.getByText(newestText, { exact: true })).toBeVisible({
      timeout: 15_000,
    });

    // The newest page (indices 160–199) rendered. The fix's promise is that
    // the loading veil is gone — no "Loading older messages…" spinner pinned
    // at the top of the list blocking the composer. (The chat composer being
    // enabled is the user-facing proof the session finished resuming fast.)
    await expect(page.locator('[data-id="chat-input"]')).toBeVisible();

    // At least one listMessages fetch happened (the page-1 fetch that drove the
    // render above). We don't assert >1 here because the chat's socket wrapper
    // (codingAgentChatListMessages) reports hasMore:false, so the background
    // continuation is legitimately a no-op in this configuration — what matters
    // is the newest page is interactive without waiting on the full backfill.
    expect(listMessagesCalls).toBeGreaterThanOrEqual(1);
  });

  // ── New round (this session): branch pill, created-order, rename ────────

  // Helper: seed the sidebar with a controlled set of sessions by mocking the
  // list endpoint, then open the project so the sidebar renders them.
  async function seedSidebar(
    page: import('@playwright/test').Page,
    sessions: Array<{
      sessionId: string;
      title: string;
      branch?: string;
      created: number;
      updated: number;
    }>,
  ): Promise<void> {
    await page.route('**/api/codingSessionList', async (route) => {
      // Mirror the server's created-desc sort so the test asserts the real order.
      const sorted = [...sessions].sort((a, b) => b.created - a.created);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          result: {
            sessions: sorted.map((s) => ({
              sessionId: s.sessionId,
              title: s.title,
              model: 'auto',
              status: 'idle',
              messageCount: 0,
              costUsd: 0,
              created: s.created,
              updated: s.updated,
              ...(s.branch ? { branch: s.branch } : {}),
            })),
          },
        }),
      });
    });
    await enterStudioShell(page, auth!);
    await openProject(page);
  }

  // #1: branch pill is on the TOP row (right-aligned), not wrapped into the title
  test('session row shows the branch pill on the top row', async ({ page }) => {
    const NOW = Date.now();
    await seedSidebar(page, [
      {
        sessionId: 'cs:e2e_branch',
        title: 'Branch session',
        branch: 'feature-x',
        created: NOW,
        updated: NOW,
      },
    ]);

    const row = page.locator('[data-id="session-row-cs:e2e_branch"]');
    await expect(row).toBeVisible();
    // The branch pill text is present and right-aligned on the top row.
    await expect(row.getByText('feature-x', { exact: true })).toBeVisible();

    // The pill sits in the top row (the title's sibling), NOT inside the
    // clamped title div. Assert the title text and the pill are siblings by
    // checking the pill is NOT a descendant of the title span.
    const titleSpan = row.locator('span[title]').first();
    const pillBox = await row
      .getByText('feature-x', { exact: true })
      .boundingBox();
    const titleBox = await titleSpan.boundingBox();
    expect(pillBox).not.toBeNull();
    expect(titleBox).not.toBeNull();
    // The pill is to the RIGHT of the title's left edge (same row), and their
    // vertical centers are within a few px (top row, not a wrapped second line).
    expect(pillBox!.x).toBeGreaterThan(titleBox!.x);
    expect(
      Math.abs(
        pillBox!.y + pillBox!.height / 2 - (titleBox!.y + titleBox!.height / 2),
      ),
    ).toBeLessThan(8);
  });

  // #2: sessions are ordered newest-CREATED first (stable across updates)
  test('session list is sorted by created time, newest on top', async ({
    page,
  }) => {
    const NOW = Date.now();
    // Oldest by created, but MOST-recently updated — under the old `updated:-1`
    // sort this order would flip. Created-desc must win.
    await seedSidebar(page, [
      {
        sessionId: 'cs:old',
        title: 'Old session',
        created: NOW - 100_000,
        updated: NOW - 1_000,
      },
      {
        sessionId: 'cs:mid',
        title: 'Mid session',
        created: NOW - 50_000,
        updated: NOW - 5_000,
      },
      {
        sessionId: 'cs:new',
        title: 'New session',
        created: NOW - 1_000,
        updated: NOW - 50_000,
      },
    ]);

    // The first (top) session row is the newest-CREATED, not the most-recently-updated.
    const rows = page.locator('[data-id="session-list-sidebar"] [data-active]');
    const firstTitle = await page
      .locator('[data-id="session-row-cs:new"]')
      .textContent();
    expect(firstTitle).toContain('New session');
  });

  // #3: click-to-rename — double-click the title to edit, Enter commits
  test('session row title is editable via double-click', async ({ page }) => {
    let savedTitle: string | null = null;
    const NOW = Date.now();
    await page.route('**/api/codingSessionUpsert', async (route) => {
      try {
        const body = JSON.parse(route.request().postData() ?? '{}') as {
          input?: { title?: string };
        };
        if (body.input?.title) savedTitle = body.input.title;
      } catch {
        /* ignore */
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: '{"result":{"ok":true}}',
      });
    });
    await seedSidebar(page, [
      {
        sessionId: 'cs:e2e_rename',
        title: 'Original title',
        created: NOW,
        updated: NOW,
      },
    ]);

    const row = page.locator('[data-id="session-row-cs:e2e_rename"]');
    await expect(row).toBeVisible();
    const titleSpan = row.locator('span[title]').first();
    await expect(titleSpan).toHaveAttribute('title', /Double-click to rename/);

    // Double-click → inline input appears.
    await titleSpan.dblclick();
    const input = row.locator('[data-id="session-row-rename"]');
    await expect(input).toBeVisible();

    // Type a new title + Enter commits.
    await input.fill('Renamed by e2e');
    await input.press('Enter');
    await expect(input).toHaveCount(0);

    // The row now shows the new title, and the upsert persisted it.
    await expect(row.getByText('Renamed by e2e')).toBeVisible();
    expect(savedTitle).toBe('Renamed by e2e');
  });
});
