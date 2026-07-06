// CLI auth: resolve the user session token passed to the agent's /api/* fetch
// shim so LLM calls on the deployed origin authenticate. Precedence:
//   explicit --token  →  --test-user (mint via `ugly-app test-user create`)  →
//   ~/.ugly-bot/auth.json (written by `ugly-app login`).
import { native } from 'ugly-app/native';
import { spawnCollect } from '../agent/tools/spawn';

export interface AuthOpts { token?: string; testUser?: boolean; origin: string }
export interface ResolvedAuth { token: string; origin: string }

function home(): string {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
  return env.HOME ?? env.USERPROFILE ?? '.';
}

export async function resolveAuth(opts: AuthOpts): Promise<ResolvedAuth> {
  if (opts.token) return { token: opts.token, origin: opts.origin };
  if (opts.testUser) {
    const res = await spawnCollect('ugly-app', ['test-user', 'create'], {});
    let token: string | undefined;
    try { token = (JSON.parse(res.stdout) as { result?: { token?: string } }).result?.token; } catch { /* not JSON */ }
    if (!token) throw new Error(`test-user create returned no token: ${res.stdout.slice(0, 200)}`);
    return { token, origin: opts.origin };
  }
  try {
    const raw = await native.fs.readFile(`${home()}/.ugly-bot/auth.json`);
    const token = (JSON.parse(raw) as { token?: string }).token;
    if (token) return { token, origin: opts.origin };
  } catch { /* not logged in */ }
  throw new Error('Not logged in. Run `ugly-code --login` (or pass --test-user / --token).');
}
