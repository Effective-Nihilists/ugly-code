import React from 'react';
import { useSessionDeletion } from '../hooks/useSessionDeletion';
import { bootMark } from '../utils/startupTiming';
import { SessionRow } from './SessionRow';

/**
 * Duration of the row enter/leave animation in ms. Kept in sync with
 * the keyframes injected below.
 */
const ROW_TRANSITION_MS = 200;

/**
 * Maintains a render list that lags the source list during exits so
 * removed entries can play a leave animation before they unmount.
 *
 * - Items present in `items` render with `phase === 'visible'`.
 * - Items absent from `items` keep rendering with `phase === 'leaving'`
 *   for `duration` ms (long enough for the CSS leave animation), then
 *   are dropped.
 * - Newly added items enter as `phase === 'visible'` with a CSS enter
 *   animation triggered by mount; no special bookkeeping needed.
 *
 * Order matches `items`. Leaving entries are slotted back in at the
 * index they previously occupied so neighbours don't suddenly shift.
 */
function useTransitionList<T extends { compositeId: string }>(
  items: ReadonlyArray<T>,
  duration: number,
  staggerMs = 50,
  baseDelayMs = 0,
): Array<{ item: T; phase: 'visible' | 'leaving'; delayMs: number }> {
  type Entry = {
    item: T;
    phase: 'visible' | 'leaving';
    /** Per-row enter-animation delay. > 0 only on the first non-empty
     *  batch so the initial list cascades; subsequent adds use 0
     *  (single new row animating with a stagger delay would feel
     *  laggy). */
    delayMs: number;
  };
  // True until the first non-empty batch lands. After that, every new
  // entry enters with `delayMs: 0` so add/remove deltas play instantly.
  const isFirstBatchRef = React.useRef<boolean>(items.length === 0);
  const [entries, setEntries] = React.useState<Entry[]>(() => {
    if (items.length === 0) return [];
    isFirstBatchRef.current = false;
    return items.map((item, idx) => ({
      item,
      phase: 'visible' as const,
      delayMs: baseDelayMs + idx * staggerMs,
    }));
  });

  React.useEffect(() => {
    setEntries((prev) => {
      const incomingIds = new Set(items.map((i) => i.compositeId));
      const prevDelayById = new Map<string, number>();
      prev.forEach((e) => prevDelayById.set(e.item.compositeId, e.delayMs));

      const firstBatch =
        isFirstBatchRef.current && items.length > 0 && prev.length === 0;
      if (firstBatch) isFirstBatchRef.current = false;

      // Build the new visible run from `items`, picking up the latest
      // data for each id. Carry forward delays for existing rows so a
      // poll refresh doesn't restart the stagger; brand-new rows get
      // 0 (subsequent additions shouldn't stagger).
      const visible: Entry[] = items.map((item, idx) => {
        const carried = prevDelayById.get(item.compositeId);
        const delayMs = firstBatch
          ? baseDelayMs + idx * staggerMs
          : carried !== undefined
          ? carried
          : 0;
        return { item, phase: 'visible' as const, delayMs };
      });

      // Collect entries that are exiting (were visible, now gone) and
      // entries already mid-leave (carry them forward).
      const leaving: Array<{ entry: Entry; prevIdx: number }> = [];
      prev.forEach((e, idx) => {
        if (e.phase === 'leaving') {
          if (!incomingIds.has(e.item.compositeId)) {
            leaving.push({ entry: e, prevIdx: idx });
          }
          return;
        }
        if (!incomingIds.has(e.item.compositeId)) {
          leaving.push({
            entry: { item: e.item, phase: 'leaving', delayMs: 0 },
            prevIdx: idx,
          });
        }
      });

      if (leaving.length === 0) return visible;

      // Splice leaving entries back in at their prior position,
      // measured against the surviving prior entries (i.e. ignore the
      // already-leaving ones when computing the insertion index).
      const survivorPrevIdxs = prev
        .map((e, idx) => ({ idx, id: e.item.compositeId }))
        .filter(({ id }) => incomingIds.has(id))
        .sort((a, b) => a.idx - b.idx);

      const result = [...visible];
      // Sort leaving entries by their prevIdx ascending so insertions
      // are stable.
      leaving.sort((a, b) => a.prevIdx - b.prevIdx);
      for (const { entry, prevIdx } of leaving) {
        // Find how many surviving prior entries had a prevIdx less
        // than this leaving entry's — that's where we splice.
        let insertAt = 0;
        for (const s of survivorPrevIdxs) {
          if (s.idx < prevIdx) insertAt += 1;
          else break;
        }
        if (insertAt > result.length) insertAt = result.length;
        result.splice(insertAt, 0, entry);
      }
      return result;
    });
  }, [items, staggerMs, baseDelayMs]);

  // Sweep up leaving entries after the animation has played.
  React.useEffect(() => {
    const hasLeaving = entries.some((e) => e.phase === 'leaving');
    if (!hasLeaving) return;
    const t = setTimeout(() => {
      setEntries((curr) => curr.filter((e) => e.phase !== 'leaving'));
    }, duration);
    return () => clearTimeout(t);
  }, [entries, duration]);

  return entries;
}

