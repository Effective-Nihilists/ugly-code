// Task B2.2 python_exec + B2.3 python_libraries.
import { describe, it, expect, beforeEach } from 'vitest';
import { resetMock, mockCalls } from '../../helpers/uglyNativeMock';
import { pythonExecTool } from '../../../client/agent/tools/pythonExec';
import { pythonLibrariesTool } from '../../../client/agent/tools/pythonLibraries';

describe('python_exec', () => {
  it('runs the snippet and returns stdout', async () => {
    resetMock({ proc: (cmd, args) => ({ stdout: cmd === 'python' && args.includes('-c') ? 'hello\n' : '', code: 0 }) });
    const out = await pythonExecTool.run({ code: "print('hello')" }, { projectDir: '/proj' });
    expect(out).toContain('hello');
    const spawn = mockCalls().find((c) => c.channel === 'process.spawn');
    expect((spawn?.payload as { cmd: string }).cmd).toBe('python');
  });
  it('surfaces stderr + non-zero exit', async () => {
    resetMock({ proc: () => ({ stdout: '', stderr: 'Traceback: boom\n', code: 1 }) });
    const out = await pythonExecTool.run({ code: 'raise Exception()' }, undefined);
    expect(out).toMatch(/boom/);
    expect(out).toMatch(/exit 1/);
  });
});

describe('python_libraries', () => {
  it('lists installed libraries, filtered', async () => {
    resetMock({ proc: () => ({ stdout: 'numpy 1.0\nrequests 2.0\npandas 3.0\n', code: 0 }) });
    const out = await pythonLibrariesTool.run({ filter: 'num' }, { projectDir: '/proj' });
    expect(out).toContain('numpy');
    expect(out).not.toContain('requests');
  });
  it('lists all when no filter', async () => {
    resetMock({ proc: () => ({ stdout: 'numpy 1.0\nrequests 2.0\n', code: 0 }) });
    const out = await pythonLibrariesTool.run({}, undefined);
    expect(out).toContain('numpy');
    expect(out).toContain('requests');
  });
});
