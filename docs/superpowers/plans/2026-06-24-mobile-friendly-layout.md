# Mobile-friendly Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ugly-code's workspace and entry surfaces usable on a phone-sized screen (the ugly-studio iOS/Android native shell, plus mobile web for the landing page).

**Architecture:** A shared `useIsMobile()` hook (matchMedia, 768px) drives conditional rendering. The desktop 3-column workspace collapses below 768px to one full-width column plus a single slide-in nav drawer (back row + Views list + the existing `SessionListSidebar`). Entry surfaces (project picker, landing, login) reflow their grids to one column and respect safe-area insets. Desktop (≥768px) layout is untouched.

**Tech Stack:** React 18 (inline `style={}` objects), TypeScript (strict, no `any`), CSS custom properties in `client/styles.css`, Playwright e2e, Vitest unit tests.

## Global Constraints

- **Breakpoint:** workspace + picker use **768px** (`max-width: 768px` = mobile). The landing page keeps its existing **900px** `isDesktop` threshold (do not change it).
- **No `any` types** — `noExplicitAny` is enforced.
- **No emojis in UI** — use existing icon components; the hamburger is a small inline SVG, not "☰" text. (See `client/styles.css` / existing `navIcons.tsx` patterns.)
- **Desktop layout must not change** at ≥768px — all changes are gated behind the mobile branch.
- **Safe-area:** reuse the existing `--safe-area-inset-*` vars and `.safe-area` class already in `client/styles.css` (lines ~1371–1393). Do not redefine them.
- **Styles are inline `style={}` objects** in these components — follow that pattern; only add CSS to `styles.css` for things that need pseudo-classes/media queries.
- Run all e2e with the existing harness: `npx playwright test tests/e2e/<spec>` (auto-starts `npm run dev`). Workspace specs require `~/.ugly-bot/auth.json` and `test.skip(!auth, …)` so CI without a login stays green (mirror `tests/e2e/studio.spec.ts`).

---

### Task 1: `useIsMobile()` responsive hook

**Files:**
- Create: `client/studio/hooks/useIsMobile.ts`
- Test: `tests/unit/useIsMobile.test.ts`

**Interfaces:**
- Produces: `export function useIsMobile(maxWidth?: number): boolean` — returns `true` when `window.innerWidth <= maxWidth` (default `768`); re-renders on resize. SSR-safe (returns `false` when `window` is undefined).

This mirrors the existing `useIsDesktop()` inside `client/pages/StudioLandingPage.tsx:174-185` (which uses `window.innerWidth >= 900` + a `resize` listener), generalized into a shared hook with a parameterized threshold.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/useIsMobile.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useIsMobile } from '../../client/studio/hooks/useIsMobile';

function setWidth(px: number): void {
  Object.defineProperty(window, 'innerWidth', { value: px, configurable: true, writable: true });
}

