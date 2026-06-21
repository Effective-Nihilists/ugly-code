// Anonymous install handoff. The CTA creates an intent (which app Studio should
// open after install) and downloads a code-bearing installer for targets that
// can recover it. Best-effort: any failure falls back to a plain download.

const STUDIO_WEB = 'https://studio.ugly.bot';

export type InstallOs =
  | 'win'
  | 'mac-arm64'
  | 'mac-x64'
  | 'mac-dmg'
  | 'linux-appimage'
  | 'linux-deb';

// Only these targets can recover the code from the filename (Plan 1: AppImage
// works end-to-end now; win works once Plan 2's NSIS hook lands).
const CODE_BEARING: Partial<Record<InstallOs, string>> = {
  win: 'exe',
  'linux-appimage': 'AppImage',
};

export function buildInstallDownloadUrl(os: InstallOs, code: string): string | null {
  const ext = CODE_BEARING[os];
  if (!ext) return null;
  const filename = encodeURIComponent(`Ugly Studio-${code}.${ext}`);
  return `${STUDIO_WEB}/dl/${os}/${filename}`;
}

export async function requestStudioInstall(
  openUrl: string,
  fetchFn: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const res = await fetchFn(`${STUDIO_WEB}/api/createInstallIntent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: { openUrl } }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { result?: { code?: string } };
    return json.result?.code ?? null;
  } catch {
    return null;
  }
}
