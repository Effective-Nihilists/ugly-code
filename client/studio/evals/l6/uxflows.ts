// Objective UX flow batteries for "build a real product" evals (Family B). The runner
// is written into the app under test at grade time; it serves the built client and drives a
// declarative battery in headless chromium, scoring per-flow. Vendored here — NOT in the
// fixture — so the exact flows are hidden. Deterministic; needs no backend.

export const UX_RUNNER =
  "// Written into the app under test at grade time. Serves the built client dir and\n// drives a declarative flow battery in headless chromium; prints {passed,total,results}.\nimport { chromium } from 'playwright';\nimport http from 'node:http';\nimport { readFileSync, existsSync, statSync } from 'node:fs';\nimport path from 'node:path';\nconst CLIENT_DIR = path.resolve(process.argv[2]);\nconst BATTERY = JSON.parse(readFileSync(process.argv[3], 'utf8'));\nconst PORT = Number(process.argv[4] || 4457);\nconst TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };\nconst server = http.createServer((req, res) => {\n  let p = path.join(CLIENT_DIR, decodeURIComponent((req.url || '/').split('?')[0]));\n  if (!existsSync(p) || statSync(p).isDirectory()) p = path.join(CLIENT_DIR, 'index.html');\n  try { res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream' }); res.end(readFileSync(p)); }\n  catch { res.writeHead(404); res.end('nf'); }\n});\nawait new Promise((r) => server.listen(PORT, r));\nconst BASE = `http://localhost:${PORT}`;\nconst browser = await chromium.launch({ headless: true });\nconst results = [];\nasync function runFlow(flow) {\n  const ctx = await browser.newContext({ viewport: flow.device === 'mobile' ? { width: 390, height: 844 } : { width: 1024, height: 768 } });\n  const page = await ctx.newPage();\n  const errors = [];\n  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message.slice(0, 120)));\n  page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text().slice(0, 120)); });\n  const fail = (why) => { results.push({ name: flow.name, ok: false, why }); };\n  try {\n    await page.goto(BASE + (flow.path || '/'), { waitUntil: 'load', timeout: 20000 }).catch(() => {});\n    await page.waitForSelector('[data-id]', { timeout: 8000 }).catch(() => {});\n    for (const step of flow.steps || []) {\n      if (step.press) for (let i = 0; i < (step.times || 1); i++) { await page.keyboard.press(step.press); await page.waitForTimeout(step.gap ?? 70); }\n      else if (step.click) await page.click(step.click, { timeout: 4000 }).catch(() => {});\n      else if (step.wait) await page.waitForTimeout(step.wait);\n    }\n    for (const a of flow.assert || []) {\n      if (a.noErrors) { if (errors.length) return fail('errors: ' + errors.slice(0, 2).join(' | ')); }\n      else if (a.selector) { const n = await page.locator(a.selector).count(); if (a.exists !== false ? n === 0 : n > 0) return fail(`selector ${a.selector} ${a.exists === false ? 'present' : 'missing'}`); }\n      else if (a.canvasMin !== undefined) { const n = await page.locator('canvas').count(); if (n < a.canvasMin) return fail(`canvas ${n}<${a.canvasMin}`); }\n      else if (a.textContains) { const t = (await page.textContent('body')) || ''; if (!t.includes(a.textContains)) return fail(`missing \"${a.textContains}\"`); }\n      else if (a.inspectClean) { const rep = await page.evaluate(() => (window.__uglyInspect ? window.__uglyInspect() : null)); if (!rep) return fail('no __uglyInspect'); for (const k of a.inspectClean) { const v = rep[k]; if (Array.isArray(v) && v.length) return fail(`${k}:${v.length}`); } }\n      else if (a.evalTrue) { const ok = await page.evaluate(a.evalTrue).catch(() => false); if (!ok) return fail(`evalTrue false`); }\n    }\n    results.push({ name: flow.name, ok: true });\n  } catch (e) { fail('threw: ' + e.message.slice(0, 80)); }\n  finally { await ctx.close(); }\n}\nfor (const flow of BATTERY) await runFlow(flow);\nawait browser.close(); server.close();\nconsole.log('UXFLOWS_RESULT ' + JSON.stringify({ passed: results.filter((r) => r.ok).length, total: results.length, results }));\nprocess.exit(0);\n";

