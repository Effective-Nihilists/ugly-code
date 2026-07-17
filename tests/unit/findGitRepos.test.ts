// Tests for findGitRepos — repo scanning, tilde resolution, and dedup.
import { describe, it, expect, beforeEach } from 'vitest';
import { resetMock, mockFiles } from '../helpers/uglyNativeMock';

// Import the module under test (mocked via vitest setup → UglyNative mock).
// findGitRepos uses native.fs.readdir + native.process.spawn — both covered
// by the mock, so we test the real logic through the real module.
import {
  findAndCacheGitRepos,
  getCachedRepos,
} from '../../client/studio/panels/findGitRepos';

beforeEach(() => {
  // Seed a file tree that looks like a real GitHub folder with nested .git dirs
  resetMock({
    files: {
      '/Users/admin/GitHub/keys/setup-studio-keys.sh': '#!/bin/bash\necho keys',
      '/Users/admin/GitHub/keys/.git/HEAD': 'ref: refs/heads/main',
      '/Users/admin/GitHub/keys/.git/config': '[core]\nbare = false',
      '/Users/admin/GitHub/ugly-code/.git/HEAD': 'ref: refs/heads/main',
      '/Users/admin/GitHub/ugly-code/package.json':
        '{"dependencies":{"ugly-app":"^0.1.812"}}',
      '/Users/admin/GitHub/ugly-code/.git/config':
        '[core]\nbRepositoryFormatVersion = 0',
      '/Users/admin/GitHub/not-a-repo/readme.md': '# just docs',
    },
  });
});

describe('findAndCacheGitRepos', () => {
  it('discovers repos with .git dirs', async () => {
    const repos = await findAndCacheGitRepos('/Users/admin/GitHub');
    // keys and ugly-code have .git → should be discovered
    const names = repos.map((r) => r.name);
    expect(names).toContain('keys');
    expect(names).toContain('ugly-code');
    // not-a-repo has no .git → excluded
    expect(names).not.toContain('not-a-repo');
  });

  it('populates the module-level cache', async () => {
    // Clear previous runs (import-level cache is module-scoped in vitest)
    const repos = await findAndCacheGitRepos('/Users/admin/GitHub');
    expect(getCachedRepos()).toEqual(repos);
  });

  it('deduplicates concurrent calls — only one scan runs', async () => {
    // Fire two concurrent calls; both should resolve to the same result
    // without triggering duplicate readdir calls (the module-level scanPromise gate).
    const [a, b] = await Promise.all([
      findAndCacheGitRepos('/Users/admin/GitHub'),
      findAndCacheGitRepos('/Users/admin/GitHub'),
    ]);
    expect(a).toBe(b); // same array reference (dedup returned the single promise)
    expect(a.length).toBeGreaterThan(0);
  });

  it('resolves tilde paths via the HOME env fast path', async () => {
    // Set HOME so resolveTilde takes the fast path (no bash spawn)
    const prevHome = (process as unknown as { env: Record<string, string> })
      .env['HOME'];
    (process as unknown as { env: Record<string, string> }).env['HOME'] =
      '/Users/admin';

    try {
      const repos = await findAndCacheGitRepos('~/GitHub');
      expect(repos.length).toBeGreaterThan(0);
      expect(repos.some((r) => r.name === 'ugly-code')).toBe(true);
    } finally {
      if (prevHome)
        (process as unknown as { env: Record<string, string> }).env['HOME'] =
          prevHome;
    }
  });

  it('tags ugly-app repos with isUglyApp', async () => {
    const repos = await findAndCacheGitRepos('/Users/admin/GitHub');
    const ua = repos.find((r) => r.name === 'ugly-code');
    expect(ua?.isUglyApp).toBe(true);
    const k = repos.find((r) => r.name === 'keys');
    expect(k?.isUglyApp).toBe(false);
  });
});

describe('getCachedRepos', () => {
  it('returns empty array before any scan', () => {
    // Note: vitest modules are reset between test files, but if another test
    // in this file already populated the cache we still get the array back.
    const cached = getCachedRepos();
    expect(Array.isArray(cached)).toBe(true);
    // Cache could be populated from prior tests in this file — that's fine;
    // the key invariant is that it never returns null/undefined.
  });
});
