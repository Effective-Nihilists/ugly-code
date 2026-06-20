import React from 'react';
import { ProjectsProvider } from './state/ProjectsContext';
import { ProjectOnboarding } from './panels/ProjectOnboarding';
import StudioProjectPage from './StudioProjectPage';

// The Studio IDE on window.UglyNative, backed by the native transport shim
// (./hooks/useSocket) instead of the sidecar /rpc socket.
//   Phase 1: the real project picker (ProjectOnboarding).
//   Phase 2: opening a project mounts the real session sidebar (StudioProjectPage).
//   Phase 3 (next): the session workspace — coding-agent chat + the 9-tab rail.
export default function StudioShell(): React.ReactElement {
  const [open, setOpen] = React.useState<{ name: string; path?: string } | null>(null);

  if (open) {
    return (
      <StudioProjectPage
        projectName={open.name}
        {...(open.path ? { projectPath: open.path } : {})}
        onBack={() => setOpen(null)}
      />
    );
  }

  return (
    <ProjectsProvider>
      <ProjectOnboarding
        onProjectOpen={(name, path) => setOpen({ name, ...(path ? { path } : {}) })}
        platform={null}
        onOpenSettings={() => undefined}
        leaving={false}
      />
    </ProjectsProvider>
  );
}
