/**
 * Detect the local Claude Code CLI over the native bridge. The web app can't run
 * `which`, so we spawn a login shell and resolve `command -v claude` (falling back
 * to the well-known install locations). Cached for the session. Returns the
 * absolute binary path, or null when unavailable (no native bridge / not installed).
 */

import { native } from 'ugly-app/native';

let cached: string | null | undefined;
let inflight: Promise<string | null> | null = null;

function homeFromPath(p: string | null): string | null {
  if (!p) return null;
  const m = /^(\/Users\/[^/]+|\/home\/[^/]+|\/root)/.exec(p);
  return m ? m[1] : null;
}

/** Run a command to completion, returning trimmed stdout (or '' on any failure). */
function runCapture(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    try {
      let out = '';
      const proc = native.process.spawn(cmd, args);
      proc.onStdout((c) => (out += c));
      proc.onError(() => { resolve(''); });
      proc.onExit(() => { resolve(out.trim()); });
    } catch {
      resolve('');
    }
  });
}

export async function detectClaudeCli(projectPath: string | null): Promise<string | null> {
  if (cached !== undefined) return cached;
  if (inflight) return inflight;
  inflight = (async () => {
    // 1) Well-known install paths — a direct stat, no shell and no PATH lookup,
    //    so this survives the minimal PATH a Finder/Dock-launched app hands to
    //    its spawned processes. The two absolute paths need no home dir, so they
    //    are ALWAYS checked (previously they were wrongly gated behind `home`,
    //    which is null on the pre-project new-session screen — the exact case
    //    where claude at /opt/homebrew/bin went undetected). The ~/.local/bin
    //    path needs $HOME, so it's added only when we can derive it from the
    //    open project.
    const home = homeFromPath(projectPath);
    const candidates = [
      '/opt/homebrew/bin/claude',
      '/usr/local/bin/claude',
      ...(home ? [`${home}/.local/bin/claude`] : []),
    ];
    for (const candidate of candidates) {
      try {
        const st = await native.fs.stat(candidate);
        if (st.isFile) { cached = candidate; return candidate; }
      } catch { /* not there */ }
    }
    // 2) PATH lookup via a login shell. Prepend the common install dirs so the
    //    lookup still resolves under a GUI app's stripped PATH; `$HOME` is set on
    //    the spawned process even with no project open, so ~/.local/bin is
    //    covered here regardless of `home` above.
    const lookup =
      'PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH" command -v claude';
    const found = (await runCapture('bash', ['-lc', lookup])).split('\n')[0] ?? '';
    cached = found.startsWith('/') ? found : null;
    return cached;
  })().finally(() => { inflight = null; });
  return inflight;
}

/** Synchronous cached read for render paths (null until detectClaudeCli resolves). */
export function claudeCliPathCached(): string | null {
  return cached ?? null;
}
