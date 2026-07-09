/**
 * Scan a root directory for all `.git` directories (up to 4 levels deep) so the
 * GitPanel can offer a repo switcher. Skips `node_modules`/`.pnpm` junk.
 *
 * Resolves tilde paths via a quick bash spawn (the UglyNative proxy maps
 * `native.process.spawn` to the host shell), then walks the filesystem with
 * `native.fs.readdir` — the type-safe ugly-app wrapper.
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
  } catch (e) {
    console.log('[findGitRepos:walk] readdir failed', JSON.stringify({ dir, err: (e as Error).message }));
    return;
  }
  for (const e of entries) {
    if (e.name === '.git') {
      out.push({ name: dir.split('/').pop() ?? dir, path: dir });
      continue;
    }
    if (!e.isDirectory) continue;
    if (SKIP_DIRS.has(e.name)) continue;
    await walk(`${dir}/${e.name}`, depth + 1, out);
  }
}

/** Resolve a leading `~` to an absolute home-directory path by asking the host
 *  shell. Falls back to the raw input if bash isn't available. */
function resolveTilde(root: string): Promise<string> {
  if (!root.startsWith('~')) return Promise.resolve(root);
  return new Promise<string>((resolve) => {
    let out = '';
    try {
      const p = native.process.spawn('bash', ['-lc', 'echo "$HOME"']);
      p.onStdout((c) => (out += c));
      p.onError(() => resolve(root)); // fall back to raw path
      p.onExit((code) => {
        const home = out.trim();
        if (code === 0 && home.length > 0) {
          resolve(root.replace(/^~/, home));
        } else {
          resolve(root); // fall back
        }
      });
    } catch {
      resolve(root); // no process permission — hope native.fs handles tilde
    }
  });
}

/** Find all git repos under `root`. */
export async function findGitRepos(root: string): Promise<GitRepo[]> {
  if (!root) return [];
  const expanded = await resolveTilde(root);
  console.log('[findGitRepos] scanning', JSON.stringify({ original: root, expanded }));
  const repos: GitRepo[] = [];
  try {
    await walk(expanded, 0, repos);
  } catch (e) {
    console.log('[findGitRepos] walk threw', (e as Error).message);
  }
  repos.sort((a, b) => a.path.length - b.path.length);
  console.log('[findGitRepos] found', repos.length, 'repos', JSON.stringify(repos.map((r) => r.path)));
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
