import React from 'react';
import { Search, ChevronDown, ChevronRight } from 'lucide-react';
import { installUglyNative } from 'ugly-app/native';
import { getActiveProjectPath } from '../hooks/useSocket';
import { dispatchTool } from '../../agent/tools';
import { provenance, type SearchHit, type SearchResponse, type SearchMode } from '../../agent/tools/searchResponse';
import { resultLabel, snippet, parseGrepHits } from './codebaseSearchFormat';

const MODES: SearchMode[] = ['grep', 'fts', 'semantic', 'mixed'];

type State =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'response'; resp: SearchResponse }
  | { kind: 'grep'; hits: SearchHit[] }
  | { kind: 'error'; error: string };

/** Hybrid-search UI for the FilePanel: run the same four retrieval modes the
 *  coding agent uses (grep / fts / semantic / mixed) against the open project
 *  and compare rankings — each hit shows its provenance scores. */
export function CodebaseSearch({ onOpen }: { onOpen: (path: string, line: number) => void }): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [mode, setMode] = React.useState<SearchMode>('mixed');
  const [state, setState] = React.useState<State>({ kind: 'idle' });
  const limit = 10;

  const run = React.useCallback(async () => {
    const q = query.trim();
    const projectPath = getActiveProjectPath();
    if (!q || !projectPath) return;
    setState({ kind: 'loading' });
    try {
      if (mode === 'grep') {
        const text = await dispatchTool(
          'grep',
          { pattern: q, mode: 'exact', output_mode: 'content', head_limit: limit },
          { projectDir: projectPath },
        );
        setState({ kind: 'grep', hits: parseGrepHits(text) });
      } else {
        const resp = (await installUglyNative().invoke('codebase.search' as never, {
          projectPath, mode, query: q, limit,
        } as never)) as SearchResponse;
        setState({ kind: 'response', resp });
      }
    } catch (e) {
      // Ship to errorLog (browser Logger → errorLog) so a "search failed" is
      // diagnosable remotely — the in-panel error text alone is invisible when
      // the host is another machine. Carries mode/query/projectPath + stack.
      console.error(
        '[CodebaseSearch:search]',
        JSON.stringify({ mode, query: q, projectPath, limit, error: e instanceof Error ? e.message : String(e) }),
        e instanceof Error ? e.stack : undefined,
      );
      setState({ kind: 'error', error: (e as Error).message });
    }
  }, [query, mode]);

  const hits: SearchHit[] =
    state.kind === 'grep' ? state.hits
    : state.kind === 'response' && state.resp.status === 'ready' ? state.resp.results
    : [];

  const pill = (() => {
    if (state.kind === 'loading') return 'searching…';
    if (state.kind === 'error') return `error: ${state.error}`;
    if (state.kind === 'grep') return `${state.hits.length} hits`;
    if (state.kind === 'response') {
      return state.resp.status === 'ready' ? `${state.resp.results.length} hits` : state.resp.status;
    }
    return '';
  })();

  return (
    <div style={S.root} data-id="codebase-search">
      <button style={S.header} onClick={() => { setOpen((o) => !o); }}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <Search size={13} />
        <span style={{ fontWeight: 600 }}>Search</span>
        {pill && <span style={S.pill}>{pill}</span>}
      </button>
      {open && (
        <div style={S.body}>
          <input
            data-id="codebase-search-input"
            style={S.input}
            placeholder="Search the codebase…"
            value={query}
            onChange={(e) => { setQuery(e.target.value); }}
            onKeyDown={(e) => { if (e.key === 'Enter') void run(); }}
          />
          <div style={S.tabs}>
            {MODES.map((m) => (
              <button
                key={m}
                data-id={`codebase-search-mode-${m}`}
                onClick={() => { setMode(m); }}
                style={{ ...S.tab, ...(mode === m ? S.tabActive : {}) }}
                title={
                  m === 'grep' ? 'ripgrep regex/exact'
                  : m === 'fts' ? 'full-text keyword (BM25)'
                  : m === 'semantic' ? 'embedding search'
                  : 'fts + semantic, cross-encoder re-ranked'
                }
              >
                {m}
              </button>
            ))}
            <button data-id="codebase-search-go" style={S.go} onClick={() => void run()}>Go</button>
          </div>
          <div style={S.results}>
            {hits.map((h, i) => (
              <div key={`${h.file_path}:${h.start_line}:${i}`} style={S.hit}>
                <button
                  style={S.hitLabel}
                  onClick={() => { onOpen(h.file_path, h.start_line); }}
                  title={h.file_path}
                >
                  {resultLabel(h)}
                </button>
                {h.mode !== 'grep' && <span style={S.prov}>{provenance(h)}</span>}
                <pre style={S.snippet}>{snippet(h.content)}</pre>
              </div>
            ))}
            {state.kind === 'response' && state.resp.status !== 'ready' && (
              <div style={S.note}>{state.resp.status === 'unavailable' ? state.resp.error : state.resp.status}</div>
            )}
            {state.kind === 'error' && <div style={S.note}>{state.error}</div>}
          </div>
        </div>
      )}
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  root: { borderBottom: '1px solid var(--border)', fontSize: 12 },
  header: { display: 'flex', alignItems: 'center', gap: 6, width: '100%', padding: '6px 8px', background: 'transparent', border: 'none', color: 'var(--text-primary)', cursor: 'pointer' },
  pill: { marginLeft: 'auto', fontSize: 10, color: 'var(--text-muted)' },
  body: { padding: '0 8px 8px' },
  input: { width: '100%', boxSizing: 'border-box', padding: '5px 8px', fontSize: 12, background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 6 },
  tabs: { display: 'flex', gap: 4, marginTop: 6, alignItems: 'center' },
  tab: { padding: '2px 8px', fontSize: 11, background: 'var(--bg-secondary)', color: 'var(--text-secondary)', border: '1px solid var(--border)', borderRadius: 5, cursor: 'pointer' },
  tabActive: { background: 'var(--accent, #3b82f6)', color: '#fff', borderColor: 'transparent' },
  go: { marginLeft: 'auto', padding: '2px 10px', fontSize: 11, fontWeight: 600, background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 5, cursor: 'pointer' },
  results: { marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8, maxHeight: '40vh', overflowY: 'auto' },
  hit: { display: 'flex', flexDirection: 'column', gap: 2 },
  hitLabel: { textAlign: 'left', background: 'transparent', border: 'none', color: 'var(--accent, #3b82f6)', cursor: 'pointer', padding: 0, fontSize: 11, fontFamily: 'var(--font-mono, monospace)' },
  prov: { fontSize: 10, color: 'var(--text-muted)' },
  snippet: { margin: 0, whiteSpace: 'pre', overflowX: 'auto', fontSize: 11, fontFamily: 'var(--font-mono, monospace)', color: 'var(--text-secondary)', background: 'var(--bg-secondary)', padding: 6, borderRadius: 4 },
  note: { fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' },
};
