import { useEffect, useState } from 'react';
import { DevProdToggle } from '../components/DevProdToggle';
import { useSocket } from '../hooks/useSocket';
import { useStudioUserSetting } from '../hooks/useStudioUserSetting';
import { useProdDeployGate } from '../hooks/useProdDeployGate';
import { ProdPublishGate } from './ProdPublishGate';

interface ErrorSummary {
  message: string;
  count: number;
  lastSeen: number;
  latestErrorId: string;
}

interface ErrorLogItem {
  id: string;
  created: number;
  userId: string | null;
  source: string;
  type: string;
  level: string;
  message: string;
  stack?: string;
  hash: string;
  isExpected: boolean;
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
  cursor: 'pointer',
};

export interface ErrorsPanelProps {
  /**
   * Pin source to prod + hide the toggle. Used by ProdView (live
   * data, read-only by definition).
   */
  forceProd?: boolean;
  /**
   * Pin source to dev + hide the toggle. Used by the session view
   * where every panel is scoped to the session's own dev stack.
   */
  forceDev?: boolean;
  /** Hide the panel header when rendered inside an outer tab bar. */
  hideHeader?: boolean;
  /** Route to the Publish tab (shown when prod errors are requested but the
   *  project was never deployed, so there's no prod error log yet). */
  onPublish?: () => void;
  /**
   * When rendered inside SessionLayout, this is the active session's
   * compositeId. The list query filters by it so the Errors tab shows
   * only errors captured while THIS session's dev app was running —
   * other sessions' errors stay in their own tabs.
   * Unset for the global Errors tab in the standalone Editor view.
   */
  studioSessionId?: string | null;
}

export function ErrorsPanel({
  forceProd,
  forceDev,
  hideHeader,
  studioSessionId,
  onPublish,
}: ErrorsPanelProps = {}) {
  const socket = useSocket();
  const [storedMode, setStoredMode] = useStudioUserSetting<'dev' | 'prod'>(
    'panel.errors.mode',
    'dev',
  );
  const mode: 'dev' | 'prod' = forceProd
    ? 'prod'
    : forceDev
    ? 'dev'
    : storedMode;
  const setMode = setStoredMode;
  const modePinned = Boolean(forceProd) || Boolean(forceDev);
  const [summary, setSummary] = useState<ErrorSummary[]>([]);
  const [errors, setErrors] = useState<ErrorLogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Prod errors live in the project's prod D1; a never-deployed project has none,
  // so gate on publish state and prompt to publish first instead of an empty list.
  const prodDeploy = useProdDeployGate(mode === 'prod');
  const gated = mode === 'prod' && prodDeploy !== 'deployed';

  const handleModeChange = (m: 'dev' | 'prod') => {
    if (modePinned) return;
    setMode(m);
  };

  useEffect(() => {
    if (gated) { setLoading(false); return; }
    setLoading(true);
    // When the panel is rendered inside a session, scope the list
    // query to that session's compositeId via studioSessionId.
    const sessionFilter = studioSessionId ? { studioSessionId } : {};
    Promise.all([
      socket.request('errorLogGetSummary', {}),
      socket.request('errorLogGetList', {
        limit: 50,
        ...sessionFilter,
      }),
    ])
      .then(([sRes, lRes]) => {
        setSummary(sRes.aggregations);
        setErrors(lRes.errors);
      })
      .catch((e: unknown) => { console.error('[ErrorsPanel]', e); })
      .finally(() => { setLoading(false); });
  }, [mode, studioSessionId, gated]);

  if (mode === 'prod' && prodDeploy === 'undeployed') {
    return <ProdPublishGate what="error log" onPublish={onPublish} />;
  }

  return (
    <div
      data-id="errors-panel"
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
            Errors
          </span>
          {!modePinned && (
            <DevProdToggle mode={mode} onModeChange={handleModeChange} />
          )}
        </div>
      )}
      <div
        style={{
          flex: 1,
          overflow: 'auto',
          padding: 12,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        {loading ? (
          <Loading />
        ) : (
          <>
            <Section title="Top Errors (grouped)" dataId="errors-summary">
              {summary.length === 0 ? (
                <Muted>No errors found</Muted>
              ) : (
                summary.map((s) => (
                  <div
                    key={s.latestErrorId}
                    data-id="error-summary-item"
                    style={{ ...card, cursor: 'default' }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                      }}
                    >
                      <span
                        style={{
                          fontSize: 12,
                          color: 'var(--text-primary)',
                          flex: 1,
                        }}
                      >
                        {s.message}
                      </span>
                      <div style={{ marginLeft: 12, textAlign: 'right' }}>
                        <span
                          style={{
                            fontSize: 12,
                            fontWeight: 600,
                            color: 'var(--error, #dc2626)',
                          }}
                        >
                          {s.count}x
                        </span>
                        <br />
                        <span
                          style={{
                            fontSize: 11,
                            color: 'var(--text-secondary)',
                          }}
                        >
                          {formatDate(s.lastSeen)}
                        </span>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </Section>
            <Section title="Recent Errors" dataId="errors-recent">
              {errors.length === 0 ? (
                <Muted>No recent errors</Muted>
              ) : (
                errors.map((e) => (
                  <div
                    key={e.id}
                    data-id="error-item"
                    style={card}
                    onClick={() =>
                      { setExpandedId(expandedId === e.id ? null : e.id); }
                    }
                  >
                    <div
                      style={{
                        display: 'flex',
                        gap: 8,
                        alignItems: 'center',
                        marginBottom: 6,
                      }}
                    >
                      <Badge
                        text={e.level}
                        color={
                          e.level === 'error'
                            ? 'var(--error, #dc2626)'
                            : e.level === 'warn'
                            ? 'var(--warning, #d97706)'
                            : 'var(--accent-primary, #3b82f6)'
                        }
                      />
                      <Badge text={e.source} color="var(--bg-tertiary, #333)" />
                      <span style={{ flex: 1 }} />
                      <span
                        style={{ fontSize: 11, color: 'var(--text-secondary)' }}
                      >
                        {formatDate(e.created)}
                      </span>
                    </div>
                    <div
                      style={{
                        fontSize: 12,
                        color: 'var(--text-primary)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        ...(expandedId !== e.id
                          ? {
                              display: '-webkit-box',
                              WebkitLineClamp: 2,
                              WebkitBoxOrient: 'vertical' as const,
                            }
                          : {}),
                      }}
                    >
                      {e.message}
                    </div>
                    {expandedId === e.id && e.stack && (
                      <div
                        className="us-fade-down"
                        style={{ margin: '8px 0 0' }}
                      >
                        <pre
                          style={{
                            margin: 0,
                            fontSize: 11,
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-all',
                            color: 'var(--text-primary)',
                            opacity: 0.8,
                            maxHeight: 300,
                            overflow: 'auto',
                            fontFamily: 'var(--font-mono, monospace)',
                            background: 'var(--bg-primary)',
                            border: '1px solid var(--border)',
                            borderRadius: 4,
                            padding: 8,
                          }}
                        >
                          {e.stack}
                        </pre>
                      </div>
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
  dataId,
}: {
  title: string;
  children: React.ReactNode;
  dataId?: string;
}) {
  return (
    <div
      data-id={dataId}
      style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
    >
      <span
        style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}
      >
        {title}
      </span>
      {children}
    </div>
  );
}

function Badge({ text, color }: { text: string; color: string }) {
  return (
    <span
      style={{
        background: color,
        padding: '2px 6px',
        borderRadius: 4,
        fontSize: 11,
        fontWeight: 600,
        color: '#fff',
      }}
    >
      {text}
    </span>
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