describe('useIsMobile', () => {
  afterEach(() => { setWidth(1024); });

  it('is true at/below the default 768px breakpoint', () => {
    setWidth(390);
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(true);
  });

  it('is false above the breakpoint', () => {
    setWidth(1024);
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(false);
  });

  it('updates on resize', () => {
    setWidth(1024);
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(false);
    act(() => { setWidth(390); window.dispatchEvent(new Event('resize')); });
    expect(result.current).toBe(true);
  });

  it('honors a custom threshold', () => {
    setWidth(800);
    const { result } = renderHook(() => useIsMobile(900));
    expect(result.current).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/useIsMobile.test.ts`
Expected: FAIL — `Cannot find module '.../useIsMobile'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// client/studio/hooks/useIsMobile.ts
import { useEffect, useState } from 'react';

// True when the viewport is at or below `maxWidth` (default 768px). Mirrors the
// landing page's useIsDesktop() but generalized + inverted for the workspace
// drawer breakpoint. Used for conditional STRUCTURE swaps (drawer vs inline
// sidebar), which CSS media queries can't express on their own.
export function useIsMobile(maxWidth = 768): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(() =>
    typeof window === 'undefined' ? false : window.innerWidth <= maxWidth,
  );
  useEffect(() => {
    const onResize = (): void => setIsMobile(window.innerWidth <= maxWidth);
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [maxWidth]);
  return isMobile;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/useIsMobile.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add client/studio/hooks/useIsMobile.ts tests/unit/useIsMobile.test.ts
git commit -m "feat(mobile): add useIsMobile responsive hook"
```

---

### Task 2: Workspace mobile nav drawer

**Files:**
- Modify: `client/studio/StudioProjectPage.tsx` (the whole layout — header, root flex, content; the `S` style map at lines 355-376)
- Test: `tests/e2e/mobile-layout.spec.ts`

**Interfaces:**
- Consumes: `useIsMobile` from Task 1; the existing `SessionListSidebar` (`client/studio/panels/SessionListSidebar.tsx`, props `SessionListSidebarProps`, including `footerNav?: SidebarNavItem[]`); the existing `TABS`/`SESSION_TABS`/`WorkspaceTab` already defined in this file (lines 33-50).
- Produces: new stable selectors used by the e2e — `data-id="mobile-nav-toggle"` (hamburger), `data-id="mobile-nav-drawer"` (the sliding panel), `data-id="mobile-nav-scrim"` (backdrop), and `data-id="mobile-view-<id>"` for each Views-list row (e.g. `mobile-view-preview`).

**Behavior:** Below 768px the root no longer renders the inline sidebar, the resizer, the path span, or the top segmented tab control. Instead the header shows a hamburger + the active view's label, and a `drawerOpen` state toggles a fixed, left-anchored, `translateX` drawer over a scrim. The drawer contains, top-to-bottom: a "‹ Projects" back row (calls `onBack`), a "Views" list of the 5 `TABS` (each sets `tab` + closes the drawer), then the existing `<SessionListSidebar>` (with its `footerNav`; selecting a session or footer item also closes the drawer). At ≥768px the existing desktop layout renders unchanged.

- [ ] **Step 1: Write the failing e2e test**

```ts
// tests/e2e/mobile-layout.spec.ts
import { expect, test } from '@playwright/test';
import { loadDevAuth } from './helpers/auth';
import { enterStudioShell, openProject } from './helpers/studio';

const auth = loadDevAuth();
const PHONE = { width: 390, height: 844 };

test.describe('Mobile workspace — nav drawer', () => {
  test.skip(!auth, 'No ~/.ugly-bot/auth.json — run logged in to a real session');

  test('drawer opens, switches view, and closes; no horizontal overflow', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await enterStudioShell(page, auth!);
    await openProject(page); // mounts StudioProjectPage + chat

    // Desktop chrome is hidden on a phone: the top segmented tab control is gone.
    await expect(page.locator('[data-id="tab-preview"]')).toHaveCount(0);

    // The hamburger is present; the drawer starts closed.
    const toggle = page.locator('[data-id="mobile-nav-toggle"]');
    await expect(toggle).toBeVisible();
    await expect(page.locator('[data-id="mobile-nav-drawer"]')).not.toBeVisible();

    // Open the drawer, switch to Preview, drawer closes and the pane is shown.
    await toggle.click();
    await expect(page.locator('[data-id="mobile-nav-drawer"]')).toBeVisible();
    await page.locator('[data-id="mobile-view-preview"]').click();
    await expect(page.locator('[data-id="mobile-nav-drawer"]')).not.toBeVisible();
    await expect(page.locator('[data-id="preview-panel"]')).toBeVisible();

    // Re-open and dismiss via the scrim.
    await toggle.click();
    await expect(page.locator('[data-id="mobile-nav-drawer"]')).toBeVisible();
    await page.locator('[data-id="mobile-nav-scrim"]').click({ position: { x: 360, y: 400 } });
    await expect(page.locator('[data-id="mobile-nav-drawer"]')).not.toBeVisible();

    // No horizontal overflow of the document at phone width.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1); // allow sub-pixel rounding
  });
});
```

> Note: confirm the Preview pane's root carries `data-id="preview-panel"`. If `client/studio/panels/PreviewPanel.tsx`'s outer element has no `data-id`, add `data-id="preview-panel"` to it as part of this task (one-line attribute add; it has no behavioral effect).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx playwright test tests/e2e/mobile-layout.spec.ts --project=chromium`
Expected: FAIL — `[data-id="mobile-nav-toggle"]` never becomes visible (not implemented yet). (If no `auth.json`, it SKIPS — log in first so the test actually runs.)

- [ ] **Step 3: Add the hamburger icon + drawer state**

In `client/studio/StudioProjectPage.tsx`, add the hook import and a small inline hamburger icon near the top (after the existing imports, around line 25):

```tsx
import { useIsMobile } from '../studio/hooks/useIsMobile';
```

Inside `StudioProjectPage`, add state next to the other `useState` calls (around line 105):

```tsx
const isMobile = useIsMobile();
const [drawerOpen, setDrawerOpen] = React.useState(false);
// Close the drawer whenever we leave mobile (e.g. rotate to a wide tablet).
React.useEffect(() => { if (!isMobile) setDrawerOpen(false); }, [isMobile]);
```

Add a tiny icon component at the bottom of the file (next to `TabPickerStyles`):

```tsx
function HamburgerIcon(): React.ReactElement {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  );
}
```

- [ ] **Step 4: Branch the layout — desktop sidebar vs mobile drawer**

Replace the current single `return (...)` body. Keep the desktop sidebar + resizer ONLY when `!isMobile`; render the drawer when `isMobile`. The `<main>` becomes full-width on mobile. Concretely, in the JSX returned from `StudioProjectPage`:

Replace the sidebar+resizer block (lines 250-277, the `<div style={{ ...S.sidebar, width: sidebarW }}>…</div>` and the `<div style={S.resizer} … />`) with:

```tsx
{!isMobile && (
  <>
    <div style={{ ...S.sidebar, width: sidebarW }}>
      <SessionListSidebar {...sidebarProps} />
    </div>
    <div
      style={S.resizer}
      onPointerDown={startResize}
      role="separator"
      aria-orientation="vertical"
      title="Drag to resize"
    />
  </>
)}
```

Extract the `SessionListSidebar` props into a `sidebarProps` const just above the `return` so both the desktop sidebar and the mobile drawer reuse them verbatim (DRY) — move the existing `sessions`/`activeCompositeId`/`onSelect`/…/`footerNav` object into:

```tsx
const closeDrawer = React.useCallback(() => setDrawerOpen(false), []);
const sidebarProps = {
  sessions: sidebarSessions,
  activeCompositeId: activeSessionId ?? MAIN_PLACEHOLDER,
  onSelect: (id: string) => { selectSession(id); closeDrawer(); },
  onNewSession: () => { newSession(); closeDrawer(); },
  onArchiveSession: archiveSession,
  onResetMainSession: archiveSession,
  timeAgo: timeAgoShort,
  archivedCount: 0,
  onShowArchived: () => undefined,
  footerNav: [
    { id: 'publish', label: 'Publish', icon: <PublishIcon />, active: tab === 'publish', onClick: () => { setTab('publish'); closeDrawer(); } },
    { id: 'prodDatabase', label: 'Database', icon: <DatabaseIcon />, active: tab === 'prodDatabase', onClick: () => { setTab('prodDatabase'); closeDrawer(); } },
    { id: 'errors', label: 'Errors', icon: <ErrorsIcon />, active: tab === 'errors', onClick: () => { setTab('errors'); closeDrawer(); } },
    { id: 'events', label: 'Events', icon: <EventsIcon />, active: tab === 'events', onClick: () => { setTab('events'); closeDrawer(); } },
    { id: 'workers', label: 'Workers', icon: <WorkersIcon />, active: tab === 'workers', onClick: () => { setTab('workers'); closeDrawer(); } },
    { id: 'terminal', label: 'Terminal', icon: <TerminalIcon />, active: tab === 'terminal', onClick: () => { setTab('terminal'); closeDrawer(); } },
  ],
};
```

(`closeDrawer()` is a no-op visual on desktop since the drawer isn't rendered, but keeps one props object for both.)

- [ ] **Step 5: Add the mobile header + drawer JSX**

In the `<header style={S.header}>`, gate the desktop bits and add the mobile bits. Wrap the existing back button / name / path so they only show on desktop, and the hamburger + active-view label only on mobile:

```tsx
<header style={S.header}>
  <TabPickerStyles />
  {isMobile ? (
    <button data-id="mobile-nav-toggle" onClick={() => setDrawerOpen(true)} style={S.hamburger} aria-label="Open navigation">
      <HamburgerIcon />
    </button>
  ) : (
    <button data-id="back-to-projects" onClick={onBack} style={S.back}>‹ Projects</button>
  )}
  <span style={S.name}>{isMobile ? activeViewLabel : projectName}</span>
  {!isMobile && projectPath && <span style={S.path}>{projectPath}</span>}
  <span style={{ flex: 1 }} />
  {!isMobile && SESSION_TABS.includes(tab) && <div style={S.tabBar}>
    {/* unchanged segmented control */}
  </div>}
</header>
```

Where `activeViewLabel` is computed just above the return:

```tsx
const ALL_TAB_LABELS: Record<WorkspaceTab, string> = {
  chat: 'Agent', preview: 'Preview', file: 'File', git: 'Git', database: 'Database',
  publish: 'Publish', prodDatabase: 'Database', errors: 'Errors', events: 'Events',
  workers: 'Workers', terminal: 'Terminal',
};
const activeViewLabel = ALL_TAB_LABELS[tab];
```

Then, immediately inside the root `<div style={S.root}>` (after the `<main>`), add the drawer (rendered only on mobile, and only mounted when open or animating — simplest: always render when `isMobile`, slide via transform):

```tsx
{isMobile && (
  <>
    <div
      data-id="mobile-nav-scrim"
      onClick={closeDrawer}
      style={{ ...S.scrim, ...(drawerOpen ? S.scrimOpen : {}) }}
    />
    <div data-id="mobile-nav-drawer" style={{ ...S.drawer, ...(drawerOpen ? S.drawerOpen : {}) }}>
      <button onClick={() => { onBack(); closeDrawer(); }} style={S.drawerBack}>‹ Projects</button>
      <div style={S.viewsList}>
        {TABS.map((t) => (
          <button
            key={t.id}
            data-id={`mobile-view-${t.id}`}
            onClick={() => { setTab(t.id); closeDrawer(); }}
            style={{ ...S.viewRow, ...(tab === t.id ? S.viewRowActive : {}) }}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div style={S.drawerSidebar}>
        <SessionListSidebar {...sidebarProps} />
      </div>
    </div>
  </>
)}
```

- [ ] **Step 6: Add the mobile styles to the `S` map**

Append to the `S` object (after `placeholder`, line ~375). The drawer sits above the fixed feedback button (`z-index: 1000` in styles.css) so use 1100/1200. `visibility` toggles so the closed scrim/drawer aren't hit-testable (and Playwright's `not.toBeVisible()` passes):

```tsx
hamburger: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 28, background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer', flexShrink: 0, padding: 0 },
scrim: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', opacity: 0, visibility: 'hidden', transition: 'opacity 180ms ease, visibility 180ms ease', zIndex: 1100 },
scrimOpen: { opacity: 1, visibility: 'visible' },
drawer: { position: 'fixed', top: 0, left: 0, bottom: 0, width: 'min(86vw, 320px)', display: 'flex', flexDirection: 'column', background: 'var(--bg-panel)', borderRight: '1px solid var(--border)', transform: 'translateX(-100%)', visibility: 'hidden', transition: 'transform 200ms ease, visibility 200ms ease', zIndex: 1200, paddingTop: 'var(--safe-area-inset-top)', paddingBottom: 'var(--safe-area-inset-bottom)', boxSizing: 'border-box' },
drawerOpen: { transform: 'translateX(0)', visibility: 'visible' },
drawerBack: { flex: 'none', textAlign: 'left', fontFamily: 'var(--font-mono)', fontSize: 12, height: 40, padding: '0 14px', background: 'transparent', color: 'var(--text-primary)', border: 'none', borderBottom: '1px solid var(--border)', cursor: 'pointer' },
viewsList: { flex: 'none', display: 'flex', flexDirection: 'column', padding: '6px 0', borderBottom: '1px solid var(--border)' },
viewRow: { textAlign: 'left', fontFamily: 'var(--font-mono)', fontSize: 13, height: 40, padding: '0 14px', background: 'transparent', color: 'var(--text-muted)', border: 'none', cursor: 'pointer' },
viewRowActive: { color: 'var(--accent)', background: 'var(--bg-secondary)' },
drawerSidebar: { flex: 1, minHeight: 0, display: 'flex' },
```

- [ ] **Step 7: Run the e2e test to verify it passes**

Run: `npx playwright test tests/e2e/mobile-layout.spec.ts --project=chromium`
Expected: PASS — drawer opens, switching to Preview shows `preview-panel` and closes the drawer, scrim dismiss works, overflow ≤ 1px.

- [ ] **Step 8: Verify desktop is unchanged**

Run: `npx playwright test tests/e2e/studio.spec.ts --project=chromium`
Expected: PASS (no regression — desktop branch untouched).

- [ ] **Step 9: Typecheck + commit**

Run: `npx tsc --noEmit`
Expected: no errors.

```bash
git add client/studio/StudioProjectPage.tsx client/studio/panels/PreviewPanel.tsx tests/e2e/mobile-layout.spec.ts
git commit -m "feat(mobile): collapse workspace to nav drawer below 768px"
```

---

### Task 3: Composer safe-area + panel horizontal-overflow wrappers

**Files:**
- Modify: `client/studio/panels/CodingAgentChat.tsx` (composer container, lines ~8276-8283)
- Modify: `client/studio/panels/DatabasePanel.tsx` (table wrapper)
- Modify: `client/studio/panels/EvalScorecard.tsx` (results table / modal padding) — and/or the EvalScorecard modal block in `CodingAgentChat.tsx` lines ~8599-8641
- Test: extend `tests/e2e/mobile-layout.spec.ts`

**Interfaces:**
- Consumes: nothing new. Pure styling.
- Produces: no new selectors.

**Behavior:** The chat composer's bottom edge clears the home indicator via `env(safe-area-inset-bottom)`. Wide panels (Database table, eval results table) get an `overflow-x: auto` scroll container so they scroll internally instead of pushing the document wider than the viewport.

- [ ] **Step 1: Extend the e2e to assert no overflow on the Database pane**

Add to `tests/e2e/mobile-layout.spec.ts` a second test:

```ts
test('database pane does not overflow the viewport at phone width', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await enterStudioShell(page, auth!);
  await openProject(page);
  await page.locator('[data-id="mobile-nav-toggle"]').click();
  await page.locator('[data-id="mobile-view-database"]').click();
  await expect(page.locator('[data-id="mobile-nav-drawer"]')).not.toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});
```

- [ ] **Step 2: Run it to see the overflow failure (if any)**

Run: `npx playwright test tests/e2e/mobile-layout.spec.ts --project=chromium -g "database pane"`
Expected: FAIL if the table overflows; PASS already means the existing `paneScroll` (`overflow:auto`) wrapper handles it. If it PASSES, skip Steps 3-4 for DatabasePanel and just keep the regression test.

- [ ] **Step 3: Add the composer safe-area inset**

In `client/studio/panels/CodingAgentChat.tsx`, the composer outer container (~line 8276) currently has `padding: '8px 12px'`. Change its bottom padding to include the safe-area inset:

```tsx
// before: padding: '8px 12px',
paddingTop: 8, paddingLeft: 12, paddingRight: 12,
paddingBottom: 'calc(8px + var(--safe-area-inset-bottom))',
```

- [ ] **Step 4: Wrap wide tables in an overflow-x container**

In `client/studio/panels/DatabasePanel.tsx`, find the table root and ensure its nearest scroll parent allows horizontal scroll. Wrap the `<table>` (or grid) in:

```tsx
<div style={{ width: '100%', overflowX: 'auto' }}>
  {/* existing table */}
</div>
```

Do the same for the eval results table in `client/studio/panels/EvalScorecard.tsx`. For the eval modal in `CodingAgentChat.tsx` (~line 8626), reduce padding on small screens:

```tsx
// before: padding: 40,
padding: 'clamp(16px, 5vw, 40px)',
```

- [ ] **Step 5: Run the e2e to verify no overflow**

Run: `npx playwright test tests/e2e/mobile-layout.spec.ts --project=chromium`
Expected: PASS (both tests).

- [ ] **Step 6: Typecheck + commit**

Run: `npx tsc --noEmit` → no errors.

```bash
git add client/studio/panels/CodingAgentChat.tsx client/studio/panels/DatabasePanel.tsx client/studio/panels/EvalScorecard.tsx tests/e2e/mobile-layout.spec.ts
git commit -m "fix(mobile): composer safe-area + horizontal-scroll wide panels"
```

---

### Task 4: Project picker single-column reflow

**Files:**
- Modify: `client/studio/panels/ProjectOnboarding.tsx` (root grid, lines ~407-416)
- Test: extend `tests/e2e/mobile-layout.spec.ts`

**Interfaces:**
- Consumes: `useIsMobile` from Task 1.
- Produces: no new selectors (reuses the existing picker DOM).

**Behavior:** Below 768px the `minmax(380px,420px) 1fr` two-column grid becomes a single column, and the 56px gap/padding shrink so nothing overflows a 390px viewport.

- [ ] **Step 1: Write the failing e2e assertion**

Add to `tests/e2e/mobile-layout.spec.ts`:

```ts
test('project picker fits a phone with no horizontal overflow', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await enterStudioShell(page, auth!); // lands on the picker (no project opened)
  await expect(page.getByRole('button', { name: /Create Project/ })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});
```

- [ ] **Step 2: Run it to verify the overflow failure**

Run: `npx playwright test tests/e2e/mobile-layout.spec.ts --project=chromium -g "project picker"`
Expected: FAIL — `overflow` is positive (left column forces ≥380px → horizontal scroll at 390px with padding).

- [ ] **Step 3: Reflow the grid**

In `client/studio/panels/ProjectOnboarding.tsx`, import and call the hook:

```tsx
import { useIsMobile } from '../hooks/useIsMobile';
// inside the component:
const isMobile = useIsMobile();
```

Change the root grid container (~line 407-416) so the columns/gap/padding are mobile-aware:

```tsx
gridTemplateColumns: isMobile ? '1fr' : 'minmax(380px, 420px) 1fr',
gap: isMobile ? 24 : 56,
padding: isMobile ? '24px 16px' : '56px 40px 40px',
```

- [ ] **Step 4: Run the e2e to verify it passes**

Run: `npx playwright test tests/e2e/mobile-layout.spec.ts --project=chromium -g "project picker"`
Expected: PASS — `overflow` ≤ 1.

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc --noEmit` → no errors.

```bash
git add client/studio/panels/ProjectOnboarding.tsx tests/e2e/mobile-layout.spec.ts
git commit -m "feat(mobile): single-column project picker below 768px"
```

---

### Task 5: Landing page grid fixes + safe-area

**Files:**
- Modify: `client/pages/StudioLandingPage.tsx` (Tools grid ~line 1181, eval table ~line 1742, hero `maxWidth` ~line 504, oversized gaps ~656/1261/2075, radial gradient ~438-440, root container ~2302)
- Test: extend `tests/e2e/mobile-layout.spec.ts`

**Interfaces:**
- Consumes: the existing `isDesktop` (900px) flag already threaded through these components — DO NOT add `useIsMobile` here; use the existing `isDesktop` prop these blocks already receive.
- Produces: no new selectors.

**Behavior:** Mobile web visitors (the landing page is the non-native home) get a fully single-column page with no horizontal overflow. The landing page already collapses most grids when `!isDesktop`; this task fixes the remaining hardcoded grids and oversized spacing the audit flagged.

- [ ] **Step 1: Write the failing e2e assertion (no native, no auth)**

Add to `tests/e2e/mobile-layout.spec.ts` (this one needs NO auth — the landing page renders for non-native browsers, so put it in its own `describe` without the skip):

```ts
test.describe('Mobile landing page', () => {
  test('landing has no horizontal overflow at phone width', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.goto('/'); // non-native browser → landing page
    await expect(page.getByText('Dream big.', { exact: false }).first()).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run it to verify the overflow failure**

Run: `npx playwright test tests/e2e/mobile-layout.spec.ts --project=chromium -g "landing"`
Expected: FAIL — overflow positive (Tools `repeat(3,1fr)` + eval table fixed columns push past 390px).

- [ ] **Step 3: Fix the hardcoded grids + spacing**

In `client/pages/StudioLandingPage.tsx`, make each flagged block respect the existing `isDesktop` flag in scope:

- Tools grid (~1181): `gridTemplateColumns: isDesktop ? 'repeat(3, 1fr)' : '1fr'`
- Eval results table (~1742): wrap the grid in a horizontal scroller — `<div style={{ width: '100%', overflowX: 'auto' }}>…</div>` (keep the `130px 1fr 90px 90px` columns; they scroll instead of overflowing the page).
- Hero copy (~504): `maxWidth: isDesktop ? 720 : '100%'`
- Oversized gaps (~656, ~1261, ~2075): `gap: isDesktop ? 48 : 24`
- Radial gradient overlay (~438-440): `width: isDesktop ? '90vw' : '140vw', maxWidth: 1400` (keep it from forcing a wide layout; it's decorative `position:absolute`, but cap its contribution — verify it's `position:absolute`/`pointerEvents:none` so it never adds scroll width; if not, add `overflow: hidden` to its parent).
- Root container (~2302): add `className="safe-area"` (or merge the existing inline padding with the safe-area vars) so the notch/home-indicator are respected.

- [ ] **Step 4: Run the e2e to verify it passes**

Run: `npx playwright test tests/e2e/mobile-layout.spec.ts --project=chromium -g "landing"`
Expected: PASS — overflow ≤ 1.

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc --noEmit` → no errors.

```bash
git add client/pages/StudioLandingPage.tsx tests/e2e/mobile-layout.spec.ts
git commit -m "feat(mobile): single-column landing page + safe-area"
```

---

### Task 6: Login prompt polish

**Files:**
- Modify: `client/pages/StudioLoginPrompt.tsx` (root container ~lines 30-46)

**Interfaces:**
- Consumes: the existing `.safe-area` class.
- Produces: nothing.

**Behavior:** The login prompt centers cleanly on a phone and respects safe-area insets. It's already a centered grid with `maxWidth: 360` on the paragraph; this just adds safe-area padding and a container max-width so it never touches the screen edges or the notch.

- [ ] **Step 1: Add safe-area + container max-width**

In `client/pages/StudioLoginPrompt.tsx`, on the outer container (~line 30-40), add `className="safe-area"` and ensure inner content has a `maxWidth` and horizontal padding:

```tsx
<div className="safe-area" style={{ height: '100%', display: 'grid', placeItems: 'center', gap: 16, padding: '0 20px', boxSizing: 'border-box' }}>
  <div style={{ width: '100%', maxWidth: 360, display: 'grid', gap: 16, justifyItems: 'center', textAlign: 'center' }}>
    {/* existing heading / paragraph / button */}
  </div>
</div>
```

- [ ] **Step 2: Verify visually at phone width**

Run: `npx playwright test tests/e2e/mobile-layout.spec.ts --project=chromium` (full file — the login surface is exercised indirectly; no dedicated assertion needed since it's a centered card). Then manually: `npm run dev`, open the dev URL in a 390px window with native disabled + logged out, confirm the card is centered with edge padding.
Expected: card centered, no edge-touching, no overflow.

- [ ] **Step 3: Typecheck + commit**

Run: `npx tsc --noEmit` → no errors.

```bash
git add client/pages/StudioLoginPrompt.tsx
git commit -m "feat(mobile): safe-area + max-width on login prompt"
```

---

### Task 7: Full-suite verification

**Files:** none (verification only).

- [ ] **Step 1: Run the mobile e2e suite**

Run: `npx playwright test tests/e2e/mobile-layout.spec.ts --project=chromium`
Expected: all tests PASS (or SKIP where `auth.json` is absent — log in so the workspace tests actually run before claiming done).

- [ ] **Step 2: Run the desktop regression suites**

Run: `npx playwright test tests/e2e/studio.spec.ts tests/e2e/agent.spec.ts --project=chromium`
Expected: PASS — desktop layout + agent loop unaffected.

- [ ] **Step 3: Run unit tests + typecheck + lint**

Run: `npx vitest run tests/unit/useIsMobile.test.ts && npx tsc --noEmit && npx eslint client/studio/hooks/useIsMobile.ts client/studio/StudioProjectPage.tsx`
Expected: all green.

- [ ] **Step 4: Manual visual pass**

Run `npm run dev`; in the browser devtools device toolbar at 390px, walk: landing → (with native+auth) picker → open project → drawer → switch each view → send a chat message. Confirm no horizontal scrollbar anywhere and the drawer/scrim animate.

---

## Self-Review

**Spec coverage:**
- `useIsMobile()` hook → Task 1. ✓
- Workspace drawer (back row + Views list + SessionListSidebar, hamburger header, hidden resizer/path/segmented control, full-width pane) → Task 2. ✓
- Composer + drawer safe-area → Tasks 2 (drawer) + 3 (composer). ✓
- Panel overflow (Database/Eval/Terminal tables, eval modal padding) → Task 3. ✓ (Terminal: verified by the overflow assertion; it already scrolls — no code change unless the assertion fails.)
- ProjectOnboarding 1-col → Task 4. ✓
- StudioLandingPage grids/gaps/gradient/safe-area → Task 5. ✓
- StudioLoginPrompt → Task 6. ✓
- Mobile e2e (390px, native mock, drawer + no-overflow) → Tasks 2-5 build it incrementally; Task 7 runs the whole suite. ✓
- Feedback-button z-index (drawer above it) → Task 2 Step 6 (drawer z-index 1100/1200 > 1000). ✓

**Placeholder scan:** No TBD/TODO; every code step shows concrete code. The only conditional ("if the database pane already passes, skip Steps 3-4 for DatabasePanel") is a real branch with a defined outcome, not a placeholder.

**Type consistency:** `useIsMobile(maxWidth?: number): boolean` is defined in Task 1 and consumed identically in Tasks 2/4. `SidebarNavItem`/`SessionListSidebarProps` are the real exported types from `SessionListSidebar.tsx`. Selectors (`mobile-nav-toggle`, `mobile-nav-drawer`, `mobile-nav-scrim`, `mobile-view-<id>`) are introduced in Task 2 and reused verbatim in Tasks 3-5.

**Open risk (carried from spec):** keyboard insets inside the native shell are out of scope — flag separately if the composer is obscured.
