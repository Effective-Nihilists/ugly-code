import { defineConfig, devices } from '@playwright/test';

const DEFAULT_PORT = 4321;

/**
 * Resolve the local dev-server port. Priority:
 *   1. PLAYWRIGHT_BASE_URL env (full URL — port extracted from it)
 *   2. PORT env
 *   3. DEFAULT_PORT (matches ugly-app's DEFAULT_LOCAL_PORT)
 */
function getLocalPort(): number {
  const envUrl = process.env['PLAYWRIGHT_BASE_URL'];
  if (envUrl) {
    const m = envUrl.match(/:(\d+)/);
    if (m) return Number(m[1]);
  }
  if (process.env['PORT']) {
    const n = Number(process.env['PORT']);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return DEFAULT_PORT;
}

function getBaseURL(): string {
  return (
    process.env['PLAYWRIGHT_BASE_URL'] ?? `http://localhost:${getLocalPort()}`
  );
}

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 2 : 0,
  workers: process.env['CI'] ? 1 : undefined,
  reporter: 'list',
  outputDir: 'test-results',
  timeout: 60_000,
  expect: {
    timeout: 30_000,
  },
  use: {
    baseURL: getBaseURL(),
    screenshot: 'only-on-failure',
    video: 'on-first-retry',
    trace: 'on-first-retry',
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: 'npm run dev',
    url: getBaseURL(),
    reuseExistingServer: !process.env['CI'],
    timeout: 120_000,
    env: {
      PORT: String(getLocalPort()),
    },
  },
});
