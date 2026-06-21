import { describe, expect, it, vi } from 'vitest';
import { buildInstallDownloadUrl, requestStudioInstall } from '../../client/lib/studioInstall';

describe('buildInstallDownloadUrl', () => {
  it('builds /dl URLs for code-bearing targets with correct extension', () => {
    expect(buildInstallDownloadUrl('win', 'abc1234567')).toBe(
      'https://studio.ugly.bot/dl/win/Ugly%20Studio-abc1234567.exe',
    );
    expect(buildInstallDownloadUrl('linux-appimage', 'abc1234567')).toBe(
      'https://studio.ugly.bot/dl/linux-appimage/Ugly%20Studio-abc1234567.AppImage',
    );
  });
  it('builds a /dl URL for mac-pkg', () => {
    expect(buildInstallDownloadUrl('mac-pkg', 'abcdefghij')).toBe(
      'https://studio.ugly.bot/dl/mac-pkg/Ugly%20Studio-abcdefghij.pkg',
    );
  });
  it('returns null for targets that cannot recover the code', () => {
    expect(buildInstallDownloadUrl('mac-dmg', 'abc1234567')).toBeNull();
    expect(buildInstallDownloadUrl('linux-deb', 'abc1234567')).toBeNull();
  });
});

describe('requestStudioInstall', () => {
  it('POSTs the intent and returns the code', async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(JSON.stringify({ result: { code: 'zzz9999999' } }), { status: 200 }),
    ) as unknown as typeof fetch;
    const code = await requestStudioInstall('https://code.ugly.bot', fetchFn);
    expect(code).toBe('zzz9999999');
    expect(fetchFn).toHaveBeenCalledWith(
      'https://studio.ugly.bot/api/createInstallIntent',
      expect.objectContaining({ method: 'POST' }),
    );
  });
  it('returns null on a non-ok response (best-effort)', async () => {
    const fetchFn = vi.fn(
      async () => new Response('nope', { status: 429 }),
    ) as unknown as typeof fetch;
    expect(await requestStudioInstall('https://code.ugly.bot', fetchFn)).toBeNull();
  });
  it('returns null when fetch throws', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await requestStudioInstall('https://code.ugly.bot', fetchFn)).toBeNull();
  });
});
