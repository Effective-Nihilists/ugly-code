import React from 'react';

/**
 * Large "tile" presentation of a session, used on the Project Home
 * screen. Matches the ugly-studio brand: square edges, orange accent
 * only on running state, Plus Jakarta Sans for the title, monospace
 * for metadata.
 */

export interface SessionCardData {
  compositeId: string;
  title: string;
  /** Short one-line preview of the agent's latest action. */
  activity?: string;
  /** Relative time-ago string. */
  time: string;
  /** True while the agent is mid-turn. */
  running: boolean;
  /**
   * True when the session is stuck waiting on a user answer
   * (permission prompt or ask_user). Overrides the running
   * indicator with a BLOCKED pill.
   */
  blocked?: boolean;
}

export interface SessionCardProps {
  session: SessionCardData;
  onClick(): void;
}

export function SessionCard({
  session,
  onClick,
}: SessionCardProps): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: '22px 24px 20px 24px',
        // Fixed height (not min-height) so every card in the grid is
        // visually identical regardless of activity-line length. Grid
        // row is `1fr` but each card opts out of the row stretch by
        // locking to this height — matches the mockup's bordered
        // tiles sharing one aspect.
        height: 170,
        boxSizing: 'border-box',
        background: session.running ? 'var(--bg-secondary)' : 'var(--bg-panel)',
        border: 'none',
        borderRight: '1px solid var(--border)',
        borderBottom: '1px solid var(--border)',
        cursor: 'pointer',
        textAlign: 'left',
        color: 'inherit',
        font: 'inherit',
        overflow: 'hidden',
        transition: 'background 160ms ease',
        flex: 1,
        minWidth: 0,
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background =
          'var(--bg-secondary)';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background =
          session.running ? 'var(--bg-secondary)' : 'var(--bg-panel)';
      }}
    >
      {session.running && (
        <>
          <span
            style={{
              position: 'absolute',
              inset: '0 0 auto 0',
              height: 2,
              background:
                'linear-gradient(135deg, #FF8041 0%, #FF5500 50%, #E63900 100%)',
            }}
          />
          <span
            style={{
              position: 'absolute',
              top: '-40%',
              left: '-20%',
              width: '60%',
              height: '100%',
              background:
                'radial-gradient(ellipse at center, rgba(255,85,0,0.14) 0%, transparent 60%)',
              pointerEvents: 'none',
            }}
          />
        </>
      )}

      <div
        style={{
          position: 'relative',
          display: 'flex',
          alignItems: 'flex-start',
          gap: 12,
        }}
      >
        <div
          style={{
            fontFamily: 'var(--font-heading)',
            fontWeight: 700,
            fontSize: 17,
            color: 'var(--text-primary)',
            letterSpacing: '-0.02em',
            lineHeight: 1.25,
            flex: 1,
            minWidth: 0,
            // Clamp to 2 lines — longer titles render with an ellipsis.
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            // Reserve space for the hover-revealed archive button so
            // the title doesn't shift when it appears.
            paddingRight: 28,
          }}
        >
          {session.title}
        </div>
      </div>

      <div
        style={{
          flex: 1,
          fontSize: 13,
          color: 'var(--text-secondary)',
          lineHeight: 1.55,
          position: 'relative',
          minWidth: 0,
          // Single-line ellipsis for the activity summary so cards
          // stay visually consistent regardless of message length.
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {session.activity ?? 'Idle'}
      </div>

      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          paddingTop: 12,
          borderTop: '1px solid var(--border)',
          fontFamily: '"JetBrains Mono", monospace',
          fontSize: 11,
          color: 'var(--text-muted)',
          position: 'relative',
        }}
      >
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            fontWeight: 600,
          }}
        >
          {session.blocked ? (
            <>
              <BlockedDot />
              <span style={{ color: 'var(--warning, #f5a623)' }}>blocked</span>
            </>
          ) : (
            <>
              <StatusDot running={session.running} />
              <span
                style={{
                  color: session.running ? '#FF5500' : 'var(--text-secondary)',
                }}
              >
                {session.running ? 'thinking' : 'idle'}
              </span>
            </>
          )}
        </span>
        <span>{session.time}</span>
      </div>
    </button>
  );
}

/**
 * Blocked-state indicator: amber filled dot with a soft pulse so the
 * user notices the session needs them without a frantic red.
 */
function BlockedDot(): React.ReactElement {
  return (
    <span
      style={{
        position: 'relative',
        width: 8,
        height: 8,
        background: 'var(--warning, #f5a623)',
        flexShrink: 0,
        boxShadow: '0 0 12px var(--warning, #f5a623)',
        borderRadius: '50%',
      }}
      aria-label="Session is blocked"
    >
      <span
        style={{
          position: 'absolute',
          inset: -5,
          borderRadius: '50%',
          border: '1.5px solid var(--warning, #f5a623)',
          opacity: 0.5,
          animation:
            'ugly-pulse-ring 1.6s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        }}
      />
    </span>
  );
}

export function StatusDot({
  running,
}: {
  running: boolean;
}): React.ReactElement {
  return (
    <span
      style={{
        position: 'relative',
        width: 8,
        height: 8,
        background: running ? '#FF5500' : '#00E28A',
        flexShrink: 0,
        boxShadow: running ? '0 0 12px #FF5500' : 'none',
      }}
    >
      {running && (
        <span
          style={{
            position: 'absolute',
            inset: -5,
            border: '1.5px solid #FF5500',
            opacity: 0.5,
            animation:
              'ugly-pulse-ring 1.4s cubic-bezier(0.4, 0, 0.6, 1) infinite',
          }}
        />
      )}
    </span>
  );
}
