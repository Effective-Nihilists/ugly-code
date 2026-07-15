import React from 'react';
import { native } from 'ugly-app/native';
import { useSafeAreaInsets } from 'ugly-app/client';
import { ChatOpenUriProvider } from './components/LinkifiedText';
import {
  SessionListSidebar,
  type SessionListSidebarSession,
} from './panels/SessionListSidebar';
import { setActiveProjectPath } from './hooks/useSocket';
import { loadSessions, saveSessions, type StoredSession } from './state/projectSessions';
import { sessionApi, resolveProjectId } from './agent/serverSessionApi';
import { timeAgoShort } from './utils/timeAgo';
import { ThemeProvider } from './theme/ThemeProvider';
import { CodingAgentChat } from './panels/CodingAgentChat';
import { DatabasePanel } from './panels/DatabasePanel';
import { ErrorsPanel } from './panels/ErrorsPanel';
import { EventsPanel } from './panels/EventsPanel';
import { FeedbackPanel } from './panels/FeedbackPanel';
import { WorkersPanel } from './panels/WorkersPanel';
import { GitPanel } from './panels/GitPanel';
import { TestsPanel } from './panels/TestsPanel';
import { TerminalPanel } from './panels/TerminalPanel';
import { ProdPanel } from './panels/ProdPanel';
import { PreviewPanel } from './panels/PreviewPanel';
import { FilePanel } from './panels/FilePanel';
import {
  DeployIcon, DatabaseIcon, ErrorsIcon, EventsIcon, WorkersIcon, TerminalIcon, FeedbackIcon, TestsIcon,
  AgentIcon, PreviewIcon, FileIcon, GitIcon,
} from './panels/navIcons';
import { useIsMobile } from './hooks/useIsMobile';

// Two nav surfaces:
//  - Session top tab picker (per-session, dev-scoped): Agent / Preview / File /
//    Git / Database.
//  - Sidebar footer (prod-scoped views): Deploy / Database(prod) / Errors /
//    Events / Workers / Terminal. Errors/Events/Workers are prod-only; Database
//    appears in both (dev in the top tabs, prod in the sidebar).
type WorkspaceTab =
  | 'chat' | 'preview' | 'file' | 'git' | 'tests' | 'database'
  | 'deploy' | 'prodDatabase' | 'errors' | 'events' | 'workers' | 'terminal' | 'feedback';
const TABS: { id: WorkspaceTab; label: string }[] = [
  { id: 'chat', label: 'Agent' },
  { id: 'preview', label: 'Preview' },
  { id: 'file', label: 'File' },
  { id: 'git', label: 'Git' },
  { id: 'tests', label: 'Tests' },
  { id: 'database', label: 'Database' },
];
const ALL_TABS: WorkspaceTab[] = [
  'chat', 'preview', 'file', 'git', 'tests', 'database',
  'deploy', 'prodDatabase', 'errors', 'events', 'workers', 'terminal', 'feedback',
];
// The deploy tab used to be `publish`, and that id is written into the URL
// (`?tab=publish`). Keep old links and restored windows working.
const LEGACY_TAB_IDS: Record<string, WorkspaceTab> = { publish: 'deploy' };
// Icons for the per-session view sub-nav (rendered under the active session row in
// the sidebar). Keyed by the same ids as TABS. The session-scoped views
// (chat/preview/file/git/database) now live in the sidebar, not a top tab bar.
const SESSION_VIEW_ICONS: Record<string, React.ReactNode> = {
  chat: <AgentIcon />,
  preview: <PreviewIcon />,
  file: <FileIcon />,
  git: <GitIcon />,
  tests: <TestsIcon />,
  database: <DatabaseIcon />,
};

// Resizable session sidebar — width persisted across reloads.
const SIDEBAR_W_KEY = 'us-session-sidebar-w';
const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 560;
function readSidebarW(): number {
  const v = Number(localStorage.getItem(SIDEBAR_W_KEY));
  return v >= SIDEBAR_MIN && v <= SIDEBAR_MAX ? v : 264;
}

