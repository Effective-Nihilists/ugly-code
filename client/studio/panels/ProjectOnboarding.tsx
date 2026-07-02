import React, { useCallback, useEffect, useRef, useState } from 'react';
import { isNativeAvailable } from 'ugly-app/native';
import { useAppOptional } from 'ugly-app/client';
import {
  useRecentProjects,
  useSelfDeviceId,
  removeRecentProject,
  connectToHost,
  type RecentProject,
} from '../state/recentProjects';
import { useKeyboardHeight } from '../hooks/useKeyboardHeight';
import { FilePicker } from '../components/FilePicker';
import { shortcut } from '../utils/platform';
import { generateTaskId } from '../utils/taskId';
import { timeAgoShort } from '../utils/timeAgo';
import { EvalPickerModal } from './EvalPickerModal';
import { ManifestoFooter } from './ManifestoFooter';
import { useIsMobile } from '../hooks/useIsMobile';

/**
 * Render text with each word in its own animated <span>. Words cascade
 * in with `baseDelayMs + i * stepMs` so the headline assembles itself
 * left-to-right instead of all at once. Used by the picker hero.
 */
function splitWords(
  text: string,
  baseDelayMs: number,
  stepMs = 60,
): React.ReactNode[] {
  return text.split(' ').map((word, i, arr) => (
    <span
      key={i}
      className="us-word"
      style={{ animationDelay: `${baseDelayMs + i * stepMs}ms` }}
    >
      {word}
      {i < arr.length - 1 ? ' ' : ''}
    </span>
  ));
}

/**
 * Tween an integer from 0 → target over durationMs on first mount, so
 * the recents count badge ticks up rather than snapping in.
 */
function useCountUp(target: number, durationMs: number): number {
  const [value, setValue] = useState(0);
  useEffect(() => {
    if (target <= 0) {
      setValue(0);
      return;
    }
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      // ease-out cubic — matches --ease-out feel
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(Math.round(target * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); };
  }, [target, durationMs]);
  return value;
}

/**
 * App-start project picker — the entry surface every time Ugly Studio
 * opens. Matches the `studio-home.html` mockup: 2-column layout with
 * a "Pick your poison" hero + 3 stacked action cards on the left,
 * and a recent-projects list on the right. Manifesto footer at the
 * bottom; platform-aware top bar with the shared StudioTopBar chrome.
 *
 * Actions (all three are "first-class", not hidden behind an Add
 * Project modal):
 *   - New Project   → `npx ugly-app init <name>` (primary, gradient)
 *   - Open Folder   → existing path, browse via Electron
 *   - Clone from Git → `git clone <url>` using the connected GitHub
 */

// The single default parent folder shared by all three onboarding actions —
// new-project's parent, clone-into target, and the folder-picker's start dir.
// Keeping them in sync means a repo you clone lands next to the projects you
// create (previously clone defaulted to `~` and open/clone browsed from `~`).
const DEFAULT_PARENT_DIR = '~/Documents/Ugly Studio';

interface ProjectOnboardingProps {
  /**
   * Fires when a project has been opened (picked, created, or cloned).
   * `path` is the absolute project root; the multi-tab shell uses it
   * to convert the active picker tab into a real project tab. Older
   * callers that omit `path` keep the previous single-project flow.
   */
  onProjectOpen: (name: string, path?: string) => void;
  /** Hand off "Create Project" to the shell's live progress view (which streams
   *  `npx ugly-app init` + `pnpm install` and opens the project on success). */
  onBeginCreate?: (name: string, parentDir: string) => void;
  /** Platform from electronAPI.getPlatform() — threads into StudioTopBar. */
  platform?: NodeJS.Platform | null;
  /** Open the global settings modal — wired up by the Editor shell. */
  onOpenSettings?: () => void;
  /** When true, run the exit animation (us-picker-exit). Editor.tsx
   *  flips this on once `projectOpen` becomes true; the wrapper
   *  fades + lifts before the parent unmounts the picker. */
  leaving?: boolean;
}

type ConnectionStatus = 'checking' | 'connected' | 'error';
type ActionTab = 'new' | 'open' | 'clone';

// Shape of the `openProject` / `cloneProject` responses — the opened
// project's display name + absolute root path.
interface OpenedProject {
  name: string;
  path: string;
}

// Shape of the `evalCreateProject` response — the carved one-off eval
// project plus the seed prompt for its first coding-agent turn.
interface EvalCreatedProject {
  projectName: string;
  projectPath: string;
  firstTurnPrompt: string;
}

// Phase 1: what used to be a sidecar `/api/*` fetch now routes through the
// native transport shim (window.UglyNative). The native bridge returns an
// untyped payload; each caller supplies the expected response shape via `T`
// and we narrow with a single boundary cast.
async function apiRequest<T>(method: string, input: object): Promise<T> {
  const { nativeRequest } = await import('../hooks/useSocket');
  return (await nativeRequest(method, input)) as T;
}

// ──────────────────────────────────────────────────────────────────
// Main component
// ──────────────────────────────────────────────────────────────────

