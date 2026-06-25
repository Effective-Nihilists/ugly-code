# Mobile-friendly layout for ugly-code

**Date:** 2026-06-24
**Status:** Approved design, ready for implementation plan

## Problem

ugly-code's client has no width-based responsive code. The viewport meta is
already mobile-correct (`width=device-width`, no zoom), but every surface is a
desktop-only layout. The workspace ([client/studio/StudioProjectPage.tsx][spp])
is a fixed 3-column flex (≈264px session sidebar · drag-resizer · main pane)
whose header crams a back button, project name, path, and a 5-tab segmented
control — none of which survives a ~375–430px phone.

The workspace runs inside the **ugly-studio iOS/Android native shell**, where
`UglyNative` is present, so the IDE mounts on a phone (the web `code.ugly.bot`
gate routes non-native browsers to the landing page). The landing page is still
reachable by mobile **web** visitors, so it must reflow too.

## Scope

Full parity across workspace **and** entry surfaces:

- **Workspace** — [StudioProjectPage.tsx][spp]: 3-column desktop layout → one
  full-width column + slide-in nav drawer.
- **Project picker** — [ProjectOnboarding.tsx][onb]: 2-col grid → 1-col.
- **Landing** — [StudioLandingPage.tsx][land]: extend existing `isDesktop`
  scaffolding; fix remaining hardcoded grids (mobile web).
- **Login** — [StudioLoginPrompt.tsx][login]: minor (safe-area + max-width).
- **Panels** — targeted overflow fixes only (tables, eval modal).

This is **pure layout/CSS work**. No `homeView` ungating, no remote/sidecar
transport, no backend changes.

## Non-goals (YAGNI)

- No bottom tab bar (single nav drawer was chosen).
- No keyboard-handling rewrite — native shell owns keyboard insets; flag if it
  misbehaves.
- No panel rewrites — drawer + reflow + horizontal-scroll wrappers only.
- No conversion of the landing page's existing `isDesktop` ternaries to CSS.

## Architecture

### Responsive primitive — `useIsMobile()`

New shared hook `client/studio/hooks/useIsMobile.ts`, backed by `matchMedia`,
subscribing to changes, returning a boolean at a **768px** breakpoint
(`max-width: 768px`).

We use a **JS hook** (not pure CSS media queries) for the workspace because
mobile swaps component *structure* — a fixed inline sidebar becomes an overlay
drawer; conditional rendering, not just styling. Pure-stylistic reflows (landing
grids, picker columns) may use the same hook or CSS media queries as convenient.

### Workspace — `StudioProjectPage`

Below 768px the layout collapses to **one full-width column + a slide-in
drawer**. At ≥768px the current desktop layout is rendered unchanged.

**Drawer** (`position: fixed`, anchored left, `translateX` transition, scrim
behind, z-index above the fixed feedback button). Top-to-bottom contents:

1. A "‹ Projects" back row (the desktop back button moves here on mobile).
2. A **Views** list — the 5 session tabs: Agent / Preview / File / Git /
   Database (these were the top segmented control on desktop).
3. The existing `<SessionListSidebar>` — session list + its `footerNav` prod
   views (Publish / Database / Errors / Events / Workers / Terminal).

Selecting **anything** in the drawer sets the active tab/session and closes the
drawer. Scrim click and a view-select both close it. `SessionListSidebar` is
unchanged — the Views row and back row live in the drawer wrapper inside
`StudioProjectPage`, not inside the sidebar component. (`SessionListSidebar` is
already `width:100%` / parent-controlled, so it drops into the drawer as-is.)

**Header** (mobile) simplifies to: ☰ hamburger (left) · current view/project
name, truncated · the existing fixed feedback button (top-right, already
reserves 42px of header padding). The path span and the top segmented tab
control are hidden below 768px.

**Content pane** goes full-width; the drag-resizer (`S.resizer`) is not rendered
on mobile.

Drawer open state is local React state in `StudioProjectPage`.

### Composer & safe area

The chat composer and the drawer respect `env(safe-area-inset-bottom/top)`. The
`--safe-area-inset-*` CSS vars and the `.safe-area` utility class already exist
in `client/styles.css` (today only `StudioShell` uses them). The composer's
toolbar (Permission · Model · Pattern · Reason) keeps its existing intentional
`overflow-x: auto` horizontal scroll — acceptable on mobile, not wrapped.

### Panels (full parity)

Most panes are already `width:100%`. Targeted fixes only, where the structural
audit found fixed dimensions:

- Wrap `DatabasePanel` tables in `overflow-x: auto`.
- Wrap / scroll the `EvalScorecard` results table; reduce the eval modal's 40px
  padding on mobile (modal is already `width: min(720px, 100%)`).
- Confirm `TerminalPanel` scrolls horizontally.

No structural rewrites of any panel.

### Entry surfaces

- **ProjectOnboarding** — the `gridTemplateColumns: minmax(380px,420px) 1fr`
  grid collapses to a single column below 768px; shrink the 56px gaps and top
  padding. (Inline styles switched via the hook.)
- **StudioLandingPage** — extend the existing `isDesktop` (900px) scaffolding:
  - Tools grid `repeat(3, 1fr)` → responsive (2-col then 1-col).
  - Eval results table (`130px 1fr 90px 90px`) → horizontal-scroll wrapper.
  - Hero `maxWidth: 720` → responsive.
  - Reduce oversized `gap: 48` blocks and section padding on mobile.
  - Constrain the `90vw × 70vw` radial-gradient overlay at narrow widths.
  - Apply `.safe-area` to the root container.
- **StudioLoginPrompt** — apply `.safe-area` + a container `maxWidth`. Minor.

### Global

- The fixed top-right feedback button must not overlap the drawer — keep the
  drawer's z-index above it. The header already reserves 42px for it.
- Apply safe-area insets to the mobile root surfaces.

## Testing

A Playwright spec at a **390px** viewport using the existing native mock
(`installUglyNativeMock` / the `__uglyCodeAgentStep` agent fixture — no real AI):

1. Mount the workspace.
2. Open the drawer via the ☰ hamburger; assert it overlays the content.
3. Switch a view from the drawer; assert the drawer closes and the pane changes.
4. Send a message through the composer.
5. Assert no horizontal overflow on the root (`scrollWidth <= clientWidth`).

Deterministic; reuses the existing fixtures and config.

## Open risks

- **Keyboard insets** inside the native shell are unverified here — if the
  composer is obscured by the on-screen keyboard, that's a native-shell /
  `safeArea.keyboard` concern to address separately, not in this layout pass.

[spp]: ../../../client/studio/StudioProjectPage.tsx
[onb]: ../../../client/studio/panels/ProjectOnboarding.tsx
[land]: ../../../client/pages/StudioLandingPage.tsx
[login]: ../../../client/pages/StudioLoginPrompt.tsx
