// dev_server_errors (filters the dev log) + dev_server_start/stop (write the
// control-file bridge PreviewPanel polls).
import { describe, it, expect, beforeEach } from 'vitest';
import { resetMock, mockFiles } from '../../helpers/uglyNativeMock';
import {
  devServerStartTool,
  devServerStopTool,
  devServerErrorsTool,
} from '../../../client/agent/tools/devServer';

const CTL = '/proj/.ugly-studio/dev-server.control';

describe('dev_server_errors', () => {
  beforeEach(() =>
    resetMock({
      files: {
        '/proj/.ugly-studio/dev-server.log':
          'ok\nl2\nTypeError: x is not defined\n[error: boom]\nl5\n',
      },
    }),
  );

  it('returns only the error-ish lines', async () => {
    const out = await devServerErrorsTool.run({}, { projectDir: '/proj' });
    expect(out).toContain('TypeError');
    expect(out).toContain('[error: boom]');
    expect(out).not.toContain('\nl2');
  });

  it('reports a clean log', async () => {
    resetMock({
      files: {
        '/proj/.ugly-studio/dev-server.log': 'ready\nlistening on 4321\n',
      },
    });
    expect(await devServerErrorsTool.run({}, { projectDir: '/proj' })).toMatch(
      /no errors/i,
    );
  });

  it('reports no log at all', async () => {
    resetMock({ files: {} });
    expect(await devServerErrorsTool.run({}, { projectDir: '/proj' })).toMatch(
      /no dev.?server|start it/i,
    );
  });
});

describe('dev_server_start / dev_server_stop control bridge', () => {
  beforeEach(() => resetMock({ files: {} }));

  it('start writes a `start` command to the control file', async () => {
    const out = await devServerStartTool.run({}, { projectDir: '/proj' });
    expect(out).toMatch(/start/i);
    const ctl = mockFiles().get(CTL);
    expect(ctl).toBeTruthy();
    expect(JSON.parse(ctl!).cmd).toBe('start');
  });

  it('stop writes a `stop` command with a fresh nonce (act-once)', async () => {
    await devServerStartTool.run({}, { projectDir: '/proj' });
    const n1 = JSON.parse(mockFiles().get(CTL)!).nonce as string;
    await devServerStopTool.run({}, { projectDir: '/proj' });
    const ctl = JSON.parse(mockFiles().get(CTL)!) as {
      cmd: string;
      nonce: string;
    };
    expect(ctl.cmd).toBe('stop');
    expect(ctl.nonce).not.toBe(n1);
  });

  it('reports when no project is open', async () => {
    expect(await devServerStartTool.run({}, {})).toMatch(/no project/i);
  });
});
