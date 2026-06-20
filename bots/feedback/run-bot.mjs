#!/usr/bin/env node
/**
 * Pre-validated feedback-bot driver. The bot-swarm skill calls this
 * once or twice per persona during Step 2 (Feedback Bots).
 *
 * Usage:
 *   node bots/feedback/run-bot.mjs <persona-slug>            # legacy: capture + submit in one pass
 *   node bots/feedback/run-bot.mjs <persona-slug> --capture  # crawl + screenshots only (no submit)
 *   node bots/feedback/run-bot.mjs <persona-slug> --submit   # submit findings.json (no Playwright)
 *
 * The two-phase form exists so the persona subagent can LOOK at the
 * just-captured screenshots (Read on PNG, or `analyze_image`) before
 * authoring findings.json. The single-pass form is the original
 * crawl+submit flow and is kept for callers that don't need vision.
 *
 * Reads `bots/feedback/active/<slug>/.env` for `BOT_TOKEN`, launches a
 * headless Chromium, browses the local dev server (`BASE_URL`,
 * default http://localhost:5400), captures a screenshot per page +
 * an element map, and submits one `feedback` entry per finding via
 * `npx ugly-app feedback:submit`.
 *
 * Why this is shipped instead of asked-of-the-model: every prior
 * cycle the manager re-invented this script and burned 20+ min
 * iterating on the playwright spawn, the screenshot path layout,
 * and the feedback-submit args. A known-good template short-circuits
 * that loop. Don't rewrite the I/O scaffolding.
 *
 * Output per route:
 *   - bots/journal/cycles/screenshots/<slug>/<page>.png
 *   - bots/journal/cycles/screenshots/<slug>/<page>.element-map.json
 *   - bots/journal/cycles/screenshots/<slug>/<page>.<interaction>.ux-report.json
 *       — one report per interaction (mount, hover-first, scroll-deep,
 *         focus-input by default). Each is a measurement WINDOW driven
 *         by the named action script, so animation jank and CLS that
 *         only appear during a specific gesture get isolated instead of
 *         conflated with page mount.
 *   - bots/journal/cycles/screenshots/<slug>/<page>.ux-report.json
 *       — kept as an alias for the `mount` report so callers that
 *         look for the legacy single-report path don't break.
 *   - feedback rows posted via `submitFeedbackBot` (data-proxy
 *     `db.captureFeedback` under the hood).
 *
 * Personas can override the default interaction set by writing
 * `bots/feedback/active/<slug>/interactions.json`:
 *
 *   [
 *     { "name": "mount", "actions": [] },
 *     { "name": "open-feedback",
 *       "actions": [{ "click": "[data-id=feedback-button]" },
 *                   { "wait": 600 }] }
 *   ]
 *
 * Action shapes mirror `ugly-app inspect:ux` and the studio coding-
 * agent `inspect_ux` tool: navigate / click / focus / hover /
 * scroll:{to|selector} / wait / simulate_keyboard.
 */
import { chromium } from 'playwright';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const execFileP = promisify(execFile);

const SLUG = process.argv[2];
if (!SLUG) {
  console.error(
    'Usage: node bots/feedback/run-bot.mjs <persona-slug> [--capture|--submit]',
  );
  process.exit(2);
}

const MODE_FLAG = process.argv[3];
let MODE; // 'capture' | 'submit' | 'both'
if (!MODE_FLAG) MODE = 'both';
else if (MODE_FLAG === '--capture') MODE = 'capture';
else if (MODE_FLAG === '--submit') MODE = 'submit';
else {
  console.error(`[${SLUG}] unknown mode flag "${MODE_FLAG}" — use --capture or --submit`);
  process.exit(2);
}

