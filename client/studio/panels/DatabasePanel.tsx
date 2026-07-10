/**
 * Database panel — a debugging console for the project's data.
 *
 *   Browse  — collection list → filter / sort / paginate → inspect, edit, insert,
 *             duplicate, delete rows (JSON editor with syntax highlighting).
 *   SQL     — raw SQL console (reads free; writes gated; UPDATE/DELETE dry-run).
 *   Schema  — columns, indexes, exact count, and the collection's TS interface.
 *
 * Works against the bundled local postgres (dev) or the project's Neon (prod).
 * Writes are locked by default in prod (loud banner + explicit unlock); the
 * backend (db/dbScript) re-checks the same gate, so it's defense in depth.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { native } from 'ugly-app/native';
import { DevProdToggle } from '../components/DevProdToggle';
import { CodeEditor } from '../components/CodeEditor';
import { ResultsTable } from '../components/ResultsTable';
import { useSocket, getActiveRepoPath } from '../hooks/useSocket';
import { useStudioUserSetting } from '../hooks/useStudioUserSetting';
import { shortcut } from '../utils/platform';
import { isNativeAvailable } from 'ugly-app/native';
import { NativeHostRequired } from '../common/NativeHostRequired';
import { GitRepoSelector, useActiveRepoPath } from './GitRepoSelector';

type DbMode = 'dev' | 'prod';
type Tab = 'browse' | 'sql' | 'schema';

const FILTER_OPS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'exists'] as const;
type FilterOp = (typeof FILTER_OPS)[number];
const OP_LABEL: Record<FilterOp, string> = {
  eq: '=', ne: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤', contains: 'contains', exists: 'exists',
};

interface Collection {
  name: string;
  estimatedCount: number;
}
interface Filter {
  field: string;
  op: FilterOp;
  value: string;
}
interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  total: number;
  durationMs: number;
}

// ── shared styles ────────────────────────────────────────────────────────────
const errorBoxStyle: React.CSSProperties = {
  padding: 10, background: 'rgba(220, 38, 38, 0.08)', border: '1px solid var(--error, #dc2626)',
  borderRadius: 4, fontFamily: 'var(--font-mono, monospace)', fontSize: 12,
  color: 'var(--error, #dc2626)', whiteSpace: 'pre-wrap',
};
const sectionHeaderStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 0.5,
};
const inputStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono, monospace)', fontSize: 12.5, padding: '6px 8px', borderRadius: 4,
  border: '1px solid var(--border-primary)', background: 'var(--bg-secondary)', color: 'var(--text-primary)',
  outline: 'none', boxSizing: 'border-box',
};
/** Stringify a non-object, non-null value without hitting Object's default
 *  `[object Object]` stringification (safe for any primitive incl. symbol). */
function primitiveToString(v: unknown): string {
  if (typeof v === 'symbol') return v.toString();
  if (typeof v === 'function') return '[Function]';
  if (typeof v === 'object') return JSON.stringify(v);
  // Primitive: string | number | bigint | boolean | undefined
  return `${v as string | number | bigint | boolean | undefined}`;
}

function btnStyle(variant: 'default' | 'primary' | 'danger', disabled = false): React.CSSProperties {
  const bg = variant === 'primary' ? 'var(--accent-primary, #3b82f6)'
    : variant === 'danger' ? 'var(--error, #dc2626)' : 'var(--bg-secondary)';
  return {
    background: bg,
    border: variant === 'default' ? '1px solid var(--border-primary)' : 'none',
    color: variant === 'default' ? 'var(--text-primary)' : 'var(--text-on-accent, #fff)',
    borderRadius: 4, padding: '5px 12px', fontSize: 12, fontWeight: 600,
    cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1, whiteSpace: 'nowrap',
  };
}

export interface DatabasePanelProps {
  forceProd?: boolean;
  forceDev?: boolean;
  hideHeader?: boolean;
  /** Route the user to the Publish tab (shown when the prod DB isn't provisioned
   *  yet because the project was never deployed). */
  onPublish?: () => void;
}