export function ProjectOnboarding({
  onProjectOpen,
  onBeginCreate,
  // platform was threaded into the inline StudioTopBar; the bar is
  // now persistent at the Editor root and reads platform from
  // ChromeContext directly, so this prop is no longer needed here.
  platform: _platform,
  onOpenSettings: _onOpenSettings,
  leaving,
}: ProjectOnboardingProps): React.ReactElement {
  // Top bar intentionally stays neutral — no per-view content. The
  // picker used to publish a "PROJECT · none open" badge into the
  // center slot, but it visibly flickered during the body's
  // mount/exit transitions and clashed with the project tab strip
  // that lives in the same bar.

  // Below 768px the two-column hero/recents grid collapses to one column.
  const isMobile = useIsMobile();
  const keyboardHeight = useKeyboardHeight();
  const keyboardRef = useRef(keyboardHeight);
  keyboardRef.current = keyboardHeight;
  // Recent projects are synced across the user's devices/sessions (trackDocs).
  // selfDeviceId tells us which rows live on *this* desktop vs another machine.
  const recentProjects = useRecentProjects();
  const selfDeviceId = useSelfDeviceId();
  const app = useAppOptional();
  const [activeAction, setActiveAction] = useState<ActionTab>('new');
  const [newName, setNewName] = useState('');
  const [newParentDir, setNewParentDir] = useState(DEFAULT_PARENT_DIR);
  const [openPath, setOpenPath] = useState('');
  const [cloneUrl, setCloneUrl] = useState('');
  const [cloneDir, setCloneDir] = useState(DEFAULT_PARENT_DIR);
  const [picker, setPicker] = useState<{ startPath: string; onPick: (p: string) => void } | null>(null);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>('checking');
  // Interactive eval-task runner. Click the floating button → modal
  // lists every available task → on pick, server carves a one-off
  // project, creates a coding-agent session, seeds it from the
  // task's fixture, and the client routes through onProjectOpen so
  // ProjectHome auto-opens the session via sessionStorage.
  const [showEvalPicker, setShowEvalPicker] = useState(false);
  const [evalSubmitting, setEvalSubmitting] = useState(false);
  const [evalError, setEvalError] = useState<string | null>(null);
  const evalTaskIdRef = useRef<string | null>(null);

  const handlePickEvalTask = useCallback(
    async (taskName: string) => {
      if (evalSubmitting) return;
      setEvalSubmitting(true);
      setEvalError(null);
      const taskId = generateTaskId();
      evalTaskIdRef.current = taskId;
      try {
        const created = await apiRequest<EvalCreatedProject>(
          'evalCreateProject',
          {
            taskName,
            taskId,
          },
        );
        // Hand off to ProjectHome via sessionStorage. ProjectHome
        // reads `eval-pending-task` on mount, pre-fills the prompt
        // input with the first turn, and seeds the session AFTER the
        // user picks a model and clicks Start. Session creation is
        // deferred so the user can choose Claude CLI / Opus / etc. on
        // the project page before the agent spins up.
        sessionStorage.setItem(
          'eval-pending-task',
          JSON.stringify({
            taskName,
            firstTurnPrompt: created.firstTurnPrompt,
          }),
        );
        setShowEvalPicker(false);
        onProjectOpen(created.projectName, created.projectPath);
      } catch (err) {
        setEvalError((err as Error).message);
      } finally {
        setEvalSubmitting(false);
        evalTaskIdRef.current = null;
      }
    },
    [evalSubmitting, onProjectOpen],
  );

  const handleOpenEvalRun = useCallback(
    async (projectName: string, projectPath: string, sessionId: string) => {
      if (evalSubmitting) return;
      setEvalSubmitting(true);
      setEvalError(null);
      try {
        const result = await apiRequest<OpenedProject>('openProject', {
          path: projectPath,
        });
        sessionStorage.setItem('eval-pending-session-id', sessionId);
        setShowEvalPicker(false);
        onProjectOpen(result.name, result.path);
      } catch (err) {
        setEvalError(`Failed to open prior run: ${(err as Error).message}`);
      } finally {
        setEvalSubmitting(false);
      }
    },
    [evalSubmitting, onProjectOpen],
  );

  // The native folder picker (fs.pickDirectory) is available whenever the IDE
  // runs on the native bridge (Ugly Studio).
  const hasElectronAPI = isNativeAvailable();

  useEffect(() => {
    // AbortController doubles as the fetch timeout *and* the unmount guard:
    // aborting on cleanup makes the in-flight fetch reject, and
    // `signal.aborted` (which the type system can't prove constant) gates the
    // post-await setState so we never touch state after unmount.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => { controller.abort(); }, 5000);
    void (async () => {
      try {
        const res = await fetch('/', { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (!res.ok) {
          setConnectionStatus('error');
          return;
        }
        setConnectionStatus('connected');
        // Recent projects now arrive via the synced trackDocs hook above.
      } catch {
        if (!controller.signal.aborted) setConnectionStatus('error');
      }
    })();
    return () => {
      clearTimeout(timeoutId);
      controller.abort();
    };
  }, []);

  // Keep the focused field above the on-screen keyboard. The native iOS shell
  // overlays the keyboard (the page is laid out full-height behind it), so the
  // browser never auto-scrolls focused inputs into view — we shrink the page to
  // the area above the keyboard (see container height below) and scroll the
  // active field into that area ourselves, both when the keyboard opens and when
  // a different field is tapped while it's already up.
  const scrollActiveFieldIntoView = useCallback(() => {
    const el = document.activeElement;
    if (
      el instanceof HTMLElement &&
      (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')
    ) {
      // 'nearest' scrolls the minimum to reveal the field just above the keyboard,
      // rather than 'center' which yanks it high up the (shortened) viewport.
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, []);
  useEffect(() => {
    if (keyboardHeight <= 0) return;
    const id = setTimeout(scrollActiveFieldIntoView, 60);
    return () => { clearTimeout(id); };
  }, [keyboardHeight, scrollActiveFieldIntoView]);
  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      const t = e.target;
      if (
        keyboardRef.current > 0 &&
        t instanceof HTMLElement &&
        (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')
      ) {
        setTimeout(() => { t.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, 60);
      }
    };
    document.addEventListener('focusin', onFocusIn);
    return () => { document.removeEventListener('focusin', onFocusIn); };
  }, []);

  const handleBrowse = useCallback((setter: (val: string) => void, current: string) => {
    // Custom in-app folder picker — works over the Ugly Proxy (it navigates via
    // native.fs.readdir), unlike the native fs.pickDirectory dialog which would open on
    // the desktop and be invisible on a phone. '~' resolves to home on the host.
    setPicker({ startPath: current.trim() || DEFAULT_PARENT_DIR, onPick: setter });
  }, []);

  const handleOpenRecent = useCallback(
    async (project: RecentProject) => {
      setLoading(true);
      setError(null);
      // If the project lives on another desktop (or we're a phone, where
      // selfDeviceId is null), ask the proxy to connect to that specific host
      // first so the fs calls tunnel to the machine that holds the files.
      if (project.deviceId && project.deviceId !== selfDeviceId) {
        connectToHost(project.deviceId, project.deviceLabel);
      }
      try {
        const result = await apiRequest<OpenedProject>('openProject', {
          path: project.path,
        });
        onProjectOpen(result.name, result.path);
      } catch (err) {
        const msg = (err as Error).message;
        if (
          msg.includes('ENOENT') ||
          msg.includes('no such file') ||
          msg.includes('Not a directory')
        ) {
          // Only prune when the folder is gone on the host that owns it — a
          // remote host being offline shouldn't delete a perfectly good entry.
          if (!project.deviceId || project.deviceId === selfDeviceId) {
            void removeRecentProject(app?.socket, project._id);
          }
          setError(`Project folder no longer exists: ${project.path}`);
        } else {
          setError(`Failed to open project: ${msg}`);
        }
      } finally {
        setLoading(false);
      }
    },
    [onProjectOpen, selfDeviceId, app],
  );

  const handleNewProject = useCallback(() => {
    if (!newName.trim() || loading) return;
    // Hand off to StudioShell's <ProjectCreationProgress>, which spawns the
    // scaffold and streams its live CLI output (npx ugly-app init + pnpm
    // install) instead of blocking silently on the button.
    setError(null);
    onBeginCreate?.(newName.trim(), newParentDir.trim());
  }, [newName, newParentDir, loading, onBeginCreate]);

  const handleOpenFolder = useCallback(async () => {
    if (!openPath.trim() || loading) return;
    setLoading(true);
    setError(null);
    try {
      const result = await apiRequest<OpenedProject>('openProject', {
        path: openPath.trim(),
      });
      onProjectOpen(result.name, result.path);
    } catch (err) {
      setError(`Failed to open project: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [openPath, loading, onProjectOpen]);

  const handleClone = useCallback(async () => {
    if (!cloneUrl.trim() || loading) return;
    setLoading(true);
    setError(null);
    try {
      const input: { url: string; parentDir?: string } = {
        url: cloneUrl.trim(),
      };
      if (cloneDir.trim()) input.parentDir = cloneDir.trim();
      const result = await apiRequest<OpenedProject>('cloneProject', input);
      onProjectOpen(result.name, result.path);
    } catch (err) {
      setError(`Failed to clone repository: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [cloneUrl, cloneDir, loading, onProjectOpen]);

  // ── Connection error state ────────────────────────────────────────
  if (connectionStatus === 'error') {
    return (
      <div
        className="us-picker-exit"
        data-leaving={leaving ? 'true' : 'false'}
        style={{
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--bg-primary)',
          color: 'var(--text-primary)',
        }}
      >
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 40,
          }}
        >
          <div style={{ maxWidth: 420, textAlign: 'center' }}>
            <div
              style={{
                fontFamily: 'var(--font-heading)',
                fontSize: 22,
                fontWeight: 800,
                color: 'var(--text-primary)',
                letterSpacing: '-0.02em',
                marginBottom: 10,
              }}
            >
              Can&rsquo;t reach ugly.bot
            </div>
            <div
              style={{
                color: 'var(--text-secondary)',
                fontSize: 13,
                lineHeight: 1.55,
                marginBottom: 24,
              }}
            >
              Check that the dev server is running, then retry.
            </div>
            <button
              type="button"
              data-id="onboarding-retry-connection"
              onClick={() => { window.location.reload(); }}
              style={primaryButtonStyle}
            >
              Retry connection
            </button>
          </div>
        </div>
      </div>
    );
  }

  const filteredRecents = recentProjects.filter((p) => {
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q);
  });

  return (
    <div
      className="us-picker-exit"
      data-leaving={leaving ? 'true' : 'false'}
      style={{
        // Shrink the whole page to the area ABOVE the on-screen keyboard. The native
        // iOS shell overlays the keyboard so the viewport never shrinks on its own;
        // subtracting the measured keyboard height keeps the scrollable form within
        // the visible region (and the focus effect above scrolls the field into it).
        // 0 when closed / on desktop → plain 100dvh.
        height: keyboardHeight > 0 ? `calc(100dvh - ${keyboardHeight}px)` : '100dvh',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg-primary)',
        color: 'var(--text-primary)',
        minHeight: 0,
        // Bespoke full-height page (bypasses PageLayout) → apply safe-area itself
        // so the "Pick your poison" hero clears the notch / status bar. env() is
        // 0 on desktop, so this is a no-op there.
        boxSizing: 'border-box',
        paddingTop: 'var(--safe-area-inset-top)',
        paddingBottom: 'var(--safe-area-inset-bottom)',
        paddingLeft: 'var(--safe-area-inset-left)',
        paddingRight: 'var(--safe-area-inset-right)',
      }}
    >
      <main
        style={{
          flex: 1,
          minHeight: 0,
          overflow: 'auto',
        }}
      >
        <div
          style={{
            maxWidth: 1280,
            margin: '0 auto',
            padding: isMobile ? '24px 16px' : '56px 40px 40px',
            display: 'grid',
            gridTemplateColumns: isMobile ? '1fr' : 'minmax(380px, 420px) 1fr',
            gap: isMobile ? 24 : 56,
            alignItems: 'flex-start',
          }}
        >
          {/* LEFT: hero + actions */}
          <section
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 28,
              minWidth: 0,
            }}
          >
            <div>
              <div
                className="us-fade-up"
                style={{
                  fontFamily: 'var(--font-label)',
                  fontSize: 11,
                  color: 'var(--accent)',
                  letterSpacing: '0.24em',
                  textTransform: 'uppercase',
                  fontWeight: 700,
                  marginBottom: 18,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  animationDuration: '320ms',
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 26,
                    height: 2,
                    background: 'var(--accent)',
                    transformOrigin: 'left center',
                    animationName: 'us-bar-grow',
                    animationDuration: '360ms',
                    animationTimingFunction: 'var(--ease-out)',
                    animationFillMode: 'both',
                    animationDelay: '60ms',
                  }}
                />
                Pick your poison
              </div>
              <h1
                style={{
                  margin: 0,
                  fontFamily: 'var(--font-heading)',
                  fontSize: 'clamp(46px, 5.5vw, 72px)',
                  fontWeight: 800,
                  color: 'var(--text-primary)',
                  letterSpacing: '-0.04em',
                  lineHeight: 1.15,
                }}
              >
                {splitWords('Dream big.', 80, 60)}
                <br />
                {splitWords('Build', 240, 60)}{' '}
                <span
                  className="us-word-pop"
                  style={{
                    color: 'var(--accent)',
                    animationDelay: '340ms',
                  }}
                >
                  Ugly.
                </span>
                <br />
                {splitWords('Ship today.', 460, 60)}
              </h1>
              <p
                className="us-fade-up"
                style={{
                  marginTop: 20,
                  marginBottom: 0,
                  fontSize: 15,
                  color: 'var(--text-secondary)',
                  lineHeight: 1.6,
                  maxWidth: 380,
                  animationDelay: '660ms',
                  animationDuration: '320ms',
                }}
              >
                Open a folder, spin up something new, or yank it from Git.{' '}
                <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
                  We won&rsquo;t tell you
                </span>{' '}
                which one was the bad idea.
              </p>
            </div>

            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                border: '1px solid var(--border)',
              }}
            >
              <ActionRow
                kind="new"
                data-id="onboarding-action-new"
                active={activeAction === 'new'}
                onClick={() => { setActiveAction('new'); }}
                delayMs={760}
              />
              {activeAction === 'new' && (
                <div style={actionBodyStyle}>
                  <LabelInput
                    label="Project name"
                    value={newName}
                    onChange={setNewName}
                    placeholder="my-side-project"
                    autoFocus
                  />
                  <LabelInput
                    label="Parent folder"
                    value={newParentDir}
                    onChange={setNewParentDir}
                    browsable={hasElectronAPI}
                    onBrowse={() => { handleBrowse(setNewParentDir, newParentDir); }}
                  />
                  <button
                    type="button"
                    data-id="onboarding-create-project"
                    onClick={() => { handleNewProject(); }}
                    disabled={loading || !newName.trim()}
                    style={primaryButtonStyle}
                  >
                    {loading ? 'Creating…' : 'Create Project →'}
                  </button>
                </div>
              )}

              <ActionRow
                kind="open"
                data-id="onboarding-action-open"
                active={activeAction === 'open'}
                onClick={() => { setActiveAction('open'); }}
                delayMs={860}
              />
              {activeAction === 'open' && (
                <div style={actionBodyStyle}>
                  <LabelInput
                    label="Path to existing folder"
                    value={openPath}
                    onChange={setOpenPath}
                    placeholder={
                      hasElectronAPI
                        ? `${DEFAULT_PARENT_DIR}/project`
                        : '/path/to/project'
                    }
                    browsable={hasElectronAPI}
                    onBrowse={() => { handleBrowse(setOpenPath, openPath); }}
                    autoFocus
                  />
                  <button
                    type="button"
                    data-id="onboarding-open-folder"
                    onClick={() => void handleOpenFolder()}
                    disabled={loading || !openPath.trim()}
                    style={primaryButtonStyle}
                  >
                    {loading ? 'Opening…' : 'Open Folder →'}
                  </button>
                </div>
              )}

              <ActionRow
                kind="clone"
                data-id="onboarding-action-clone"
                active={activeAction === 'clone'}
                onClick={() => { setActiveAction('clone'); }}
                delayMs={960}
              />
              {activeAction === 'clone' && (
                <div style={actionBodyStyle}>
                  <LabelInput
                    label="Git URL"
                    value={cloneUrl}
                    onChange={setCloneUrl}
                    placeholder="https://github.com/you/repo.git"
                    autoFocus
                  />
                  <LabelInput
                    label="Clone into (optional)"
                    value={cloneDir}
                    onChange={setCloneDir}
                    placeholder={hasElectronAPI ? DEFAULT_PARENT_DIR : ''}
                    browsable={hasElectronAPI}
                    onBrowse={() => { handleBrowse(setCloneDir, cloneDir); }}
                  />
                  <button
                    type="button"
                    data-id="onboarding-clone-repo"
                    onClick={() => void handleClone()}
                    disabled={loading || !cloneUrl.trim()}
                    style={primaryButtonStyle}
                  >
                    {loading ? 'Cloning…' : 'Clone Repository →'}
                  </button>
                </div>
              )}
            </div>

            {error && (
              <div
                style={{
                  fontFamily: 'var(--font-label)',
                  fontSize: 11.5,
                  padding: '10px 14px',
                  border: '1px solid var(--accent)',
                  color: 'var(--accent)',
                  background: 'var(--accent-dim)',
                }}
              >
                {error}
              </div>
            )}
            {picker && (
              <FilePicker
                mode="folder"
                startPath={picker.startPath}
                onResult={(p) => {
                  if (p) picker.onPick(p);
                  setPicker(null);
                }}
              />
            )}
          </section>

          {/* RIGHT: recent projects */}
          <section
            style={{
              display: 'flex',
              flexDirection: 'column',
              minHeight: 0,
              minWidth: 0,
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'flex-end',
                justifyContent: 'space-between',
                paddingBottom: 18,
                borderBottom: '1px solid var(--border)',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 14,
                }}
              >
                <h2
                  className="us-fade-down"
                  style={{
                    margin: 0,
                    fontFamily: 'var(--font-heading)',
                    fontSize: 30,
                    fontWeight: 800,
                    color: 'var(--text-primary)',
                    letterSpacing: '-0.03em',
                    lineHeight: 1,
                    animationDelay: '700ms',
                    animationDuration: '320ms',
                  }}
                >
                  Recent projects
                </h2>
                <RecentsCountBadge target={recentProjects.length} />
              </div>
            </div>

            {recentProjects.length > 0 && (
              <div
                className="us-slide-r"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '10px 14px',
                  background: 'var(--bg-panel)',
                  border: '1px solid var(--border)',
                  borderTop: 'none',
                  animationDelay: '1000ms',
                  animationDuration: '320ms',
                }}
              >
                <svg
                  width={14}
                  height={14}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ color: 'var(--text-muted)', flexShrink: 0 }}
                >
                  <circle cx={11} cy={11} r={8} />
                  <line x1={21} y1={21} x2={16.65} y2={16.65} />
                </svg>
                <input
                  data-id="onboarding-recents-filter"
                  value={search}
                  onChange={(e) => { setSearch(e.currentTarget.value); }}
                  placeholder="Filter by name or path…"
                  style={{
                    flex: 1,
                    background: 'none',
                    border: 'none',
                    outline: 'none',
                    color: 'var(--text-primary)',
                    fontSize: 13,
                    fontFamily: 'inherit',
                    fontWeight: 500,
                  }}
                />
              </div>
            )}

            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                border:
                  recentProjects.length > 0
                    ? '1px solid var(--border)'
                    : 'none',
                borderTop: 'none',
                background: 'var(--bg-panel)',
                maxHeight: 620,
                overflowY: 'auto',
              }}
            >
              {recentProjects.length === 0 ? (
                <div
                  style={{
                    padding: '48px 32px',
                    border: '1px dashed var(--border)',
                    color: 'var(--text-muted)',
                    fontFamily: 'var(--font-label)',
                    fontSize: 12,
                    textAlign: 'center',
                    letterSpacing: '0.04em',
                  }}
                >
                  no projects yet. pick an action on the left to get started.
                </div>
              ) : filteredRecents.length === 0 ? (
                <div
                  style={{
                    padding: '32px',
                    color: 'var(--text-muted)',
                    fontFamily: 'var(--font-label)',
                    fontSize: 12,
                    textAlign: 'center',
                    letterSpacing: '0.04em',
                  }}
                >
                  nothing matches &ldquo;{search}&rdquo;.
                </div>
              ) : (
                filteredRecents.map((p, i) => (
                  <ProjectRow
                    key={p._id}
                    index={i + 1}
                    project={p}
                    isThisDevice={!!selfDeviceId && p.deviceId === selfDeviceId}
                    onOpen={() => void handleOpenRecent(p)}
                    onDelete={() => void removeRecentProject(app?.socket, p._id)}
                    delayMs={1100 + i * 70}
                  />
                ))
              )}
            </div>
          </section>
        </div>
      </main>

      {keyboardHeight === 0 && (
        <div
          className="us-fade-up"
          style={{ animationDelay: '1400ms', animationDuration: '320ms' }}
        >
          <ManifestoFooter />
        </div>
      )}

      {/* Floating "Run eval" button — opens a picker of every available
        eval task. On pick, the server carves a one-off project under
        ~/.ugly-studio/eval-projects/ and creates a seeded coding-agent
        session; we route through onProjectOpen so the user lands in the
        chat with the prompt pre-filled. */}
      <button
        type="button"
        onClick={() => { setShowEvalPicker(true); }}
        data-id="run-eval-button"
        disabled={evalSubmitting}
        title="Run an eval task interactively (pick → seed → watch → grade)"
        style={{
          position: 'fixed',
          right: 16,
          // Sit above the ManifestoFooter (~64px tall) so the gradient
          // chip doesn't overlap the manifesto strip at the bottom.
          bottom: 80,
          zIndex: 999,
          fontFamily: 'var(--font-label)',
          fontSize: 11,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          fontWeight: 800,
          color: '#ffffff',
          background: evalSubmitting
            ? 'var(--border)'
            : 'linear-gradient(135deg, #FF8041 0%, #FF5500 50%, #E63900 100%)',
          border: '1px solid var(--accent)',
          padding: '10px 16px',
          cursor: evalSubmitting ? 'not-allowed' : 'pointer',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
          opacity: evalSubmitting ? 0.6 : 1,
        }}
      >
        <span aria-hidden style={{ fontSize: 14, lineHeight: 1 }}>
          ▶
        </span>
        {evalSubmitting ? 'Setting up…' : 'Run eval'}
      </button>

      {showEvalPicker && (
        <EvalPickerModal
          onCancel={() => { setShowEvalPicker(false); }}
          onPick={(name) => void handlePickEvalTask(name)}
          onOpenRun={(projectName, projectPath, sessionId) =>
            void handleOpenEvalRun(projectName, projectPath, sessionId)
          }
        />
      )}

      {evalError && !showEvalPicker && (
        <div
          style={{
            position: 'fixed',
            right: 16,
            bottom: 136,
            zIndex: 999,
            maxWidth: 420,
            padding: '10px 14px',
            background: 'var(--bg-secondary)',
            border: '1px solid #FF5500',
            color: '#FF5500',
            fontSize: 12,
            lineHeight: 1.5,
            boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 4 }}>
            Eval task failed
          </div>
          <div style={{ color: 'var(--text-secondary)' }}>{evalError}</div>
          <button
            type="button"
            data-id="onboarding-eval-error-dismiss"
            onClick={() => { setEvalError(null); }}
            style={{
              marginTop: 6,
              fontFamily: 'var(--font-label)',
              fontSize: 10,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              fontWeight: 700,
              color: 'var(--text-secondary)',
              background: 'transparent',
              border: '1px solid var(--border)',
              padding: '4px 8px',
              cursor: 'pointer',
            }}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Project-init progress now lives in <ProjectCreationProgress>,
          mounted by EditorInner when the tab's `creating` field is set. */}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// Sub-components
// ──────────────────────────────────────────────────────────────────

function RecentsCountBadge({ target }: { target: number }): React.ReactElement {
  // Count ticks 00 → target on first reveal so the badge feels alive
  // alongside the rest of the staggered entrance.
  const value = useCountUp(target, 600);
  return (
    <span
      className="us-pop"
      style={{
        fontFamily: 'var(--font-label)',
        fontSize: 12,
        color: 'var(--accent)',
        fontWeight: 700,
        letterSpacing: '0.08em',
        display: 'inline-block',
        animationDelay: '940ms',
        animationDuration: '320ms',
      }}
    >
      · {String(value).padStart(2, '0')}
    </span>
  );
}

const ACTION_META: Record<
  ActionTab,
  { title: string; desc: string; hint?: string; icon: React.ReactNode }
> = {
  new: {
    title: 'New Project',
    desc: 'Scaffolds a fresh ugly-app repo — server, client, db, auth.',
    hint: shortcut('N'),
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={3}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <line x1={12} y1={5} x2={12} y2={19} />
        <line x1={5} y1={12} x2={19} y2={12} />
      </svg>
    ),
  },
  open: {
    title: 'Open Folder',
    desc: 'Any existing repo — studio auto-indexes what’s there.',
    hint: shortcut('O'),
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      </svg>
    ),
  },
  clone: {
    title: 'Clone from Git',
    desc: 'Paste a URL — uses your connected GitHub.',
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx={18} cy={18} r={3} />
        <circle cx={6} cy={6} r={3} />
        <path d="M13 6h3a2 2 0 0 1 2 2v7" />
        <line x1={6} y1={9} x2={6} y2={21} />
      </svg>
    ),
  },
};

