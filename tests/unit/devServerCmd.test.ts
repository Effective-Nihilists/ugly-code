import { describe, it, expect } from 'vitest';
import { devServerSpawn } from '../../client/studio/panels/devServerCmd';

// Coverage for the Preview "Start app" control (previously the panel could only reload the
// iframe — there was no way to boot the dev server). Locks in that Start spawns the project's
// dev script on the session's preview port via a login shell (so pnpm resolves on PATH).
describe('devServerSpawn', () => {
  it('runs the dev script through a login bash on the given port', () => {
    const spec = devServerSpawn(4321);
    expect(spec.cmd).toBe('bash');
    expect(spec.args).toEqual(['-lc', 'pnpm dev']);
    expect(spec.env.PORT).toBe('4321');
  });

  it('binds the session-specific port so each session previews its own server', () => {
    expect(devServerSpawn(4109).env.PORT).toBe('4109');
    expect(devServerSpawn(4110).env.PORT).toBe('4110');
  });
});
