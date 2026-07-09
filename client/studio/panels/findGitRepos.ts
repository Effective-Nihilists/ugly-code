/**
 * Scan a root directory for all `.git` directories (up to 4 levels deep) so the
 * GitPanel can offer a repo switcher. Skips `node_modules`/`.pnpm` junk.
 *
 * The scan runs via `bash` over `native.process.spawn` — inexpensive at panel
 * mount and cached in-memory (the panel re-scans on Refresh).
 */
import { native } from 'ugly-app/native';

export interface GitRepo {
  name: string;
  path: string;
}

/** Spawn a quick find command and collect stdout. Expands leading ~ to $HOME
 *  so the path resolves inside the double-quoted shell command (bash won't
 *  expand ~ inside double quotes). */
function runFind(root: string): Promise<string> {
  // Expand leading ~ to $HOME so it resolves inside double quotes below.
  const expanded = root.replace(/^~(?=$|\/)/, '$HOME');
  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    try {
      const p = native.process.spawn('bash', [
        '-c',
        // -type d catches normal .git dirs; -type f catches submodule/worktree .git files.
        `(find -L "${expanded.replace(/"/g, '\\"')}" -maxdepth 4 -name ".git" -type d 2>/dev/null; find -L "${expanded.replace(/"/g, '\\"')}" -maxdepth 4 -name ".git" -type f 2>/dev/null) | sed 's|/\\.git$||' | grep -v '/node_modules/' | sort -u`,
      ]);
      p.onStdout((c) => (out += c));
      p.onStderr((c) => (err += c));
      p.onError((e) => { reject(new Error(e)); });
      p.onExit((code) => {
        if (code === 0) resolve(out);
        else reject(new Error(err || `find exited ${code ?? '?'}`));
      });
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

/** Find all git repos under `root` (synchronous-appearing via caching). */
let cachedRepos: GitRepo[] | null = null;

export async function findGitRepos(root: string): Promise<GitRepo[]> {
  // Always clear the cache so a manual Refresh re-scans.
  cachedRepos = null;
  if (!root) return [];
  try {
    const stdout = await runFind(root);
    const lines = stdout.trim().split('\n').filter(Boolean);
    const repos = lines.map((p) => ({
      name: p.split('/').pop() ?? p,
      path: p,
    }));
    // Sort: deepest nested last so the root is first.
    repos.sort((a, b) => a.path.length - b.path.length);
    cachedRepos = repos;
    return repos;
  } catch {
    return [];
  }
}

/** Quick synchronous lookup of the cached scan (no re-scan). */
export function getCachedRepos(): GitRepo[] {
  return cachedRepos ?? [];
}
