import { useCallback, useEffect, useMemo, useState } from 'react';
import { DevProdToggle } from '../components/DevProdToggle';
import { useSocket } from '../hooks/useSocket';
import { useStudioUserSetting } from '../hooks/useStudioUserSetting';

interface WorkerManifestItem {
  name: string;
  description?: string;
  schedule?: string;
  timeout?: number;
  inputSchema?: unknown;
  defaultInput: unknown;
}

interface WorkerRunItem {
  runId: string;
  name: string;
  input: unknown;
  startedAt: number;
  finishedAt: number | null;
  status: 'running' | 'completed' | 'failed' | 'queued';
  error: string | null;
  durationMs: number | null;
}

interface WorkerRunDetail extends WorkerRunItem {
  result: unknown;
  logs: string[];
}

type Mode = 'dev' | 'prod';

function formatAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 0) return 'in the future';
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function statusColor(status: WorkerRunItem['status']): string {
  switch (status) {
    case 'completed':
      return 'var(--accent-success, #10b981)';
    case 'failed':
      return 'var(--error, #dc2626)';
    case 'running':
      return 'var(--accent-primary, #3b82f6)';
    case 'queued':
      return 'var(--text-secondary)';
  }
}

export interface WorkersPanelProps {
  forceProd?: boolean;
  forceDev?: boolean;
  hideHeader?: boolean;
}

