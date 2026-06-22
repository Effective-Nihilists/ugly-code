import React from 'react';
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
import { WorkersPanel } from './panels/WorkersPanel';
import { GitPanel } from './panels/GitPanel';
import { TerminalPanel } from './panels/TerminalPanel';
import { ProdPanel } from './panels/ProdPanel';
import { PreviewPanel } from './panels/PreviewPanel';
import { FilePanel } from './panels/FilePanel';
import {
  PublishIcon, DatabaseIcon, ErrorsIcon, EventsIcon, WorkersIcon, TerminalIcon,
} from './panels/navIcons';

// Two nav surfaces:
//  - Session top tab picker (per-session, dev-scoped): Agent / Preview / File /
//    Git / Database.
//  - Sidebar footer (prod-scoped views): Publish / Database(prod) / Errors /
//    Events / Workers / Terminal. Errors/Events/Workers are prod-only; Database
//    appears in both (dev in the top tabs, prod in the sidebar).
type WorkspaceTab =
  | 'chat' | 'preview' | 'file' | 'git' | 'database'
  | 'publish' | 'prodDatabase' | 'errors' | 'events' | 'workers' | 'terminal';
const TABS: { id: WorkspaceTab; label: string }[] = [
  { id: 'chat', label: 'Agent' },
  { id: 'preview', label: 'Preview' },
  { id: 'file', label: 'File' },
  { id: 'git', label: 'Git' },
  { id: 'database', label: 'Database' },
];
const ALL_TABS: WorkspaceTab[] = [
  'chat', 'preview', 'file', 'git', 'database',
  'publish', 'prodDatabase', 'errors', 'events', 'workers', 'terminal',
];

// The open tab + active session live in the URL (alongside ?path=) so a reload
// restores exactly where you were.
function readWorkspaceUrl(): { tab: WorkspaceTab | null; session: string | null } {
  const p = new URLSearchParams(window.location.search);
  const t = p.get('tab') as WorkspaceTab | null;
  return { tab: t && ALL_TABS.includes(t) ? t : null, session: p.get('session') };
}
function writeWorkspaceUrl(tab: WorkspaceTab, session: string | null): void {
  const url = new URL(window.location.href);
  if (tab === 'chat') url.searchParams.delete('tab');
  else url.searchParams.set('tab', tab);
  if (session) url.searchParams.set('session', session);
  else url.searchParams.delete('session');
  window.history.replaceState({}, '', url.pathname + url.search);
}

// The project page: session sidebar (list + main + New session) + the workspace
// (coding-agent chat + the tab rail). Sessions persist per project; the main
// session is the always-present canonical one.
const MAIN_PLACEHOLDER = '__new-main__';

