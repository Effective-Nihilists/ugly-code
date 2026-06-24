import { describe, it, expect } from 'vitest';
import { DB_SCRIPT } from '../../client/studio/db/dbScript';

// Regression guard for the "Database tab stuck on Loading…" bug.
//
// The db script runs in a Node child (runDbScript spawns it). It connects via
// ugly-app/server's createAdapter(), which opens a pg pool that keeps the event loop
// alive — so after writing its result the child would NEVER exit on its own, and
// runDbScript (which resolves on the child's `exit`) hangs forever → the panel spins.
//
// The e2e suite can't catch this: its native mock returns process.spawn results
// statically (no real child, no real exit), so the hang only manifests against a real
// process. These assertions lock in the explicit exit.
describe('dbScript', () => {
  it('writes its result to stdout then force-exits (else the panel hangs on Loading…)', () => {
    expect(DB_SCRIPT).toContain('process.stdout.write');
    // The exit must run in the write callback so stdout isn't truncated on a pipe.
    expect(DB_SCRIPT).toMatch(/\(\)\s*=>\s*process\.exit\(0\)\)/);
  });

  it('opens the adapter (the pool that necessitates the explicit exit)', () => {
    expect(DB_SCRIPT).toContain('createAdapter');
  });
});
