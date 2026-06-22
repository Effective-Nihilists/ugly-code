import React from 'react';
import {
  SessionListSidebar,
  type SessionListSidebarSession,
} from './panels/SessionListSidebar';
import { nativeRequest, setActiveProjectPath } from './hooks/useSocket';
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

// Phase 2: the project page — the REAL Studio session sidebar (session list +
// Prod/Git/Terminal footer buttons + New session) rendering against the native
// transport. The center workspace (coding-agent chat + the 9-tab rail) is the
// next phase; for now it's a placeholder.
interface SessionRow {
  compositeId: string;
  title: string;
  updated_at: number;
  running: boolean;
  blocked: boolean;
  archived?: boolean;
  model: string;
  totalTokens: number;
  totalCost: number;
}

export default function StudioProjectPage({
  projectName,
  projectPath,
  onBack,
}: {
  projectName: string;
  projectPath?: string;
  onBack: () => void;
}): React.ReactElement {
  const [sessions, setSessions] = React.useState<SessionRow[]>([]);
  const [tab, setTab] = React.useState<WorkspaceTab>('chat');

  // Tell the native transport which project the panels (DB query, ugly-app CLI)
  // should target.
  React.useEffect(() => {
    setActiveProjectPath(projectPath ?? null);
    return () => { setActiveProjectPath(null); };
  }, [projectPath]);

  React.useEffect(() => {
    nativeRequest('codingAgentListSessions', { projectPath, includeArchived: true })
      .then((r) => { setSessions((r as { sessions?: SessionRow[] } | null)?.sessions ?? []); })
      .catch(() => { setSessions([]); });
  }, [projectPath]);

  const sidebarSessions: SessionListSidebarSession[] = sessions
    .filter((s) => !s.archived)
    .map((s) => ({
      compositeId: s.compositeId,
      title: s.title,
      updated_at: s.updated_at,
      running: s.running,
      blocked: s.blocked,
      model: s.model,
      totalTokens: s.totalTokens,
      totalCost: s.totalCost,
    }));

  return (
    <ThemeProvider>
    <div style={S.root}>
      <div style={S.sidebar}>
      <SessionListSidebar
        sessions={sidebarSessions}
        activeCompositeId={null}
        onSelect={(id) => { console.log('[studio] select session', id); }}
        onNewSession={() => { console.log('[studio] new session'); }}
        onArchiveSession={(id) => { console.log('[studio] archive', id); }}
        onResetMainSession={(id) => { console.log('[studio] reset main', id); }}
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
          {/* Chat stays mounted (preserves the agent session); others mount on demand. */}
          <div style={{ ...S.pane, display: tab === 'chat' ? 'flex' : 'none' }}>
            <CodingAgentChat />
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
