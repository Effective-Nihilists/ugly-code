import React from 'react';
import {
  SessionListSidebar,
  type SessionListSidebarSession,
} from './panels/SessionListSidebar';
import { nativeRequest } from './hooks/useSocket';
import { timeAgoShort } from './utils/timeAgo';
import { ThemeProvider } from './theme/ThemeProvider';
import { CodingAgentChat } from './panels/CodingAgentChat';

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

  React.useEffect(() => {
    nativeRequest('codingAgentListSessions', { projectPath, includeArchived: true })
      .then((r) => setSessions(((r as { sessions?: SessionRow[] })?.sessions ?? [])))
      .catch(() => setSessions([]));
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
        onSelect={(id) => console.log('[studio] select session', id)}
        onNewSession={() => console.log('[studio] new session')}
        onArchiveSession={(id) => console.log('[studio] archive', id)}
        onResetMainSession={(id) => console.log('[studio] reset main', id)}
        timeAgo={timeAgoShort}
        archivedCount={0}
        onShowArchived={() => undefined}
        footerNav={{
          activeView: 'session',
          prodAvailable: false,
          onGoProd: () => console.log('[studio] prod'),
          onGoGit: () => console.log('[studio] git'),
          onGoTerminal: () => console.log('[studio] terminal'),
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
        </header>
        <div style={S.chat}>
          <CodingAgentChat />
        </div>
      </main>
    </div>
    </ThemeProvider>
  );
}

const S: Record<string, React.CSSProperties> = {
  root: { display: 'flex', height: '100vh', background: '#0c0b0a', color: '#efe9e1' },
  sidebar: { width: 264, flex: 'none', display: 'flex', minHeight: 0, borderRight: '1px solid #2c2620' },
  main: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' },
  header: { display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderBottom: '1px solid #2c2620' },
  back: { fontFamily: 'monospace', fontSize: 12, background: 'transparent', color: '#988e80', border: '1px solid #2c2620', borderRadius: 7, padding: '5px 11px', cursor: 'pointer' },
  name: { fontFamily: 'monospace', fontWeight: 700 },
  path: { fontFamily: 'monospace', fontSize: 12, color: '#5f574c' },
  chat: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' },
};