/**
 * Per-row wrapper that owns the enter/leave animation. Keyed by
 * compositeId so React reuses the wrapper across re-renders, which
 * lets the leave animation actually play before unmount.
 */
function AnimatedRow({
  leaving,
  isChild,
  delayMs,
  children,
}: {
  leaving: boolean;
  isChild: boolean;
  delayMs: number;
  children: React.ReactNode;
}): React.ReactElement {
  // animationDelay is only honored on the enter keyframe; leaving
  // entries always start their exit immediately.
  const style: React.CSSProperties = {
    ...(isChild ? { paddingLeft: 16 } : {}),
    ...(!leaving && delayMs > 0 ? { animationDelay: `${delayMs}ms` } : {}),
  };
  return (
    <div
      className={`us-session-row-wrap${
        leaving ? ' us-session-row-wrap-leaving' : ''
      }`}
      style={style}
    >
      {children}
    </div>
  );
}

/**
 * Left-rail vertical list of sessions, rendered in the Session view
 * (and in the shared Prod / Git shells). Compact — each row is a
 * `SessionRow`. The top of the rail hosts a full-width "+ New session"
 * action (toolbar-height gradient button) that forks a fresh spec-mode
 * session.
 *
 * Active sessions expose ONLY an archive action (hover-revealed on
 * each row). Deletion happens in the archived drawer on Project
 * Home — not here.
 *
 * When `footerNav` is set, a pinned footer with Prod / Git shortcuts
 * is rendered at the bottom. Used to mirror the nav in the Session,
 * Prod, and Git shells — one consistent rail across views.
 */

export interface SessionListSidebarSession {
  compositeId: string;
  title: string;
  updated_at: number;
  running: boolean;
  /** True when the session is stuck on a pending user answer. */
  blocked?: boolean;
  /** Tooltip explaining what the session is blocked on. */
  blockedReason?: string;
  /**
   * True when this row represents an in-flight `codingAgentChatCreate`
   * RPC (a pending session, not yet provisioned). The row renders a
   * "CREATING…" pill in place of the usual thinking/idle indicator
   * and skips the archive button on hover — closing happens via the
   * inline Stop/Close buttons on the center pane.
   */
  creating?: boolean;
  /** Display model — `'auto'` for auto-mode sessions. */
  model: string;
  /** Cumulative token usage from in-memory `info`. */
  totalTokens: number;
  /** Cumulative USD cost from in-memory `info`. */
  totalCost: number;
  /**
   * Parent orchestrator's compositeId when this session is a max-mode
   * peer. Causes the row to render indented under its parent.
   */
  parentSessionId?: string;
  /**
   * Discriminator for the always-present "main" session per project.
   * `'main'` runs on the parent branch with no worktree and is the
   * canonical surface for git push/pull. Rendered in a separate
   * "Repository" pane above the regular session list.
   */
  kind?: 'main';
}

/** One button in the sidebar footer nav (the prod-scoped views live here). */
export interface SidebarNavItem {
  id: string;
  label: string;
  icon: React.ReactNode;
  active: boolean;
  disabled?: boolean;
  badgeCount?: number;
  onClick(): void;
}

export interface SessionListSidebarProps {
  sessions: SessionListSidebarSession[];
  activeCompositeId: string | null;
  onSelect(compositeId: string): void;
  onNewSession(): void;
  onArchiveSession(compositeId: string): void;
  timeAgo(ts: number): string;
  footerNav?: SidebarNavItem[];
  /**
   * Current branch of the project root, displayed in the Repository
   * row's title (`main · <branch>`). Optional — if absent, the row
   * just shows "main".
   */
  repoBranch?: string;
  /**
   * Reset the project's main session — archives the current main
   * (lazy replacement: a fresh main is provisioned on next access).
   * Hidden when undefined.
   */
  onResetMainSession?(compositeId: string): void;
  /**
   * Count of archived sessions for this project. When > 0, an
   * "Archived (N)" pill appears above the footer nav; clicking it
   * fires `onShowArchived` which opens the ArchivedSessionsModal.
   */
  archivedCount?: number;
  onShowArchived?(): void;
  /**
   * The per-session views (Agent/Preview/File/Git/Database). Rendered as an
   * indented sub-list directly beneath the active session row — collapsed for
   * all other sessions. Each item's `active`/`onClick` drive the open view.
   */
  sessionViews?: SidebarNavItem[];
}

