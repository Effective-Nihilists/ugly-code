import React, { useState } from 'react';
import {
  Button,
  Card,
  Input,
  PageLayout,
  useApp,
} from 'ugly-app/client';

type Mode = 'search' | 'summarize' | 'enrich-web' | 'enrich-news';

interface LogEntry {
  ts: number;
  msg: string;
  kind: 'info' | 'ok' | 'err';
}

interface SearchItem {
  url: string;
  title: string;
  snippet: string;
  published?: number;
  thumbnail?: { url: string; width?: number; height?: number };
}

interface SearchResult {
  items: SearchItem[];
  related?: string[];
}

function fmt(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

const modes: { key: Mode; label: string }[] = [
  { key: 'search', label: 'Search' },
  { key: 'summarize', label: 'Summarize' },
  { key: 'enrich-web', label: 'Enrich Web' },
  { key: 'enrich-news', label: 'Enrich News' },
];

export default function KagiTestPage(): React.ReactElement {
  const { socket } = useApp();
  const [mode, setMode] = useState<Mode>('search');
  const [query, setQuery] = useState('');
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [searchResult, setSearchResult] = useState<SearchResult | null>(null);
  const [summaryResult, setSummaryResult] = useState('');

  function addLog(msg: string, kind: LogEntry['kind'] = 'info'): void {
    const prefix = '[KagiTest]';
    if (kind === 'err') console.error(prefix, msg);
    else console.log(prefix, msg);
    setLogs((prev) => [...prev, { ts: Date.now(), msg, kind }]);
  }

  function reset(): void {
    setLogs([]);
    setSearchResult(null);
    setSummaryResult('');
  }

  async function handleRun(): Promise<void> {
    setLoading(true);
    reset();

    const started = Date.now();
    addLog(`Mode: ${mode}`);

    try {
      if (mode === 'search') {
        if (!query.trim()) return;
        addLog(`Searching: "${query}"…`);
        const result = (await socket.request('kagiSearch', {
          query,
        })) as SearchResult;
        const elapsed = Date.now() - started;
        addLog(`Done in ${fmt(elapsed)} — ${result.items.length} results${result.related ? `, ${result.related.length} related` : ''}`, 'ok');
        setSearchResult(result);
      } else if (mode === 'summarize') {
        if (!url.trim() && !query.trim()) return;
        addLog(`Summarizing${url ? `: ${url}` : ' text input'}…`);
        const { summary } = (await socket.request('kagiSummarize', {
          url: url || undefined,
          text: !url ? query : undefined,
        })) as { summary: string };
        const elapsed = Date.now() - started;
        addLog(`Done in ${fmt(elapsed)} — ${summary.length} chars`, 'ok');
        setSummaryResult(summary);
      } else if (mode === 'enrich-web') {
        if (!query.trim()) return;
        addLog(`Enriching web: "${query}"…`);
        const result = (await socket.request('kagiEnrichWeb', {
          query,
        })) as SearchResult;
        const elapsed = Date.now() - started;
        addLog(`Done in ${fmt(elapsed)} — ${result.items.length} results`, 'ok');
        setSearchResult(result);
      } else {
        if (!query.trim()) return;
        addLog(`Enriching news: "${query}"…`);
        const result = (await socket.request('kagiEnrichNews', {
          query,
        })) as SearchResult;
        const elapsed = Date.now() - started;
        addLog(`Done in ${fmt(elapsed)} — ${result.items.length} results`, 'ok');
        setSearchResult(result);
      }
    } catch (err) {
      const elapsed = Date.now() - started;
      const msg = err instanceof Error ? err.message : String(err);
      addLog(`Failed in ${fmt(elapsed)}: ${msg}`, 'err');
    } finally {
      setLoading(false);
    }
  }

  const needsQuery = mode !== 'summarize' || !url.trim();
  const canRun =
    !loading &&
    (mode === 'summarize' ? url.trim() || query.trim() : query.trim());

  return (
    <PageLayout
      header={
        <div>
          <a href="/test">← Tests</a>
        </div>
      }
    >
      <div>
        <h1>Kagi Web Search Test</h1>

        {/* Mode toggle */}
        <div>
          {modes.map((m) => (
            <button
              key={m.key}
              onClick={() => {
                setMode(m.key);
                reset();
              }}
              style={{
                fontWeight: mode === m.key ? 'bold' : 'normal',
              }}
            >
              {m.label}
            </button>
          ))}
        </div>

        <Card>
          <div>
            {mode === 'summarize' && (
              <Input
                label="URL (leave empty to summarize text)"
                value={url}
                onChange={setUrl}
                placeholder="https://example.com/article"
              />
            )}

            {needsQuery && (
              <Input
                label={mode === 'summarize' ? 'Text to summarize' : 'Query'}
                value={query}
                onChange={setQuery}
                placeholder={
                  mode === 'summarize'
                    ? 'Paste text to summarize…'
                    : 'Search query…'
                }
              />
            )}

            <Button onClick={() => { void handleRun(); }} disabled={!canRun}>
              {loading ? 'Running…' : 'Run'}
            </Button>
          </div>
        </Card>

        {/* Log panel */}
        {logs.length > 0 && (
          <div>
            {logs.map((entry, i) => (
              <div key={i}>
                {entry.kind === 'err' ? '✗' : entry.kind === 'ok' ? '✓' : '·'}{' '}
                {entry.msg}
              </div>
            ))}
            {loading && <div>· waiting…</div>}
          </div>
        )}

        {/* Summary result */}
        {summaryResult && (
          <Card>
            <p>Summary</p>
            <pre style={{ whiteSpace: 'pre-wrap' }}>{summaryResult}</pre>
          </Card>
        )}

        {/* Search / enrich results */}
        {searchResult && (
          <div>
            {searchResult.items.map((item, i) => (
              <Card key={i}>
                <div>
                  <a href={item.url} target="_blank" rel="noreferrer">
                    <strong>{item.title}</strong>
                  </a>
                  <p style={{ fontSize: '0.85em', opacity: 0.7 }}>
                    {item.url}
                  </p>
                  <p>{item.snippet}</p>
                  {item.thumbnail && (
                    <img
                      src={item.thumbnail.url}
                      alt=""
                      style={{ maxWidth: 120 }}
                    />
                  )}
                </div>
              </Card>
            ))}
            {searchResult.related && searchResult.related.length > 0 && (
              <Card>
                <p>Related queries</p>
                <ul>
                  {searchResult.related.map((r, i) => (
                    <li key={i}>
                      <button
                        onClick={() => {
                          setQuery(r);
                        }}
                        style={{
                          background: 'none',
                          border: 'none',
                          cursor: 'pointer',
                          textDecoration: 'underline',
                        }}
                      >
                        {r}
                      </button>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </div>
        )}
      </div>
    </PageLayout>
  );
}