export function DatabasePanel({ forceProd, forceDev, onPublish }: DatabasePanelProps = {}) {
  const activeRepo = useActiveRepoPath();
  const [storedMode, setStoredMode] = useStudioUserSetting<DbMode>('panel.database.mode', 'dev');
  const mode: DbMode = forceProd ? 'prod' : forceDev ? 'dev' : storedMode;
  // `||` (not `??`) is intentional: either boolean flag being `true` pins the mode.
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
  const modePinned = Boolean(forceProd || forceDev);

  const [tab, setTab] = useState<Tab>('browse');
  // Writes default ON for the throwaway local dev DB, OFF for prod (real data).
  const [writes, setWrites] = useState(mode === 'dev');
  useEffect(() => { setWrites(mode === 'dev'); }, [mode]);

  const handleModeChange = useCallback(
    (m: DbMode) => { if (!modePinned) setStoredMode(m); },
    [modePinned, setStoredMode],
  );

  const enableWrites = useCallback(() => {
    if (mode === 'prod') {
      const ok = window.confirm(
        'Enable writes against PRODUCTION data?\n\nUPDATE/DELETE/INSERT will affect live user data. ' +
          'Destructive statements still require an extra confirmation.',
      );
      if (!ok) return;
    }
    setWrites(true);
  }, [mode]);

  // For the prod DB, gate on publish state. A project that was never deployed has
  // no Neon database yet, so firing the query just surfaces a confusing raw
  // "No prod database connection" error. Read `.uglyapp` deployTarget (as ProdPanel
  // does) and prompt the user to publish first instead. Only relevant in prod mode.
  const [prodDeployed, setProdDeployed] = useState<'checking' | 'yes' | 'no'>('checking');
  useEffect(() => {
    if (mode !== 'prod') return;
    let cancelled = false;
    setProdDeployed('checking');
    const cwd = activeRepo;
    if (!cwd) { setProdDeployed('no'); return; }
    void (async () => {
      try {
        const ua = JSON.parse(await native.fs.readFile(`${cwd}/.uglyapp`)) as {
          deployTarget?: { workerUrl?: string } | null;
        };
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- set true by cleanup across the await; flow analysis can't see the async gap
        if (cancelled) return;
        setProdDeployed(ua.deployTarget?.workerUrl ? 'yes' : 'no');
      } catch {
        // No `.uglyapp` yet (ENOENT) = never published → prompt to publish.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- set true by cleanup across the await; flow analysis can't see the async gap
        if (cancelled) return;
        setProdDeployed('no');
      }
    })();
    return () => { cancelled = true; };
  }, [activeRepo, mode]);

  // The DB panel runs its query script as a local node subprocess (both dev bundled
  // Postgres AND prod Neon go through `native.process.spawn`), so a browser tab with
  // no native host can't reach any database — show that instead of an empty list.
  if (!isNativeAvailable()) return <NativeHostRequired feature="The database panel" />;

  if (mode === 'prod' && prodDeployed === 'checking') {
    return (
      <div data-id="database-panel" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
        <Centered>Checking publish status…</Centered>
      </div>
    );
  }
  if (mode === 'prod' && prodDeployed === 'no') {
    return <ProdPublishGate onPublish={onPublish} />;
  }

  return (
    <div data-id="database-panel" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="panel-toolbar" style={{ gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>Database</span>
        <GitRepoSelector />
        <div style={{ display: 'inline-flex', gap: 2, marginLeft: 4 }}>
          {(['browse', 'sql', 'schema'] as Tab[]).map((t) => (
            <button
              key={t}
              data-id={`db-tab-${t}`}
              onClick={() => { setTab(t); }}
              style={{
                ...btnStyle(tab === t ? 'primary' : 'default'),
                textTransform: 'capitalize',
                ...(tab === t ? {} : { background: 'transparent', border: '1px solid transparent', color: 'var(--text-secondary)' }),
              }}
            >
              {t}
            </button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <WriteToggle mode={mode} writes={writes} onEnable={enableWrites} onDisable={() => { setWrites(false); }} />
        {!modePinned && <DevProdToggle mode={mode} onModeChange={handleModeChange} />}
      </div>

      {mode === 'prod' && writes && (
        <div
          data-id="prod-write-banner"
          style={{
            padding: '6px 12px', background: 'rgba(220,38,38,0.12)', borderBottom: '1px solid var(--error, #dc2626)',
            color: 'var(--error, #dc2626)', fontSize: 12, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8,
          }}
        >
          ⚠ PRODUCTION WRITES ENABLED — statements affect live user data.
        </div>
      )}

      <div style={{ flex: 1, overflow: 'auto', padding: 12 }}>
        {tab === 'browse' && <BrowseView mode={mode} writes={writes} />}
        {tab === 'sql' && <SqlConsole mode={mode} writes={writes} onWantWrites={enableWrites} />}
        {tab === 'schema' && <SchemaView mode={mode} />}
      </div>
    </div>
  );
}

// Shown for the prod DB when the project was never deployed (no Neon yet).
function ProdPublishGate({ onPublish }: { onPublish?: () => void }) {
  return (
    <div
      data-id="database-panel"
      style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        height: '100%', gap: 12, padding: 24, textAlign: 'center',
      }}
    >
      <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
        No production database yet
      </span>
      <span style={{ fontSize: 13, color: 'var(--text-secondary)', maxWidth: 420, lineHeight: 1.5 }}>
        This project hasn’t been published, so there’s no production database to
        browse. Publish it first to provision Neon — then your prod data shows up here.
      </span>
      {onPublish && (
        <button data-id="db-publish-first" onClick={onPublish} style={btnStyle('primary')}>
          Publish project →
        </button>
      )}
    </div>
  );
}

function WriteToggle({
  mode, writes, onEnable, onDisable,
}: { mode: DbMode; writes: boolean; onEnable: () => void; onDisable: () => void }) {
  return (
    <button
      data-id="db-writes-toggle"
      onClick={writes ? onDisable : onEnable}
      title={writes ? 'Writes enabled — click to lock' : 'Writes locked — click to enable'}
      style={{
        ...btnStyle(writes ? (mode === 'prod' ? 'danger' : 'default') : 'default'),
        display: 'inline-flex', alignItems: 'center', gap: 6,
      }}
    >
      {writes ? '🔓' : '🔒'} Writes {writes ? 'on' : 'off'}
    </button>
  );
}

// ── Browse ───────────────────────────────────────────────────────────────────
function BrowseView({ mode, writes }: { mode: DbMode; writes: boolean }) {
  const socket = useSocket();
  const [collections, setCollections] = useState<Collection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    socket
      .request('dbCollections', { mode })
      .then((res) => { setCollections(res.collections); })
      .catch((e: unknown) => {
        // → errorLog (browser Logger); the panel's in-view error box is invisible
        // when the host is another machine. This is the panel's initial load, so
        // it's the most common "database panel failed".
        console.error('[DatabasePanel:dbCollections]', JSON.stringify({ mode, error: e instanceof Error ? e.message : String(e) }), e instanceof Error ? e.stack : undefined);
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => { setLoading(false); });
  }, [mode, socket]);

  useEffect(() => { setSelected(null); reload(); }, [reload]);

  // Re-query when the window regains focus. The collection list is populated by
  // the running dev DB, so a panel opened BEFORE the app's first `pnpm dev`
  // created the tables would otherwise stay "No collections found" forever —
  // the "started the app, DB panel still empty" report. Coming back to the
  // Studio window after starting the app now refreshes the list.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onFocus = (): void => { reload(); };
    window.addEventListener('focus', onFocus);
    return () => { window.removeEventListener('focus', onFocus); };
  }, [reload]);

  if (selected) {
    return <CollectionDetail mode={mode} writes={writes} collection={selected} onBack={() => { setSelected(null); }} />;
  }
  const refreshBtn = (
    <button
      data-id="db-collections-refresh"
      onClick={() => { reload(); }}
      disabled={loading}
      title="Re-query collections (after the app creates its tables)"
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px',
        fontSize: 12, background: 'var(--bg-secondary)', color: 'var(--text-primary)',
        border: '1px solid var(--border-primary)', borderRadius: 4,
        cursor: loading ? 'default' : 'pointer', opacity: loading ? 0.6 : 1, alignSelf: 'flex-start',
      }}
    >
      <RefreshCw size={12} style={loading ? { animation: 'us-readiness-pulse 1.4s ease-in-out infinite' } : undefined} />
      Refresh
    </button>
  );
  if (loading && collections.length === 0) return <Centered>Loading…</Centered>;
  if (error) return <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{refreshBtn}<div style={errorBoxStyle}>{error}</div></div>;
  if (collections.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center', paddingTop: 24 }}>
        <span style={{ color: 'var(--text-secondary)', fontSize: 13 }}>No collections found</span>
        <span style={{ color: 'var(--text-secondary)', fontSize: 11, textAlign: 'center', maxWidth: 280 }}>
          Tables are created when the app first runs its migrations (start it from the Preview panel). Then refresh.
        </span>
        {refreshBtn}
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {refreshBtn}
      {collections.map((c) => (
        <div
          key={c.name}
          data-id={`collection-item-${c.name}`}
          onClick={() => { setSelected(c.name); }}
          style={{
            padding: 12, background: 'var(--bg-secondary)', borderRadius: 4, border: '1px solid var(--border-primary)',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer',
          }}
        >
          <span style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 12, color: 'var(--text-primary)' }}>{c.name}</span>
          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>~{c.estimatedCount.toLocaleString()} rows</span>
        </div>
      ))}
    </div>
  );
}

