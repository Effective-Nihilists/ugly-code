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
 *  (the caller supplies a fallback). */
export function parseScaffoldResult(output: string, code: number | null): ScaffoldResult {
  if (code !== 0) return { ok: false, code };
  const lines = output.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  return { ok: true, path: lines[lines.length - 1] ?? '' };
}
