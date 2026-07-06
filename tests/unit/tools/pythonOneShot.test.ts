import { describe, it, expect, vi } from 'vitest';

const { spawn, writeFile, rm } = vi.hoisted(() => ({ spawn: vi.fn(), writeFile: vi.fn(async () => {}), rm: vi.fn(async () => {}) }));
vi.mock('ugly-app/native', () => ({ native: { process: { spawn }, fs: { writeFile, rm } } }));
vi.mock('../../../client/agent/binaries/resolve', () => ({ ensureUv: async () => 'uv' }));

import { runPythonOneShot } from '../../../client/agent/tools/pythonOneShot';

function fakeProc() {
  const cbs: Record<string, (a?: unknown) => void> = {};
  return {
    handle: {
      onStdout: (cb: (c: string) => void) => { cbs.stdout = cb as never; },
      onStderr: (cb: (c: string) => void) => { cbs.stderr = cb as never; },
      onExit: (cb: (c: number | null) => void) => { cbs.exit = cb as never; },
      onError: (cb: (e: string) => void) => { cbs.error = cb as never; },
      write: () => {}, closeStdin: () => {}, kill: vi.fn(),
    },
    cbs,
  };
}

describe('runPythonOneShot', () => {
  it('runs uv run --script and returns stdout, cleaning up the tempfile', async () => {
    const fp = fakeProc();
    spawn.mockImplementation((cmd: string, args: string[]) => {
      expect(cmd).toBe('uv');
      expect(args.slice(0, 2)).toEqual(['run', '--script']);
      queueMicrotask(() => { fp.cbs.stdout('hello\n'); fp.cbs.exit(0); });
      return fp.handle;
    });
    const r = await runPythonOneShot({ code: "print('hello')" });
    expect(r.output).toContain('hello');
    expect(r.isError).toBe(false);
    expect(writeFile).toHaveBeenCalled();
    expect(rm).toHaveBeenCalled();
  });

  it('annotates a non-zero exit', async () => {
    const fp = fakeProc();
    spawn.mockImplementation(() => { queueMicrotask(() => { fp.cbs.stderr('boom\n'); fp.cbs.exit(1); }); return fp.handle; });
    const r = await runPythonOneShot({ code: 'raise SystemExit(1)' });
    expect(r.output).toMatch(/boom/);
    expect(r.output).toMatch(/exit 1/);
    expect(r.isError).toBe(true);
  });

  it('kills on timeout and reports timedOut', async () => {
    vi.useFakeTimers();
    const fp = fakeProc();
    spawn.mockImplementation(() => fp.handle);
    const p = runPythonOneShot({ code: 'while True: pass', timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(60);
    expect(fp.handle.kill).toHaveBeenCalledWith('SIGTERM');
    fp.cbs.exit(null);
    const r = await p;
    expect(r.timedOut).toBe(true);
    vi.useRealTimers();
  });
});
