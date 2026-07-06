// Shared eval-run history ledger — the CLI↔studio parity mechanism. Both
// surfaces drive the same agent core; this is where a run they produce is
// recorded so it shows up in the other's history. A JSONL ledger at
// ~/.ugly-code/eval-history.jsonl, written via native.fs (works in the CLI's
// Node UglyNative and, host-HOME permitting, the studio bridge).
import { native } from 'ugly-app/native';

export interface RunHistoryEntry {
  taskName: string;
  projectName: string;
  projectPath: string;
  sessionId: string;
  createdAt: string;
  gradedAt?: string;
  score?: number;
  scoreMax?: number;
  costUsd?: number;
  /** Total messages (back-compat). Inflated by harness-injected nudges/resumes. */
  turns?: number;
  /** Honest model turn count — assistant messages only, excludes injected nudges. */
  assistantTurns?: number;
  /** Token usage when the session store captured it (input/output/cache). */
  tokens?: { input: number; output: number; cacheRead: number; cacheCreate: number };
  /** Wall-clock of the run in ms (session updated − created). */
  durationMs?: number;
  /** True when the provider produced zero assistant turns (outage), not a real 0-score. */
  transportFailure?: boolean;
  config?: string;
}

export function historyPath(): string {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
  const home = env.HOME ?? env.USERPROFILE ?? '.';
  return `${home}/.ugly-code/eval-history.jsonl`;
}

async function readAll(): Promise<RunHistoryEntry[]> {
  try {
    const raw = await native.fs.readFile(historyPath());
    return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l) as RunHistoryEntry);
  } catch {
    return [];
  }
}

// native.fs has no append; serialize read-modify-write so concurrent appends
// (a comparison's back-to-back runs) don't clobber each other.
let chain: Promise<unknown> = Promise.resolve();

export function appendRunHistory(entry: RunHistoryEntry): Promise<void> {
  const op = async (): Promise<void> => {
    const path = historyPath();
    await native.fs.mkdir(path.slice(0, path.lastIndexOf('/')), true);
    const rows = await readAll();
    rows.push(entry);
    await native.fs.writeFile(path, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  };
  chain = chain.then(op, op);
  return chain.then(() => undefined);
}

/** Newest-first, in the shape the studio's evalListHistory expects. */
export async function listRunHistory(): Promise<{ runs: RunHistoryEntry[] }> {
  return { runs: (await readAll()).reverse() };
}

export function deleteRunFromHistory(projectName: string): Promise<{ ok: boolean }> {
  const op = async (): Promise<{ ok: boolean }> => {
    const kept = (await readAll()).filter((e) => e.projectName !== projectName);
    await native.fs.writeFile(historyPath(), kept.length ? kept.map((r) => JSON.stringify(r)).join('\n') + '\n' : '');
    return { ok: true };
  };
  const next = chain.then(op, op);
  chain = next.catch(() => undefined);
  return next;
}