export function SessionListSidebar({
  sessions,
  activeCompositeId,
  onSelect,
  onNewSession,
  onArchiveSession,
  timeAgo,
  footerNav,
  repoBranch,
  onResetMainSession,
  archivedCount,
  onShowArchived,
  sessionViews,
}: SessionListSidebarProps): React.ReactElement {
  const sidebarMountLoggedRef = React.useRef(false);
  if (!sidebarMountLoggedRef.current) {
    sidebarMountLoggedRef.current = true;
    bootMark('sidebar:mount', { sessionCount: sessions.length });
  }
  const firstRowLoggedRef = React.useRef(false);
  if (!firstRowLoggedRef.current && sessions.length > 0) {
    firstRowLoggedRef.current = true;
    bootMark('sidebar:first-session-data', { count: sessions.length });
  }
  // Split "main" session into the Repository pane; the regular session
  // list is everything else. Server enforces at most one active main
  // session per project; we still take the first defensively.
  const mainSession = sessions.find((s) => s.kind === 'main') ?? null;
  const regularSessions = sessions.filter((s) => s.kind !== 'main');
  return (
    <aside
      data-id="session-list-sidebar"
      data-session-count={sessions.length}
      style={{
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg-primary)',
        borderRight: '1px solid var(--border)',
        minHeight: 0,
        width: '100%',
      }}
    >
      <SessionListStyles />
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div
          style={{
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: 10.5,
            letterSpacing: '0.2em',
            textTransform: 'uppercase',
            color: 'var(--text-muted)',
            height: 36,
            padding: '0 16px',
            boxSizing: 'border-box',
            borderBottom: '1px solid var(--border)',
            flexShrink: 0,
            fontWeight: 700,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <span>Sessions</span>
          {/* Count includes the always-present main session, so it
              never reads 00. */}
          <span style={{ color: 'var(--text-secondary)' }}>
            {String(sessions.length).padStart(2, '0')}
          </span>
        </div>
        {mainSession && (
          // The repo / no-worktree "main" session is always present and
          // is always the first row, directly under the Sessions header.
          <React.Fragment>
            <RepositoryRow
              session={mainSession}
              branch={repoBranch}
              active={mainSession.compositeId === activeCompositeId}
              onClick={() => onSelect(mainSession.compositeId)}
              {...(onResetMainSession
                ? { onReset: () => onResetMainSession(mainSession.compositeId) }
                : {})}
            />
            {sessionViews && mainSession.compositeId === activeCompositeId && (
              <SessionSubNav items={sessionViews} />
            )}
          </React.Fragment>
        )}
        <SessionRowList
          regularSessions={regularSessions}
          activeCompositeId={activeCompositeId}
          onSelect={onSelect}
          onArchiveSession={onArchiveSession}
          timeAgo={timeAgo}
          {...(sessionViews ? { sessionViews } : {})}
        />
        {/* "+ New session" sits directly below the last session row —
            a quiet, low-key action, not a prominent CTA. */}
        <button
          type="button"
          onClick={onNewSession}
          style={{
            width: '100%',
            height: 26,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'flex-start',
            gap: 6,
            padding: '0 12px',
            background: 'transparent',
            color: 'var(--text-muted)',
            fontFamily: 'var(--font-heading)',
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: '0.04em',
            border: 'none',
            cursor: 'pointer',
            flexShrink: 0,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = 'var(--text-primary)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = 'var(--text-muted)';
          }}
        >
          + New session
        </button>
      </div>
      {(archivedCount ?? 0) > 0 && onShowArchived && (
        <button
          type="button"
          data-id="sidebar-show-archived"
          onClick={onShowArchived}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            padding: '8px 16px',
            background: 'transparent',
            border: 'none',
            borderTop: '1px solid var(--border)',
            color: 'var(--text-secondary)',
            cursor: 'pointer',
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            flexShrink: 0,
            textAlign: 'left',
          }}
        >
          <span
            style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
          >
            <ArchiveIcon />
            Archived
          </span>
          <span style={{ color: 'var(--text-muted)' }}>
            {String(archivedCount).padStart(2, '0')}
          </span>
        </button>
      )}
      {footerNav && footerNav.length > 0 && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            borderTop: '1px solid var(--border)',
            flexShrink: 0,
            background: 'var(--bg-primary)',
          }}
        >
          {footerNav.map((item, i) => (
            <SidebarFooterButton
              key={item.id}
              label={item.label}
              active={item.active}
              {...(item.disabled ? { disabled: true } : {})}
              onClick={item.onClick}
              icon={item.icon}
              {...(item.badgeCount != null ? { badgeCount: item.badgeCount } : {})}
              {...(i < footerNav.length - 1 ? { divider: true } : {})}
            />
          ))}
        </div>
      )}
    </aside>
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

