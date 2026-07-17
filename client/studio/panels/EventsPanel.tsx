import { useEffect, useState } from 'react';
import { useSocket } from '../hooks/useSocket';
import { useProdDeployGate } from '../hooks/useProdDeployGate';
import { ProdDeployGate } from './ProdDeployGate';
import { GitRepoSelector } from './GitRepoSelector';

interface EventItem {
  id: string;
  eventName: string;
  userId: string | null;
  sessionId: string;
  created: number;
  properties: Record<string, unknown>;
}

function formatDate(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return new Date(ts).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

const card: React.CSSProperties = {
  padding: 12,
  background: 'var(--bg-secondary)',
  borderRadius: 4,
  border: '1px solid var(--border-primary)',
};

export interface EventsPanelProps {
  /** Hide the panel's own title bar when rendered inside an outer tab surface. */
  hideHeader?: boolean;
  /** Route to Deploy (shown when the project was never deployed — no prod events). */
  onDeploy?: () => void;
}

export function EventsPanel({ hideHeader, onDeploy }: EventsPanelProps = {}) {
  const socket = useSocket();
  const [topEvents, setTopEvents] = useState<
    { eventName: string; count: number }[]
  >([]);
  const [recentEvents, setRecentEvents] = useState<EventItem[]>([]);
  const [loading, setLoading] = useState(true);
  // Events live in the project's prod store — a never-deployed project has none,
  // so gate on publish state (mirrors Errors).
  const deploy = useProdDeployGate(true);

  useEffect(() => {
    if (deploy !== 'deployed') {
      setLoading(false);
      return;
    }
    setLoading(true);
    Promise.all([
      socket.request('eventTopEvents', { limit: 20 }),
      socket.request('eventList', { limit: 50 }),
    ])
      .then(([topRes, listRes]) => {
        setTopEvents(topRes.events);
        setRecentEvents(listRes.events);
      })
      .catch((e: unknown) => {
        console.error('[EventsPanel]', e);
      })
      .finally(() => {
        setLoading(false);
      });
  }, [deploy]);

  if (deploy === 'undeployed') {
    return <ProdDeployGate what="events" onDeploy={onDeploy} />;
  }

  return (
    <div
      data-id="events-panel"
      style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
    >
      {!hideHeader && (
        <div className="panel-toolbar">
          <span
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: 'var(--text-primary)',
            }}
          >
            Events
          </span>
          <GitRepoSelector />
        </div>
      )}
      <div
        style={{
          flex: 1,
          overflow: 'auto',
          padding: 12,
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
        }}
      >
        {loading ? (
          <Loading />
        ) : (
          <>
            <Section title="Top Events">
              {topEvents.length === 0 ? (
                <Muted>No events recorded</Muted>
              ) : (
                topEvents.map((e) => (
                  <div
                    key={e.eventName}
                    style={{
                      ...card,
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}
                  >
                    <span
                      style={{
                        fontSize: 12,
                        fontFamily: 'var(--font-mono, monospace)',
                        color: 'var(--text-primary)',
                      }}
                    >
                      {e.eventName}
                    </span>
                    <span
                      style={{
                        fontSize: 12,
                        fontWeight: 600,
                        color: 'var(--text-primary)',
                      }}
                    >
                      {e.count.toLocaleString()}x
                    </span>
                  </div>
                ))
              )}
            </Section>
            <Section title="Recent Events">
              {recentEvents.length === 0 ? (
                <Muted>No recent events</Muted>
              ) : (
                recentEvents.map((e) => (
                  <div
                    key={e.id}
                    style={{
                      ...card,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 4,
                    }}
                  >
                    <div
                      style={{ display: 'flex', gap: 8, alignItems: 'center' }}
                    >
                      <span
                        style={{
                          fontSize: 12,
                          fontFamily: 'var(--font-mono, monospace)',
                          color: 'var(--text-primary)',
                        }}
                      >
                        {e.eventName}
                      </span>
                      <span style={{ flex: 1 }} />
                      <span
                        style={{ fontSize: 11, color: 'var(--text-secondary)' }}
                      >
                        {formatDate(e.created)}
                      </span>
                    </div>
                    {e.userId && (
                      <span
                        style={{ fontSize: 11, color: 'var(--text-secondary)' }}
                      >
                        User: {e.userId}
                      </span>
                    )}
                  </div>
                ))
              )}
            </Section>
          </>
        )}
      </div>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span
        style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}
      >
        {title}
      </span>
      {children}
    </div>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
      {children}
    </span>
  );
}

function Loading() {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'center',
        padding: 24,
        color: 'var(--text-secondary)',
        fontSize: 12,
      }}
    >
      Loading...
    </div>
  );
}