function ActionRow({
  kind,
  active,
  onClick,
  delayMs,
  'data-id': dataId,
}: {
  kind: ActionTab;
  active: boolean;
  onClick: () => void;
  delayMs?: number;
  'data-id'?: string;
}): React.ReactElement {
  const meta = ACTION_META[kind];
  const isPrimary = kind === 'new';
  return (
    <button
      type="button"
      data-id={dataId}
      onClick={onClick}
      className="us-slide-r"
      style={{
        display: 'grid',
        gridTemplateColumns: 'auto 1fr auto',
        gap: 16,
        padding: '18px 20px',
        background:
          active && isPrimary
            ? 'linear-gradient(90deg, var(--accent-dim) 0%, var(--bg-panel) 80%)'
            : active
            ? 'var(--bg-secondary)'
            : 'var(--bg-panel)',
        border: 'none',
        borderBottom: '1px solid var(--border)',
        textAlign: 'left',
        cursor: 'pointer',
        alignItems: 'center',
        position: 'relative',
        color: 'inherit',
        font: 'inherit',
        animationDelay: delayMs != null ? `${delayMs}ms` : undefined,
        animationDuration: '420ms',
      }}
    >
      {active && isPrimary && (
        <span
          aria-hidden
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: 3,
            background: 'var(--accent)',
            boxShadow: '0 0 12px var(--accent)',
          }}
        />
      )}
      <span
        style={{
          width: 40,
          height: 40,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          background:
            active && isPrimary
              ? 'linear-gradient(135deg, #FF8041 0%, #FF5500 50%, #E63900 100%)'
              : 'var(--bg-primary)',
          border: active && isPrimary ? 'none' : '1px solid var(--border)',
          color: active && isPrimary ? '#fff' : 'var(--text-primary)',
          flexShrink: 0,
        }}
      >
        <span style={{ width: 16, height: 16, display: 'inline-block' }}>
          {meta.icon}
        </span>
      </span>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <span
          style={{
            fontFamily: 'var(--font-heading)',
            fontSize: 15,
            fontWeight: 800,
            color: 'var(--text-primary)',
            letterSpacing: '-0.015em',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          {meta.title}
          {meta.hint && (
            <span
              style={{
                fontFamily: 'var(--font-label)',
                fontSize: 10,
                color: 'var(--text-muted)',
                border: '1px solid var(--border)',
                padding: '1px 6px',
                fontWeight: 700,
                letterSpacing: '0.08em',
              }}
            >
              {meta.hint}
            </span>
          )}
        </span>
        <span
          style={{
            fontSize: 12,
            color: 'var(--text-secondary)',
            lineHeight: 1.4,
          }}
        >
          {meta.desc}
        </span>
      </span>
      <span
        style={{
          color: active ? 'var(--accent)' : 'var(--text-muted)',
          transition: 'all 160ms ease',
          flexShrink: 0,
          transform: active ? 'rotate(90deg)' : 'rotate(0deg)',
        }}
      >
        <svg
          width={15}
          height={15}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M5 12h14" />
          <path d="M13 6l6 6-6 6" />
        </svg>
      </span>
    </button>
  );
}

