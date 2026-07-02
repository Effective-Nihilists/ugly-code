import React from 'react';
import { useAppOptional } from 'ugly-app/client';
import { ProjectsProvider } from './state/ProjectsContext';
import { ProjectOnboarding } from './panels/ProjectOnboarding';
import { ProjectCreationProgress } from './panels/ProjectCreationProgress';
import StudioProjectPage from './StudioProjectPage';
import { ModalStackProvider } from './system/modal/ModalContext';
import { ModalHost } from './system/modal/ModalHost';
import { PopoverHost } from './system/popover/PopoverHost';
import { recordRecentProject } from './state/recentProjects';

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
interface OpenProject {
  name: string;
  path?: string;
}

// The open project is reflected in the URL as `?path=<local path>` so the
// workspace is deep-linkable, survives a reload, and Back returns to the picker.
const PATH_PARAM = 'path';

function projectFromUrl(): OpenProject | null {
  const path = new URLSearchParams(window.location.search).get(PATH_PARAM);
  if (!path) return null;
  // Name isn't in the URL (path is the source of truth) — derive it from the
  // last path segment, e.g. /Users/me/test1 → "test1".
  const name = path.split('/').filter(Boolean).pop() ?? path;
  return { name, path };
}

function pushProjectUrl(project: OpenProject | null): void {
  let url = window.location.pathname;
  if (project?.path) {
    // Keep slashes readable (the user's `?path=/test1` shape) while still
    // escaping spaces/specials; URLSearchParams.get decodes both forms.
    url += `?${PATH_PARAM}=${encodeURIComponent(project.path).replace(/%2F/g, '/')}`;
  }
  window.history.pushState({}, '', url);
}

export default function StudioShell(): React.ReactElement {
  // Restore an open project from the URL on first paint (deep link / reload).
  const [open, setOpen] = React.useState<OpenProject | null>(() => projectFromUrl());
  // When set, the picker has handed off to the live "Create Project" progress
  // view (streams `npx ugly-app init` + `pnpm install`); on success it opens.
  const [creating, setCreating] = React.useState<{ name: string; parentDir: string } | null>(null);
  // The ugly-app socket (cross-device sync). Optional: a logged-out shell still
  // renders the picker; it just won't record/sync recents until sign-in.
  const app = useAppOptional();

  const openProject = React.useCallback((name: string, path?: string) => {
    const next: OpenProject = { name, ...(path ? { path } : {}) };
    // Stamp this open into the synced recent-projects list (desktop only —
    // recordRecentProject no-ops when there's no local host to point at).
    if (path) void recordRecentProject(app?.socket, name, path);
    setCreating(null);
    setOpen(next);
    pushProjectUrl(next);
  }, [app]);
  const closeProject = React.useCallback(() => {
    setOpen(null);
    pushProjectUrl(null);
  }, []);

  // Browser Back/Forward → re-derive the open project from the URL.
  React.useEffect(() => {
    const onPop = (): void => { setOpen(projectFromUrl()); };
    window.addEventListener('popstate', onPop);
    return () => { window.removeEventListener('popstate', onPop); };
  }, []);

  let body: React.ReactNode;
  if (creating) {
    body = (
      <ProjectCreationProgress
        name={creating.name}
        parentDir={creating.parentDir}
        onDone={(name, path) => { openProject(name, path); }}
        onCancel={() => { setCreating(null); }}
      />
    );
  } else if (open) {
    body = (
      <StudioProjectPage
        projectName={open.name}
        {...(open.path ? { projectPath: open.path } : {})}
        onBack={closeProject}
      />
    );
  } else {
    body = (
      <ProjectsProvider>
        <ProjectOnboarding
          onProjectOpen={(name, path) => { openProject(name, path); }}
          onBeginCreate={(name, parentDir) => { setCreating({ name, parentDir }); }}
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