const BASE_URL =
  process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 4321}`;
const REPO = process.cwd();
const BOT_DIR = path.join(REPO, 'bots', 'feedback', 'active', SLUG);
const SCREENSHOTS_DIR = path.join(
  REPO,
  'bots',
  'journal',
  'cycles',
  'screenshots',
  SLUG,
);

// --- Read persona credentials ----------------------------------------
const envPath = path.join(BOT_DIR, '.env');
if (!fs.existsSync(envPath)) {
  console.error(`[${SLUG}] missing ${envPath} — run \`ugly-app auth:create-bot\` first`);
  process.exit(2);
}
const envText = fs.readFileSync(envPath, 'utf-8');
const BOT_TOKEN = envText.match(/^BOT_TOKEN=(.+)$/m)?.[1]?.trim();
if (!BOT_TOKEN) {
  console.error(`[${SLUG}] BOT_TOKEN missing in .env`);
  process.exit(2);
}

const personaPath = path.join(BOT_DIR, 'persona.md');
const personaText = fs.existsSync(personaPath)
  ? fs.readFileSync(personaPath, 'utf-8')
  : '';

// --- Pages to crawl --------------------------------------------------
// Defaults: home + every defined route. The manager populates
// `pages.json` per persona to override (e.g. mobile bots skip
// desktop-only flows).
let pages = ['/'];
const pagesJson = path.join(BOT_DIR, 'pages.json');
if (fs.existsSync(pagesJson)) {
  try {
    const parsed = JSON.parse(fs.readFileSync(pagesJson, 'utf-8'));
    if (Array.isArray(parsed) && parsed.every((p) => typeof p === 'string')) {
      pages = parsed;
    }
  } catch {
    /* fall back to default */
  }
}