function LabelInput({
  label,
  value,
  onChange,
  placeholder,
  browsable,
  onBrowse,
  autoFocus,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  browsable?: boolean;
  onBrowse?: () => void;
  autoFocus?: boolean;
}): React.ReactElement {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span
        style={{
          fontFamily: 'var(--font-label)',
          fontSize: 10.5,
          color: 'var(--text-muted)',
          letterSpacing: '0.16em',
          textTransform: 'uppercase',
          fontWeight: 700,
        }}
      >
        {label}
      </span>
      <div
        style={{
          display: 'flex',
          gap: 6,
          background: 'var(--bg-primary)',
          border: '1px solid var(--border)',
          padding: 0,
        }}
      >
        <input
          data-id={`onboarding-input-${label}`}
          value={value}
          onChange={(e) => { onChange(e.currentTarget.value); }}
          placeholder={placeholder}
          autoFocus={autoFocus}
          style={{
            flex: 1,
            padding: '10px 12px',
            background: 'none',
            border: 'none',
            outline: 'none',
            color: 'var(--text-primary)',
            fontSize: 13,
            fontFamily: 'inherit',
            fontWeight: 500,
          }}
        />
        {browsable && (
          <button
            type="button"
            data-id={`onboarding-browse-${label}`}
            onClick={onBrowse}
            style={{
              fontFamily: 'var(--font-label)',
              fontSize: 10.5,
              fontWeight: 700,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color: 'var(--text-secondary)',
              background: 'var(--bg-secondary)',
              border: 'none',
              borderLeft: '1px solid var(--border)',
              padding: '0 14px',
              cursor: 'pointer',
            }}
          >
            Browse
          </button>
        )}
      </div>
    </label>
  );
}

