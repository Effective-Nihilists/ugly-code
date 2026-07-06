// Task B2.2 python_exec + B2.3 python_libraries.
import { describe, it, expect, vi } from 'vitest';

const { runPythonOneShot } = vi.hoisted(() => ({ runPythonOneShot: vi.fn() }));
vi.mock('../../../client/agent/tools/pythonOneShot', () => ({ runPythonOneShot }));

import { resetMock } from '../../helpers/uglyNativeMock';
import { pythonExecTool } from '../../../client/agent/tools/pythonExec';
import { pythonLibrariesTool } from '../../../client/agent/tools/pythonLibraries';

describe('python_exec', () => {
  it('runs the snippet via the one-shot runner and returns its output', async () => {
    runPythonOneShot.mockResolvedValue({ output: 'hello', isError: false, timedOut: false, exitCode: 0 });
    const out = await pythonExecTool.run({ code: "print('hello')" }, { projectDir: '/proj' });
    expect(out).toBe('hello');
    expect(runPythonOneShot).toHaveBeenCalledWith(expect.objectContaining({ code: "print('hello')", cwd: '/proj' }));
  });
  it('passes an explicit timeout_ms through as timeoutMs', async () => {
    runPythonOneShot.mockResolvedValue({ output: 'x', isError: false, timedOut: false, exitCode: 0 });
    await pythonExecTool.run({ code: 'x=1', timeout_ms: 5000 }, undefined);
    expect(runPythonOneShot).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 5000 }));
  });
  it('requires code', async () => {
    const out = await pythonExecTool.run({}, undefined);
    expect(out).toMatch(/`code` is required/);
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