const PAGE = 50;

function CollectionDetail({
  mode, writes, collection, onBack,
}: { mode: DbMode; writes: boolean; collection: string; onBack: () => void }) {
  const socket = useSocket();
  const [filters, setFilters] = useState<Filter[]>([]);
  const [sortField, setSortField] = useState('created');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(0);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, unknown> | null>(null);
  const [editing, setEditing] = useState<{ mode: 'edit' | 'insert'; doc: Record<string, unknown> } | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);

  const run = useCallback(
    async (toPage = page) => {
      setLoading(true);
      setError(null);
      try {
        const res = await socket.request('dbGetQuery', {
          mode, collection,
          filters: filters.filter((f) => f.field.trim()),
          sort: { field: sortField, dir: sortDir },
          limit: PAGE, skip: toPage * PAGE,
        });
        setResult(res);
        setPage(toPage);
      } catch (e: unknown) {
        console.error('[DatabasePanel:dbGetQuery]', JSON.stringify({ mode, collection, filters: filters.filter((f) => f.field.trim()), sort: { field: sortField, dir: sortDir }, error: e instanceof Error ? e.message : String(e) }), e instanceof Error ? e.stack : undefined);
        setError(e instanceof Error ? e.message : String(e));
        setResult(null);
      } finally {
        setLoading(false);
      }
    },
    [socket, mode, collection, filters, sortField, sortDir, page],
  );

  // Initial + on collection change.
  useEffect(() => { void run(0); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [collection, mode]);

  // Auto-refresh (live tail).
  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => void run(page), 5000);
    return () => { clearInterval(id); };
  }, [autoRefresh, run, page]);

  const del = useCallback(
    async (id: string) => {
      if (!window.confirm(`Delete ${collection}/${id}?`)) return;
      try {
        await socket.request('dbMutate', { mode, collection, action: 'delete', id, allowWrite: true });
        void run(page);
      } catch (e: unknown) {
        console.error('[DatabasePanel:dbMutate:delete]', JSON.stringify({ mode, collection, id, error: e instanceof Error ? e.message : String(e) }), e instanceof Error ? e.stack : undefined);
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [socket, mode, collection, run, page],
  );

  const saveDoc = useCallback(
    async (doc: Record<string, unknown>, action: 'insert' | 'update') => {
      const id = typeof doc._id === 'string' ? doc._id : undefined;
      await socket.request('dbMutate', { mode, collection, action, id, doc, allowWrite: true });
      setEditing(null);
      void run(action === 'insert' ? 0 : page);
    },
    [socket, mode, collection, run, page],
  );

  const total = result?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const dataCols = result ? result.columns.filter((c) => c !== '_id') : [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button onClick={onBack} style={btnStyle('default')} data-id="collection-back-btn">← Back</button>
        <span data-id="selected-collection-name" style={{ fontSize: 14, fontWeight: 600, fontFamily: 'var(--font-mono, monospace)', color: 'var(--text-primary)' }}>{collection}</span>
        <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{total.toLocaleString()} rows</span>
        <div style={{ flex: 1 }} />
        <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'inline-flex', gap: 4, alignItems: 'center' }}>
          <input data-id="auto-refresh-toggle" type="checkbox" checked={autoRefresh} onChange={(e) => { setAutoRefresh(e.target.checked); }} /> Auto-refresh
        </label>
        {result && <ExportMenu collection={collection} columns={result.columns} rows={result.rows} />}
        {writes && <button data-id="db-new-row" onClick={() => { setEditing({ mode: 'insert', doc: {} }); }} style={btnStyle('primary')}>+ New row</button>}
      </div>

      {/* Filter builder */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={sectionHeaderStyle}>Filters</span>
        {filters.map((f, i) => (
          <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input
              data-id="filter-field" placeholder="field" value={f.field}
              onChange={(e) => { setFilters((fs) => fs.map((x, j) => (j === i ? { ...x, field: e.target.value } : x))); }}
              style={{ ...inputStyle, width: 140 }}
            />
            <select
              data-id="filter-op"
              value={f.op}
              onChange={(e) => { setFilters((fs) => fs.map((x, j) => (j === i ? { ...x, op: e.target.value as FilterOp } : x))); }}
              style={{ ...inputStyle, width: 90 }}
            >
              {FILTER_OPS.map((op) => <option key={op} value={op}>{OP_LABEL[op]}</option>)}
            </select>
            {f.op !== 'exists' && (
              <input
                data-id="filter-value" placeholder="value" value={f.value}
                onChange={(e) => { setFilters((fs) => fs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x))); }}
                onKeyDown={(e) => { if (e.key === 'Enter') void run(0); }}
                style={{ ...inputStyle, flex: 1 }}
              />
            )}
            <button data-id="filter-remove" onClick={() => { setFilters((fs) => fs.filter((_, j) => j !== i)); }} style={btnStyle('default')}>✕</button>
          </div>
        ))}
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <button data-id="add-filter" onClick={() => { setFilters((fs) => [...fs, { field: '', op: 'eq', value: '' }]); }} style={btnStyle('default')}>+ Filter</button>
          <span style={{ fontSize: 11, color: 'var(--text-secondary)', marginLeft: 6 }}>Sort</span>
          <input data-id="sort-field" value={sortField} onChange={(e) => { setSortField(e.target.value); }} style={{ ...inputStyle, width: 120 }} />
          <select data-id="sort-dir" value={sortDir} onChange={(e) => { setSortDir(e.target.value as 'asc' | 'desc'); }} style={{ ...inputStyle, width: 70 }}>
            <option value="desc">desc</option><option value="asc">asc</option>
          </select>
          <button data-id="run-query" onClick={() => void run(0)} disabled={loading} style={btnStyle('primary', loading)}>{loading ? 'Running…' : 'Apply'}</button>
        </div>
      </div>

      {error && <div style={errorBoxStyle}>{error}</div>}

      {result && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, color: 'var(--text-secondary)' }}>
            <span>{result.rowCount} shown · {result.durationMs}ms</span>
            <div style={{ flex: 1 }} />
            <button data-id="page-prev" onClick={() => void run(page - 1)} disabled={page <= 0 || loading} style={btnStyle('default', page <= 0 || loading)}>‹ Prev</button>
            <span>{page + 1} / {pages}</span>
            <button data-id="page-next" onClick={() => void run(page + 1)} disabled={page + 1 >= pages || loading} style={btnStyle('default', page + 1 >= pages || loading)}>Next ›</button>
          </div>
          <RowGrid
            rows={result.rows} dataCols={dataCols} writes={writes}
            onExpand={setExpanded}
            onEdit={(doc) => { setEditing({ mode: 'edit', doc }); }}
            onDuplicate={(doc) => { const d = { ...doc }; delete d._id; delete d._created; delete d._updated; setEditing({ mode: 'insert', doc: d }); }}
            onDelete={(id) => void del(id)}
          />
        </>
      )}

      {expanded && <JsonViewerModal title="Row" doc={expanded} onClose={() => { setExpanded(null); }} />}
      {editing && (
        <DocEditorModal
          title={editing.mode === 'insert' ? `Insert into ${collection}` : `Edit ${collection}`}
          initial={editing.doc}
          onClose={() => { setEditing(null); }}
          onSave={(doc) => saveDoc(doc, editing.mode === 'insert' ? 'insert' : 'update')}
        />
      )}
    </div>
  );
}

