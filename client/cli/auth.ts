// CLI auth: resolve the user session token passed to the agent's /api/* fetch
// shim so LLM calls on the deployed origin authenticate. Precedence:
//   explicit --token  →  --test-user (mint via `ugly-app test-user create`)  →
//   ~/.ugly-bot/auth.json (written by `ugly-app login`).
//
// Uses Node builtins (not native.fs/process): auth is resolved BEFORE the agent's
// UglyNative bridge is installed, so the native facade isn't available yet.
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export interface AuthOpts {
  token?: string;
  testUser?: boolean;
  origin: string;
}
export interface ResolvedAuth {
  token: string;
  origin: string;
}

function home(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? '.';
}

export async function resolveAuth(opts: AuthOpts): Promise<ResolvedAuth> {
  if (opts.token) return { token: opts.token, origin: opts.origin };
  if (opts.testUser) {
    const { stdout } = await execFileP('ugly-app', ['test-user', 'create']);
    let token: string | undefined;
    try {
      token = (JSON.parse(stdout) as { result?: { token?: string } }).result
        ?.token;
    } catch {
      /* not JSON */
    }
    if (!token)
      throw new Error(
        `test-user create returned no token: ${stdout.slice(0, 200)}`,
      );
    return { token, origin: opts.origin };
  }
  try {
    const raw = await readFile(`${home()}/.ugly-bot/auth.json`, 'utf8');
    const token = (JSON.parse(raw) as { token?: string }).token;
    if (token) return { token, origin: opts.origin };
  } catch {
    /* not logged in */
  }
  throw new Error(
    'Not logged in. Run `ugly-code --login` (or pass --test-user / --token).',
  );
}
