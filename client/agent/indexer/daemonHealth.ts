/**
 * Human-readable diagnosis of why the indexer daemon isn't answering.
 *
 * Split out of daemon.ts so it is pure (no fs, no spawn, no bundled-binary
 * imports) and can be unit-tested. daemon.ts feeds it the portfile it read and
 * whether that pid is alive.
 *
 * This exists because a silent daemon death used to be invisible: the status
 * read collapses to `null`, the pill renders "Codebase: analyzing…", and the
 * stats modal showed an empty Diagnostics box — the daemon log is truncated on
 * every respawn, and `lastDaemonError` is null when the *last spawn succeeded*
 * and the process died later.
 */

export interface DaemonPortFile {
  port: number;
  pid: number;
  started_at: number;
}

export type DaemonHealth =
  /** A portfile exists, the pid is alive, and it answered /ping. */
  | { state: 'running'; message: string }
  /** Never started on this machine (or the portfile was cleaned up). */
  | { state: 'never-started'; message: string }
  /** Portfile points at a pid that no longer exists — it crashed or was killed. */
  | { state: 'dead'; message: string }
  /** Pid is alive but not answering /ping — wedged, or still binding its port. */
  | { state: 'unresponsive'; message: string };

function ageOf(startedAt: number, now: number): string {
  const secs = Math.max(0, Math.round((now - startedAt) / 1000));
  if (secs < 90) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 90) return `${mins}m ago`;
  return `${Math.round(mins / 60)}h ago`;
}

/**
 * Diagnose the daemon from the facts daemon.ts can cheaply observe.
 *
 * `portFile` is null when the file is missing/unparseable. `pidAlive` and
 * `responding` are only meaningful when a portfile exists.
 */
export function describeDaemonHealth(
  portFile: DaemonPortFile | null,
  pidAlive: boolean,
  responding: boolean,
  now: number,
): DaemonHealth {
  if (!portFile) {
    return {
      state: 'never-started',
      message:
        'The indexer daemon has not been started yet. It boots on first use; ' +
        'the first run also downloads a Python runtime and an embedding model.',
    };
  }
  if (!pidAlive) {
    return {
      state: 'dead',
      message:
        `The indexer daemon (pid ${portFile.pid}, started ${ageOf(portFile.started_at, now)}) ` +
        'is no longer running — it crashed, was killed, or the machine slept. Restarting it.',
    };
  }
  if (!responding) {
    return {
      state: 'unresponsive',
      message:
        `The indexer daemon (pid ${portFile.pid}) is running on port ${portFile.port} ` +
        'but is not answering. It may still be starting up, or it is wedged.',
    };
  }
  return { state: 'running', message: 'The indexer daemon is running.' };
}