// The open tab + active session live in the URL (alongside ?path=) so a reload
// restores exactly where you were.
function isWorkspaceTab(value: string): value is WorkspaceTab {
  return (ALL_TABS as string[]).includes(value);
}
function readWorkspaceUrl(): { tab: WorkspaceTab | null; session: string | null } {
  const p = new URLSearchParams(window.location.search);
  const raw = p.get('tab');
  const t = raw !== null ? LEGACY_TAB_IDS[raw] ?? raw : null;
  return {
    tab: t !== null && isWorkspaceTab(t) ? t : null,
    session: p.get('session'),
  };
}
function writeWorkspaceUrl(tab: WorkspaceTab, session: string | null): void {
  const url = new URL(window.location.href);
  if (tab === 'chat') url.searchParams.delete('tab');
  else url.searchParams.set('tab', tab);
  if (session) url.searchParams.set('session', session);
  else url.searchParams.delete('session');
  window.history.replaceState({}, '', url.pathname + url.search);
}

// The project page: session sidebar (list + New session) + the workspace
// (coding-agent chat + the tab rail). Sessions persist per project; every session
// is uniform — isolation is a per-session branchMode pick (worktree vs. main), not
// a distinct "main" kind. An empty project shows the new-session hero directly.

export default function StudioProjectPage({
  projectName,
  projectPath,
  onBack,
}: {
  projectName: string;
  projectPath?: string;
  onBack: () => void;
}): React.ReactElement {
  const insets = useSafeAreaInsets();
  const urlInit = React.useMemo(() => readWorkspaceUrl(), []);
  const [tab, setTab] = React.useState<WorkspaceTab>(urlInit.tab ?? 'chat');
  // Sessions are persisted per project; CodingAgentChat assigns the real
  // compositeId on first turn (onSessionCreated), which we record here.
  const [stored, setStored] = React.useState<StoredSession[]>(() => loadSessions(projectPath));
  const [activeSessionId, setActiveSessionId] = React.useState<string | null>(
    () => urlInit.session ?? null,
  );
  // Bumped to remount CodingAgentChat when switching sessions / starting fresh.
  const [chatKey, setChatKey] = React.useState(0);
  // Live run state of the ACTIVE session's chat, reported by CodingAgentChat.
  // The server-status poll below covers background/peer sessions but lags for the
  // one the user is watching (poll interval + D1 replica latency), so we drive the
  // active row's "thinking" indicator off this instant signal too.
  const [activeRunning, setActiveRunning] = React.useState(false);

  // Resizable sidebar. Window-level pointer listeners (not setPointerCapture) — on macOS the
  // window-controls drag region swallows mousemove otherwise (see ugly-studio dock-drag notes).
  const [sidebarW, setSidebarW] = React.useState<number>(readSidebarW);
  const startResize = React.useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarW;
    const onMove = (ev: PointerEvent): void => {
      const w = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, startW + (ev.clientX - startX)));
      setSidebarW(w);
    };
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setSidebarW((w) => { localStorage.setItem(SIDEBAR_W_KEY, String(w)); return w; });
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [sidebarW]);

  // Below 768px the workspace collapses to one full-width column + a slide-in
  // nav drawer (the sidebar isn't rendered inline). Leaving mobile closes it.
  const isMobile = useIsMobile();
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const closeDrawer = React.useCallback(() => { setDrawerOpen(false); }, []);
  React.useEffect(() => { if (!isMobile) setDrawerOpen(false); }, [isMobile]);

  React.useEffect(() => {
    setActiveProjectPath(projectPath ?? null);
    return () => { setActiveProjectPath(null); };
  }, [projectPath]);

  // A file (with an optional line) to open in the File panel — set when a tool
  // card / console file path is clicked, consumed + cleared by <FilePanel>.
  const [pendingFile, setPendingFile] = React.useState<{ path: string; line?: number } | null>(null);

  // One handler for clickable links across ALL panels (chat tool widgets + publish console +
  // anything using LinkifiedText). http(s) opens the browser; a FILE path opens in the in-app
  // File panel (was: OS default editor) so clicking a tool's path stays inside Studio.
  const openUri = React.useCallback((uri: string) => {
    if (/^https?:\/\//i.test(uri)) {
      // Open web links in a NEW TAB of this browser (the Studio host intercepts
      // window.open as a new tab) rather than kicking out to the OS default
      // browser. Fall back to openExternal only if the tab was blocked (popup
      // blocker / host denied → null), so the link still opens somewhere.
      const opened = window.open(uri, '_blank', 'noopener,noreferrer');
      if (!opened) void native.system.openExternal({ url: uri });
      return;
    }
    // File path, possibly `file://`-prefixed and/or with a trailing :line[-endLine].
    let p = uri.replace(/^file:\/\//, '');
    let line: number | undefined;
    const m = /:(\d+)(?:-\d+)?$/.exec(p);
    if (m) { line = Number(m[1]); p = p.slice(0, m.index); }
    const isAbs = p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\');
    const abs = isAbs || !projectPath ? p : `${projectPath.replace(/[\\/]+$/, '')}/${p}`;
    setPendingFile(line ? { path: abs, line } : { path: abs });
    setTab('file');
  }, [projectPath]);

  const clearPendingFile = React.useCallback(() => { setPendingFile(null); }, []);

  // Reload the session list when the project actually changes (not on first
  // mount — initial state already came from the URL + store).
  const prevPathRef = React.useRef(projectPath);
  React.useEffect(() => {
    if (prevPathRef.current === projectPath) return;
    prevPathRef.current = projectPath;
    const u = readWorkspaceUrl();
    const s = loadSessions(projectPath);
    setStored(s);
    setActiveSessionId(u.session ?? null);
    setTab(u.tab ?? 'chat');
  }, [projectPath]);

  React.useEffect(() => {
    saveSessions(projectPath, stored);
  }, [projectPath, stored]);

  // Source the session list from the server (survives cache-clear + cross-device)
  // and MERGE with any just-created, not-yet-persisted local sessions (a session
  // is only persisted server-side on its first turn). The localStorage list above
  // gives an instant first paint; this reconciles it with the authoritative rows.
  //
  // Re-polls on an interval so each row's live `status` (→ the sidebar "thinking"
  // indicator) flips while an agent works and back to idle when it stops. Paused
  // while the tab is hidden, and re-fired the moment it becomes visible again.
  React.useEffect(() => {
    let cancelled = false;
    const poll = async (): Promise<void> => {
      const projectId = await resolveProjectId(projectPath ?? null);
      const data = await sessionApi.list({ projectId });
      if (cancelled || !data) return;
      const mapped: StoredSession[] = data.sessions.map((s) => ({
        compositeId: s.sessionId,
        title: s.title || 'Session',
        updated_at: s.updated,
        model: s.model || 'auto',
        // Live run status → the row's thinking/idle pill.
        status: s.status,
        // Branch is server-persisted for cross-browser visibility.
        ...(s.branch ? { branch: s.branch } : {}),
      }));
      setStored((prev) => {
        const serverIds = new Set(mapped.map((m) => m.compositeId));
        const localOnly = prev.filter((p) => !serverIds.has(p.compositeId));
        return [...mapped, ...localOnly];
      });
    };
    void poll();
    const id = window.setInterval(() => { if (!document.hidden) void poll(); }, 3000);
    const onVisible = (): void => { if (!document.hidden) void poll(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [projectPath]);

  // Keep ?tab= / ?session= in sync so a reload restores the workspace.
  React.useEffect(() => {
    writeWorkspaceUrl(tab, activeSessionId);
  }, [tab, activeSessionId]);

  const recordSession = React.useCallback((id: string) => {
    setStored((prev) => {
      if (prev.some((s) => s.compositeId === id)) return prev;
      return [...prev, { compositeId: id, title: 'Session', updated_at: Date.now(), model: 'auto' }];
    });
    setActiveSessionId(id);
  }, []);

  const selectSession = React.useCallback((id: string) => {
    setActiveSessionId(id);
    // The freshly-mounted chat re-reports its run state; reset so the switched-to
    // row doesn't inherit the previous session's "thinking" for a frame.
    setActiveRunning(false);
    setChatKey((k) => k + 1);
    setTab('chat');
  }, []);

  const newSession = React.useCallback(() => {
    setActiveSessionId(null);
    setActiveRunning(false);
    setChatKey((k) => k + 1);
    setTab('chat');
  }, []);

  // Hand a feedback report to the coding agent: seed the composer with a fix
  // prompt (via the same sessionStorage bridges the eval flow uses) in an existing
  // session or a fresh one, then switch to it. The user reviews + hits Send.
  const sendFeedbackToAgent = React.useCallback((prompt: string, sessionId: string | null) => {
    if (sessionId) {
      try { sessionStorage.setItem(`eval-first-turn-prompt:${sessionId}`, prompt); } catch { /* ignore */ }
      selectSession(sessionId);
    } else {
      try {
        sessionStorage.setItem('eval-pending-task', JSON.stringify({ taskName: 'feedback-fix', firstTurnPrompt: prompt }));
      } catch { /* ignore */ }
      newSession();
    }
  }, [selectSession, newSession]);

  const archiveSession = React.useCallback((id: string) => {
    setStored((prev) => prev.filter((s) => s.compositeId !== id));
    setActiveSessionId((cur) => (cur === id ? null : cur));
    // Archiving the session currently mounted in the chat pane must drop its
    // view back to the new-session hero. The pane is keyed on chatKey only
    // (not activeSessionId), so bump chatKey to force that remount.
    if (id === activeSessionId) setChatKey((k) => k + 1);
    // Persist the archive + tear down the session's worktree (best-effort).
    void sessionApi.archive({ sessionId: id });
    void import('./agent/sessionWorkspace').then((m) => m.removeSessionWorkspace(id, projectPath ?? null));
  }, [projectPath, activeSessionId]);

  const sidebarSessions: SessionListSidebarSession[] = stored.map((s) => ({
    compositeId: s.compositeId,
    title: s.title,
    updated_at: s.updated_at,
    // Thinking indicator: the ACTIVE session uses the chat's instant live signal;
    // every session also honors the server-persisted status from the poll (covers
    // background/peer sessions + the active one once the poll catches up).
    running: (s.compositeId === activeSessionId && activeRunning) || s.status === 'running',
    model: s.model,
    totalTokens: 0,
    totalCost: 0,
    ...(s.branch ? { branch: s.branch } : {}),
  }));

  // One props object shared by the desktop inline sidebar and the mobile drawer
  // (DRY). On mobile, every selection also closes the drawer; closeDrawer() is a
  // harmless no-op on desktop where the drawer isn't rendered.
  const sidebarProps = {
    sessions: sidebarSessions,
    activeCompositeId: activeSessionId,
    onSelect: (id: string) => { selectSession(id); closeDrawer(); },
    onNewSession: () => { newSession(); closeDrawer(); },
    onArchiveSession: archiveSession,
    timeAgo: timeAgoShort,
    archivedCount: 0,
    onShowArchived: () => undefined,
    // The five session views (Agent/Preview/File/Git/Database) render as an indented
    // sub-list under the active session row. Selecting one switches the view (and
    // closes the drawer on mobile).
    sessionViews: TABS.map((t) => ({
      id: t.id,
      label: t.label,
      icon: SESSION_VIEW_ICONS[t.id],
      active: tab === t.id,
      onClick: () => { setTab(t.id); closeDrawer(); },
    })),
    footerNav: [
      { id: 'deploy', label: 'Deploy', icon: <DeployIcon />, active: tab === 'deploy', onClick: () => { setTab('deploy'); closeDrawer(); } },
      { id: 'prodDatabase', label: 'Database', icon: <DatabaseIcon />, active: tab === 'prodDatabase', onClick: () => { setTab('prodDatabase'); closeDrawer(); } },
      { id: 'errors', label: 'Errors', icon: <ErrorsIcon />, active: tab === 'errors', onClick: () => { setTab('errors'); closeDrawer(); } },
      { id: 'events', label: 'Events', icon: <EventsIcon />, active: tab === 'events', onClick: () => { setTab('events'); closeDrawer(); } },
      { id: 'feedback', label: 'Feedback', icon: <FeedbackIcon />, active: tab === 'feedback', onClick: () => { setTab('feedback'); closeDrawer(); } },
      { id: 'workers', label: 'Workers', icon: <WorkersIcon />, active: tab === 'workers', onClick: () => { setTab('workers'); closeDrawer(); } },
      { id: 'terminal', label: 'Terminal', icon: <TerminalIcon />, active: tab === 'terminal', onClick: () => { setTab('terminal'); closeDrawer(); } },
    ],
    // Settings lives in the sidebar's top header bar (a global preference,
    // not a workspace tab). StudioShell owns the modal and listens for this
    // event. Kept as a CustomEvent so the desktop shell + any other host can
    // intercept without a prop drilled all the way up.
    onOpenSettings: () => {
      window.dispatchEvent(new CustomEvent('ugly-studio:open-settings'));
      closeDrawer();
    },
  };

  const activeViewLabel = ALL_TAB_LABELS[tab];

  return (
    <ThemeProvider>
    <div style={{ ...S.root, paddingBottom: `max(${insets.bottom}px, var(--keyboard-inset-height, 0px))` }}>
      {!isMobile && (
        <>
          <div style={{ ...S.sidebar, width: sidebarW }}>
            <SessionListSidebar {...sidebarProps} />
          </div>
          <div
            style={S.resizer}
            onPointerDown={startResize}
            role="separator"
            aria-orientation="vertical"
            title="Drag to resize"
          />
        </>
      )}
      <main style={S.main}>
        <header style={S.header}>
          <TabPickerStyles />
          {isMobile ? (
            <button
              data-id="mobile-nav-toggle"
              onClick={() => { setDrawerOpen(true); }}
              style={S.hamburger}
              aria-label="Open navigation"
            >
              <HamburgerIcon />
            </button>
          ) : (
            <button data-id="back-to-projects" onClick={onBack} style={S.back}>
              ‹ Projects
            </button>
          )}
          <span style={S.name}>{isMobile ? activeViewLabel : projectName}</span>
          {!isMobile && projectPath && <span style={S.path}>{projectPath}</span>}
          {/* On desktop the header now shows the active view name (the five
              session views moved into the sidebar's per-session sub-nav). */}
          {!isMobile && <span style={S.path}>· {activeViewLabel}</span>}
          <span style={{ flex: 1 }} />
        </header>
        <ChatOpenUriProvider value={openUri}>
        <div style={S.content}>
          {/* Chat stays mounted (preserves the agent session); others mount on demand.
              key bumps on session switch so the chat reloads the selected session. */}
          <div style={{ ...S.pane, display: tab === 'chat' ? 'flex' : 'none' }}>
            <CodingAgentChat
              // Key on chatKey ONLY — never on activeSessionId. When the chat
              // creates its own session, recordSession sets activeSessionId,
              // which previously flipped this key and destroyed the live
              // instance mid-create — the fresh instance then re-fetched the
              // just-created session before its message + setting RPCs had
              // persisted, so the model/plan/initial message only appeared
              // after a manual reload. Explicit session switches (select/new/
              // archive-active) bump chatKey to force the remount they need.
              key={`chat-${chatKey}`}
              {...(activeSessionId ? { initialSessionId: activeSessionId } : {})}
              onSessionCreated={recordSession}
              onResumeMissing={archiveSession}
              onOpenUri={openUri}
              onRunningChange={setActiveRunning}
            />
          </div>
          {/* Session tabs (dev-scoped) */}
          {tab === 'preview' && <div style={S.pane}><PreviewPanel sessionId={activeSessionId} /></div>}
          {tab === 'file' && <div style={S.pane}><FilePanel openTarget={pendingFile} onOpened={clearPendingFile} /></div>}
          {tab === 'git' && <div style={S.pane}><GitPanel /></div>}
          {tab === 'tests' && <div style={S.pane}><TestsPanel /></div>}
          {tab === 'database' && <div style={S.paneScroll}><DatabasePanel forceDev /></div>}
          {/* Sidebar prod views */}
          {tab === 'deploy' && <div style={S.pane}><ProdPanel /></div>}
          {tab === 'prodDatabase' && <div style={S.paneScroll}><DatabasePanel forceProd onDeploy={() => { setTab('deploy'); }} /></div>}
          {tab === 'errors' && <div style={S.paneScroll}><ErrorsPanel forceProd onDeploy={() => { setTab('deploy'); }} /></div>}
          {tab === 'events' && <div style={S.paneScroll}><EventsPanel onDeploy={() => { setTab('deploy'); }} /></div>}
          {tab === 'feedback' && <div style={S.paneScroll}><FeedbackPanel onDeploy={() => { setTab('deploy'); }} sessions={stored.map((s) => ({ compositeId: s.compositeId, title: s.title }))} onSendToAgent={sendFeedbackToAgent} /></div>}
          {tab === 'workers' && <div style={S.paneScroll}><WorkersPanel forceProd /></div>}
          {tab === 'terminal' && <div style={S.pane}><TerminalPanel /></div>}
        </div>
        </ChatOpenUriProvider>
      </main>
      {isMobile && (
        <>
          <div
            data-id="mobile-nav-scrim"
            onClick={closeDrawer}
            style={{ ...S.scrim, ...(drawerOpen ? S.scrimOpen : {}) }}
          />
          <div data-id="mobile-nav-drawer" style={{ ...S.drawer, ...(drawerOpen ? S.drawerOpen : {}) }}>
            <button data-id="mobile-drawer-back" onClick={() => { onBack(); closeDrawer(); }} style={S.drawerBack}>
              ‹ Projects
            </button>
            <div style={S.viewsList}>
              {TABS.map((t) => (
                <button
                  key={t.id}
                  data-id={`mobile-view-${t.id}`}
                  onClick={() => { setTab(t.id); closeDrawer(); }}
                  style={{ ...S.viewRow, ...(tab === t.id ? S.viewRowActive : {}) }}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <div style={S.drawerSidebar}>
              <SessionListSidebar {...sidebarProps} />
            </div>
          </div>
        </>
      )}
    </div>
    </ThemeProvider>
  );
}

// Display label per tab — drives the mobile header title + the drawer Views
// list reuses TABS for its own labels (these match).
const ALL_TAB_LABELS: Record<WorkspaceTab, string> = {
  chat: 'Agent', preview: 'Preview', file: 'File', git: 'Git', tests: 'Tests', database: 'Database',
  deploy: 'Deploy', prodDatabase: 'Database', errors: 'Errors', events: 'Events', feedback: 'Feedback',
  workers: 'Workers', terminal: 'Terminal',
};

// Minimal inline hamburger (no emoji / no lucide-react dep — matches the repo's
// inline-SVG icon convention).
function HamburgerIcon(): React.ReactElement {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  );
}

// Hover affordance for the segmented tab control (inactive chips brighten on
// hover; the active chip is already raised so it's excluded).
function TabPickerStyles(): React.ReactElement {
  return (
    <style>{`
      .us-chat-tab:hover:not([data-active="true"]) { color: var(--text-primary); }
      .us-chat-tab:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    `}</style>
  );
}

// Themed via the studio CSS variables (light + dark) so the workspace matches
// the rest of the app instead of a hardcoded dark palette.
const S: Record<string, React.CSSProperties> = {
  // 100dvh (not 100vh) tracks the mobile browser/keyboard chrome. Safe-area
  // padding on L/R/bottom keeps content clear of side notches + the home
  // indicator; the header owns the TOP inset so its bar fills behind the status
  // bar (immersive). All env() insets are 0 on desktop → a no-op there.
  root: { display: 'flex', height: '100dvh', boxSizing: 'border-box', paddingLeft: 'var(--safe-area-inset-left)', paddingRight: 'var(--safe-area-inset-right)', paddingBottom: 'var(--safe-area-inset-bottom)', background: 'var(--bg-primary)', color: 'var(--text-primary)' },
  sidebar: { flex: 'none', display: 'flex', minHeight: 0, borderRight: '1px solid var(--border)' },
  // Thin draggable gutter between the session sidebar and the workspace.
  resizer: { width: 5, flex: 'none', cursor: 'col-resize', background: 'transparent', marginLeft: -3, zIndex: 5 },
  main: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' },
  // Fixed 36px height to line up exactly with the session-list sidebar header.
  // Right padding reserves space for the fixed top-right feedback icon so the
  // tab control never slides under it (see [data-id='feedback-button'] in styles.css).
  // Height grows by the top inset and paddingTop pushes content below the notch,
  // so the panel background fills behind the status bar (immersive header).
  header: { display: 'flex', alignItems: 'center', gap: 10, height: 'calc(36px + var(--safe-area-inset-top))', paddingTop: 'var(--safe-area-inset-top)', paddingRight: 42, paddingBottom: 0, paddingLeft: 12, boxSizing: 'border-box', borderBottom: '1px solid var(--border)', background: 'var(--bg-panel)', flexShrink: 0 },
  back: { fontFamily: 'var(--font-mono)', fontSize: 11.5, lineHeight: 1, height: 24, display: 'inline-flex', alignItems: 'center', background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 6, padding: '0 9px', cursor: 'pointer', flexShrink: 0 },
  name: { fontFamily: 'var(--font-mono)', fontSize: 12.5, fontWeight: 700, color: 'var(--text-primary)', flexShrink: 0 },
  path: { fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 320 },
  // Segmented control: one rounded track holding the tab chips.
  tabBar: { display: 'inline-flex', alignItems: 'center', gap: 2, height: 26, padding: 3, boxSizing: 'border-box', background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, flexShrink: 0 },
  tabSeg: { height: '100%', display: 'inline-flex', alignItems: 'center', padding: '0 11px', fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 600, letterSpacing: '0.01em', color: 'var(--text-muted)', background: 'transparent', border: 'none', borderRadius: 5, cursor: 'pointer', transition: 'color 120ms ease, background 120ms ease, box-shadow 120ms ease' },
  tabSegActive: { background: 'var(--bg-primary)', color: 'var(--accent)', boxShadow: '0 1px 2px rgba(0,0,0,0.16)' },
  content: { flex: 1, minHeight: 0, display: 'flex', position: 'relative', background: 'var(--bg-primary)' },
  pane: { flex: 1, minHeight: 0, minWidth: 0, flexDirection: 'column', display: 'flex' },
  paneScroll: { flex: 1, minHeight: 0, minWidth: 0, overflow: 'auto' },
  placeholder: { display: 'flex', flexDirection: 'column', gap: 8, padding: 32, maxWidth: 560, fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.6 },
  // --- Mobile nav drawer (rendered below 768px) ---
  hamburger: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 28, background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer', flexShrink: 0, padding: 0 },
  // Scrim + drawer sit above the fixed feedback button (z-index 1000 in styles.css).
  // visibility toggles so the closed overlay isn't hit-testable (Playwright not.toBeVisible passes).
  scrim: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', opacity: 0, visibility: 'hidden', transition: 'opacity 180ms ease, visibility 180ms ease', zIndex: 1100 },
  scrimOpen: { opacity: 1, visibility: 'visible' },
  drawer: { position: 'fixed', top: 0, left: 0, bottom: 0, width: 'min(86vw, 320px)', display: 'flex', flexDirection: 'column', background: 'var(--bg-panel)', borderRight: '1px solid var(--border)', transform: 'translateX(-100%)', visibility: 'hidden', transition: 'transform 200ms ease, visibility 200ms ease', zIndex: 1200, paddingTop: 'var(--safe-area-inset-top)', paddingBottom: 'var(--safe-area-inset-bottom)', boxSizing: 'border-box' },
  drawerOpen: { transform: 'translateX(0)', visibility: 'visible' },
  drawerBack: { flex: 'none', textAlign: 'left', fontFamily: 'var(--font-mono)', fontSize: 12, height: 40, padding: '0 14px', background: 'transparent', color: 'var(--text-primary)', border: 'none', borderBottom: '1px solid var(--border)', cursor: 'pointer' },
  viewsList: { flex: 'none', display: 'flex', flexDirection: 'column', padding: '6px 0', borderBottom: '1px solid var(--border)' },
  viewRow: { textAlign: 'left', fontFamily: 'var(--font-mono)', fontSize: 13, height: 40, padding: '0 14px', background: 'transparent', color: 'var(--text-muted)', border: 'none', cursor: 'pointer' },
  viewRowActive: { color: 'var(--accent)', background: 'var(--bg-secondary)' },
  drawerSidebar: { flex: 1, minHeight: 0, display: 'flex' },
};
