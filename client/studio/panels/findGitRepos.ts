/**
 * Scan a root directory for all `.git` directories (up to 4 levels deep) so the
 * GitPanel can offer a repo switcher. Skips `node_modules`/`.pnpm` junk.
 *
 * Uses `native.fs` (readdir + exists) instead of bash `find` — no process
 * permission needed, and the scan runs synchronously at mount without a shell.
 */
import { native } from 'ugly-app/native';

export interface GitRepo {
  name: string;
  path: string;
}

const MAX_DEPTH = 4;
const SKIP_DIRS = new Set(['node_modules', '.pnpm', '.git', 'dist', '.ugly-studio']);

async function walk(dir: string, depth: number, out: GitRepo[]): Promise<void> {
  if (depth > MAX_DEPTH) return;
  let entries: { name: string; isDirectory: boolean; isFile: boolean }[];
  try {
    entries = await native.fs.readdir(dir);
  } catch {
    return; // permission denied or not a dir — skip
  }
  for (const e of entries) {
    // Catch both .git dirs (normal repos) and .git files (submodules/worktrees).
    if (e.name === '.git') {
      out.push({ name: dir.split('/').pop() ?? dir, path: dir });
      continue; // never recurse into .git
    }
    if (!e.isDirectory) continue;
    if (SKIP_DIRS.has(e.name)) continue;
    await walk(`${dir}/${e.name}`, depth + 1, out);
  }
}

/** Find all git repos under `root`. */
export async function findGitRepos(root: string): Promise<GitRepo[]> {
  if (!root) return [];
  const repos: GitRepo[] = [];
  try {
    await walk(root, 0, repos);
  } catch {
    // degrade — empty list
  }
  // Sort: deepest nested last so the root is first in the dropdown.
  repos.sort((a, b) => a.path.length - b.path.length);
  return repos;
}

let cachedRepos: GitRepo[] | null = null;

export function getCachedRepos(): GitRepo[] {
  return cachedRepos ?? [];
}

export async function findAndCacheGitRepos(root: string): Promise<GitRepo[]> {
  cachedRepos = await findGitRepos(root);
  return cachedRepos;
}
