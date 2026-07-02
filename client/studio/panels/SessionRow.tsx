import React from 'react';
import { StatusDot } from './SessionCard';

/**
 * Compact vertical-list presentation of a session, used in the
 * Session view's left sidebar. Matches the same brand language as
 * SessionCard but denser — single line title + monospace metadata.
 *
 * Per spec, active sessions expose ONLY an archive action, no
 * delete. Deletion lives on the archived-row surface (see
 * ProjectHome's archived drawer). Hover reveals a small archive
 * button in the row's top-right.
 */

export interface SessionRowData {
  compositeId: string;
  title: string;
  time: string;
  running: boolean;
  /**
   * True when the session is waiting on a user answer (permission
   * prompt or ask_user). Takes priority over `running` in the
   * status pill — a blocked session isn't really "thinking," it's
   * stuck until the user unsticks it.
   */
  blocked?: boolean;
  /**
   * Short human-readable reason for the BLOCKED pill — e.g. "Waiting
   * for permission" / "Agent is asking a question". Rendered as the
   * pill's tooltip so the user can tell what the agent is waiting on
   * without opening the session. Optional; falls back to a generic
   * "Session is blocked" tooltip when missing.
   */
  blockedReason?: string;
  /**
   * True when the row represents an in-flight session creation. Shows
   * a CREATING pill with a spinner ring in place of the
   * thinking/idle/blocked status.
   */
  creating?: boolean;
  /** Archived sessions render dimmer. */
  archived?: boolean;
  /** Display model — `'auto'` for auto-mode sessions. */
  model: string;
  /** Cumulative token usage from in-memory `info`. */
  totalTokens: number;
  /** Cumulative USD cost from in-memory `info`. */
  totalCost: number;
}

export interface SessionRowProps {
  session: SessionRowData;
  active: boolean;
  onClick: () => void;
  /** Optional — when set, hover shows an archive button. */
  onArchive?: () => void;
  /**
   * When true, render a slim single-line variant (no `thinking/idle`
   * + token/cost meta rows). Used for max-mode peer rows under their
   * parent — peers are auxiliary to the orchestrator, so the sidebar
   * de-emphasizes them visually.
   */
  compact?: boolean;
  /**
   * True while this session has a teardown in flight (see
   * [useSessionDeletion]). Dim the row, swap the archive button for
   * a "Deleting…" badge, and disable click — the row will disappear
   * once the next poll lands. Set by the parent list.
   */
  deleting?: boolean;
}

