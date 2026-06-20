import React, { useEffect, useMemo, useState } from 'react';
import { useSocket } from '../hooks/useSocket';
import { Modal } from '../system';

/**
 * Picker overlay for interactive eval-task runs.
 *
 * Renders every available eval task in one list sorted easy → hard.
 * Each row carries a difficulty rating, a one-line "why this is
 * interesting" blurb, and any prior sessions the user has run on the
 * task (with score + open / copy-id / delete actions).
 *
 * Pure picker: `onPick(taskName)` starts a fresh run, `onOpenRun(...)`
 * reopens a prior one. The parent handles the actual RPCs +
 * route-switching.
 */

interface TaskListItem {
  name: string;
  kind: 'bug-fix' | 'feature' | 'planning';
  turns: string[];
  successCriteria: string;
  hasFixture: boolean;
  hasSetup: boolean;
  hasChecker: boolean;
  ticketPath?: string;
  gates?: { name: string; points: number; kind: string }[];
  tags?: string[];
  /** 1 = smoke, 5 = boss-level. Server-derived; see eval-bridge. */
  difficulty: number;
  /** One-line "why this is interesting" blurb. */
  whyInteresting: string;
}

interface HistoryRun {
  taskName: string;
  projectName: string;
  projectPath: string;
  sessionId: string;
  createdAt: string;
  gradedAt?: string;
  score?: number;
  scoreMax?: number;
}

export function EvalPickerModal({
  onCancel,
  onPick,
  onOpenRun,
}: {
  onCancel(): void;
  onPick(taskName: string): void;
  onOpenRun(projectName: string, projectPath: string, sessionId: string): void;
}): React.ReactElement {
  const socket = useSocket();
  const [tasks, setTasks] = useState<TaskListItem[] | null>(null);
  const [history, setHistory] = useState<HistoryRun[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [submittingFor, setSubmittingFor] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [tasksRes, historyRes] = await Promise.all([
          socket.request('evalListTasks', {}),
          socket.request('evalListHistory', {}),
        ]);
        if (cancelled) return;
        setTasks(tasksRes.tasks);
        setHistory(historyRes.runs);
      } catch (err) {
        if (cancelled) return;
        setError((err as Error).message ?? 'failed to load tasks');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [socket]);

  const handleDeleteRun = async (projectName: string): Promise<void> => {
    try {
      await socket.request('evalDeleteRun', { projectName });
      setHistory((prev) => prev.filter((r) => r.projectName !== projectName));
    } catch (err) {
      setError((err as Error).message ?? 'failed to delete run');
    }
  };

  // Escape + backdrop dismissal flow through <Modal>'s `closeOnEscape` /
  // `closeOnBackdrop`, both gated on whether a pick is mid-submit.

  // Single sorted list, easy → hard. Server pre-sorts by difficulty;
  // we only need to apply the search filter here.
  const filtered = useMemo(() => {
    if (!tasks) return null;
    const q = query.trim().toLowerCase();
    if (q === '') return tasks;
    return tasks.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.whyInteresting.toLowerCase().includes(q) ||
        t.successCriteria.toLowerCase().includes(q),
    );
  }, [tasks, query]);

  // Group history runs by taskName so each task row can render its
  // own sub-list of prior runs (newest first — the server hands them
  // back pre-sorted).
  const historyByTask = useMemo(() => {
    const out = new Map<string, HistoryRun[]>();
    for (const run of history) {
      const list = out.get(run.taskName);
      if (list) list.push(run);
      else out.set(run.taskName, [run]);
    }
    return out;
  }, [history]);

  const handlePick = (name: string): void => {
    if (submittingFor) return;
    setSubmittingFor(name);
    // onPick (parent) routes away or surfaces an error; we leave the
    // spinner in place until this component unmounts (success path) or
    // a future render flips submittingFor back to null.
    onPick(name);
  };

  return (
    <Modal
      open
      onClose={onCancel}
      size={820}
      ariaLabel="Eval task picker"
      closeOnEscape={!submittingFor}
      closeOnBackdrop={!submittingFor}
      cardStyle={{
        border: '1px solid var(--accent)',
        padding: 24,
        gap: 16,
      }}
    >
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            gap: 16,
          }}
        >
          <div
            style={{
              fontFamily: 'var(--font-heading)',
              fontSize: 22,
              fontWeight: 800,
              color: 'var(--text-primary)',
              letterSpacing: '-0.02em',
              lineHeight: 1.15,
            }}
          >
            Pick an eval task
          </div>
          <div
            style={{
              fontSize: 11,
              color: 'var(--text-secondary)',
              fontFamily: 'var(--font-label)',
              letterSpacing: '0.10em',
              textTransform: 'uppercase',
            }}
          >
            {tasks ? `${tasks.length} available` : 'loading…'}
          </div>
        </div>

        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by name or success criteria…"
          autoFocus
          style={{
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border)',
            color: 'var(--text-primary)',
            padding: '8px 12px',
            fontSize: 13,
            outline: 'none',
            width: '100%',
          }}
        />

        <div
          style={{
            overflow: 'auto',
            flex: '1 1 auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
            paddingRight: 4,
          }}
        >
          {error && (
            <div style={{ color: '#FF5500', fontSize: 13 }}>{error}</div>
          )}
          {!tasks && !error && (
            <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
              Loading tasks…
            </div>
          )}
          {filtered?.length === 0 && (
            <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
              No tasks match the current filter.
            </div>
          )}
          {filtered && filtered.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {filtered.map((t) => (
                <TaskRow
                  key={t.name}
                  task={t}
                  history={historyByTask.get(t.name) ?? []}
                  disabled={submittingFor !== null && submittingFor !== t.name}
                  isSubmitting={submittingFor === t.name}
                  onPick={() => handlePick(t.name)}
                  onOpenRun={onOpenRun}
                  onDeleteRun={(p) => void handleDeleteRun(p)}
                />
              ))}
            </div>
          )}
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: 12,
            borderTop: '1px solid var(--border)',
            paddingTop: 12,
          }}
        >
          <button
            type="button"
            onClick={onCancel}
            disabled={submittingFor !== null}
            style={{
              fontFamily: 'var(--font-label)',
              fontSize: 10,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              fontWeight: 700,
              color: 'var(--text-secondary)',
              background: 'transparent',
              border: '1px solid var(--border)',
              padding: '5px 10px',
              cursor: submittingFor !== null ? 'not-allowed' : 'pointer',
              opacity: submittingFor !== null ? 0.5 : 1,
            }}
          >
            Cancel
          </button>
        </div>
    </Modal>
  );
}

