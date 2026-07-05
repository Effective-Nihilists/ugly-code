// Bridge the dev server's log (owned by PreviewPanel, in the renderer) to the
// agent's task context: PreviewPanel persists the rolling log to a per-project
// file; the `dev_server_logs` tool reads it. Both sides go through native.fs so
// they share the file regardless of which JS context they run in.

import { native } from 'ugly-app/native';

export const DEV_LOG_REL = '.ugly-studio/dev-server.log';

export function devServerLogPath(projectPath: string): string {
  return `${projectPath.replace(/\/+$/, '')}/${DEV_LOG_REL}`;
}

// Throttle writes so a chatty dev server doesn't hammer the fs bridge.
const lastWrite = new Map<string, number>();

/** Best-effort persist of the current log for a project (throttled ~1/sec). */
export async function persistDevLog(projectPath: string, text: string): Promise<void> {
  // A cheap monotonic clock without Date/performance (kept side-effect-free for
  // tests): count calls; persist at most every ~40 updates. PreviewPanel calls
  // this on every stdout chunk, so this bounds write frequency.
  const key = projectPath;
  const n = (lastWrite.get(key) ?? 0) + 1;
  lastWrite.set(key, n);
  if (n % 40 !== 1) return;
  try {
    await native.fs.mkdir(`${projectPath.replace(/\/+$/, '')}/.ugly-studio`, true);
    await native.fs.writeFile(devServerLogPath(projectPath), text);
  } catch {
    /* best-effort */
  }
}

/** Force a persist regardless of throttle (call on server start/stop/exit). */
export async function flushDevLog(projectPath: string, text: string): Promise<void> {
  try {
    await native.fs.mkdir(`${projectPath.replace(/\/+$/, '')}/.ugly-studio`, true);
    await native.fs.writeFile(devServerLogPath(projectPath), text);
  } catch {
    /* best-effort */
  }
}

/** Read the raw persisted log, or '' if none. */
export async function readDevLog(projectPath: string): Promise<string> {
  try {
    return await native.fs.readFile(devServerLogPath(projectPath));
  } catch {
    return '';
  }
}