export function SessionRow({
  session,
  active,
  onClick,
  onArchive,
  compact,
  deleting = false,
}: SessionRowProps): React.ReactElement {
  // Hover styling is delegated to CSS `:hover` (see the global
  // `.us-session-row` rules in SessionListSidebar). React-tracked
  // hover state was buggy across list mutations: when the active row
  // was archived, the row that slid under the cursor never received a
  // synthetic `mouseenter`, so it rendered un-hovered (no archive
  // button, no highlight) until the user moved the mouse.
  return (
    <div
      role="button"
      tabIndex={deleting ? -1 : 0}
      onClick={deleting ? undefined : onClick}
      onKeyDown={(e) => {
        if (deleting) return;
        if (e.key === 'Enter' || e.key === ' ') onClick();
      }}
      data-id={`session-row-${session.compositeId}`}
      data-active={active ? 'true' : 'false'}
      aria-disabled={deleting || undefined}
      className="us-session-row"
      style={{
        position: 'relative',
        padding: compact ? '4px 14px 4px 16px' : '12px 14px 12px 16px',
        cursor: deleting ? 'default' : 'pointer',
        display: 'flex',
        flexDirection: 'column',
        gap: compact ? 0 : 4,
        opacity: deleting ? 0.5 : session.archived ? 0.55 : 1,
        transition: 'background 120ms ease, opacity 120ms ease',
      }}
    >
      {active && (
        <span
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: 3,
            background: 'var(--accent)',
            boxShadow: '0 0 12px var(--accent)',
            pointerEvents: 'none',
          }}
        />
      )}

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          minWidth: 0,
        }}
      >
        <div
          style={{
            flex: 1,
            minWidth: 0,
            fontFamily: compact ? 'var(--font-mono)' : 'var(--font-heading)',
            fontSize: compact ? 11 : 13,
            fontWeight: compact ? 500 : 700,
            color: compact ? 'var(--text-secondary)' : 'var(--text-primary)',
            lineHeight: compact ? 1.4 : 1.3,
            letterSpacing: compact ? 0 : '-0.01em',
            // Compact rows stay single-line (inline summary contexts);
            // the main sidebar list clamps to 2 lines so long titles
            // (model id + prompt prefix) stay readable.
            ...(compact
              ? {
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }
              : {
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical',
                  overflow: 'hidden',
                  wordBreak: 'break-word',
                }),
            ...(compact && {
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }),
          }}
        >
          {compact && <StatusDot running={session.running} />}
          {session.title}
        </div>
        {deleting ? (
          <span
            className="us-pulse-soft"
            style={{
              fontFamily: 'var(--font-label)',
              fontSize: 9.5,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              fontWeight: 700,
              color: 'var(--text-muted)',
              flexShrink: 0,
            }}
          >
            Deleting…
          </span>
        ) : (
          onArchive && (
            <button
              data-id="session-row-archive"
              type="button"
              title="Archive session"
              aria-label="Archive session"
              className="us-session-row-archive"
              onClick={(e) => {
                e.stopPropagation();
                onArchive();
              }}
              style={{
                width: 22,
                height: 22,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--text-muted)',
                background: 'transparent',
                border: '1px solid transparent',
                cursor: 'pointer',
                flexShrink: 0,
                padding: 0,
                // Default hidden; the row's `:hover` rule flips opacity
                // and pointer-events on. Keeping the button mounted (not
                // conditionally rendered) reserves the slot so the
                // title never reflows when the icon appears.
                opacity: 0,
                pointerEvents: 'none',
                transition: 'opacity 120ms ease',
              }}
            >
              <ArchiveIcon />
            </button>
          )
        )}
      </div>

      {!compact && (
        <>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              fontFamily: '"JetBrains Mono", monospace',
              fontSize: 10.5,
              color: 'var(--text-muted)',
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
            }}
          >
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                fontWeight: 600,
              }}
            >
              {session.creating ? (
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    minWidth: 0,
                  }}
                  title="Session is being provisioned"
                >
                  <span
                    aria-hidden
                    className="us-spin"
                    style={{
                      width: 9,
                      height: 9,
                      borderRadius: '50%',
                      border: '1.5px solid var(--border)',
                      borderTopColor: 'var(--accent)',
                      flexShrink: 0,
                    }}
                  />
                  <span style={{ color: 'var(--accent)' }}>creating</span>
                </span>
              ) : session.blocked ? (
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    minWidth: 0,
                  }}
                  title={session.blockedReason ?? 'Session is blocked'}
                >
                  <BlockedDot />
                  <span style={{ color: 'var(--warning, #f5a623)' }}>
                    blocked
                  </span>
                </span>
              ) : (
                <>
                  <StatusDot running={session.running} />
                  <span
                    style={{
                      color: session.running ? 'var(--accent)' : undefined,
                    }}
                  >
                    {session.running ? 'thinking' : 'idle'}
                  </span>
                </>
              )}
            </span>
            <span>{session.time}</span>
          </div>

          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              fontFamily: '"JetBrains Mono", monospace',
              fontSize: 10,
              color: 'var(--text-muted)',
              letterSpacing: '0.06em',
              gap: 8,
              minWidth: 0,
            }}
          >
            <span
              style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                minWidth: 0,
              }}
              title={session.model}
            >
              {formatModel(session.model)}
            </span>
            <span style={{ flexShrink: 0 }}>
              {session.totalTokens > 0
                ? `${formatTokens(session.totalTokens)} · ${formatCost(
                    session.totalCost,
                  )}`
                : '—'}
            </span>
          </div>
        </>
      )}
    </div>
  );
}

function formatModel(id: string): string {
  if (id === 'auto') return 'Auto';
  return id;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatCost(n: number): string {
  if (n < 0.01) return '$0.00';
  if (n < 10) return `$${n.toFixed(2)}`;
  if (n < 1_000) return `$${n.toFixed(1)}`;
  return `$${Math.round(n)}`;
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
        boxShadow: '0 0 10px var(--warning, #f5a623)',
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

function ArchiveIcon(): React.ReactElement {
  return (
    <svg
      viewBox="0 0 24 24"
      width={12}
      height={12}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="21 8 21 21 3 21 3 8" />
      <rect x={1} y={3} width={22} height={5} />
      <line x1={10} y1={12} x2={14} y2={12} />
    </svg>
  );
}
