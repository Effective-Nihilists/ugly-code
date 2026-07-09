import React from 'react';
import { useSocket } from '../hooks/useSocket';
import { useProdDeployGate } from '../hooks/useProdDeployGate';
import { ProdPublishGate } from './ProdPublishGate';
import { GitRepoSelector } from './GitRepoSelector';

// The Studio Feedback tab — the `ugly-app feedback` CLI, in-app: list the
// project's prod feedback reports, resolve/decline them (owner-gated via the
// bridged ugly.bot token), and hand a report to the coding agent to fix. Feedback
// lives in the project's PROD store, so an unpublished project has none → gate on
// publish state (mirrors Errors/Database).

interface FeedbackItem {
  id: string;
  created: number;
  type: string;
  status: string;
  description: string;
  url: string;
  page: string;
  userId: string | null;
  resolution: string | null;
}

export interface FeedbackPanelProps {
  onPublish?: () => void;
  /** Sessions the user can hand a report to ("existing session" picker). */
  sessions?: { compositeId: string; title: string }[];
  /** Seed a coding session (existing id, or null = new) with a fix prompt. */
  onSendToAgent?: (prompt: string, sessionId: string | null) => void;
}

const card: React.CSSProperties = {
  border: '1px solid var(--border)', borderRadius: 8, padding: 12, marginBottom: 10,
  background: 'var(--bg-panel)', display: 'flex', flexDirection: 'column', gap: 6,
};
const badge = (bg: string, fg: string): React.CSSProperties => ({
  fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4,
  padding: '2px 6px', borderRadius: 4, background: bg, color: fg,
});
const btn: React.CSSProperties = {
  fontSize: 12, padding: '4px 10px', borderRadius: 5, cursor: 'pointer',
  border: '1px solid var(--border)', background: 'var(--bg-secondary)', color: 'var(--text-primary)',
};

function statusBadge(status: string): React.ReactElement {
  const map: Record<string, [string, string]> = {
    new: ['rgba(59,142,234,0.15)', '#3b8eea'],
    resolved: ['rgba(35,209,139,0.15)', '#23d18b'],
    declined: ['rgba(160,160,160,0.15)', '#999'],
  };
  const known = status === 'resolved' || status === 'declined' ? status : 'new';
  const [bg, fg] = map[known];
  return <span style={badge(bg, fg)}>{status}</span>;
}

export function FeedbackPanel({ onPublish, sessions = [], onSendToAgent }: FeedbackPanelProps = {}): React.ReactElement {
  const socket = useSocket();
  const deploy = useProdDeployGate(true);
  const [items, setItems] = React.useState<FeedbackItem[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [pickerId, setPickerId] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    setLoading(true);
    socket
      .request('feedbackList', { limit: 100 })
      .then((r) => { setItems(r.items as unknown as FeedbackItem[]); })
      .catch((e: unknown) => { console.error('[FeedbackPanel]', e); })
      .finally(() => { setLoading(false); });
  }, [socket]);

  React.useEffect(() => {
    if (deploy !== 'deployed') { setLoading(false); return; }
    load();
  }, [deploy, load]);

  const resolve = React.useCallback(
    async (item: FeedbackItem, status: 'resolved' | 'declined') => {
      const resolution = window.prompt(
        `Message to the reporter (${status === 'resolved' ? 'what was fixed' : 'why declined'}):`,
        status === 'resolved' ? 'Fixed — thanks for the report.' : '',
      );
      if (resolution == null) return;
      setBusyId(item.id);
      try {
        await socket.request('feedbackResolve', { feedbackReportId: item.id, status, resolution });
        load();
      } catch (e) {
        console.error('[FeedbackPanel:resolve]', e);
        window.alert(`Resolve failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setBusyId(null);
      }
    },
    [socket, load],
  );

  const sendToAgent = React.useCallback(
    (item: FeedbackItem, sessionId: string | null) => {
      setPickerId(null);
      const prompt =
        `Fix this user feedback (${item.type}):\n\n${item.description}` +
        (item.url ? `\n\nReported on: ${item.url}` : '') +
        `\n\n(feedback id: ${item.id})`;
      onSendToAgent?.(prompt, sessionId);
    },
    [onSendToAgent],
  );

  if (deploy === 'checking') {
    return <div style={{ padding: 24, color: 'var(--text-muted)', fontSize: 13 }}>Checking publish status…</div>;
  }
  if (deploy === 'undeployed') {
    return <ProdPublishGate what="feedback" onPublish={onPublish} />;
  }

  return (
    <div data-id="feedback-panel" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="panel-toolbar" style={{ gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>Feedback</span>
        <GitRepoSelector />
        <div style={{ flex: 1 }} />
        <button data-id="feedback-refresh" style={btn} onClick={load}>↻ Refresh</button>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: 12 }}>
        {loading ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading…</div>
        ) : items.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No feedback yet.</div>
        ) : (
          items.map((item) => (
            <div key={item.id} data-id="feedback-item" style={card}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={badge('rgba(255,255,255,0.08)', 'var(--text-secondary)')}>{item.type}</span>
                {statusBadge(item.status)}
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  {new Date(item.created).toLocaleString()}
                </span>
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-primary)', whiteSpace: 'pre-wrap' }}>
                {item.description}
              </div>
              {item.url && (
                <div style={{ fontSize: 11, color: 'var(--text-muted)', wordBreak: 'break-all' }}>{item.url}</div>
              )}
              {item.resolution && (
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', fontStyle: 'italic' }}>
                  Resolution: {item.resolution}
                </div>
              )}
              <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap', position: 'relative' }}>
                {item.status === 'new' && (
                  <>
                    <button
                      data-id="feedback-resolve"
                      style={{ ...btn, opacity: busyId === item.id ? 0.5 : 1 }}
                      disabled={busyId === item.id}
                      onClick={() => void resolve(item, 'resolved')}
                    >
                      {busyId === item.id ? '…' : '✓ Resolve'}
                    </button>
                    <button
                      data-id="feedback-decline"
                      style={{ ...btn, opacity: busyId === item.id ? 0.5 : 1 }}
                      disabled={busyId === item.id}
                      onClick={() => void resolve(item, 'declined')}
                    >
                      ✕ Decline
                    </button>
                  </>
                )}
                <button
                  data-id="feedback-send-agent"
                  style={btn}
                  onClick={() => { setPickerId(pickerId === item.id ? null : item.id); }}
                >
                  → Send to agent
                </button>
                {pickerId === item.id && (
                  <div
                    data-id="feedback-agent-picker"
                    style={{
                      position: 'absolute', top: '100%', left: 0, zIndex: 10, marginTop: 4,
                      minWidth: 200, maxHeight: 260, overflow: 'auto', background: 'var(--bg-panel)',
                      border: '1px solid var(--border)', borderRadius: 6, boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
                    }}
                  >
                    <button data-id="feedback-agent-new" style={pickerRow} onClick={() => { sendToAgent(item, null); }}>+ New session</button>
                    {sessions.map((s) => (
                      <button data-id="feedback-agent-session" key={s.compositeId} style={pickerRow} onClick={() => { sendToAgent(item, s.compositeId); }}>
                        {s.title || s.compositeId}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

const pickerRow: React.CSSProperties = {
  display: 'block', width: '100%', textAlign: 'left', padding: '7px 12px', fontSize: 12,
  background: 'transparent', border: 'none', borderBottom: '1px solid var(--border)',
  color: 'var(--text-primary)', cursor: 'pointer',
};
