---
name: fix-feedback
description: Fetch prod user feedback and fix reported issues
user-invocable: true
---

Fetch recent user feedback from the project's **production** Cloudflare D1 and fix the
reported issues.

Feedback is written only by the deployed app, so this is prod-only:

```bash
npx ugly-app feedback            # add --limit <n> as needed
```

If it reports "No prod Cloudflare D1 found", the app hasn't been deployed yet — run
`npm run deploy` first.

For each piece of feedback:
1. Understand the user's issue or request
2. Implement the fix or feature — **no matter how large or complex**
3. Run `npm run build` to verify it compiles

## Ambition policy

**You must attempt every piece of feedback.** There is no such thing as "too complex" or "too risky" or "out of scope." If a user asked for it, build it. This includes:

- New pages, new collections, new API endpoints
- Major UI redesigns or layout overhauls
- Adding entirely new features (search, filtering, sorting, animations, themes)
- Generating images with `npm run imageGen` when visuals are needed
- Writing migrations when collection schemas must change
- Multi-file changes that touch client, server, and shared simultaneously

The only valid reason to decline feedback is if it contradicts a Critical Rule in CLAUDE.md (e.g. "commit .env" or "add `any` types"). Everything else gets built.

If you're unsure how to implement something, read the existing code, read the ugly-app API reference, and figure it out. Do not skip it. Do not defer it. Do not say "this would require significant refactoring" — just do the refactoring.

## Using screenshots

Bot-submitted feedback (and any feedback from the studio's bug-report flow) includes `context.screenshotPath` — an absolute path to the PNG the user/persona saw when they wrote the feedback. **Look at it before proposing a fix.** The written message alone is insufficient context for layout, contrast, spacing, image-rendering, or overlap work — the user is reacting to what they SAW.

- If `analyze_image` is available (ugly-studio coding-agent):

  ```
  analyze_image(
    path=context.screenshotPath,
    query="describe the area the user is reacting to; list any visible
           defects in layout, contrast, copy, or image rendering"
  )
  ```

  Run multiple targeted queries when the feedback is non-trivial — one for the affected region, one to OCR any visible text the user references, one for colors/contrast if the complaint is design-related. `analyze_image` is Haiku-cheap; vague one-shots waste tokens.

- If the active model is vision-capable (Claude Code CLI, Claude/GPT/Gemini framework models): `Read(context.screenshotPath)` inlines the image directly.

Cross-reference what you see with `context.elementMap` (next section) to translate visual descriptions into source-file references.

**Do NOT propose a visual fix without inspecting the screenshot.** Element maps describe DOM state; the screenshot is the only record of what the user perceived.

## Using element maps

Feedback may include an `elementMap` field — a JSON snapshot of every interactive element on the page with:
- **Structural:** `dataId`, `tag`, `role`, `ariaLabel`, `text`, bounding `rect`
- **Visual:** `computedStyle` with colors, fonts, spacing, shadows, opacity
- **Animation:** `duration`, `easing` from `data-anim-*` attributes
- **Source:** `dataSource` mapping to the source file and line (e.g., `"client/pages/Home.tsx:42"`)
- **Theme:** `themeVars` with all `--app-*` CSS custom properties

Use this to:
- Map visual descriptions ("the button in the top right") to specific `data-id` values and source files
- See exact computed styles causing design issues (e.g., low contrast, wrong font size)
- Read animation configs (duration, easing) to adjust motion timing
- Go directly from `dataSource` to the file and line to edit
