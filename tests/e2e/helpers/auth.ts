import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { injectAuthCookie } from 'ugly-app/playwright';

/**
 * "Log in as me" for e2e: Ugly Studio persists the developer's live ugly.bot
 * session at `~/.ugly-bot/auth.json` ({ token, userId, serverUrl }). The real
 * smoke tests read that token and inject it as the `auth_token` cookie so the
 * local dev server (auth mode: uglybot) treats the page as authenticated and
 * `/api/agentStep` → ugly.bot textGen succeeds.
 *
 * The token is read at run time from the developer's machine — it is NEVER
 * hard-coded or committed. When the file is absent (fresh CI), `loadDevAuth()`
 * returns null and the real-smoke specs skip instead of failing.
 */
export interface DevAuth {
  token: string;
  userId: string;
  serverUrl: string;
}

export function loadDevAuth(): DevAuth | null {
  const path = join(homedir(), '.ugly-bot', 'auth.json');
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<DevAuth>;
    if (!raw.token || !raw.userId) return null;
    return { token: raw.token, userId: raw.userId, serverUrl: raw.serverUrl ?? 'https://ugly.bot' };
  } catch {
    return null;
  }
}

/** Inject the developer's real session cookie before navigating. */
export async function authenticate(page: Page, auth: DevAuth): Promise<void> {
  await injectAuthCookie(page, auth.token);
}