export function WorkersPanel({
  forceProd,
  forceDev,
  hideHeader,
}: WorkersPanelProps = {}) {
  const socket = useSocket();
  const [storedMode, setStoredMode] = useStudioUserSetting<Mode>(
    'panel.workers.mode',
    'dev',
  );
  const mode: Mode = forceProd ? 'prod' : forceDev ? 'dev' : storedMode;
  const setMode = setStoredMode;
  const modePinned = Boolean(forceProd) || Boolean(forceDev);
  const [workers, setWorkers] = useState<WorkerManifestItem[]>([]);
  const [unavailableReason, setUnavailableReason] = useState<string | null>(
    null,
  );
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [inputText, setInputText] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [runs, setRuns] = useState<WorkerRunItem[]>([]);
  const [expandedRun, setExpandedRun] = useState<WorkerRunDetail | null>(null);
  const [lastResult, setLastResult] = useState<{
    status: string;
    error?: string | null;
    logs?: string[];
    result?: unknown;
    durationMs?: number;
  } | null>(null);

  const selected = useMemo(
    () => workers.find((w) => w.name === selectedName) ?? null,
    [workers, selectedName],
  );

  const handleModeChange = (m: Mode) => {
    if (modePinned) return;
    setMode(m);
  };

  const loadManifest = useCallback(async () => {
    try {
      const res = await socket.request('workersGetManifest', {});
      if (!res.available) {
        setUnavailableReason(res.reason ?? 'Workers panel unavailable.');
        setWorkers([]);
        return;
      }
      setUnavailableReason(null);
      setWorkers(res.workers);
      if (!selectedName && res.workers.length > 0) {
        setSelectedName(res.workers[0].name);
      }
    } catch (err) {
      console.error('[WorkersPanel:workersGetManifest]', JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), err instanceof Error ? err.stack : undefined);
      setUnavailableReason(
        err instanceof Error ? err.message : 'Failed to load workers',
      );
    }
  }, [socket, selectedName]);

  const loadRuns = useCallback(async () => {
    if (unavailableReason) return;
    try {
      const res = await socket.request('workersListRuns', {
        mode,
        ...(selectedName ? { name: selectedName } : {}),
        limit: 50,
      });
      setRuns(res.runs);
    } catch (err) {
      console.error('[WorkersPanel:workersListRuns]', JSON.stringify({ mode, name: selectedName === '' ? undefined : selectedName, error: err instanceof Error ? err.message : String(err) }), err instanceof Error ? err.stack : undefined);
      setRuns([]);
    }
  }, [socket, mode, selectedName, unavailableReason]);

  useEffect(() => {
    void loadManifest();
  }, [loadManifest]);

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  // Reset input + last-result when selecting a different worker.
  useEffect(() => {
    if (!selected) {
      setInputText('');
      setLastResult(null);
      return;
    }
    setInputText(
      selected.defaultInput === undefined || selected.defaultInput === null
        ? ''
        : JSON.stringify(selected.defaultInput, null, 2),
    );
    setLastResult(null);
    setInputError(null);
  }, [selected]);

  const handleRun = async () => {
    if (!selected) return;
    let parsedInput: unknown = undefined;
    if (inputText.trim().length > 0) {
      try {
        parsedInput = JSON.parse(inputText);
      } catch (err) {
        setInputError(`Invalid JSON: ${(err as Error).message}`);
        return;
      }
    }
    setInputError(null);
    setRunning(true);
    try {
      const res = await socket.request('workersRun', {
        name: selected.name,
        input: parsedInput,
        mode,
      });
      setLastResult({
        status: res.status,
        error: res.error ?? null,
        logs: res.logs ?? [],
        result: res.result,
        durationMs: res.durationMs,
      });
      // Refresh the runs list so the new row appears immediately. On prod the worker is
      // ENQUEUED (runs async on the server), so poll a few times to surface the run moving
      // queued → running → completed without a manual Refresh.
      void loadRuns();
      if (mode === 'prod' && (res.status === 'queued' || res.status === 'running')) {
        for (let i = 1; i <= 6; i++) setTimeout(() => void loadRuns(), i * 2000);
      }
    } catch (err) {
      console.error('[WorkersPanel:workersRun]', JSON.stringify({ name: selected.name, mode, error: err instanceof Error ? err.message : String(err) }), err instanceof Error ? err.stack : undefined);
      setLastResult({
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setRunning(false);
    }
  };

  const handleExpandRun = async (runId: string) => {
    if (expandedRun?.runId === runId) {
      setExpandedRun(null);
      return;
    }
    try {
      const res = await socket.request('workersGetRun', { runId, mode });
      setExpandedRun(res.run as WorkerRunDetail | null);
    } catch (err) {
      console.error('[WorkersPanel:workersGetRun]', JSON.stringify({ runId, mode, error: err instanceof Error ? err.message : String(err) }), err instanceof Error ? err.stack : undefined);
      setExpandedRun(null);
    }
  };

  if (unavailableReason) {
    return (
      <div
        data-id="panel-workers"
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
              Workers
            </span>
          </div>
        )}
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
            color: 'var(--text-secondary)',
            fontSize: 13,
            textAlign: 'center',
          }}
        >
          {unavailableReason}
        </div>
      </div>
    );
  }

  return (
    <div
      data-id="panel-workers"
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
            Workers
          </span>
          {!modePinned && (
            <DevProdToggle mode={mode} onModeChange={handleModeChange} />
          )}
          <span style={{ flex: 1 }} />
          <button
            onClick={() => {
              void loadManifest();
              void loadRuns();
            }}
            style={toolbarBtn}
            data-id="workers-refresh"
          >
            Refresh
          </button>
        </div>
      )}

      <div
        style={{
          flex: 1,
          display: 'flex',
          minHeight: 0,
        }}
      >
        {/* Left pane — worker list */}
        <div
          style={{
            width: '30%',
            minWidth: 200,
            maxWidth: 360,
            borderRight: '1px solid var(--border-primary)',
            overflow: 'auto',
          }}
        >
          {workers.length === 0 ? (
            <div style={{ padding: 12, color: 'var(--text-secondary)' }}>
              No workers defined. Add a <code>shared/workers.ts</code> that
              exports a <code>defineWorkers({'{...}'})</code> registry and run{' '}
              <code>npm run build</code>.
            </div>
          ) : (
            workers.map((w) => (
              <button
                key={w.name}
                onClick={() => { setSelectedName(w.name); }}
                data-id={`worker-item-${w.name}`}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  padding: '8px 12px',
                  border: 'none',
                  background:
                    selectedName === w.name
                      ? 'var(--bg-tertiary, #242424)'
                      : 'transparent',
                  color: 'var(--text-primary)',
                  cursor: 'pointer',
                  borderBottom: '1px solid var(--border-primary)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    fontSize: 13,
                    fontWeight: 500,
                  }}
                >
                  {w.name}
                  {w.schedule && (
                    <span
                      style={{
                        fontSize: 10,
                        padding: '1px 5px',
                        borderRadius: 3,
                        background: 'var(--accent-primary, #3b82f6)',
                        color: 'var(--text-on-accent, #fff)',
                      }}
                    >
                      {w.schedule}
                    </span>
                  )}
                </div>
                {w.description && (
                  <div
                    style={{
                      fontSize: 11,
                      color: 'var(--text-secondary)',
                    }}
                  >
                    {w.description}
                  </div>
                )}
              </button>
            ))
          )}
        </div>

        {/* Right pane — worker detail */}
        <div
          style={{
            flex: 1,
            overflow: 'auto',
            padding: 16,
            minWidth: 0,
          }}
        >
          {!selected ? (
            <div style={{ color: 'var(--text-secondary)', fontSize: 13 }}>
              Select a worker to run or inspect recent runs.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div>
                <div
                  style={{
                    fontSize: 16,
                    fontWeight: 600,
                    color: 'var(--text-primary)',
                  }}
                >
                  {selected.name}
                </div>
                {selected.description && (
                  <div
                    style={{
                      fontSize: 12,
                      color: 'var(--text-secondary)',
                      marginTop: 4,
                    }}
                  >
                    {selected.description}
                  </div>
                )}
                <div
                  style={{
                    fontSize: 11,
                    color: 'var(--text-secondary)',
                    marginTop: 6,
                    display: 'flex',
                    gap: 12,
                  }}
                >
                  {selected.schedule && (
                    <span>schedule: {selected.schedule}</span>
                  )}
                  {selected.timeout && (
                    <span>timeout: {selected.timeout}ms</span>
                  )}
                </div>
              </div>

              <div>
                <label
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: 'var(--text-primary)',
                    display: 'block',
                    marginBottom: 6,
                  }}
                >
                  Input (JSON)
                </label>
                <textarea
                  data-id="workers-input"
                  value={inputText}
                  onChange={(e) => {
                    setInputText(e.target.value);
                    setInputError(null);
                  }}
                  rows={8}
                  style={{
                    width: '100%',
                    fontFamily: 'monospace',
                    fontSize: 12,
                    padding: 8,
                    background: 'var(--bg-secondary)',
                    color: 'var(--text-primary)',
                    border: `1px solid ${
                      inputError
                        ? 'var(--error, #dc2626)'
                        : 'var(--border-primary)'
                    }`,
                    borderRadius: 4,
                    resize: 'vertical',
                  }}
                />
                {inputError && (
                  <div
                    style={{
                      marginTop: 4,
                      fontSize: 11,
                      color: 'var(--error, #dc2626)',
                    }}
                  >
                    {inputError}
                  </div>
                )}
                <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
                  <button
                    onClick={() => void handleRun()}
                    disabled={running}
                    data-id="workers-run"
                    style={{
                      ...toolbarBtn,
                      background:
                        mode === 'prod'
                          ? 'var(--accent-warning, #d97706)'
                          : 'var(--accent-primary, #3b82f6)',
                      color: 'var(--text-on-accent, #fff)',
                      padding: '6px 16px',
                      fontSize: 13,
                      opacity: running ? 0.6 : 1,
                    }}
                  >
                    {running
                      ? 'Running…'
                      : mode === 'prod'
                      ? 'Enqueue on Prod'
                      : 'Run on Dev'}
                  </button>
                </div>
              </div>

              {lastResult && (
                <div
                  data-id="workers-last-result"
                  style={{
                    padding: 10,
                    background: 'var(--bg-secondary)',
                    border: '1px solid var(--border-primary)',
                    borderRadius: 4,
                    fontSize: 12,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      marginBottom: 6,
                    }}
                  >
                    <span
                      style={{
                        fontWeight: 600,
                        color: statusColor(
                          lastResult.status as WorkerRunItem['status'],
                        ),
                      }}
                    >
                      {lastResult.status}
                    </span>
                    {lastResult.durationMs !== undefined && (
                      <span style={{ color: 'var(--text-secondary)' }}>
                        ({formatDuration(lastResult.durationMs)})
                      </span>
                    )}
                  </div>
                  {lastResult.status === 'queued' && (
                    <div style={{ color: 'var(--text-secondary)', marginBottom: 4 }}>
                      Enqueued on production — it runs on the server queue. Watch it move to
                      <b> running → completed</b> in <b>Recent runs</b> below (auto-refreshing),
                      then click the run for its result + logs.
                    </div>
                  )}
                  {lastResult.error && (
                    <pre
                      style={{
                        margin: 0,
                        fontSize: 11,
                        color: 'var(--error, #dc2626)',
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                      }}
                    >
                      {lastResult.error}
                    </pre>
                  )}
                  {lastResult.result !== undefined &&
                    lastResult.result !== null && (
                      <pre
                        style={{
                          margin: '4px 0 0',
                          fontSize: 11,
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-word',
                          color: 'var(--text-primary)',
                        }}
                      >
                        {JSON.stringify(lastResult.result, null, 2)}
                      </pre>
                    )}
                  {lastResult.logs && lastResult.logs.length > 0 && (
                    <details style={{ marginTop: 6 }}>
                      <summary
                        style={{
                          cursor: 'pointer',
                          color: 'var(--text-secondary)',
                          fontSize: 11,
                        }}
                      >
                        Logs ({lastResult.logs.length})
                      </summary>
                      <pre
                        style={{
                          margin: '4px 0 0',
                          fontSize: 11,
                          whiteSpace: 'pre-wrap',
                          color: 'var(--text-primary)',
                          opacity: 0.85,
                          maxHeight: 240,
                          overflow: 'auto',
                        }}
                      >
                        {lastResult.logs.join('\n')}
                      </pre>
                    </details>
                  )}
                </div>
              )}

              <div>
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: 'var(--text-primary)',
                    marginBottom: 6,
                  }}
                >
                  Recent runs ({mode})
                </div>
                {runs.length === 0 ? (
                  <div
                    style={{
                      color: 'var(--text-secondary)',
                      fontSize: 12,
                    }}
                  >
                    No runs yet.
                  </div>
                ) : (
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 4,
                    }}
                  >
                    {runs.map((r) => (
                      <div
                        key={r.runId}
                        data-id={`run-${r.runId}`}
                        style={{
                          padding: 8,
                          background: 'var(--bg-secondary)',
                          border: '1px solid var(--border-primary)',
                          borderRadius: 4,
                          cursor: 'pointer',
                          fontSize: 12,
                        }}
                        onClick={() => void handleExpandRun(r.runId)}
                      >
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                          }}
                        >
                          <span
                            style={{
                              fontWeight: 600,
                              color: statusColor(r.status),
                              minWidth: 80,
                            }}
                          >
                            {r.status}
                          </span>
                          <span style={{ color: 'var(--text-secondary)' }}>
                            {formatAgo(r.startedAt)}
                          </span>
                          <span style={{ color: 'var(--text-secondary)' }}>
                            {formatDuration(r.durationMs)}
                          </span>
                          <span style={{ flex: 1 }} />
                          {r.error && (
                            <span
                              style={{
                                color: 'var(--error, #dc2626)',
                                fontSize: 11,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                                maxWidth: 280,
                              }}
                            >
                              {r.error}
                            </span>
                          )}
                        </div>
                        {expandedRun?.runId === r.runId && (
                          <div
                            className="us-fade-down"
                            style={{ marginTop: 8 }}
                          >
                            <RunDetailView run={expandedRun} />
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function RunDetailView({ run }: { run: WorkerRunDetail }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        fontSize: 11,
      }}
    >
      {run.input !== undefined && (
        <details>
          <summary
            style={{ cursor: 'pointer', color: 'var(--text-secondary)' }}
          >
            Input
          </summary>
          <pre
            style={{
              margin: '4px 0 0',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {JSON.stringify(run.input, null, 2)}
          </pre>
        </details>
      )}
      {run.result !== undefined && run.result !== null && (
        <details>
          <summary
            style={{ cursor: 'pointer', color: 'var(--text-secondary)' }}
          >
            Result
          </summary>
          <pre
            style={{
              margin: '4px 0 0',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {JSON.stringify(run.result, null, 2)}
          </pre>
        </details>
      )}
      {run.error && (
        <pre
          style={{
            margin: 0,
            color: 'var(--error, #dc2626)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {run.error}
        </pre>
      )}
      {run.logs.length > 0 && (
        <details open>
          <summary
            style={{ cursor: 'pointer', color: 'var(--text-secondary)' }}
          >
            Logs ({run.logs.length})
          </summary>
          <pre
            style={{
              margin: '4px 0 0',
              whiteSpace: 'pre-wrap',
              maxHeight: 240,
              overflow: 'auto',
              opacity: 0.85,
            }}
          >
            {run.logs.join('\n')}
          </pre>
        </details>
      )}
    </div>
  );
}

const toolbarBtn: React.CSSProperties = {
  padding: '4px 10px',
  fontSize: 12,
  background: 'var(--bg-secondary)',
  color: 'var(--text-primary)',
  border: '1px solid var(--border-primary)',
  borderRadius: 4,
  cursor: 'pointer',
};