function TaskRow({
  task,
  history,
  disabled,
  isSubmitting,
  onPick,
  onOpenRun,
  onDeleteRun,
}: {
  task: TaskListItem;
  history: HistoryRun[];
  disabled: boolean;
  isSubmitting: boolean;
  onPick(): void;
  onOpenRun(projectName: string, projectPath: string, sessionId: string): void;
  onDeleteRun(projectName: string): void;
}): React.ReactElement {
  const isSbpro = task.tags?.includes('swe-bench-pro') ?? false;
  return (
    <div
      style={{
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <button
        type="button"
        onClick={onPick}
        disabled={disabled || isSubmitting}
        style={{
          textAlign: 'left',
          background: 'transparent',
          border: 'none',
          padding: '10px 12px',
          cursor: disabled || isSubmitting ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.4 : 1,
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          color: 'inherit',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 10,
              minWidth: 0,
            }}
          >
            <div
              style={{
                fontWeight: 700,
                fontSize: 13,
                color: 'var(--text-primary)',
              }}
            >
              {task.name}
            </div>
            <DifficultyStars value={task.difficulty} />
          </div>
          <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
            <Badge label={task.kind} tone="muted" />
            {task.hasSetup && <Badge label="setup" />}
            {isSbpro && <Badge label="docker grader" tone="accent" />}
            {task.turns.length > 1 && (
              <Badge label={`${task.turns.length} turns`} />
            )}
            {task.gates && task.gates.length > 0 && (
              <Badge label={`${task.gates.length} gates`} />
            )}
            {task.hasChecker ? (
              <Badge label="checker" tone="ok" />
            ) : (
              <Badge label="no checker" tone="muted" />
            )}
            {isSubmitting && <Badge label="creating…" tone="accent" />}
          </div>
        </div>
        <div
          style={{
            fontSize: 12,
            color: 'var(--text-secondary)',
            lineHeight: 1.4,
          }}
        >
          {task.whyInteresting}
        </div>
      </button>

      {history.length > 0 && (
        <div
          style={{
            borderTop: '1px solid var(--border)',
            padding: '8px 12px',
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            background: 'var(--bg-primary)',
          }}
        >
          <div
            style={{
              fontFamily: 'var(--font-label)',
              fontSize: 9,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              fontWeight: 700,
              color: 'var(--text-secondary)',
              marginBottom: 2,
            }}
          >
            Prior runs ({history.length})
          </div>
          {history.map((run) => (
            <HistoryRunRow
              key={run.sessionId}
              run={run}
              onOpen={() =>
                onOpenRun(run.projectName, run.projectPath, run.sessionId)
              }
              onDelete={() => onDeleteRun(run.projectName)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function HistoryRunRow({
  run,
  onOpen,
  onDelete,
}: {
  run: HistoryRun;
  onOpen(): void;
  onDelete(): void;
}): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const when = (() => {
    try {
      return new Date(run.createdAt).toLocaleString();
    } catch {
      return run.createdAt;
    }
  })();
  const scoreLabel =
    typeof run.score === 'number' && typeof run.scoreMax === 'number'
      ? `${run.score}/${run.scoreMax}`
      : run.gradedAt
      ? 'graded'
      : 'in progress';
  const handleCopy = (e: React.MouseEvent): void => {
    e.stopPropagation();
    void navigator.clipboard.writeText(run.sessionId).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      },
      () => undefined,
    );
  };
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 11,
      }}
    >
      <button
        type="button"
        onClick={onOpen}
        title={`Open session ${run.sessionId} (${run.projectName})`}
        style={{
          fontFamily: 'var(--font-label)',
          fontSize: 10,
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          fontWeight: 800,
          color:
            typeof run.score === 'number' && run.score === run.scoreMax
              ? '#6abf6a'
              : 'var(--text-primary)',
          background: 'var(--bg-secondary)',
          border: `1px solid ${
            typeof run.score === 'number' && run.score === run.scoreMax
              ? '#3a8c4a'
              : 'var(--border)'
          }`,
          padding: '3px 8px',
          cursor: 'pointer',
          minWidth: 56,
          textAlign: 'center',
        }}
      >
        {scoreLabel}
      </button>
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
          color: 'var(--text-secondary)',
        }}
      >
        <span
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={run.projectPath}
        >
          {run.projectName}
        </span>
        <span style={{ fontSize: 10, opacity: 0.7 }}>{when}</span>
      </div>
      <button
        type="button"
        onClick={handleCopy}
        title="Copy session id"
        style={{
          fontFamily: 'var(--font-label)',
          fontSize: 9,
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          fontWeight: 700,
          color: copied ? '#6abf6a' : 'var(--text-secondary)',
          background: 'transparent',
          border: `1px solid ${copied ? '#3a8c4a' : 'var(--border)'}`,
          padding: '2px 6px',
          cursor: 'pointer',
        }}
      >
        {copied ? 'copied' : 'copy id'}
      </button>
      <button
        type="button"
        onClick={() => {
          if (confirming) {
            onDelete();
            setConfirming(false);
          } else {
            setConfirming(true);
            setTimeout(() => setConfirming(false), 2500);
          }
        }}
        title={confirming ? 'Click again to confirm delete' : 'Delete this run'}
        style={{
          fontFamily: 'var(--font-label)',
          fontSize: 9,
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          fontWeight: 700,
          color: confirming ? '#fff' : '#FF5500',
          background: confirming
            ? 'linear-gradient(135deg, #FF8041 0%, #FF5500 50%, #E63900 100%)'
            : 'transparent',
          border: '1px solid #FF5500',
          padding: '2px 6px',
          cursor: 'pointer',
        }}
      >
        {confirming ? 'confirm?' : 'delete'}
      </button>
    </div>
  );
}

function DifficultyStars({ value }: { value: number }): React.ReactElement {
  const clamped = Math.max(1, Math.min(5, value));
  const labels: Record<number, string> = {
    1: 'easy',
    2: 'moderate',
    3: 'medium',
    4: 'hard',
    5: 'very hard',
  };
  return (
    <span
      title={`Difficulty: ${labels[clamped] ?? ''} (${clamped}/5)`}
      style={{
        display: 'inline-flex',
        gap: 2,
        fontFamily: 'var(--font-label)',
        fontSize: 11,
        letterSpacing: '0.05em',
        color: 'var(--accent)',
        whiteSpace: 'nowrap',
      }}
    >
      {Array.from({ length: 5 }, (_, i) => (
        <span
          key={i}
          style={{
            color: i < clamped ? 'var(--accent)' : 'var(--text-tertiary, #555)',
          }}
        >
          ●
        </span>
      ))}
    </span>
  );
}

function Badge({
  label,
  tone = 'default',
}: {
  label: string;
  tone?: 'default' | 'ok' | 'muted' | 'accent';
}): React.ReactElement {
  const palette = {
    default: {
      bg: 'transparent',
      border: 'var(--border)',
      color: 'var(--text-secondary)',
    },
    ok: { bg: 'transparent', border: '#3a8c4a', color: '#6abf6a' },
    muted: {
      bg: 'transparent',
      border: 'var(--border)',
      color: 'var(--text-tertiary, #888)',
    },
    accent: {
      bg: 'transparent',
      border: 'var(--accent)',
      color: 'var(--accent)',
    },
  }[tone];
  return (
    <span
      style={{
        fontFamily: 'var(--font-label)',
        fontSize: 9,
        letterSpacing: '0.12em',
        textTransform: 'uppercase',
        fontWeight: 700,
        padding: '2px 6px',
        border: `1px solid ${palette.border}`,
        color: palette.color,
        background: palette.bg,
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </span>
  );
}