function RepositoryRow({
  session,
  branch,
  active,
  onClick,
  onReset,
}: {
  session: SessionListSidebarSession;
  branch?: string;
  active: boolean;
  onClick(): void;
  onReset?(): void;
}): React.ReactElement {
  const [hovered, setHovered] = React.useState(false);
  // Cyan stays on the REPO badge as a brand identifier (so the row
  // still reads as a distinct *kind* of session) — but the active
  // selection bar uses the same orange accent as SessionRow + the
  // Prod/Git/Terminal nav buttons so "this is the selected surface"
  // reads consistently across the whole sidebar.
  const labelAccent = '#22D3EE';
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onClick();
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: 'relative',
        padding: '12px 14px 12px 16px',
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        background: active
          ? 'var(--bg-secondary)'
          : hovered
          ? 'var(--bg-panel)'
          : 'transparent',
        transition: 'background 120ms ease',
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
            fontFamily: 'var(--font-heading)',
            fontSize: 13,
            fontWeight: 700,
            color: 'var(--text-primary)',
            lineHeight: 1.3,
            letterSpacing: '-0.01em',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <span
            style={{
              fontSize: 9,
              fontWeight: 800,
              letterSpacing: '0.16em',
              padding: '1px 5px',
              borderRadius: 3,
              background: labelAccent,
              color: '#04161a',
              flexShrink: 0,
            }}
          >
            REPO
          </span>
          <span
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            main{branch ? ` · ${branch}` : ''}
          </span>
        </div>
        {onReset && (
          <button
            type="button"
            title="Archive this session and start a fresh one. The repository session always exists."
            aria-label="Reset main session"
            onClick={(e) => {
              e.stopPropagation();
              onReset();
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
              // Always reserve the slot — only opacity toggles on
              // hover so the title never reflows when the icon shows.
              opacity: hovered ? 1 : 0,
              pointerEvents: hovered ? 'auto' : 'none',
              transition: 'opacity 120ms ease',
            }}
          >
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
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15A9 9 0 1 1 18 6.36L23 10" />
            </svg>
          </button>
        )}
      </div>

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
          {session.running ? (
            <>
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: labelAccent,
                  flexShrink: 0,
                  boxShadow: `0 0 8px ${labelAccent}`,
                }}
              />
              <span style={{ color: labelAccent }}>thinking</span>
            </>
          ) : (
            <span>push / pull</span>
          )}
        </span>
      </div>
    </div>
  );
}

