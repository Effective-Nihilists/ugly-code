import React from 'react';
import { ProjectsProvider } from './state/ProjectsContext';
import { ProjectOnboarding } from './panels/ProjectOnboarding';

// Phase 1 of the Studio IDE on window.UglyNative: the real project picker
// (ProjectOnboarding) rendering inside the Ugly Browser, backed by the native
// transport shim (./hooks/useSocket) instead of the sidecar /rpc socket.
// Phase 2 mounts the project workspace (SessionLayout + session sidebar) from
// onProjectOpen.
export default function StudioShell(): React.ReactElement {
  const handleProjectOpen = (name: string, path?: string): void => {
    // eslint-disable-next-line no-console
    console.log('[studio] open project', name, path);
  };
  return (
    <ProjectsProvider>
      <ProjectOnboarding
        onProjectOpen={handleProjectOpen}
        platform={null}
        onOpenSettings={() => undefined}
        leaving={false}
      />
    </ProjectsProvider>
  );
}
