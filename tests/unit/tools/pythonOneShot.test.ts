import { describe, it, expect, vi, beforeEach } from 'vitest';

const { spawn, writeFile, rm } = vi.hoisted(() => ({
  spawn: vi.fn(),
  writeFile: vi.fn(async () => {}),
  rm: vi.fn(async () => {}),
}));
vi.mock('ugly-app/native', () => ({
  native: { process: { spawn }, fs: { writeFile, rm } },
}));
vi.mock('../../../client/agent/binaries/resolve', () => ({
  ensureUv: async () => 'uv',
}));

import { runPythonOneShot } from '../../../client/agent/tools/pythonOneShot';

function fakeProc() {
  const cbs: Record<string, (a?: unknown) => void> = {};
  return {
    handle: {
      onStdout: (cb: (c: string) => void) => {
        cbs.stdout = cb as never;
      },
      onStderr: (cb: (c: string) => void) => {
        cbs.stderr = cb as never;
      },
      onExit: (cb: (c: number | null) => void) => {
        cbs.exit = cb as never;
      },
      onError: (cb: (e: string) => void) => {
        cbs.error = cb as never;
      },
      write: () => {},
      closeStdin: () => {},
      kill: vi.fn(),
    },
    cbs,
  };
}

describe('runPythonOneShot', () => {
  beforeEach(() => {
    spawn.mockClear();
    writeFile.mockClear();
    rm.mockClear();
  });

  it('runs uv run --script and returns stdout, cleaning up the tempfile', async () => {
    const fp = fakeProc();
    spawn.mockImplementation((cmd: string, args: string[]) => {
      expect(cmd).toBe('uv');
      expect(args.slice(0, 2)).toEqual(['run', '--script']);
      queueMicrotask(() => {
        fp.cbs.stdout('hello\n');
        fp.cbs.exit(0);
      });
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
    spawn.mockImplementation(() => {
      queueMicrotask(() => {
        fp.cbs.stderr('boom\n');
        fp.cbs.exit(1);
      });
      return fp.handle;
    });
    const r = await runPythonOneShot({ code: 'raise SystemExit(1)' });
    expect(r.output).toMatch(/boom/);
    expect(r.output).toMatch(/exit 1/);
    expect(r.isError).toBe(true);
  });

  it('guard mode injects the import, env, and PYTHONPATH', async () => {
    const fp = fakeProc();
    let seenArgs: string[] = [];
    let seenOpts: { env?: Record<string, string> } = {};
    spawn.mockImplementation(
      (
        _cmd: string,
        args: string[],
        opts: { env?: Record<string, string> },
      ) => {
        seenArgs = args;
        seenOpts = opts;
        queueMicrotask(() => {
          fp.cbs.exit(0);
        });
        return fp.handle;
      },
    );
    await runPythonOneShot({
      code: "open('x','w')",
      cwd: '/proj',
      mode: 'spec',
    });
    const written = writeFile.mock.calls[0][1] as string;
    expect(written.startsWith('import ugly_studio._guard')).toBe(true);
    expect(seenOpts.env?.UGLY_STUDIO_GUARD_MODE).toBe('spec');
    expect(seenOpts.env?.UGLY_STUDIO_GUARD_CWD).toBe('/proj');
    expect(seenOpts.env?.PYTHONPATH).toContain('python-lib');
    expect(seenArgs.slice(0, 2)).toEqual(['run', '--script']);
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
