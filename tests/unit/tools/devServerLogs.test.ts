// Task B2.4 — dev_server_logs reads the persisted dev-server log.
import { describe, it, expect, beforeEach } from 'vitest';
import { resetMock } from '../../helpers/uglyNativeMock';
import { devServerLogsTool } from '../../../client/agent/tools/devServerLogs';

beforeEach(() =>
  resetMock({
    files: { '/proj/.ugly-studio/dev-server.log': 'l1\nl2\nERROR boom\nl4\nl5\n' },
  }),
);

describe('dev_server_logs', () => {
  it('returns the last N lines', async () => {
    const out = await devServerLogsTool.run({ lines: 2 }, { projectDir: '/proj' });
    expect(out).toContain('l4');
    expect(out).toContain('l5');
    expect(out).not.toContain('l1');
  });

  it('filters lines by substring', async () => {
    const out = await devServerLogsTool.run({ filter: 'ERROR' }, { projectDir: '/proj' });
    expect(out).toContain('boom');
    expect(out).not.toContain('l1');
  });

  it('reports when there is no dev-server log', async () => {
    resetMock({ files: {} });
    const out = await devServerLogsTool.run({}, { projectDir: '/proj' });
    expect(out).toMatch(/no dev.?server|not running|no log/i);
  });
});
