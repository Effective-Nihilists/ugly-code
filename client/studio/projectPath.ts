// The opened project's absolute path — set by StudioProjectPage (UI) or, in a headless
// coding-task bundle, by the task entry from uglyTask.params. Kept in a tiny React-free
// module so the agent loop (clientAgent.ts) can be bundled into a Node task child without
// pulling in useSocket → React.
let activeProjectPath: string | null = null;

export function setActiveProjectPath(p: string | null): void {
  activeProjectPath = p;
}

export function getActiveProjectPath(): string | null {
  return activeProjectPath;
}
