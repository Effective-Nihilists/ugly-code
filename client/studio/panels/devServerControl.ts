// Control-file bridge so the coding agent (task context) can start/stop the
// project's dev server, which is OWNED by PreviewPanel in the renderer. Mirrors
// the log bridge (devServerLog.ts): the agent's dev_server_start/stop tools
// write a command file; PreviewPanel polls it and drives startDev/stopDev. Both
// sides go through native.fs so they share the file across JS contexts.

import { native } from 'ugly-app/native';

export const DEV_CONTROL_REL = '.ugly-studio/dev-server.control';
export type DevControlCmd = 'start' | 'stop' | 'restart';
export interface DevControl {
  cmd: DevControlCmd;
  /** Unique per request so PreviewPanel acts on each command exactly once. */
  nonce: string;
}

function controlPath(projectPath: string): string {
  return `${projectPath.replace(/\/+$/, '')}/${DEV_CONTROL_REL}`;
}

/** Agent side: request a dev-server action. Returns the nonce written. */
export async function writeDevControl(projectPath: string, cmd: DevControlCmd, nonce: string): Promise<void> {
  await native.fs.mkdir(`${projectPath.replace(/\/+$/, '')}/.ugly-studio`, true);
  await native.fs.writeFile(controlPath(projectPath), JSON.stringify({ cmd, nonce } satisfies DevControl));
}

/** PreviewPanel side: read the pending command (or null if none / unreadable). */
export async function readDevControl(projectPath: string): Promise<DevControl | null> {
  try {
    const raw = JSON.parse(await native.fs.readFile(controlPath(projectPath))) as Partial<DevControl>;
    if ((raw.cmd === 'start' || raw.cmd === 'stop' || raw.cmd === 'restart') && typeof raw.nonce === 'string') {
      return { cmd: raw.cmd, nonce: raw.nonce };
    }
    return null;
  } catch {
    return null;
  }
}
