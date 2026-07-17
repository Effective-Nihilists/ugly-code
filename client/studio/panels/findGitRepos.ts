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
  /** True when the repo has `ugly-app` as a dependency (package.json) or a
   *  `.uglyapp` config file — used to flag ugly-app-based projects in the
   *  repo selector dropdown. */
  isUglyApp?: boolean;
}

const MAX_DEPTH = 4;
const SKIP_DIRS = new Set([
  'node_modules',
  '.pnpm',
  '.git',
  'dist',
  '.ugly-studio',
]);

async function walk(dir: string, depth: number, out: GitRepo[]): Promise<void> {
  if (depth > MAX_DEPTH) return;
  let entries: { name: string; isDirectory: boolean; isFile: boolean }[];
  try {
    entries = await native.fs.readdir(dir);
  } catch (e) {
    console.log(
      '[findGitRepos:walk] readdir failed',
      JSON.stringify({ dir, err: (e as Error).message }),
    );
    return;
  }
  const subdirs: string[] = [];
  for (const e of entries) {
    if (e.name === '.git') {
      out.push({ name: dir.split('/').pop() ?? dir, path: dir });
      continue;
    }
    if (!e.isDirectory) continue;
    if (SKIP_DIRS.has(e.name)) continue;
    subdirs.push(`${dir}/${e.name}`);
  }
  // Walk sibling directories concurrently — sequential readdir over the UglyNative
  // IPC bridge made scanning a big root (e.g. ~/Documents/GitHub) take many seconds.
  await Promise.all(subdirs.map((d) => walk(d, depth + 1, out)));
}

/** Check if a repo directory is an ugly-app-based project by looking for
 *  `.uglyapp` config or `ugly-app` in `package.json` dependencies. */
async function checkIsUglyApp(repoPath: string): Promise<boolean> {
  try {
    // Fast path: .uglyapp exists → definite ugly-app project
    const entries = await native.fs.readdir(repoPath);
    if (entries.some((e) => e.name === '.uglyapp')) return true;
    // Check package.json for ugly-app dependency
    if (entries.some((e) => e.name === 'package.json')) {
      const pkg = await native.fs.readFile(`${repoPath}/package.json`);
      try {
        const parsed = JSON.parse(pkg) as {
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
        };
        return !!(
          parsed.dependencies?.['ugly-app'] ??
          parsed.devDependencies?.['ugly-app']
        );
      } catch {
        /* invalid JSON */
      }
    }
  } catch {
    /* read error — not accessible */
  }
  return false;
}

/** Annotate repos with the isUglyApp flag in batches. */
async function annotateUglyApp(repos: GitRepo[]): Promise<GitRepo[]> {
  const checks = repos.map(async (r) => {
    r.isUglyApp = await checkIsUglyApp(r.path);
    return r;
  });
  return Promise.all(checks);
}

/** Resolve a leading `~` to an absolute home-directory path. Tries the host
 *  shell first; falls back to the environment HOME variable; last resort is
 *  the raw input (native.fs.readdir will surface a clear error). */
async function resolveTilde(root: string): Promise<string> {
  if (!root.startsWith('~')) return root;
  // Fast path: Node-like runtime with HOME env var (no process spawn needed)
  try {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (
      typeof process !== 'undefined' &&
      (process as { env?: Record<string, string> }).env?.HOME
    ) {
      return root.replace(
        /^~/,
        (process as { env: Record<string, string> }).env.HOME,
      );
    }
  } catch {
    /* not a Node runtime */
  }

  // Slow path: ask the host shell (needed in webview sandboxes)
  return new Promise<string>((resolve) => {
    let out = '';
    try {
      const p = native.process.spawn('bash', ['-lc', 'echo "$HOME"']);
      p.onStdout((c) => (out += c));
      p.onError(() => {
        resolve(root);
      });
      p.onExit((code) => {
        const home = out.trim();
        resolve(
          code === 0 && home.length > 0 ? root.replace(/^~/, home) : root,
        );
      });
    } catch {
      resolve(root);
    }
  });
}

/** Find all git repos under `root`. */
export async function findGitRepos(root: string): Promise<GitRepo[]> {
  if (!root) return [];
  const expanded = await resolveTilde(root);
  console.log(
    '[findGitRepos] scanning',
    JSON.stringify({ original: root, expanded }),
  );
  const repos: GitRepo[] = [];
  try {
    await walk(expanded, 0, repos);
  } catch (e) {
    console.log('[findGitRepos] walk threw', (e as Error).message);
  }
  repos.sort((a, b) => a.path.length - b.path.length);
  // Annotate with ugly-app flags
  await annotateUglyApp(repos);
  console.log(
    '[findGitRepos] found',
    repos.length,
    'repos',
    JSON.stringify(
      repos.map((r) => ({ path: r.path, isUglyApp: r.isUglyApp })),
    ),
  );
  return repos;
}

let cachedRepos: GitRepo[] | null = null;

export function getCachedRepos(): GitRepo[] {
  return cachedRepos ?? [];
}

/** Check whether a given repo path is known to have ugly-app as a dependency,
 *  based on the cached scan results. Returns false (not ugly-app) when the
 *  scan hasn't finished yet (the cache is still null).
 *
 *  CAUTION: this answers "is it in the scan and flagged", NOT "is it an ugly-app
 *  project". A path the scan never visited — every session worktree under
 *  `.ugly-studio/worktrees/` — is false here no matter what's on disk. Use
 *  `resolveIsUglyApp` for a decision about an arbitrary path. */
export function isRepoUglyApp(repoPath: string): boolean {
  if (!cachedRepos) return false;
  return cachedRepos.some((r) => r.path === repoPath && r.isUglyApp);
}

/**
 * Is `path` an ugly-app project? Asks the FILESYSTEM, falling back to the scan cache
 * only as a fast path.
 *
 * The scan-cache-only check told the Preview panel that a session worktree "is not an
 * ugly-app project" — because the scan never walks `.ugly-studio/` — even though the
 * worktree has a `.uglyapp` marker and a real package.json. So Preview could never boot
 * a dev server for the code the agent had just written, and the agent's dev_server_*
 * tools dead-ended chasing a server that would never start.
 */
export async function resolveIsUglyApp(path: string): Promise<boolean> {
  const cached = cachedRepos?.find((r) => r.path === path);
  if (cached?.isUglyApp === true) return true;
  return checkIsUglyApp(path);
}

let scanPromise: Promise<GitRepo[]> | null = null;

export async function findAndCacheGitRepos(root: string): Promise<GitRepo[]> {
  // Deduplicate concurrent calls — only one scan runs at a time.
  scanPromise ??= findGitRepos(root)
    .then((r) => {
      cachedRepos = r;
      return r;
    })
    .finally(() => {
      scanPromise = null;
    });
  return scanPromise;
}
