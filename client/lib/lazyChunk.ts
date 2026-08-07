import React from 'react';

/**
 * `React.lazy` with stale-deploy chunk recovery.
 *
 * After a redeploy, a client holding the cached index.html still points at the
 * OLD hashed chunk filenames, which no longer exist on the CDN. The dynamic
 * `import()` then rejects ("Failed to fetch dynamically imported module") and
 * the Suspense boundary never resolves — the page is wedged. errorLog caught
 * exactly this on the home route:
 *   Failed to fetch dynamically imported module:
 *   https://code-static.ugly.bot/static/assets/StudioLandingPage-CSMh92jr.js
 *
 * ugly-app's `lazyPage` already does this for ROUTE entries, but it does not
 * export the helper, so a nested `React.lazy` gets no recovery at all. Use this
 * instead of `React.lazy` anywhere a chunk is imported outside the route table.
 *
 * Reload ONCE, guarded by sessionStorage, so a genuinely-broken chunk cannot
 * loop; the guard clears on success so a later deploy can recover again.
 */
export function lazyChunk<P extends object>(
  factory: () => Promise<{ default: React.ComponentType<P> }>,
): React.LazyExoticComponent<React.ComponentType<P>> {
  const RELOAD_KEY = '__uglyChunkReload__';
  return React.lazy(async () => {
    try {
      const mod = await factory();
      try {
        sessionStorage.removeItem(RELOAD_KEY);
      } catch {
        /* no sessionStorage (privacy mode) — nothing to clear */
      }
      return mod;
    } catch (err) {
      let firstFailure = false;
      try {
        firstFailure = !sessionStorage.getItem(RELOAD_KEY);
        if (firstFailure) sessionStorage.setItem(RELOAD_KEY, '1');
      } catch {
        /* no sessionStorage → can't guard a reload loop, so rethrow below */
      }
      if (firstFailure && typeof window !== 'undefined') {
        window.location.reload();
        // The reload replaces this document; keep Suspense pending so no error
        // boundary paints before we're gone.
        return new Promise<{ default: React.ComponentType<P> }>(() => {
          /* never settles — the reload tears down this document */
        });
      }
      throw err;
    }
  });
}
