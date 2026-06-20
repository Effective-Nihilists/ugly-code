import { useCallback, useEffect, useMemo, useState } from 'react';
import { DevProdToggle } from '../components/DevProdToggle';
import { ResultsTable } from '../components/ResultsTable';
import { useSocket } from '../hooks/useSocket';
import { useStudioUserSetting } from '../hooks/useStudioUserSetting';
import { shortcut } from '../utils/platform';

type DbMode = 'dev' | 'prod';

interface Collection {
  name: string;
  estimatedCount: number;
}

const contentStyle: React.CSSProperties = {
  flex: 1,
  overflow: 'auto',
  padding: 12,
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
};

const errorBoxStyle: React.CSSProperties = {
  padding: 12,
  background: 'rgba(220, 38, 38, 0.08)',
  border: '1px solid var(--error, #dc2626)',
  borderRadius: 4,
  fontFamily: 'var(--font-mono, monospace)',
  fontSize: 12,
  color: 'var(--error, #dc2626)',
  whiteSpace: 'pre-wrap',
};

const itemStyle: React.CSSProperties = {
  padding: 12,
  background: 'var(--bg-secondary)',
  borderRadius: 4,
  border: '1px solid var(--border-primary)',
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  cursor: 'pointer',
};

const smallBtnStyle = (
  variant: 'default' | 'primary',
  disabled: boolean,
): React.CSSProperties => ({
  background:
    variant === 'primary'
      ? 'var(--accent-primary, #3b82f6)'
      : 'var(--bg-secondary)',
  border: variant === 'primary' ? 'none' : '1px solid var(--border-primary)',
  color:
    variant === 'primary'
      ? 'var(--text-on-accent, #fff)'
      : 'var(--text-primary)',
  borderRadius: 4,
  padding: '5px 14px',
  fontSize: 12,
  fontWeight: 600,
  cursor: disabled ? 'default' : 'pointer',
  opacity: disabled ? 0.5 : 1,
});

const sectionHeaderStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  color: 'var(--text-secondary)',
  textTransform: 'uppercase',
  letterSpacing: 0.5,
};

const inputStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono, monospace)',
  fontSize: 13,
  padding: 8,
  borderRadius: 4,
  border: '1px solid var(--border-primary)',
  background: 'var(--bg-secondary)',
  color: 'var(--text-primary)',
  outline: 'none',
  width: '100%',
  boxSizing: 'border-box',
};

export interface DatabasePanelProps {
  forceProd?: boolean;
  forceDev?: boolean;
  hideHeader?: boolean;
}

export function DatabasePanel({
  forceProd,
  forceDev,
  hideHeader: _hideHeader,
}: DatabasePanelProps = {}) {
  const socket = useSocket();

  const [storedMode, setStoredMode] = useStudioUserSetting<DbMode>(
    'panel.database.mode',
    'dev',
  );
  const mode: DbMode = forceProd ? 'prod' : forceDev ? 'dev' : storedMode;
  const modePinned = forceProd || forceDev;

  const [collections, setCollections] = useState<Collection[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const handleModeChange = useCallback(
    (m: DbMode) => {
      if (modePinned) return;
      setStoredMode(m);
      setCollections([]);
      setSelected(null);
      setListError(null);
      setListLoading(true);
    },
    [modePinned],
  );

  useEffect(() => {
    setListLoading(true);
    setListError(null);
    socket
      .request('dbCollections', { mode })
      .then((res) => setCollections(res.collections))
      .catch((e: unknown) => {
        setListError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setListLoading(false));
  }, [mode]);

  return (
    <div
      data-id="database-panel"
      style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
    >
      <div className="panel-toolbar">
        <span
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: 'var(--text-primary)',
          }}
        >
          Database
        </span>
        {!modePinned && (
          <DevProdToggle mode={mode} onModeChange={handleModeChange} />
        )}
      </div>

      <div style={contentStyle}>
        {selected ? (
          <CollectionDetail
            mode={mode}
            collection={selected}
            onBack={() => setSelected(null)}
          />
        ) : (
          <CollectionList
            collections={collections}
            loading={listLoading}
            error={listError}
            onSelect={setSelected}
          />
        )}
      </div>
    </div>
  );
}

function CollectionList({
  collections,
  loading,
  error,
  onSelect,
}: {
  collections: Collection[];
  loading: boolean;
  error: string | null;
  onSelect: (name: string) => void;
}) {
  if (loading) return <LoadingSpinner />;
  if (error) return <div style={errorBoxStyle}>{error}</div>;
  if (collections.length === 0) {
    return (
      <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
        No collections found
      </span>
    );
  }
  return (
    <>
      {collections.map((c) => (
        <div
          key={c.name}
          data-id={`collection-item-${c.name}`}
          style={itemStyle}
          onClick={() => onSelect(c.name)}
        >
          <span
            style={{
              fontFamily: 'var(--font-mono, monospace)',
              fontSize: 12,
              color: 'var(--text-primary)',
            }}
          >
            {c.name}
          </span>
          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            ~{c.estimatedCount.toLocaleString()} rows
          </span>
        </div>
      ))}
    </>
  );
}

