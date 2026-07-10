// Materialize the Python indexer sources from the app origin onto disk.
//
// The coding task is a single bundled JS file fetched over HTTP, so the `.py`
// files can't ride inside it. They ship as static assets under
// `client/public/coding-agent/indexer/` (served at the origin root in dev, on
// Node, and from the Worker's R2 asset set), and this module copies them into
//
//     ~/.ugly-studio/coding-agent/indexer/<INDEXER_VERSION>/
//
// keyed by a content hash baked into the bundle at build time. Consequences:
//
//   - A DEPLOY ships a new indexer. Change a `.py`, the version changes, the
//     next run materializes a fresh directory. No Studio rebuild, no reinstall.
//   - Offline re-runs skip the network entirely: a `.complete` sentinel marks a
//     directory whose every file matched its digest.
//   - A truncated download can never leave a half-written daemon behind, because
//     the sentinel is written last and each file is verified against its sha256.
//
// The cache root stays `~/.ugly-studio` (overridable with UGLY_STUDIO_CACHE) —
// the same root the Python already uses for the 161 MB embedding model. Moving
// it would force every user to re-download the model for no benefit.

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { INDEXER_VERSION } from './indexerVersion.js';
import { buildId } from '../../../shared/Build.js';

// Where the assets live at the origin, most-specific first.
//
// PROD (Cloudflare Worker): only `/{buildId}/…`, `/assets/…`, `/favicon.ico`
// and single-segment image/font files are served from R2 — a nested `.json`/`.py`
// under `/coding-agent/indexer/` falls through to the SPA shell (HTML 200). The
// R2 objects DO exist under `builds/{buildId}/…`, reachable at `/{buildId}/…`.
//
// DEV (`ugly-app dev`, vite): `public/*` is served at the ROOT, and there is no
// `/{buildId}/` route, so the buildId path 404s and the root path wins.
//
// Trying both, in this order, covers prod and dev. It happens once per indexer
// version (then the `.complete` sentinel short-circuits), so the extra probe is
// negligible.
const ASSET_BASES = [`/${buildId}/coding-agent/indexer`, `/coding-agent/indexer`];

export interface IndexerManifest {
  version: string;
  files: { path: string; sha256: string; bytes: number }[];
}

/** Root of the on-disk cache, shared with the Python's model cache. */
export function cacheRoot(): string {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env?.UGLY_STUDIO_CACHE ?? join(homedir(), '.ugly-studio');
}

/** Directory the daemon is (or will be) run from, for this exact source version. */
export function indexerSourceDir(version: string = INDEXER_VERSION): string {
  return join(cacheRoot(), 'coding-agent', 'indexer', version);
}

function sentinelPath(dir: string): string {
  return join(dir, '.complete');
}

const sha256 = (buf: Uint8Array): string =>
  createHash('sha256').update(buf).digest('hex');

/** Dedupe concurrent callers (the poll and the agent both race to ensure). */
let inflight: Promise<string> | null = null;

/**
 * Ensure this build's Python sources exist on disk; return their directory.
 *
 * Idempotent and safe to call on every status poll: once the sentinel exists it
 * is a single `existsSync`.
 */
export async function ensureIndexerSources(): Promise<string> {
  const dir = indexerSourceDir();
  if (existsSync(sentinelPath(dir))) return dir;
  if (inflight) return inflight;

  inflight = (async () => {
    // Download into a sibling temp dir and rename into place, so a crashed or
    // concurrent run never exposes a partially-written source tree.
    const staging = `${dir}.tmp-${String(Date.now())}`;
    await mkdir(staging, { recursive: true });
    try {
      const manifest = await fetchManifest();
      if (manifest.version !== INDEXER_VERSION) {
        // The origin is serving a different build than this bundle came from
        // (deploy raced a running task). Trust the bundle: it is what the rest
        // of this process was compiled against.
        throw new Error(
          `indexer manifest version mismatch: origin=${manifest.version} bundle=${INDEXER_VERSION}`,
        );
      }
      for (const f of manifest.files) {
        const bytes = await fetchAsset(f.path);
        const got = sha256(bytes);
        if (got !== f.sha256) {
          throw new Error(
            `indexer asset ${f.path} failed checksum (expected ${f.sha256.slice(0, 12)}…, got ${got.slice(0, 12)}…)`,
          );
        }
        await writeFile(join(staging, f.path), bytes);
      }
      // Sentinel LAST: its presence is the promise that everything above passed.
      await writeFile(sentinelPath(staging), `${INDEXER_VERSION}\n`);

      if (existsSync(sentinelPath(dir))) {
        // Another process won the race while we were downloading.
        await rm(staging, { recursive: true, force: true });
        return dir;
      }
      await rm(dir, { recursive: true, force: true });
      await mkdir(join(dir, '..'), { recursive: true });
      await rename(staging, dir);
      return dir;
    } catch (e) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      throw e;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * Fetch `<base>/<name>` from the first ASSET_BASE that returns a real asset.
 *
 * The SPA fallback answers unknown paths with `text/html` 200, so a bare status
 * check isn't enough — a `content-type: text/html` response means "route not
 * found, here's the app shell", which we skip.
 */
async function fetchFromOrigin(name: string): Promise<Response> {
  let lastStatus = 0;
  for (const base of ASSET_BASES) {
    const res = await fetch(`${base}/${name}`);
    lastStatus = res.status;
    if (!res.ok) continue;
    if ((res.headers.get('content-type') ?? '').includes('text/html')) continue; // SPA shell
    return res;
  }
  throw new Error(`indexer asset ${name} not served by the origin (last HTTP ${lastStatus})`);
}

async function fetchManifest(): Promise<IndexerManifest> {
  const res = await fetchFromOrigin('manifest.json');
  return (await res.json()) as IndexerManifest;
}

async function fetchAsset(name: string): Promise<Uint8Array> {
  const res = await fetchFromOrigin(name);
  return new Uint8Array(await res.arrayBuffer());
}

/** Read the requirements.txt digest — the venv is re-provisioned when it moves. */
export async function requirementsHash(dir: string): Promise<string> {
  return sha256(await readFile(join(dir, 'requirements.txt')));
}
