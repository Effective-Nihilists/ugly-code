// Recent-projects list, persisted in the IDE's localStorage (survives reloads +
// app restarts in the Electron session). Recorded whenever a project opens
// (create / open-folder / clone / recent / eval) and read by the picker.

export interface RecentProject {
  name: string;
  path: string;
  lastOpened: number;
}

const KEY = 'ugly-studio:recent-projects';
const MAX = 24;

export function getRecentProjects(): RecentProject[] {
  try {
    const raw = localStorage.getItem(KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(arr)) return [];
    return arr.filter((p): p is RecentProject => !!p && typeof (p as RecentProject).path === 'string');
  } catch {
    return [];
  }
}

/** Add (or bump to the front) a project. Most-recent first, capped at MAX. */
export function addRecentProject(name: string, path: string): void {
  if (!path) return;
  try {
    const label = name.trim() ? name : (path.split('/').pop() ?? path);
    const next = [{ name: label, path, lastOpened: Date.now() }, ...getRecentProjects().filter((p) => p.path !== path)];
    localStorage.setItem(KEY, JSON.stringify(next.slice(0, MAX)));
  } catch {
    /* localStorage unavailable — recents are best-effort */
  }
}

export function removeRecentProject(path: string): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(getRecentProjects().filter((p) => p.path !== path)));
  } catch {
    /* ignore */
  }
}