function CollectionDetail({
  mode,
  collection,
  onBack,
}: {
  mode: DbMode;
  collection: string;
  onBack: () => void;
}) {
  const socket = useSocket();

  // Find by ID state
  const [docId, setDocId] = useState('');
  const [docResult, setDocResult] = useState<Record<string, unknown> | null>(
    null,
  );
  const [docMissing, setDocMissing] = useState(false);
  const [docLoading, setDocLoading] = useState(false);
  const [docError, setDocError] = useState<string | null>(null);
  const [docRan, setDocRan] = useState(false);

  // getQuery state
  const [pipeline, setPipeline] = useState(
    '[\n  { "$match": {} },\n  { "$limit": 20 }\n]',
  );
  const [queryColumns, setQueryColumns] = useState<string[]>([]);
  const [queryRows, setQueryRows] = useState<Record<string, unknown>[]>([]);
  const [queryRowCount, setQueryRowCount] = useState(0);
  const [queryDuration, setQueryDuration] = useState(0);
  const [queryLoading, setQueryLoading] = useState(false);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [queryRan, setQueryRan] = useState(false);

  const findById = useCallback(async () => {
    if (!docId.trim() || docLoading) return;
    setDocLoading(true);
    setDocError(null);
    setDocRan(true);
    try {
      const res = await socket.request('dbGetDoc', {
        mode,
        collection,
        id: docId.trim(),
      });
      setDocResult(res.doc);
      setDocMissing(res.doc === null);
    } catch (e: unknown) {
      setDocError(e instanceof Error ? e.message : String(e));
      setDocResult(null);
      setDocMissing(false);
    } finally {
      setDocLoading(false);
    }
  }, [docId, docLoading, mode, collection, socket]);

  const runPipeline = useCallback(async () => {
    if (!pipeline.trim() || queryLoading) return;
    // Client-side JSON sanity check for nicer errors
    try {
      const parsed = JSON.parse(pipeline);
      if (!Array.isArray(parsed)) {
        setQueryError('Pipeline must be a JSON array');
        setQueryRan(true);
        return;
      }
    } catch (e) {
      setQueryError(`Invalid JSON: ${(e as Error).message}`);
      setQueryRan(true);
      return;
    }
    setQueryLoading(true);
    setQueryError(null);
    setQueryRan(true);
    try {
      const res = await socket.request('dbGetQuery', {
        mode,
        collection,
        pipeline,
      });
      setQueryColumns(res.columns);
      setQueryRows(res.rows);
      setQueryRowCount(res.rowCount);
      setQueryDuration(res.durationMs);
    } catch (e: unknown) {
      setQueryError(e instanceof Error ? e.message : String(e));
      setQueryColumns([]);
      setQueryRows([]);
      setQueryRowCount(0);
    } finally {
      setQueryLoading(false);
    }
  }, [pipeline, queryLoading, mode, collection, socket]);

  const prettyDoc = useMemo(() => {
    if (!docResult) return '';
    return JSON.stringify(docResult, null, 2);
  }, [docResult]);

  return (
    <>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button
          onClick={onBack}
          style={smallBtnStyle('default', false)}
          data-id="collection-back-btn"
        >
          Back
        </button>
        <span
          data-id="selected-collection-name"
          style={{
            fontSize: 14,
            fontWeight: 600,
            color: 'var(--text-primary)',
            fontFamily: 'var(--font-mono, monospace)',
          }}
        >
          {collection}
        </span>
      </div>

      {/* Find by ID */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={sectionHeaderStyle}>Find by ID</span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            data-id="find-by-id-input"
            type="text"
            value={docId}
            onChange={(e) => setDocId(e.target.value)}
            placeholder="Document _id"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void findById();
              }
            }}
            style={inputStyle}
          />
          <button
            data-id="find-by-id-btn"
            onClick={() => void findById()}
            disabled={docLoading || !docId.trim()}
            style={smallBtnStyle('primary', docLoading || !docId.trim())}
          >
            {docLoading ? 'Finding...' : 'Find'}
          </button>
        </div>
        {docError && <div style={errorBoxStyle}>{docError}</div>}
        {docRan && !docError && !docLoading && docMissing && (
          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            Not found
          </span>
        )}
        {docRan && !docError && !docLoading && !docMissing && docResult && (
          <pre
            data-id="find-by-id-result"
            style={{
              margin: 0,
              padding: 10,
              background: 'var(--bg-secondary)',
              border: '1px solid var(--border-primary)',
              borderRadius: 4,
              fontFamily: 'var(--font-mono, monospace)',
              fontSize: 12,
              color: 'var(--text-primary)',
              overflow: 'auto',
              maxHeight: 320,
            }}
          >
            {prettyDoc}
          </pre>
        )}
      </div>

      {/* Run getQuery */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={sectionHeaderStyle}>Run getQuery pipeline</span>
        <textarea
          data-id="pipeline-input"
          value={pipeline}
          onChange={(e) => setPipeline(e.target.value)}
          placeholder='[{ "$match": { ... } }, { "$limit": 10 }]'
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              void runPipeline();
            }
          }}
          style={{
            ...inputStyle,
            resize: 'vertical',
            minHeight: 100,
          }}
        />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            data-id="run-getquery-btn"
            onClick={() => void runPipeline()}
            disabled={queryLoading || !pipeline.trim()}
            style={smallBtnStyle('primary', queryLoading || !pipeline.trim())}
          >
            {queryLoading ? 'Running...' : 'Run'}
          </button>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            {shortcut('Enter')}
          </span>
        </div>
        {queryError && <div style={errorBoxStyle}>{queryError}</div>}
        {queryRan && !queryError && !queryLoading && (
          <>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              {queryRowCount} row{queryRowCount === 1 ? '' : 's'} returned in{' '}
              {queryDuration}ms
            </span>
            <ResultsTable columns={queryColumns} rows={queryRows} />
          </>
        )}
      </div>
    </>
  );
}

function LoadingSpinner() {
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