function ProjectRow({
  index,
  project,
  isThisDevice,
  onOpen,
  onDelete,
  delayMs,
}: {
  index: number;
  project: RecentProject;
  isThisDevice: boolean;
  onOpen: () => void;
  onDelete: () => void;
  delayMs?: number;
}): React.ReactElement {
  const indexDelay = delayMs != null ? delayMs + 100 : undefined;
  // Shown so the user knows which machine each project lives on — and, for a
  // remote project, which desktop the open will reconnect to.
  const deviceText = isThisDevice ? 'This device' : project.deviceLabel || 'Another device';
  return (
    <div
      role="button"
      tabIndex={0}
      data-id={`recent-project-${project.path}`}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      className="us-fade-up"
      style={{
        display: 'grid',
        gridTemplateColumns: '40px 1fr auto auto',
        gap: 16,
        padding: '16px 18px',
        border: 'none',
        borderBottom: '1px solid var(--border)',
        alignItems: 'center',
        cursor: 'pointer',
        background: 'var(--bg-panel)',
        textAlign: 'left',
        color: 'inherit',
        font: 'inherit',
        animationDelay: delayMs != null ? `${delayMs}ms` : undefined,
        animationDuration: '320ms',
      }}
    >
      <span
        className="us-pop"
        style={{
          fontFamily: 'var(--font-label)',
          fontSize: 11,
          color: 'var(--text-muted)',
          letterSpacing: '0.1em',
          fontWeight: 700,
          paddingLeft: 6,
          display: 'inline-block',
          animationDelay: indexDelay != null ? `${indexDelay}ms` : undefined,
          animationDuration: '320ms',
        }}
      >
        {String(index).padStart(2, '0')}
      </span>
      <span
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          minWidth: 0,
        }}
      >
        <span
          style={{
            fontFamily: 'var(--font-heading)',
            fontSize: 15,
            fontWeight: 700,
            color: 'var(--text-primary)',
            letterSpacing: '-0.015em',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {project.name}
        </span>
        <span
          style={{
            fontFamily: 'var(--font-label)',
            fontSize: 11,
            color: 'var(--text-muted)',
            letterSpacing: '-0.01em',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {project.path}
        </span>
        <span
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 5,
            fontFamily: 'var(--font-label)',
            fontSize: 10,
            color: isThisDevice ? 'var(--text-secondary)' : 'var(--accent, #FF5500)',
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            fontWeight: 700,
            minWidth: 0,
          }}
        >
          <svg
            width={11}
            height={11}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ flexShrink: 0 }}
          >
            <rect x={2} y={3} width={20} height={14} rx={2} />
            <path d="M8 21h8M12 17v4" />
          </svg>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {deviceText}
          </span>
        </span>
      </span>
      <span
        style={{
          fontFamily: 'var(--font-label)',
          fontSize: 10.5,
          color: 'var(--text-secondary)',
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          fontWeight: 600,
        }}
      >
        {timeAgoShort(project.lastOpened)}
      </span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
        <button
          type="button"
          aria-label="Remove from recent projects"
          data-id={`recent-project-delete-${project.path}`}
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          style={{
            display: 'inline-flex',
            padding: 4,
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            color: 'var(--text-muted)',
          }}
        >
          <svg
            width={13}
            height={13}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
        <span style={{ color: 'var(--text-muted)' }}>
          <svg
            width={14}
            height={14}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M5 12h14" />
            <path d="M13 6l6 6-6 6" />
          </svg>
        </span>
      </span>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// Shared styles
// ──────────────────────────────────────────────────────────────────

const primaryButtonStyle: React.CSSProperties = {
  alignSelf: 'flex-start',
  padding: '12px 20px',
  background: 'linear-gradient(135deg, #FF8041 0%, #FF5500 50%, #E63900 100%)',
  color: '#ffffff',
  fontFamily: 'var(--font-heading)',
  fontWeight: 800,
  fontSize: 12,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  border: 'none',
  cursor: 'pointer',
};

const actionBodyStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  padding: '16px 20px 20px',
  background: 'var(--bg-primary)',
  borderBottom: '1px solid var(--border)',
};
