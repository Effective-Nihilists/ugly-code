import type { Page } from '@playwright/test';
import { installUglyNativeMock, type UglyNativeMock } from 'ugly-app/playwright';
import { authenticate, type DevAuth } from './auth';

// Enters the REAL Studio shell (HomeGate → StudioShell → ProjectOnboarding) in a
// browser. HomeGate renders the shell only when BOTH:
//   - native:  isNativeAvailable() === window.UglyNative.platform !== 'web'
//   - authed:  window.__AUTH_TOKEN__ (server-injected from a valid auth_token cookie)
//
// So we install the platform=desktop UglyNative (the repo's own native-test
// transport — the desktop daemon's OS layer is the only thing mocked; every
// Studio component, handler, and route above it is the real app) and inject the
// developer's real session cookie. Everything the user clicks is the real shell.
export async function enterStudioShell(
  page: Page,
  auth: DevAuth,
  results: Record<string, unknown> = {},
): Promise<UglyNativeMock> {
  const mock = await installUglyNativeMock(page, {
    platform: 'desktop',
    results: {
      'permissions.request': { granted: { fs: 'full', process: 'full' } },
      ...results,
    },
  });
  await authenticate(page, auth);
  await page.goto('/');
  return mock;
}
