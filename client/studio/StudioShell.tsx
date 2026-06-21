import React from 'react';
import { ProjectsProvider } from './state/ProjectsContext';
import { ProjectOnboarding } from './panels/ProjectOnboarding';
import { ProjectCreationProgress } from './panels/ProjectCreationProgress';
import StudioProjectPage from './StudioProjectPage';
import { ModalStackProvider } from './system/modal/ModalContext';
import { ModalHost } from './system/modal/ModalHost';
import { PopoverHost } from './system/popover/PopoverHost';

// The Studio IDE on window.UglyNative, backed by the native transport shim
// (./hooks/useSocket) instead of the sidecar /rpc socket.
//   Phase 1: the real project picker (ProjectOnboarding).
//   Phase 2: opening a project mounts the real session sidebar (StudioProjectPage).
//   Phase 3 (next): the session workspace — coding-agent chat + the 9-tab rail.
//
// AppProvider was trimmed in the Phase-1 vendor, but the shell now uses
// `<Modal>`/`<Popover>` (Settings, pickers, the coding-agent chat), which call
// `useModalStack` — without the provider + portal hosts that throws
// "useModalStack must be used inside <AppProvider>" and white-screens the IDE.
// Restore the minimal AppProvider equivalent here: the stack context + the two
// portal targets (modal-root before popover-root so popovers paint above).
export default function StudioShell(): React.ReactElement {
  const [open, setOpen] = React.useState<{ name: string; path?: string } | null>(null);
  // When set, the picker has handed off to the live "Create Project" progress
  // view (streams `npx ugly-app init` + `pnpm install`); on success it opens.
  const [creating, setCreating] = React.useState<{ name: string; parentDir: string } | null>(null);

  let body: React.ReactNode;
  if (creating) {
    body = (
      <ProjectCreationProgress
        name={creating.name}
        parentDir={creating.parentDir}
        onDone={(name, path) => {
          setCreating(null);
          setOpen({ name, path });
        }}
        onCancel={() => setCreating(null)}
      />
    );
  } else if (open) {
    body = (
      <StudioProjectPage
        projectName={open.name}
        {...(open.path ? { projectPath: open.path } : {})}
        onBack={() => setOpen(null)}
      />
    );
  } else {
    body = (
      <ProjectsProvider>
        <ProjectOnboarding
          onProjectOpen={(name, path) => setOpen({ name, ...(path ? { path } : {}) })}
          onBeginCreate={(name, parentDir) => setCreating({ name, parentDir })}
          platform={null}
          onOpenSettings={() => undefined}
          leaving={false}
        />
      </ProjectsProvider>
    );
  }

  return (
    <ModalStackProvider>
      {body}
      <ModalHost />
      <PopoverHost />
    </ModalStackProvider>
  );
}
