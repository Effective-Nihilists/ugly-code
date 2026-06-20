import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Card, PageLayout, Text, useApp } from 'ugly-app/client';

interface LogEntry {
  ts: number;
  msg: string;
  kind: 'info' | 'ok' | 'err';
}

interface Peer {
  userId: string;
  cursor?: { line: number; ch: number };
}

function fmt(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export default function CollabTestPage(): React.ReactElement {
  const { socket } = useApp();
  const [docId] = useState('test-doc-1');
  const [connected, setConnected] = useState(false);
  const [content, setContent] = useState('');
  const [peers, setPeers] = useState<Peer[]>([]);
  const [loading, setLoading] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const suppressUpdateRef = useRef(false);
  const unsubsRef = useRef<(() => void)[]>([]);

  function addLog(msg: string, kind: LogEntry['kind'] = 'info'): void {
    const prefix = '[CollabTest]';
    if (kind === 'err') console.error(prefix, msg);
    else console.log(prefix, msg);
    setLogs((prev) => [...prev, { ts: Date.now(), msg, kind }]);
  }

  function unsubAll(): void {
    for (const unsub of unsubsRef.current) unsub();
    unsubsRef.current = [];
  }

  // Listen for collab events via individual typed listeners
  useEffect(() => {
    const unsubs: (() => void)[] = [];

    unsubs.push(socket.on('collab:sync' as never, ((data: Record<string, unknown>) => {
      const d = data as { content: string };
      suppressUpdateRef.current = true;
      setContent(d.content);
      addLog(`Synced document (${d.content.length} chars)`, 'ok');
      setTimeout(() => { suppressUpdateRef.current = false; }, 0);
    }) as never));

    unsubs.push(socket.on('collab:update' as never, ((data: Record<string, unknown>) => {
      const d = data as { content: string };
      suppressUpdateRef.current = true;
      setContent(d.content);
      setTimeout(() => { suppressUpdateRef.current = false; }, 0);
    }) as never));

    unsubs.push(socket.on('collab:peers' as never, ((data: Record<string, unknown>) => {
      const d = data as { peerIds: string[] };
      setPeers(d.peerIds.map((userId) => ({ userId })));
      addLog(`Peers updated: ${d.peerIds.join(', ')}`, 'ok');
    }) as never));

    unsubs.push(socket.on('collab:awareness' as never, ((data: Record<string, unknown>) => {
      const d = data as { userId: string; cursor: { line: number; ch: number } };
      setPeers((prev) =>
        prev.map((p) => p.userId === d.userId ? { ...p, cursor: d.cursor } : p),
      );
    }) as never));

    unsubsRef.current = unsubs;
    return () => { unsubAll(); };
  }, [socket]);

  // Auto-connect on mount
  useEffect(() => {
    let cancelled = false;
    const doConnect = async () => {
      if (!docId.trim()) return;
      setLoading(true);
      const started = Date.now();
      addLog(`Connecting to document: ${docId}`);
      try {
        await (socket.send as (type: string, data: object) => Promise<unknown>)('collab:join', { docId });
        if (!cancelled) {
          setConnected(true);
          addLog(`Connected in ${fmt(Date.now() - started)}`, 'ok');
        }
      } catch (err) {
        if (!cancelled) addLog(`Connect failed: ${err instanceof Error ? err.message : String(err)}`, 'err');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void doConnect();
    return () => {
      cancelled = true;
      (socket.emit as (type: string, data: object) => void)('collab:leave', { docId });
    };
  }, [socket, docId]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleDisconnect(): void {
    (socket.emit as (type: string, data: object) => void)('collab:leave', { docId });
    setConnected(false);
    setContent('');
    setPeers([]);
    addLog('Disconnected', 'ok');
  }

  const handleContentChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newContent = e.target.value;
      setContent(newContent);

      // Don't send updates for remote changes
      if (suppressUpdateRef.current) return;

      // Send update to server
      (socket.emit as (type: string, data: object) => void)('collab:update', { docId, content: newContent });
    },
    [socket, docId],
  );

  const handleCursorMove = useCallback(() => {
    if (!connected || !textareaRef.current) return;
    const textarea = textareaRef.current;
    const pos = textarea.selectionStart;
    const textBefore = textarea.value.substring(0, pos);
    const lines = textBefore.split('\n');
    const line = lines.length - 1;
    const ch = lines[lines.length - 1]!.length;

    (socket.emit as (type: string, data: object) => void)('collab:awareness', { docId, cursor: { line, ch } });
  }, [socket, docId, connected]);

  return (
    <PageLayout
      header={
        <div>
          <a href="/test">← Tests</a>
        </div>
      }
    >
      <div>
        <h1>Collab Test</h1>

        {/* Connection status */}
        <Card>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Text size="sm" style={{ flex: 1, opacity: 0.6 }}>
              {connected ? `Connected to: ${docId}` : loading ? 'Connecting…' : 'Waiting for connection…'}
            </Text>
            {connected && (
              <Button data-id="collab-disconnect" onClick={() => { handleDisconnect(); }}>
                Disconnect
              </Button>
            )}
          </div>
        </Card>

        {/* Peers */}
        {peers.length > 0 && (
          <Card>
            <Text size="sm" weight="bold">Connected Peers ({peers.length})</Text>
            <div data-id="collab-peers" style={{ display: 'flex', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
              {peers.map((peer) => (
                <div
                  key={peer.userId}
                  style={{
                    padding: '4px 8px',
                    borderRadius: 12,
                    background: 'rgba(80,140,255,0.2)',
                    fontSize: '0.85em',
                  }}
                >
                  {peer.userId}
                  {peer.cursor && (
                    <span style={{ opacity: 0.5, marginLeft: 4 }}>
                      L{peer.cursor.line + 1}:{peer.cursor.ch}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </Card>
        )}

        {/* Editor */}
        <Card>
          <Text size="sm" weight="bold" style={{ marginBottom: 4 }}>
            {connected ? `Editing: ${docId}` : 'Connect to a document to start editing'}
          </Text>
          <textarea
            data-id="collab-editor"
            ref={textareaRef}
            value={content}
            onChange={handleContentChange}
            onSelect={handleCursorMove}
            onKeyUp={handleCursorMove}
            onClick={handleCursorMove}
            disabled={!connected}
            placeholder={connected ? 'Start typing… changes sync in real-time' : 'Connect to a document first'}
            style={{
              width: '100%',
              minHeight: 250,
              padding: 12,
              fontFamily: 'monospace',
              fontSize: 14,
              lineHeight: 1.5,
              background: 'rgba(255,255,255,0.05)',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 8,
              color: 'inherit',
              resize: 'vertical',
            }}
          />
          <Text size="xs" style={{ opacity: 0.4, marginTop: 4 }}>
            {content.length} characters
          </Text>
        </Card>

        {/* How it works */}
        <Card>
          <h2>How it works</h2>
          <ol>
            <li>Server uses <code>CollabServer</code> with Yjs CRDTs for conflict-free real-time editing</li>
            <li><code>collab:join</code> connects to a document and syncs the current state</li>
            <li><code>collab:update</code> sends local changes (Yjs handles merge/conflict resolution)</li>
            <li><code>collab:awareness</code> broadcasts cursor position and presence</li>
            <li>Changes are persisted via the <code>saveState</code> callback with configurable debouncing</li>
            <li>Cross-server sync via NATS ensures consistency across multiple app instances</li>
            <li>Server-side: use <code>enableCollab(configurator, config)</code> in your server setup</li>
          </ol>
        </Card>

        {/* Log panel */}
        {logs.length > 0 && (
          <div data-id="collab-logs" style={{ marginTop: 8, fontSize: '0.85em', opacity: 0.7 }}>
            {logs.map((entry, i) => (
              <div key={i} data-log-kind={entry.kind}>
                {entry.kind === 'err' ? '✗' : entry.kind === 'ok' ? '✓' : '·'}{' '}
                {entry.msg}
              </div>
            ))}
          </div>
        )}
      </div>
    </PageLayout>
  );
}
