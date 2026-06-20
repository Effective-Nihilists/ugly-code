import { defineConfig, devices } from '@playwright/test';

// Native-only e2e: serves the *built* client statically (no DB-backed dev
// server) and drives the UglyNative SDK via the testing-framework mock. Run:
//   npm run build && npx playwright test --config playwright.native.config.ts
const PORT = 4399;

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'code-editor.spec.ts',
  fullyParallel: true,
  reporter: 'list',
  outputDir: 'test-results',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://localhost:${PORT}`,
    screenshot: 'only-on-failure',
    actionTimeout: 8_000,
    navigationTimeout: 15_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `python3 -m http.server ${PORT} --directory dist/client`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