function SidebarFooterButton({
  label,
  active,
  disabled,
  onClick,
  divider,
  icon,
  badgeCount,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick(): void;
  divider?: boolean;
  icon: React.ReactNode;
  /** Optional accent-colored count shown after the label. Right-aligned
   *  via a flex spacer. Hidden when 0 / undefined. */
  badgeCount?: number;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        height: 36,
        padding: '0 16px',
        border: 'none',
        borderBottom: divider ? '1px solid var(--border)' : 'none',
        background: active ? 'var(--accent-dim)' : 'transparent',
        color: disabled
          ? 'var(--text-muted)'
          : active
          ? 'var(--accent)'
          : 'var(--text-secondary)',
        fontFamily: '"JetBrains Mono", monospace',
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        textAlign: 'left',
      }}
    >
      {active && (
        // Same orange selection bar that SessionRow + RepositoryRow
        // use — keeps "this is the active surface" reading
        // consistent across every clickable entry in the sidebar.
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
      <span
        style={{
          display: 'inline-flex',
          width: 14,
          height: 14,
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        {icon}
      </span>
      <span style={{ flex: 1 }}>{label}</span>
      {badgeCount != null && badgeCount > 0 && (
        <span
          style={{
            color: 'var(--accent)',
            fontSize: 10.5,
            fontWeight: 700,
            letterSpacing: '0.08em',
          }}
        >
          {badgeCount} changed
        </span>
      )}
    </button>
  );
}

/**
 * The per-session view sub-nav (Agent/Preview/File/Git/Database), rendered
 * indented directly under the active session row. Mirrors the orange-accent
 * active treatment used by SessionRow / SidebarFooterButton so the selected view
 * reads consistently with the rest of the rail.
 */
function SessionSubNav({ items }: { items: SidebarNavItem[] }): React.ReactElement {
  return (
    <div
      data-id="session-subnav"
      style={{
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg-secondary)',
        borderBottom: '1px solid var(--border)',
      }}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          data-id={`session-view-${item.id}`}
          aria-pressed={item.active}
          onClick={item.onClick}
          style={{
            position: 'relative',
            display: 'flex',
            alignItems: 'center',
            gap: 9,
            height: 30,
            padding: '0 14px 0 28px',
            border: 'none',
            background: item.active ? 'var(--accent-dim)' : 'transparent',
            color: item.active ? 'var(--accent)' : 'var(--text-secondary)',
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: 11.5,
            fontWeight: 600,
            letterSpacing: '0.04em',
            cursor: 'pointer',
            textAlign: 'left',
          }}
          onMouseEnter={(e) => {
            if (!item.active) e.currentTarget.style.color = 'var(--text-primary)';
          }}
          onMouseLeave={(e) => {
            if (!item.active) e.currentTarget.style.color = 'var(--text-secondary)';
          }}
        >
          {item.active && (
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
          <span
            style={{
              display: 'inline-flex',
              width: 14,
              height: 14,
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            {item.icon}
          </span>
          <span style={{ flex: 1 }}>{item.label}</span>
        </button>
      ))}
    </div>
  );
}




/**
 * Renders the regular-session rows with enter/leave animations and
 * peer grouping. Pulled into a child component so the
 * `useTransitionList` hook is scoped to this list (and not the whole
 * sidebar, which would re-run on unrelated sidebar state changes).
 */
function SessionRowList({
  regularSessions,
  activeCompositeId,
  onSelect,
  onArchiveSession,
  timeAgo,
  sessionViews,
}: {
  regularSessions: SessionListSidebarSession[];
  activeCompositeId: string | null;
  onSelect(compositeId: string): void;
  onArchiveSession(compositeId: string): void;
  timeAgo(ts: number): string;
  sessionViews?: SidebarNavItem[];
}): React.ReactElement {
  // Build the rendered order (parents with peers indented underneath)
  // BEFORE running it through the transition list, so leave animations
  // see the same ordering the user just saw.
  const ordered = React.useMemo(() => {
    const childrenByParent = new Map<string, SessionListSidebarSession[]>();
    for (const s of regularSessions) {
      if (!s.parentSessionId) continue;
      const list = childrenByParent.get(s.parentSessionId) ?? [];
      list.push(s);
      childrenByParent.set(s.parentSessionId, list);
    }
    const visibleParentIds = new Set(regularSessions.map((s) => s.compositeId));
    const out: Array<{ s: SessionListSidebarSession; isChild: boolean }> = [];
    for (const s of regularSessions) {
      if (s.parentSessionId && visibleParentIds.has(s.parentSessionId)) {
        continue;
      }
      out.push({ s, isChild: false });
      const kids = childrenByParent.get(s.compositeId);
      if (kids) {
        // Peers sort alphabetically by model id (stable across turns)
        // — most-recent-update ordering would shuffle them every time
        // one peer streams a chunk.
        const sorted = [...kids].sort((a, b) => a.model.localeCompare(b.model));
        for (const k of sorted) out.push({ s: k, isChild: true });
      }
    }
    return out;
  }, [regularSessions]);

  // Map to a uniform shape for useTransitionList (it keys on
  // compositeId), preserving the isChild flag inside the item.
  const flat = React.useMemo(
    () =>
      ordered.map((o) => ({
        compositeId: o.s.compositeId,
        s: o.s,
        isChild: o.isChild,
      })),
    [ordered],
  );

  // First-batch stagger: rows cascade with a 50ms per-row delay so the
  // list lands ordered, not all-at-once. No base delay — the previous
  // 480ms was tuned to wait for a workspace slide-in that only happens
  // on the picker→project flow; on warm starts the workspace mounts
  // directly and that 480ms was dead air before any row appeared.
  const entries = useTransitionList(flat, ROW_TRANSITION_MS, 50, 0);
  const { isDeleting } = useSessionDeletion();
  const firstRowDomLoggedRef = React.useRef(false);
  React.useEffect(() => {
    if (firstRowDomLoggedRef.current) return;
    if (entries.length === 0) return;
    firstRowDomLoggedRef.current = true;
    bootMark('sidebar:first-row-mounted', {
      delayMs: entries[0]?.delayMs ?? 0,
      count: entries.length,
    });
  }, [entries]);

  return (
    <>
      {entries.map(({ item, phase, delayMs }) => {
        const { s, isChild } = item;
        const leaving = phase === 'leaving';
        const deleting = isDeleting(s.compositeId);
        const showViews =
          !leaving && sessionViews && s.compositeId === activeCompositeId;
        return (
          <React.Fragment key={s.compositeId}>
          <AnimatedRow
            leaving={leaving}
            isChild={isChild}
            delayMs={delayMs}
          >
            <SessionRow
              session={{
                compositeId: s.compositeId,
                // Peer rows use the model id as the visible title —
                // each peer session's own title is whichever step
                // instruction the orchestrator sent first, which is
                // confusing in the list. The model is what matters.
                title: isChild ? s.model : s.title,
                time: timeAgo(s.updated_at),
                running: s.running,
                blocked: s.blocked ?? false,
                ...(s.blockedReason ? { blockedReason: s.blockedReason } : {}),
                ...(s.creating ? { creating: true } : {}),
                model: s.model,
                totalTokens: s.totalTokens,
                totalCost: s.totalCost,
              }}
              active={s.compositeId === activeCompositeId}
              onClick={() => {
                if (leaving) return;
                onSelect(s.compositeId);
              }}
              // Archive is parent-only — peers cascade off the
              // parent's archive. Pending (creating) rows hide it
              // too — closing happens via the inline Stop/Close on
              // the center pane.
              {...(isChild || s.creating
                ? {}
                : { onArchive: () => onArchiveSession(s.compositeId) })}
              compact={isChild}
              deleting={deleting}
            />
          </AnimatedRow>
          {showViews && sessionViews && <SessionSubNav items={sessionViews} />}
          </React.Fragment>
        );
      })}
    </>
  );
}

/**
 * Inlined CSS for session-row hover and enter/leave animation. We use
 * CSS `:hover` rather than React-tracked hover state so when the
 * active row is archived, the row that slides under the cursor picks
 * up `:hover` automatically — no need for the user to wiggle the
 * mouse to surface the archive button on the new active row.
 */
function SessionListStyles(): React.ReactElement {
  return (
    <style>{`
      .us-session-row {
        background: transparent;
      }
      .us-session-row:hover {
        background: var(--bg-panel);
      }
      .us-session-row[data-active="true"] {
        background: var(--bg-secondary);
      }
      .us-session-row:hover .us-session-row-archive {
        opacity: 1 !important;
        pointer-events: auto !important;
      }
      .us-session-row:focus-visible .us-session-row-archive {
        opacity: 1 !important;
        pointer-events: auto !important;
      }
      /* No fill-mode + no max-height on enter: rows mounted inside a
         display:none project tab (multi-tab shell) hit a Chromium
         quirk where the enter animation pins at the from-frame
         (max-height: 0 + overflow: hidden) and the row stays clipped
         to zero height until something forces a repaint (e.g. user
         hovering). Dropping max-height from the keyframes removes the
         layout-affecting property entirely, and omitting fill-mode
         lets the natural style (opacity 1, no transform, no max-height)
         take over as the resting state. The enter remains a pure
         opacity+slide fade-in; only the leave animation still drives
         max-height for the smooth row-collapse on archive. */
      .us-session-row-wrap {
        animation: us-session-row-enter ${ROW_TRANSITION_MS}ms ease-out;
        overflow: hidden;
      }
      .us-session-row-wrap-leaving {
        animation: us-session-row-leave ${ROW_TRANSITION_MS}ms ease-in forwards;
        pointer-events: none;
        overflow: hidden;
      }
      @keyframes us-session-row-enter {
        from {
          opacity: 0;
          transform: translateX(-8px);
        }
        to {
          opacity: 1;
          transform: translateX(0);
        }
      }
      @keyframes us-session-row-leave {
        from {
          opacity: 1;
          max-height: 200px;
        }
        to {
          opacity: 0;
          transform: translateX(-8px);
          max-height: 0;
        }
      }
    `}</style>
  );
}