export interface UxFlowSuite {
  /** Shell command that builds the client (produces `clientDir`). */
  buildCmd: string;
  /** Repo-relative dir of built static client assets to serve. */
  clientDir: string;
  /** Declarative flow battery (see UX_RUNNER for the step/assert DSL). */
  battery: unknown[];
}

const SUITES: Record<string, UxFlowSuite> = {
  'l6-build-sokoban': {
    buildCmd: 'npm run build',
    clientDir: 'dist/client',
    battery: [
      {
        name: 'boots without console/page errors',
        assert: [
          {
            selector: '[data-id=board]',
          },
          {
            noErrors: true,
          },
        ],
      },
      {
        name: 'board renders level-1 cells',
        assert: [
          {
            evalTrue: "document.querySelectorAll('[data-cell]').length >= 15",
          },
        ],
      },
      {
        name: 'every cell has a data-content',
        assert: [
          {
            evalTrue:
              "[...document.querySelectorAll('[data-cell]')].every(c => ['wall','floor','goal','box','box-on-goal','player','player-on-goal'].includes(c.getAttribute('data-content')))",
          },
        ],
      },
      {
        name: 'player starts at row1,col1',
        assert: [
          {
            evalTrue:
              "document.querySelector('[data-cell=\"1,1\"]').getAttribute('data-content').startsWith('player')",
          },
        ],
      },
      {
        name: 'moves counter starts at 0',
        assert: [
          {
            selector: '[data-id=moves]',
          },
          {
            evalTrue:
              "document.querySelector('[data-id=moves]').textContent.trim()==='0'",
          },
        ],
      },
      {
        name: 'level indicator shows level 1',
        assert: [
          {
            textContains: 'Level 1',
          },
        ],
      },
      {
        name: 'win banner hidden at start',
        assert: [
          {
            evalTrue:
              "(()=>{const w=document.querySelector('[data-id=win]');if(!w)return true;const cs=getComputedStyle(w);return w.offsetParent===null||cs.display==='none'||cs.visibility==='hidden'||w.hidden;})()",
          },
        ],
      },
      {
        name: 'ArrowRight pushes the box onto the goal',
        steps: [
          {
            press: 'ArrowRight',
          },
        ],
        assert: [
          {
            evalTrue:
              "document.querySelector('[data-cell=\"1,3\"]').getAttribute('data-content')==='box-on-goal'",
          },
        ],
      },
      {
        name: 'solving level 1 shows a win/complete banner',
        steps: [
          {
            press: 'ArrowRight',
          },
        ],
        assert: [
          {
            evalTrue:
              "(()=>{const w=document.querySelector('[data-id=win]');if(!w)return false;const cs=getComputedStyle(w);return w.offsetParent!==null&&cs.display!=='none'&&cs.visibility!=='hidden';})()",
          },
        ],
      },
      {
        name: 'a move increments the moves counter',
        steps: [
          {
            press: 'ArrowRight',
          },
        ],
        assert: [
          {
            evalTrue:
              "document.querySelector('[data-id=moves]').textContent.trim()==='1'",
          },
        ],
      },
      {
        name: 'a wall blocks movement (player stays)',
        steps: [
          {
            press: 'ArrowLeft',
          },
        ],
        assert: [
          {
            evalTrue:
              "document.querySelector('[data-cell=\"1,1\"]').getAttribute('data-content').startsWith('player')",
          },
        ],
      },
      {
        name: 'a blocked move does not increment the counter',
        steps: [
          {
            press: 'ArrowLeft',
          },
          {
            press: 'ArrowUp',
          },
        ],
        assert: [
          {
            evalTrue:
              "document.querySelector('[data-id=moves]').textContent.trim()==='0'",
          },
        ],
      },
      {
        name: 'WASD also moves (d pushes the box)',
        steps: [
          {
            press: 'd',
          },
        ],
        assert: [
          {
            evalTrue:
              "document.querySelector('[data-cell=\"1,3\"]').getAttribute('data-content')==='box-on-goal'",
          },
        ],
      },
      {
        name: 'undo (U) reverses a move',
        steps: [
          {
            press: 'ArrowRight',
          },
          {
            press: 'u',
          },
        ],
        assert: [
          {
            evalTrue:
              "document.querySelector('[data-cell=\"1,1\"]').getAttribute('data-content').startsWith('player') && document.querySelector('[data-cell=\"1,2\"]').getAttribute('data-content')==='box'",
          },
        ],
      },
      {
        name: 'undo restores the moves counter',
        steps: [
          {
            press: 'ArrowRight',
          },
          {
            press: 'u',
          },
        ],
        assert: [
          {
            evalTrue:
              "document.querySelector('[data-id=moves]').textContent.trim()==='0'",
          },
        ],
      },
      {
        name: 'undo hides the win banner again',
        steps: [
          {
            press: 'ArrowRight',
          },
          {
            press: 'u',
          },
        ],
        assert: [
          {
            evalTrue:
              "(()=>{const w=document.querySelector('[data-id=win]');if(!w)return true;const cs=getComputedStyle(w);return w.offsetParent===null||cs.display==='none'||cs.visibility==='hidden'||w.hidden;})()",
          },
        ],
      },
      {
        name: 'restart (R) resets moves to 0',
        steps: [
          {
            press: 'ArrowRight',
          },
          {
            press: 'r',
          },
        ],
        assert: [
          {
            evalTrue:
              "document.querySelector('[data-id=moves]').textContent.trim()==='0' && document.querySelector('[data-cell=\"1,2\"]').getAttribute('data-content')==='box'",
          },
        ],
      },
      {
        name: 'on-screen right control pushes the box',
        steps: [
          {
            click: '[data-id=right]',
          },
        ],
        assert: [
          {
            evalTrue:
              "document.querySelector('[data-cell=\"1,3\"]').getAttribute('data-content')==='box-on-goal'",
          },
        ],
      },
      {
        name: 'on-screen undo control works',
        steps: [
          {
            click: '[data-id=right]',
          },
          {
            click: '[data-id=undo]',
          },
        ],
        assert: [
          {
            evalTrue:
              "document.querySelector('[data-id=moves]').textContent.trim()==='0'",
          },
        ],
      },
      {
        name: 'on-screen restart control works',
        steps: [
          {
            click: '[data-id=right]',
          },
          {
            click: '[data-id=restart]',
          },
        ],
        assert: [
          {
            evalTrue:
              "document.querySelector('[data-cell=\"1,2\"]').getAttribute('data-content')==='box'",
          },
        ],
      },
      {
        name: 'advancing to level 2 after solving level 1',
        steps: [
          {
            press: 'ArrowRight',
          },
          {
            press: 'n',
          },
        ],
        assert: [
          {
            textContains: 'Level 2',
          },
        ],
      },
      {
        name: 'level 2 is solvable to a win',
        steps: [
          {
            press: 'ArrowRight',
          },
          {
            press: 'n',
          },
          {
            press: 'ArrowLeft',
          },
          {
            press: 'ArrowRight',
          },
          {
            press: 'ArrowRight',
          },
        ],
        assert: [
          {
            evalTrue:
              "(()=>{const w=document.querySelector('[data-id=win]');if(!w)return false;const cs=getComputedStyle(w);return w.offsetParent!==null&&cs.display!=='none'&&cs.visibility!=='hidden';})()",
          },
        ],
      },
      {
        name: 'no overlapping interactive controls',
        assert: [
          {
            inspectClean: ['overlaps'],
          },
        ],
      },
      {
        name: 'mobile: no safe-area violations',
        device: 'mobile',
        assert: [
          {
            inspectClean: ['safeAreaViolations'],
          },
        ],
      },
      {
        name: 'no console errors during a play session',
        steps: [
          {
            press: 'ArrowRight',
          },
          {
            press: 'u',
          },
          {
            press: 'ArrowUp',
          },
          {
            press: 'r',
          },
          {
            press: 'd',
          },
        ],
        assert: [
          {
            noErrors: true,
          },
        ],
      },
    ],
  },
};

export function getUxFlowSuite(taskName: string): UxFlowSuite | undefined {
  return SUITES[taskName];
}
