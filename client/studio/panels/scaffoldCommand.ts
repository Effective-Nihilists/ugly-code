/** Pure helpers for the new-project scaffold flow — the exact bash command
 *  driven into the interactive terminal, and parsing its result. Extracted from
 *  ProjectCreationProgress so it can be unit-tested (vitest env is `node`). */

export type ScaffoldResult =
  | { ok: true; path: string }
  | { ok: false; code: number | null };

/** Build the `bash -lc` scaffold command. A leading `~` is NOT expanded inside
 *  double quotes, so map it to `$HOME`. The command mkdir+cd's into the parent
 *  itself (it may not exist yet), runs `ugly-app init`, cd's into the project,
 *  and prints its absolute path via `pwd` (parsed by parseScaffoldResult). */
export function buildScaffoldCommand(name: string, parentDir: string): string {
  const parent = (parentDir.trim() || '~').replace(/^~(?=$|\/)/, '$HOME');
  const q = (s: string): string => s.replace(/"/g, '\\"');
  return (
    `mkdir -p "${q(parent)}" && cd "${q(parent)}" && ` +
    `npx -y ugly-app@latest init "${q(name)}" && cd "${q(name)}" && pwd`
  );
}

/** Interpret a finished scaffold command: exit 0 → the trailing `pwd` line is the
 *  project path; non-zero → failure. `path` may be '' if there was no output
 *  (the caller supplies a fallback). The caller passes the raw path through
 *  `normalizeScaffoldPath` (Windows fix) before storing/opening it. */
export function parseScaffoldResult(output: string, code: number | null): ScaffoldResult {
  if (code !== 0) return { ok: false, code };
  const lines = output.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  return { ok: true, path: lines[lines.length - 1] ?? '' };
}

/**
 * Map the scaffold's `pwd` output to a native path. On Windows the bundled
 * Git-Bash/MSYS shell prints POSIX paths (`/c/Users/theju/...`); if that string
 * is later handed to Node's `path.resolve`/`fs` on Windows it is treated as
 * drive-root-relative and mangled to `C:\c\Users\theju\...` — the studio
 * "wrong directory / missing template code" bug (the real project is at
 * `C:\Users\theju\...`, so `.uglyapp`/`.claude` aren't found there). Convert
 * `/<drive>/rest` → `<Drive>:\rest`, and normalize forward slashes on any
 * already-drive-qualified path. No-op on non-Windows and for native paths.
 */
export function normalizeScaffoldPath(p: string, isWindows: boolean): string {
  const s = p.trim();
  if (!isWindows) return s;
  const msys = /^\/([a-zA-Z])\/(.*)$/.exec(s);
  if (msys) return `${msys[1].toUpperCase()}:\\${msys[2].replace(/\//g, '\\')}`;
  if (/^[a-zA-Z]:[\\/]/.test(s)) return s.replace(/\//g, '\\');
  return s;
}