function RowGrid({
  rows, dataCols, writes, onExpand, onEdit, onDuplicate, onDelete,
}: {
  rows: Record<string, unknown>[];
  dataCols: string[];
  writes: boolean;
  onExpand: (doc: Record<string, unknown>) => void;
  onEdit: (doc: Record<string, unknown>) => void;
  onDuplicate: (doc: Record<string, unknown>) => void;
  onDelete: (id: string) => void;
}) {
  if (rows.length === 0) return <Centered>No rows match.</Centered>;
  const cell = (v: unknown): string =>
    v == null ? 'NULL' : typeof v === 'object' ? JSON.stringify(v) : primitiveToString(v);
  return (
    <div data-id="results-table" style={{ overflowX: 'auto', border: '1px solid var(--border-primary)', borderRadius: 4 }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', fontFamily: 'var(--font-mono, monospace)', fontSize: 12 }}>
        <thead>
          <tr>
            <th style={thStyle}>_id</th>
            {dataCols.map((c) => <th key={c} style={thStyle}>{c}</th>)}
            <th style={{ ...thStyle, textAlign: 'right' }}>actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const id = row._id == null ? String(i) : primitiveToString(row._id);
            return (
              <tr key={id} style={{ cursor: 'pointer' }}>
                <td data-id="row-id-cell" style={tdStyle} onClick={() => { onExpand(row); }} title="Expand">{cell(row._id)}</td>
                {dataCols.map((c) => (
                  <td data-id="row-value-cell" key={c} style={{ ...tdStyle, color: row[c] == null ? 'var(--text-muted, #999)' : 'var(--text-primary)' }} onClick={() => { onExpand(row); }} title={cell(row[c])}>{cell(row[c])}</td>
                ))}
                <td style={{ ...tdStyle, textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {writes && <button data-id="row-edit" onClick={() => { onEdit(row); }} style={iconBtn} title="Edit">✎</button>}
                  {writes && <button data-id="row-duplicate" onClick={() => { onDuplicate(row); }} style={iconBtn} title="Duplicate">⧉</button>}
                  {writes && <button data-id="row-delete" onClick={() => { onDelete(id); }} style={{ ...iconBtn, color: 'var(--error, #dc2626)' }} title="Delete">🗑</button>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const thStyle: React.CSSProperties = {
  padding: '6px 10px', borderBottom: '2px solid var(--border-primary)', background: 'var(--bg-secondary)',
  textAlign: 'left', fontWeight: 600, whiteSpace: 'nowrap', color: 'var(--text-primary)', position: 'sticky', top: 0,
};
const tdStyle: React.CSSProperties = {
  padding: '4px 10px', borderBottom: '1px solid var(--border-primary)', whiteSpace: 'nowrap',
  maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', color: 'var(--text-primary)',
};
const iconBtn: React.CSSProperties = {
  background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 13, padding: '2px 5px', color: 'var(--text-secondary)',
};

// ── JSON editor modal (insert / edit) ────────────────────────────────────────
function DocEditorModal({
  title, initial, onClose, onSave,
}: { title: string; initial: Record<string, unknown>; onClose: () => void; onSave: (doc: Record<string, unknown>) => Promise<void> }) {
  const [text, setText] = useState(() => JSON.stringify(initial, null, 2));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = useCallback(async () => {
    let doc: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Document must be a JSON object');
      doc = parsed as Record<string, unknown>;
    } catch (e) {
      setError(`Invalid JSON: ${(e as Error).message}`);
      return;
    }
    setSaving(true);
    setError(null);
    try { await onSave(doc); }
    catch (e: unknown) { console.error('[DatabasePanel:dbMutate:saveDoc]', JSON.stringify({ title, id: typeof doc._id === 'string' ? doc._id : undefined, error: e instanceof Error ? e.message : String(e) }), e instanceof Error ? e.stack : undefined); setError(e instanceof Error ? e.message : String(e)); setSaving(false); }
  }, [text, onSave]);

  return (
    <Modal title={title} onClose={onClose} width={680}>
      <CodeEditor value={text} onChange={setText} language="json" minHeight={300} maxHeight={460} dataId="doc-editor" onSubmit={() => void save()} />
      {error && <div style={errorBoxStyle}>{error}</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button data-id="doc-cancel" onClick={onClose} style={btnStyle('default')}>Cancel</button>
        <button data-id="doc-save" onClick={() => void save()} disabled={saving} style={btnStyle('primary', saving)}>{saving ? 'Saving…' : `Save  ${shortcut('Enter')}`}</button>
      </div>
    </Modal>
  );
}

function JsonViewerModal({ title, doc, onClose }: { title: string; doc: Record<string, unknown>; onClose: () => void }) {
  const text = useMemo(() => JSON.stringify(doc, null, 2), [doc]);
  return (
    <Modal title={title} onClose={onClose} width={680}>
      <CodeEditor value={text} language="json" minHeight={300} maxHeight={460} readOnly />
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button data-id="json-copy" onClick={() => void navigator.clipboard.writeText(text)} style={btnStyle('default')}>Copy JSON</button>
        <button data-id="json-viewer-close" onClick={onClose} style={btnStyle('primary')}>Close</button>
      </div>
    </Modal>
  );
}

// ── SQL console ──────────────────────────────────────────────────────────────
interface ExecResult {
  kind: 'read' | 'write';
  columns?: string[];
  rows?: Record<string, unknown>[];
  rowCount?: number;
  affected?: number;
  dryRun?: boolean;
  durationMs: number;
}
const SQL_HISTORY_KEY = 'ugly-studio:sql-history';

function SqlConsole({ mode, writes, onWantWrites }: { mode: DbMode; writes: boolean; onWantWrites: () => void }) {
  const socket = useSocket();
  const [sql, setSql] = useState('select * from todo order by created desc limit 20;');
  const [force, setForce] = useState(false);
  const [result, setResult] = useState<ExecResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(SQL_HISTORY_KEY) ?? '[]') as string[]; } catch { return []; }
  });

  const pushHistory = useCallback((q: string) => {
    setHistory((h) => {
      const next = [q, ...h.filter((x) => x !== q)].slice(0, 25);
      try { localStorage.setItem(SQL_HISTORY_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const exec = useCallback(
    async (dryRun: boolean) => {
      const q = sql.trim();
      if (!q) return;
      setLoading(true);
      setError(null);
      try {
        const res = await socket.request('dbExec', { mode, sql: q, allowWrite: writes, force, dryRun });
        setResult(res);
        pushHistory(q);
      } catch (e: unknown) {
        console.error('[DatabasePanel:dbExec]', JSON.stringify({ mode, sql: q, allowWrite: writes, force, dryRun, error: e instanceof Error ? e.message : String(e) }), e instanceof Error ? e.stack : undefined);
        setError(e instanceof Error ? e.message : String(e));
        setResult(null);
      } finally {
        setLoading(false);
      }
    },
    [sql, socket, mode, writes, force, pushHistory],
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <CodeEditor value={sql} onChange={setSql} language="sql" minHeight={140} dataId="sql-editor" accent={mode === 'prod' && writes ? 'danger' : 'none'} onSubmit={() => void exec(false)} />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button data-id="sql-run" onClick={() => void exec(false)} disabled={loading} style={btnStyle('primary', loading)}>{loading ? 'Running…' : `Run  ${shortcut('Enter')}`}</button>
        <button data-id="sql-dryrun" onClick={() => void exec(true)} disabled={loading} style={btnStyle('default', loading)} title="Run UPDATE/DELETE in a transaction and roll back — shows affected rows without committing">Dry-run</button>
        {!writes && <button data-id="sql-enable-writes" onClick={onWantWrites} style={btnStyle('default')}>🔒 Enable writes…</button>}
        <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'inline-flex', gap: 4, alignItems: 'center' }} title="Allow DROP/TRUNCATE/ALTER and WHERE-less UPDATE/DELETE">
          <input data-id="sql-force-toggle" type="checkbox" checked={force} onChange={(e) => { setForce(e.target.checked); }} /> Force destructive
        </label>
        {history.length > 0 && (
          <select
            data-id="sql-history"
            value="" onChange={(e) => { if (e.target.value) setSql(e.target.value); }}
            style={{ ...inputStyle, marginLeft: 'auto', maxWidth: 260 }} title="Query history"
          >
            <option value="">History…</option>
            {history.map((h, i) => <option key={i} value={h}>{h.replace(/\s+/g, ' ').slice(0, 80)}</option>)}
          </select>
        )}
      </div>

      {error && <div style={errorBoxStyle}>{error}</div>}
      {result?.kind === 'read' && (
        <>
          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{result.rowCount} row{result.rowCount === 1 ? '' : 's'} · {result.durationMs}ms</span>
          <ResultsTable columns={result.columns ?? []} rows={result.rows ?? []} />
        </>
      )}
      {result?.kind === 'write' && (
        <div style={{ padding: 10, background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)', borderRadius: 4, fontSize: 13, color: 'var(--text-primary)' }}>
          {result.dryRun ? '🧪 Dry-run (rolled back): ' : '✓ '}<b>{result.affected ?? 0}</b> row{result.affected === 1 ? '' : 's'} {result.dryRun ? 'would be affected' : 'affected'} · {result.durationMs}ms
        </div>
      )}
    </div>
  );
}

// ── Schema ───────────────────────────────────────────────────────────────────
interface SchemaResult {
  columns: { name: string; type: string }[];
  indexes: { name: string; def: string }[];
  count: number;
}
function SchemaView({ mode }: { mode: DbMode }) {
  const socket = useSocket();
  const [collections, setCollections] = useState<Collection[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [schema, setSchema] = useState<SchemaResult | null>(null);
  const [tsType, setTsType] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    socket.request('dbCollections', { mode })
      .then((res) => { setCollections(res.collections); if (!selected && res.collections[0]) setSelected(res.collections[0].name); })
      .catch((e: unknown) => { console.error('[DatabasePanel:dbCollections:schema]', JSON.stringify({ mode, error: e instanceof Error ? e.message : String(e) }), e instanceof Error ? e.stack : undefined); setError(e instanceof Error ? e.message : String(e)); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  useEffect(() => {
    if (!selected) return;
    setSchema(null);
    setError(null);
    socket.request('dbSchema', { mode, collection: selected })
      .then(setSchema)
      .catch((e: unknown) => { console.error('[DatabasePanel:dbSchema]', JSON.stringify({ mode, collection: selected, error: e instanceof Error ? e.message : String(e) }), e instanceof Error ? e.stack : undefined); setError(e instanceof Error ? e.message : String(e)); });
    void loadTsInterface(selected).then(setTsType);
  }, [selected, mode, socket]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <select data-id="schema-collection-select" value={selected} onChange={(e) => { setSelected(e.target.value); }} style={{ ...inputStyle, maxWidth: 240 }}>
        {collections.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
      </select>
      {error && <div style={errorBoxStyle}>{error}</div>}
      {schema && (
        <>
          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{schema.count.toLocaleString()} rows</span>
          {tsType && (
            <div>
              <span style={sectionHeaderStyle}>TypeScript</span>
              <CodeEditor value={tsType} language="json" readOnly minHeight={80} maxHeight={260} />
            </div>
          )}
          <div>
            <span style={sectionHeaderStyle}>Columns</span>
            <ResultsTable columns={['name', 'type']} rows={schema.columns} />
          </div>
          <div>
            <span style={sectionHeaderStyle}>Indexes</span>
            <ResultsTable columns={['name', 'def']} rows={schema.indexes} />
          </div>
        </>
      )}
    </div>
  );
}

/** Best-effort: pull the collection's TS interface out of the project's
 *  shared/collections.ts so the schema view shows the intended shape. */
async function loadTsInterface(collection: string): Promise<string | null> {
  const proj = getActiveRepoPath();
  if (!proj) return null;
  try {
    const src = await native.fs.readFile(`${proj}/shared/collections.ts`);
    // collections.ts maps a collection name → an interface; find that interface.
    const re = new RegExp(`${collection}\\s*:\\s*\\{[\\s\\S]*?type:\\s*\\{\\}\\s*as\\s*([A-Za-z0-9_]+)`);
    const m = re.exec(src);
    const typeName = m?.[1];
    if (!typeName) return null;
    const ire = new RegExp(`(?:export\\s+)?interface\\s+${typeName}\\b[\\s\\S]*?\\n\\}`);
    return ire.exec(src)?.[0] ?? null;
  } catch {
    return null;
  }
}

// ── Export ───────────────────────────────────────────────────────────────────
function ExportMenu({ collection, columns, rows }: { collection: string; columns: string[]; rows: Record<string, unknown>[] }) {
  const download = (filename: string, text: string, type: string): void => {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); }, 1000);
  };
  const asJson = (): void => { download(`${collection}.json`, JSON.stringify(rows, null, 2), 'application/json'); };
  const asCsv = (): void => {
    const esc = (v: unknown): string => {
      const s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : primitiveToString(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [columns.join(','), ...rows.map((r) => columns.map((c) => esc(r[c])).join(','))].join('\n');
    download(`${collection}.csv`, csv, 'text/csv');
  };
  return (
    <div style={{ display: 'inline-flex', gap: 4 }}>
      <button data-id="export-json" onClick={asJson} style={btnStyle('default')} title="Export current page as JSON" disabled={rows.length === 0}>JSON</button>
      <button data-id="export-csv" onClick={asCsv} style={btnStyle('default')} title="Export current page as CSV" disabled={rows.length === 0}>CSV</button>
    </div>
  );
}

// ── primitives ───────────────────────────────────────────────────────────────
function Modal({ title, onClose, width, children }: { title: string; onClose: () => void; width?: number; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div
      onMouseDown={(e) => { if (e.target === ref.current) onClose(); }}
      ref={ref}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 24 }}
    >
      <div style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-primary)', borderRadius: 8, width: width ?? 560, maxWidth: '100%', maxHeight: '90vh', overflow: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{title}</span>
          <button data-id="modal-close" onClick={onClose} style={iconBtn}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'flex', justifyContent: 'center', padding: 24, color: 'var(--text-secondary)', fontSize: 12 }}>{children}</div>;
}
