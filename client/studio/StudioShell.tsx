import React from 'react';
import { useAppOptional } from 'ugly-app/client';
import { permissions, type BundledToolName } from 'ugly-app/native';
import { ProjectsProvider } from './state/ProjectsContext';
import { ProjectOnboarding } from './panels/ProjectOnboarding';
import { ProjectCreationProgress } from './panels/ProjectCreationProgress';
import StudioProjectPage from './StudioProjectPage';
import { ModalStackProvider } from './system/modal/ModalContext';
import { ModalHost } from './system/modal/ModalHost';
import { PopoverHost } from './system/popover/PopoverHost';
import BinariesInstallOverlay from './panels/BinariesInstallOverlay';
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

const GATE: React.CSSProperties = {
  height: '100dvh',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 14,
  padding: 24,
  background: 'var(--bg-primary)',
  color: 'var(--text-primary)',
  boxSizing: 'border-box',
};

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

  // Request — and thereby PROVISION — the bundled toolchain the IDE relies on:
  //   • node/git/pnpm (+ bash/npm/npx shell helpers) — Preview (`pnpm dev`),
  //     scaffolding (`npx ugly-app init`), and the terminal.
  //   • uv — semantic codebase search: the indexer uses uv to install CPython into
  //     its own venv (+ sqlite_vec), so uv is the real dependency, not `python`.
  //   • postgres — the local dev database: the Database panel (`dbScript`) and the
  //     agent's dev server (`sessionWorkspace`) run bundled postgres. It MUST be in
  //     this blocking grant — otherwise it falls to the host's best-effort launch
  //     download, which can silently not-complete, leaving those features to fail
  //     with "bundled postgres missing" on a machine that never finished it.
  // Bundled tools are requested like any permission (mic/camera); the host installs
  // the downloadable ones on grant. We AWAIT this grant and gate the whole app on it
  // (`binariesReady`) — `daemon.requestPermissions` resolves only AFTER the host
  // finishes installing the requested tools. Rendering the body before that let a
  // project spawn (`npx ugly-app init`, the terminal) race an in-flight install →
  // `InstallingError` ("bundled tools are still installing before 'bash' can run"),
  // which on a fresh machine broke project setup (empty/wrong-dir project). A
  // web-only shell with no host rejects → we unblock (nothing to install).
  const [binariesReady, setBinariesReady] = React.useState(false);
  React.useEffect(() => {
    type GrantReq = Parameters<typeof permissions.request>[0];
    // Bundled tools we PROVISION — typed against ugly-app's catalog (BundledToolName)
    // so a typo or a non-catalog name is a BUILD error, not a silent no-op on the
    // install side (which is how postgres went un-provisioned before).
    const bundled: readonly BundledToolName[] = ['node', 'git', 'curl', 'pnpm', 'uv', 'postgres', 'minio', 'rg'];
    // System executables we only need spawn PERMISSION for — present on every host
    // or shipped with node (npm/npx), so NOT catalog/installable tools.
    const permissionOnly = ['bash', 'npm', 'npx'];
    let alive = true;
    void permissions
      .request({ process: [...permissionOnly, ...bundled] } as unknown as GrantReq)
      .catch(() => undefined)
      .finally(() => { if (alive) setBinariesReady(true); });
    return () => { alive = false; };
  }, []);

  let body: React.ReactNode;
  if (!binariesReady) {
    // Paused until the host finishes installing the bundled toolchain. Blocks
    // project creation / the coding agent / any spawn so nothing runs against a
    // not-yet-installed tool. BinariesInstallOverlay (below) layers live download
    // progress on top when the host emits it.
    body = (
      <div data-id="binaries-install-gate" style={GATE}>
        <div className="us-spin" style={{ fontSize: 22, color: 'var(--accent)' }}>⟳</div>
        <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 15 }}>
          Setting up your developer tools…
        </div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-muted)', maxWidth: 380, textAlign: 'center' }}>
          Installing the bundled toolchain (node, git, pnpm, postgres…). This runs
          once and can take a few minutes on a fresh machine.
        </div>
      </div>
    );
  } else if (creating) {
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
      {/* Blocks the page while the desktop shell installs bundled tools this app
          needs — otherwise a slow/failed install is invisible to the user. */}
      <BinariesInstallOverlay />
    </ModalStackProvider>
  );
}
