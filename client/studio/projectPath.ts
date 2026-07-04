// The opened project's absolute path — set by StudioProjectPage (UI) or, in a headless
// coding-task bundle, by the task entry from uglyTask.params. Kept in a tiny React-free
// module so the agent loop (clientAgent.ts) can be bundled into a Node task child without
// pulling in useSocket → React.
let activeProjectPath: string | null = null;

export function setActiveProjectPath(p: string | null): void {
  activeProjectPath = p;
}

export function getActiveProjectPath(): string | null {
  if (activeProjectPath) return activeProjectPath;
  // Fallback to the URL. On a page reload this module var resets to null and
  // stays null until StudioProjectPage's mount effect re-sets it — so a host
  // query that races that effect (DB panel / search on mount) spuriously failed
  // with "No active project" even though a project is clearly open. The open
  // project is durably encoded in the URL as `?path=<abs path>` (StudioShell's
  // PATH_PARAM), so read it directly. Guarded for the React-free Node task child,
  // which has no `window` and sets the path explicitly via setActiveProjectPath.
  if (typeof window !== 'undefined') {
    try {
      const p = new URLSearchParams(window.location.search).get('path');
      if (p) return p;
    } catch { /* malformed URL — fall through to null */ }
  }
  return null;
}