export default function StudioProjectPage({
  projectName,
  projectPath,
  onBack,
}: {
  projectName: string;
  projectPath?: string;
  onBack: () => void;
}): React.ReactElement {
  const urlInit = React.useMemo(() => readWorkspaceUrl(), []);
  const [tab, setTab] = React.useState<WorkspaceTab>(urlInit.tab ?? 'chat');
  // Sessions are persisted per project; CodingAgentChat assigns the real
  // compositeId on first turn (onSessionCreated), which we record here.
  const [stored, setStored] = React.useState<StoredSession[]>(() => loadSessions(projectPath));
  const [activeSessionId, setActiveSessionId] = React.useState<string | null>(
    () => urlInit.session ?? loadSessions(projectPath).find((s) => s.kind === 'main')?.compositeId ?? null,
  );
  // Bumped to remount CodingAgentChat when switching sessions / starting fresh.
  const [chatKey, setChatKey] = React.useState(0);
  const nextKindRef = React.useRef<'main' | 'session'>('main');

  React.useEffect(() => {
    setActiveProjectPath(projectPath ?? null);
    return () => { setActiveProjectPath(null); };
  }, [projectPath]);

  // Reload the session list when the project actually changes (not on first
  // mount — initial state already came from the URL + store).
  const prevPathRef = React.useRef(projectPath);
  React.useEffect(() => {
    if (prevPathRef.current === projectPath) return;
    prevPathRef.current = projectPath;
    const u = readWorkspaceUrl();
    const s = loadSessions(projectPath);
    setStored(s);
    setActiveSessionId(u.session ?? s.find((x) => x.kind === 'main')?.compositeId ?? null);
    setTab(u.tab ?? 'chat');
  }, [projectPath]);

  React.useEffect(() => {
    saveSessions(projectPath, stored);
  }, [projectPath, stored]);

  // Source the session list from the server (survives cache-clear + cross-device)
  // and MERGE with any just-created, not-yet-persisted local sessions (a session
  // is only persisted server-side on its first turn). The localStorage list above
  // gives an instant first paint; this reconciles it with the authoritative rows.
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const projectId = await resolveProjectId(projectPath ?? null);
      const data = await sessionApi.list({ projectId });
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `cancelled` is mutated by the cleanup closure
      if (cancelled || !data) return;
      const mapped: StoredSession[] = data.sessions.map((s) => ({
        compositeId: s.sessionId,
        title: s.title || (s.kind === 'main' ? 'Main session' : 'Session'),
        ...(s.kind === 'main' ? { kind: 'main' as const } : {}),
        updated_at: s.updated,
        model: s.model || 'auto',
      }));
      setStored((prev) => {
        const serverIds = new Set(mapped.map((m) => m.compositeId));
        const localOnly = prev.filter((p) => !serverIds.has(p.compositeId));
        return [...mapped, ...localOnly];
      });
    })();
    return () => { cancelled = true; };
  }, [projectPath]);

  // Keep ?tab= / ?session= in sync so a reload restores the workspace.
  React.useEffect(() => {
    writeWorkspaceUrl(tab, activeSessionId);
  }, [tab, activeSessionId]);

  const hasRealMain = stored.some((s) => s.kind === 'main');

  const recordSession = React.useCallback((id: string) => {
    setStored((prev) => {
      if (prev.some((s) => s.compositeId === id)) return prev;
      const asMain = nextKindRef.current === 'main' && !prev.some((s) => s.kind === 'main');
      return [
        ...prev,
        { compositeId: id, title: asMain ? 'Main session' : 'Session', updated_at: Date.now(), model: 'auto', ...(asMain ? { kind: 'main' as const } : {}) },
      ];
    });
    setActiveSessionId(id);
  }, []);

  const selectSession = React.useCallback((id: string) => {
    if (id === MAIN_PLACEHOLDER) {
      nextKindRef.current = 'main';
      setActiveSessionId(null);
    } else {
      setActiveSessionId(id);
    }
    setChatKey((k) => k + 1);
    setTab('chat');
  }, []);

  const newSession = React.useCallback(() => {
    nextKindRef.current = hasRealMain ? 'session' : 'main';
    setActiveSessionId(null);
    setChatKey((k) => k + 1);
    setTab('chat');
  }, [hasRealMain]);

  const archiveSession = React.useCallback((id: string) => {
    setStored((prev) => prev.filter((s) => s.compositeId !== id));
    setActiveSessionId((cur) => (cur === id ? null : cur));
    // Persist the archive so it doesn't reappear on reload (best-effort).
    if (id !== MAIN_PLACEHOLDER) void sessionApi.archive({ sessionId: id });
  }, []);

  // Synthetic "Main session" row when none has been started yet — clicking it
  // opens the new-session hero, and the first session created becomes main.
  const sidebarSessions: SessionListSidebarSession[] = [
    ...(hasRealMain
      ? []
      : [{ compositeId: MAIN_PLACEHOLDER, title: 'Main session', kind: 'main' as const, updated_at: Date.now(), running: false, model: 'auto', totalTokens: 0, totalCost: 0 }]),
    ...stored.map((s) => ({
      compositeId: s.compositeId,
      title: s.title,
      ...(s.kind ? { kind: s.kind } : {}),
      updated_at: s.updated_at,
      running: false,
      model: s.model,
      totalTokens: 0,
      totalCost: 0,
    })),
  ];

  return (
    <ThemeProvider>
    <div style={S.root}>
      <div style={S.sidebar}>
      <SessionListSidebar
        sessions={sidebarSessions}
        activeCompositeId={activeSessionId ?? MAIN_PLACEHOLDER}
        onSelect={selectSession}
        onNewSession={newSession}
        onArchiveSession={archiveSession}
        onResetMainSession={archiveSession}
        timeAgo={timeAgoShort}
        archivedCount={0}
        onShowArchived={() => undefined}
        footerNav={[
          { id: 'publish', label: 'Publish', icon: <PublishIcon />, active: tab === 'publish', onClick: () => { setTab('publish'); } },
          { id: 'prodDatabase', label: 'Database', icon: <DatabaseIcon />, active: tab === 'prodDatabase', onClick: () => { setTab('prodDatabase'); } },
          { id: 'errors', label: 'Errors', icon: <ErrorsIcon />, active: tab === 'errors', onClick: () => { setTab('errors'); } },
          { id: 'events', label: 'Events', icon: <EventsIcon />, active: tab === 'events', onClick: () => { setTab('events'); } },
          { id: 'workers', label: 'Workers', icon: <WorkersIcon />, active: tab === 'workers', onClick: () => { setTab('workers'); } },
          { id: 'terminal', label: 'Terminal', icon: <TerminalIcon />, active: tab === 'terminal', onClick: () => { setTab('terminal'); } },
        ]}
      />
      </div>
      <main style={S.main}>
        <header style={S.header}>
          <TabPickerStyles />
          <button data-id="back-to-projects" onClick={onBack} style={S.back}>
            ‹ Projects
          </button>
          <span style={S.name}>{projectName}</span>
          {projectPath && <span style={S.path}>{projectPath}</span>}
          <span style={{ flex: 1 }} />
          {/* Segmented control — matches the sidebar header height (36) and reads
              as one clean control instead of five separate bordered buttons. */}
          <div style={S.tabBar}>
            {TABS.map((t) => {
              const active = tab === t.id;
              return (
                <button
                  key={t.id}
                  data-id={`tab-${t.id}`}
                  aria-pressed={active}
                  data-active={active}
                  className="us-chat-tab"
                  onClick={() => { setTab(t.id); }}
                  style={{ ...S.tabSeg, ...(active ? S.tabSegActive : {}) }}
                >
                  {t.label}
                </button>
              );
            })}
          </div>
        </header>
        <div style={S.content}>
          {/* Chat stays mounted (preserves the agent session); others mount on demand.
              key bumps on session switch so the chat reloads the selected session. */}
          <div style={{ ...S.pane, display: tab === 'chat' ? 'flex' : 'none' }}>
            <CodingAgentChat
              key={`${chatKey}:${activeSessionId ?? 'new'}`}
              {...(activeSessionId ? { initialSessionId: activeSessionId } : {})}
              onSessionCreated={recordSession}
              onResumeMissing={archiveSession}
            />
          </div>
          {/* Session tabs (dev-scoped) */}
          {tab === 'preview' && <div style={S.pane}><PreviewPanel /></div>}
          {tab === 'file' && <div style={S.pane}><FilePanel /></div>}
          {tab === 'git' && <div style={S.pane}><GitPanel /></div>}
          {tab === 'database' && <div style={S.paneScroll}><DatabasePanel forceDev /></div>}
          {/* Sidebar prod views */}
          {tab === 'publish' && <div style={S.pane}><ProdPanel /></div>}
          {tab === 'prodDatabase' && <div style={S.paneScroll}><DatabasePanel forceProd /></div>}
          {tab === 'errors' && <div style={S.paneScroll}><ErrorsPanel forceProd /></div>}
          {tab === 'events' && <div style={S.paneScroll}><EventsPanel /></div>}
          {tab === 'workers' && <div style={S.paneScroll}><WorkersPanel forceProd /></div>}
          {tab === 'terminal' && <div style={S.pane}><TerminalPanel /></div>}
        </div>
      </main>
    </div>
    </ThemeProvider>
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
  root: { display: 'flex', height: '100vh', background: 'var(--bg-primary)', color: 'var(--text-primary)' },
  sidebar: { width: 264, flex: 'none', display: 'flex', minHeight: 0, borderRight: '1px solid var(--border)' },
  main: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' },
  // Fixed 36px height to line up exactly with the session-list sidebar header.
  // Right padding reserves space for the fixed top-right feedback icon so the
  // tab control never slides under it (see [data-id='feedback-button'] in styles.css).
  header: { display: 'flex', alignItems: 'center', gap: 10, height: 36, padding: '0 42px 0 12px', boxSizing: 'border-box', borderBottom: '1px solid var(--border)', background: 'var(--bg-panel)', flexShrink: 0 },
  back: { fontFamily: 'var(--font-mono)', fontSize: 11.5, lineHeight: 1, height: 24, display: 'inline-flex', alignItems: 'center', background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 6, padding: '0 9px', cursor: 'pointer', flexShrink: 0 },
  name: { fontFamily: 'var(--font-mono)', fontSize: 12.5, fontWeight: 700, color: 'var(--text-primary)', flexShrink: 0 },
  path: { fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 320 },
  // Segmented control: one rounded track holding the tab chips.
  tabBar: { display: 'inline-flex', alignItems: 'center', gap: 2, height: 26, padding: 3, boxSizing: 'border-box', background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, flexShrink: 0 },
  tabSeg: { height: '100%', display: 'inline-flex', alignItems: 'center', padding: '0 11px', fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 600, letterSpacing: '0.01em', color: 'var(--text-muted)', background: 'transparent', border: 'none', borderRadius: 5, cursor: 'pointer', transition: 'color 120ms ease, background 120ms ease, box-shadow 120ms ease' },
  tabSegActive: { background: 'var(--bg-primary)', color: 'var(--accent)', boxShadow: '0 1px 2px rgba(0,0,0,0.16)' },
  content: { flex: 1, minHeight: 0, display: 'flex', position: 'relative', background: 'var(--bg-primary)' },
  pane: { flex: 1, minHeight: 0, flexDirection: 'column', display: 'flex' },
  paneScroll: { flex: 1, minHeight: 0, overflow: 'auto' },
  placeholder: { display: 'flex', flexDirection: 'column', gap: 8, padding: 32, maxWidth: 560, fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.6 },
};