// --- Element-map extractor (runs in browser context) -----------------
// Captures every interactive node + its computed style + bounding
// rect. The maintain bot reads this to ground its critique in actual
// DOM/style state instead of guessing from the screenshot alone.
async function captureElementMap(page) {
  return await page.evaluate(() => {
    const sel =
      '[data-id], [role], [aria-label], button, a, input, select, textarea, h1, h2, h3';
    const STYLE = [
      'color',
      'backgroundColor',
      'fontSize',
      'fontFamily',
      'fontWeight',
      'borderRadius',
      'opacity',
      'padding',
      'gap',
      'display',
    ];
    return Array.from(document.querySelectorAll(sel))
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      })
      .map((el) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        const style = {};
        for (const k of STYLE) {
          const v = cs.getPropertyValue(
            k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`),
          );
          if (v) style[k] = v;
        }
        return {
          dataId: el.getAttribute('data-id'),
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role'),
          ariaLabel: el.getAttribute('aria-label'),
          text: (el.textContent ?? '').slice(0, 80).trim(),
          rect: {
            x: Math.round(r.x),
            y: Math.round(r.y),
            w: Math.round(r.width),
            h: Math.round(r.height),
          },
          style,
        };
      });
  });
}

// --- Submit feedback via CLI -----------------------------------------
async function submitFeedback({ type, message, url, screenshot, elementMap }) {
  const args = [
    'ugly-app',
    'feedback:submit',
    '--type',
    type,
    '--message',
    message,
    '--token',
    BOT_TOKEN,
    '--url',
    url,
  ];
  if (screenshot) args.push('--screenshot', screenshot);
  if (elementMap) args.push('--element-map', elementMap);
  try {
    await execFileP('npx', args, { cwd: REPO, timeout: 30_000 });
  } catch (err) {
    console.error(`[${SLUG}] feedback submit failed:`, err.stderr ?? err.message);
  }
}

// --- Interaction scripts --------------------------------------------
// Each interaction defines a measurement window. The driver navigates
// fresh to the route, marks, runs the actions, settles, and reads
// `window.__uglyInspect()`. Personas override by writing
// `bots/feedback/active/<slug>/interactions.json` (same shape).
const DEFAULT_INTERACTIONS = [
  // Pure mount: no interaction. Catches initial CLS, hydration shifts,
  // safe-area violations, mount-time animations. Also produces the
  // screenshot + element-map for vision callers.
  { name: 'mount', actions: [] },
  // Hover-first: trigger hover transitions on the first non-feedback
  // interactive element. Cheap, surfaces hover-state animation jank.
  {
    name: 'hover-first',
    actions: [
      { hover: '[data-id]:not([data-id=feedback-button]):not(input):not(textarea)' },
      { wait: 600 },
    ],
  },
  // Scroll-deep: drives scroll-linked animations and any IntersectionObserver
  // entry animations. Two-stage scroll catches enter + exit jank.
  {
    name: 'scroll-deep',
    actions: [
      { scroll: { to: 1200 } },
      { wait: 800 },
      { scroll: { to: 0 } },
      { wait: 600 },
    ],
  },
  // Focus-input: opens the mobile keyboard simulation against the
  // first input. Surfaces keyboard-covers-input on mobile profiles and
  // focus-ring animation jank.
  {
    name: 'focus-input',
    actions: [
      { focus: 'input, textarea' },
      { simulate_keyboard: true },
      { wait: 400 },
    ],
  },
];

function loadInteractions() {
  const overridePath = path.join(BOT_DIR, 'interactions.json');
  if (!fs.existsSync(overridePath)) return DEFAULT_INTERACTIONS;
  try {
    const parsed = JSON.parse(fs.readFileSync(overridePath, 'utf-8'));
    if (
      Array.isArray(parsed) &&
      parsed.every(
        (e) =>
          e &&
          typeof e.name === 'string' &&
          Array.isArray(e.actions),
      )
    ) {
      return parsed;
    }
    console.error(
      `[${SLUG}] interactions.json malformed — falling back to defaults`,
    );
  } catch (err) {
    console.error(
      `[${SLUG}] interactions.json parse error: ${err.message} — falling back to defaults`,
    );
  }
  return DEFAULT_INTERACTIONS;
}

// Run a single action against a page. Mirrors the action schema used
// by `ugly-app inspect:ux` and the studio coding-agent `inspect_ux`
// tool so a persona's interactions.json is portable across harnesses.
async function runAction(page, action) {
  if ('navigate' in action) {
    await page.evaluate((to) => {
      window.history.pushState({}, '', to);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }, action.navigate);
  } else if ('click' in action) {
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) el.click?.();
    }, action.click);
  } else if ('focus' in action) {
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el && typeof el.focus === 'function') el.focus();
    }, action.focus);
  } else if ('hover' in action) {
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const init = {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      };
      el.dispatchEvent(new MouseEvent('mouseenter', init));
      el.dispatchEvent(new MouseEvent('mouseover', init));
    }, action.hover);
  } else if ('scroll' in action) {
    await page.evaluate((spec) => {
      if ('to' in spec) {
        window.scrollTo({ top: spec.to, behavior: 'smooth' });
      } else {
        const el = document.querySelector(spec.selector);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, action.scroll);
  } else if ('wait' in action) {
    await page.waitForTimeout(action.wait);
  } else if ('simulate_keyboard' in action) {
    const h =
      typeof action.simulate_keyboard === 'number'
        ? action.simulate_keyboard
        : action.simulate_keyboard
          ? 320
          : 0;
    await page.evaluate((height) => {
      window.dispatchEvent(
        new CustomEvent('keyboard-height', { detail: { height } }),
      );
    }, h);
  }
}

// --- Per-route helpers ----------------------------------------------
function routeFilenames(route) {
  const slugForFile = route === '/' ? 'home' : route.replace(/[^a-z0-9]+/gi, '-');
  return {
    slugForFile,
    screenshotPath: path.join(SCREENSHOTS_DIR, `${slugForFile}.png`),
    elementMapPath: path.join(SCREENSHOTS_DIR, `${slugForFile}.element-map.json`),
    legacyUxReportPath: path.join(SCREENSHOTS_DIR, `${slugForFile}.ux-report.json`),
    perInteractionUxReportPath: (name) =>
      path.join(SCREENSHOTS_DIR, `${slugForFile}.${name}.ux-report.json`),
    url: `${BASE_URL}${route}`,
  };
}

async function captureRoute(page, route, interactions) {
  const {
    screenshotPath,
    elementMapPath,
    legacyUxReportPath,
    perInteractionUxReportPath,
    url,
  } = routeFilenames(route);
  for (const interaction of interactions) {
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 15_000 });
    } catch (err) {
      console.error(
        `[${SLUG}] ${interaction.name}: failed to load ${url}: ${err.message}`,
      );
      return false;
    }
    let uxReport = null;
    try {
      const mark = await page.evaluate(
        () => window.__uglyInspectMark?.() ?? Date.now(),
      );
      for (const action of interaction.actions) {
        await runAction(page, action);
      }
      // Settle long enough for the smooth-scroll / hover transition to
      // finish before reading. 800ms matches the studio inspect_ux
      // default so reports are comparable across harnesses.
      await page.waitForTimeout(800);
      uxReport = await page.evaluate(
        (s) => window.__uglyInspect?.({ since: s }) ?? null,
        mark,
      );
    } catch {
      // window.__uglyInspect not installed (pre-0.1.489 ugly-app) — leave
      // uxReport null so downstream skills can detect the absence.
    }

    // The mount interaction owns the canonical screenshot + element-map
    // (clean DOM, no hover/focus state baked in) and the legacy
    // single-report path. Subsequent interactions only emit their own
    // ux-report file.
    if (interaction.name === 'mount') {
      await page.screenshot({ path: screenshotPath, fullPage: true });
      const elementMap = await captureElementMap(page);
      fs.writeFileSync(elementMapPath, JSON.stringify(elementMap, null, 2));
      if (uxReport) {
        fs.writeFileSync(legacyUxReportPath, JSON.stringify(uxReport, null, 2));
      }
    }
    if (uxReport) {
      fs.writeFileSync(
        perInteractionUxReportPath(interaction.name),
        JSON.stringify(uxReport, null, 2),
      );
    }
  }
  return true;
}

function loadFindings(route) {
  // The persona authors findings.json between `--capture` and `--submit`.
  // If absent or empty we emit a placeholder so the journal isn't empty.
  const findingsPath = path.join(BOT_DIR, 'findings.json');
  let findings = [];
  if (fs.existsSync(findingsPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(findingsPath, 'utf-8'));
      if (Array.isArray(parsed)) findings = parsed.filter((f) => f && f.message);
    } catch {
      /* ignore — fall through to placeholder */
    }
  }
  if (findings.length === 0) {
    findings = [
      {
        type: 'feature',
        message: `[${SLUG}] visited ${route} — no findings authored yet (drop them in bots/feedback/active/${SLUG}/findings.json)`,
      },
    ];
  }
  return findings;
}

async function submitForRoute(route) {
  const { screenshotPath, elementMapPath, url } = routeFilenames(route);
  // The screenshot/element-map are attached only if the capture phase
  // actually produced them (e.g. when running `--submit` after
  // `--capture`, or in `both` mode).
  const hasScreenshot = fs.existsSync(screenshotPath);
  const hasElementMap = fs.existsSync(elementMapPath);
  const findings = loadFindings(route);
  for (const f of findings) {
    await submitFeedback({
      type: f.type ?? 'feature',
      message: `${personaText.slice(0, 200)}\n\n${f.message}`,
      url,
      screenshot: hasScreenshot ? screenshotPath : undefined,
      elementMap: hasElementMap ? elementMapPath : undefined,
    });
  }
}

// --- Main ------------------------------------------------------------
fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

if (MODE === 'capture' || MODE === 'both') {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  // Cookie-based bot auth: the framework's authReq handler accepts
  // `Authorization: Bearer ...` headers. Set the token as a cookie too
  // so the SPA's same-origin fetches inherit it without each persona
  // having to wire it through manually.
  await ctx.addCookies([
    {
      name: 'ugly_auth',
      value: BOT_TOKEN,
      url: BASE_URL,
    },
  ]);
  const page = await ctx.newPage();
  const interactions = loadInteractions();
  for (const route of pages) {
    const ok = await captureRoute(page, route, interactions);
    if (ok && MODE === 'both') {
      await submitForRoute(route);
    }
  }
  await browser.close();
  console.log(
    `[${SLUG}] ${MODE === 'both' ? 'done' : 'captured'} — ${pages.length} pages × ${interactions.length} interactions.`,
  );
} else {
  // MODE === 'submit' — no Playwright needed, just post the findings.
  for (const route of pages) {
    await submitForRoute(route);
  }
  console.log(`[${SLUG}] submitted findings for ${pages.length} routes.`);
}
