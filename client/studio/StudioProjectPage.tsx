import React from 'react';
import {
  SessionListSidebar,
  type SessionListSidebarSession,
} from './panels/SessionListSidebar';
import { setActiveProjectPath } from './hooks/useSocket';
import { loadSessions, saveSessions, type StoredSession } from './state/projectSessions';
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

// Top-bar tabs + the sidebar-footer views (git / terminal / prod).
type WorkspaceTab = 'chat' | 'database' | 'errors' | 'events' | 'workers' | 'git' | 'terminal' | 'prod';
const TABS: { id: WorkspaceTab; label: string }[] = [
  { id: 'chat', label: 'Agent' },
  { id: 'database', label: 'Database' },
  { id: 'errors', label: 'Errors' },
  { id: 'events', label: 'Events' },
  { id: 'workers', label: 'Workers' },
];

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
  const [tab, setTab] = React.useState<WorkspaceTab>('chat');
  // Sessions are persisted per project; CodingAgentChat assigns the real
  // compositeId on first turn (onSessionCreated), which we record here.
  const [stored, setStored] = React.useState<StoredSession[]>(() => loadSessions(projectPath));
  const [activeSessionId, setActiveSessionId] = React.useState<string | null>(
    () => loadSessions(projectPath).find((s) => s.kind === 'main')?.compositeId ?? null,
  );
  // Bumped to remount CodingAgentChat when switching sessions / starting fresh.
  const [chatKey, setChatKey] = React.useState(0);
  const nextKindRef = React.useRef<'main' | 'session'>('main');

  React.useEffect(() => {
    setActiveProjectPath(projectPath ?? null);
    return () => { setActiveProjectPath(null); };
  }, [projectPath]);

  // Reload the session list when the project changes.
  React.useEffect(() => {
    const s = loadSessions(projectPath);
    setStored(s);
    setActiveSessionId(s.find((x) => x.kind === 'main')?.compositeId ?? null);
  }, [projectPath]);

  React.useEffect(() => {
    saveSessions(projectPath, stored);
  }, [projectPath, stored]);

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
        footerNav={{
          activeView: tab === 'git' || tab === 'terminal' || tab === 'prod' ? tab : 'session',
          prodAvailable: true,
          onGoProd: () => { setTab('prod'); },
          onGoGit: () => { setTab('git'); },
          onGoTerminal: () => { setTab('terminal'); },
        }}
      />
      </div>
      <main style={S.main}>
        <header style={S.header}>
          <button onClick={onBack} style={S.back}>
            ‹ Projects
          </button>
          <span style={S.name}>{projectName}</span>
          {projectPath && <span style={S.path}>{projectPath}</span>}
          <span style={{ flex: 1 }} />
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => { setTab(t.id); }}
              style={{ ...S.tab, ...(tab === t.id ? S.tabActive : {}) }}
            >
              {t.label}
            </button>
          ))}
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
          {tab === 'database' && <div style={S.paneScroll}><DatabasePanel /></div>}
          {tab === 'errors' && <div style={S.paneScroll}><ErrorsPanel /></div>}
          {tab === 'events' && <div style={S.paneScroll}><EventsPanel /></div>}
          {tab === 'workers' && <div style={S.paneScroll}><WorkersPanel /></div>}
          {tab === 'git' && <div style={S.pane}><GitPanel /></div>}
          {tab === 'terminal' && <div style={S.pane}><TerminalPanel /></div>}
          {tab === 'prod' && <div style={S.pane}><ProdPanel /></div>}
        </div>
      </main>
    </div>
    </ThemeProvider>
  );
}

// Themed via the studio CSS variables (light + dark) so the workspace matches
// the rest of the app instead of a hardcoded dark palette.
const S: Record<string, React.CSSProperties> = {
  root: { display: 'flex', height: '100vh', background: 'var(--bg-primary)', color: 'var(--text-primary)' },
  sidebar: { width: 264, flex: 'none', display: 'flex', minHeight: 0, borderRight: '1px solid var(--border)' },
  main: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' },
  header: { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderBottom: '1px solid var(--border)', background: 'var(--bg-panel)', flexShrink: 0 },
  back: { fontFamily: 'var(--font-mono)', fontSize: 12, background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 7, padding: '5px 11px', cursor: 'pointer' },
  name: { fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--text-primary)' },
  path: { fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 360 },
  tab: { fontFamily: 'var(--font-mono)', fontSize: 12, background: 'transparent', color: 'var(--text-muted)', border: '1px solid var(--border)', borderRadius: 7, padding: '5px 12px', cursor: 'pointer' },
  tabActive: { background: 'var(--accent-dim)', color: 'var(--accent)', borderColor: 'var(--accent)' },
  content: { flex: 1, minHeight: 0, display: 'flex', position: 'relative', background: 'var(--bg-primary)' },
  pane: { flex: 1, minHeight: 0, flexDirection: 'column', display: 'flex' },
  paneScroll: { flex: 1, minHeight: 0, overflow: 'auto' },
  placeholder: { display: 'flex', flexDirection: 'column', gap: 8, padding: 32, maxWidth: 560, fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.6 },
};
