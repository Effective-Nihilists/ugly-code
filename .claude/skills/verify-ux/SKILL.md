---
name: verify-ux
description: Probe the running app for objective UX defects (CLS, animation jank, control overlap, safe-area violations, keyboard covering inputs) after UI changes
user-invocable: true
---

After meaningful UI changes — new page, new popup, layout edits, animation work, mobile preview switch — call `inspect_ux` and act on what it finds. Don't declare UI work done without one clean probe.

## When to run

- Created or edited a page → probe its primary route + each interactive flow
- Added/modified a popup, modal, toast, or accordion → probe the open transition
- Touched animations, transitions, or scroll-driven effects → probe with `actions` driving the trigger
- Switched a screen to a new device profile → probe `device: 'ios'` and `device: 'android'`
- Added a form with focusable inputs near the bottom of a page → probe `simulate_keyboard: true`

## How to call

`inspect_ux` runs `window.__uglyInspect()` inside an off-screen browser pointed at your session's dev server. Observers run continuously from page load; the tool reads a measurement WINDOW so you can drive interactions and see what happened during them.

Examples:

```ts
// Initial page load on iOS
inspect_ux({ url_path: '/feed', device: 'ios' })

// SPA navigation jank
inspect_ux({ actions: [{ click: '[data-id=settings-link]' }, { wait: 800 }] })

// Popup entry transition
inspect_ux({ url_path: '/profile', actions: [{ click: '[data-id=edit-btn]' }, { wait: 600 }] })

// Mobile keyboard covering input
inspect_ux({
  url_path: '/signup',
  device: 'ios',
  actions: [
    { focus: '[data-id=email-field]' },
    { simulate_keyboard: true },
    { wait: 400 },
  ],
})

// Scroll-driven animations
inspect_ux({ actions: [{ scroll: { to: 2000 } }, { wait: 1200 }] })
```

## What to act on

The returned `UglyInspectReport` is structured JSON. Treat each of these as a build failure that must be fixed before declaring done:

| Field | Defect threshold |
|---|---|
| `cls.total` | > 0.1 — significant layout shift during the window |
| `longTasks[]` | Any entry > 100ms while an animation is in flight (`during` set) |
| `overlaps[]` | Any entry — two interactive controls share screen space |
| `safeAreaViolations[]` | Any entry — interactive element spills under notch / home indicator |
| `keyboard.coveredInputs[]` | Any entry — focused input rendered behind the on-screen keyboard |
| `animations[].droppedFrames` | > 2 dropped per animation |
| `popups[].droppedFrames` | > 2 — popup entry stutters |

For each defect:

1. Quote the offending `selector` from the report in your fix description.
2. Make the smallest CSS / layout change that resolves it (move the element inside the safe rect, raise z-index, defer the layout work, add a placeholder for async content, etc.).
3. Re-run `inspect_ux` with the same arguments to confirm the defect is gone before moving on.

## Don't

- Don't use `inspect_ux` for *aesthetic* judgments ("does this look pretty?"). For those, use `dev_server_screenshot` + `analyze_image`. `inspect_ux` is for objective, measurable defects only.
- Don't gate trivial fixes (typo, copy change, color tweak) on a clean inspect_ux run.
- Don't accept "the report has overlaps but they're decorative" without checking — if the report flagged it, the elements are tagged as interactive (`[data-id]`, `[role]`, `button`, `input`, `a`).
