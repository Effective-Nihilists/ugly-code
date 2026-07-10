// Spawn a process via the native facade and collect its full output + exit code.
// Unlike tools.ts's `runCommand` (which annotates output with [exit N] for the
// model), this returns the raw streams so callers can branch on the code —
// e.g. ripgrep's exit 1 ("no matches") vs 2 (error).

import { native } from 'ugly-app/native';

export interface SpawnResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export interface SpawnCollectOpts {
  cwd?: string;
  timeoutMs?: number;
}

export function spawnCollect(
  cmd: string,
  args: string[],
  opts: SpawnCollectOpts = {},
): Promise<SpawnResult> {
  const { cwd, timeoutMs } = opts;
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (result: SpawnResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    try {
      const proc = native.process.spawn(cmd, args, { ...(cwd ? { cwd } : {}) });
      proc.onStdout((c: string) => (stdout += c));
      proc.onStderr((c: string) => (stderr += c));
      proc.onError((e: string) => { settle({ stdout, stderr: stderr + e, code: null }); });
      proc.onExit((code: number | null) => { settle({ stdout, stderr, code }); });
      if (timeoutMs) {
        timer = setTimeout(() => {
          try { proc.kill(); } catch { /* already gone */ }
          settle({ stdout: stdout.trimEnd(), stderr: stderr + `\n[timed out after ${Math.round(timeoutMs / 1000)}s]`, code: null });
        }, timeoutMs);
      }
    } catch (e) {
      console.error('[spawnTool:spawn]', JSON.stringify({ cmd, args, error: e instanceof Error ? e.message : String(e) }), e instanceof Error ? e.stack : undefined);
      settle({ stdout, stderr: (e as Error).message, code: null });
    }
  });
}
