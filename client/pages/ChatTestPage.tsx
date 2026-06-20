import React, { useEffect, useRef, useState } from 'react';
import { Button, Card, Input, PageLayout, Text, useApp } from 'ugly-app/client';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  created: number;
}

interface LogEntry {
  ts: number;
  msg: string;
  kind: 'info' | 'ok' | 'err';
}

function fmt(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export default function ChatTestPage(): React.ReactElement {
  const { socket } = useApp();
  const [conversationId] = useState('test-conv-1');
  const [message, setMessage] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState('');
  const [loading, setLoading] = useState(false);
  const [subscribed, setSubscribed] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  function addLog(msg: string, kind: LogEntry['kind'] = 'info'): void {
    const prefix = '[ChatTest]';
    if (kind === 'err') console.error(prefix, msg);
    else console.log(prefix, msg);
    setLogs((prev) => [...prev, { ts: Date.now(), msg, kind }]);
  }

  // Auto-subscribe on mount
  useEffect(() => {
    let cancelled = false;
    const doSubscribe = async () => {
      const started = Date.now();
      addLog(`Subscribing to conversation: ${conversationId}`);
      try {
        await (socket.send as (type: string, data: object) => Promise<unknown>)('conv:subscribe', { conversationId });
        if (!cancelled) {
          setSubscribed(true);
          addLog(`Subscribed in ${fmt(Date.now() - started)}`, 'ok');
        }
      } catch (err) {
        if (!cancelled) {
          addLog(`Subscribe failed: ${err instanceof Error ? err.message : String(err)}`, 'err');
        }
      }
    };
    void doSubscribe();
    return () => {
      cancelled = true;
      (socket.send as (type: string, data: object) => Promise<unknown>)('conv:unsubscribe', { conversationId }).catch(() => { /* noop */ });
    };
  }, [socket, conversationId]);

  // Listen for conversation events
  useEffect(() => {
    const unsubs: (() => void)[] = [];

    unsubs.push(socket.on('conv:message' as never, ((data: Record<string, unknown>) => {
      const m = data as { conversationId: string; messageId: string; userId: string; text: string; created: number };
      if (m.conversationId !== conversationId) return;
      const role = m.userId === 'ai' ? 'assistant' as const : 'user' as const;
      setMessages((prev) => {
        // Deduplicate by id (broadcast may send the message twice via NATS round-trip)
        if (prev.some((p) => p.id === m.messageId)) return prev;
        return [...prev, { id: m.messageId, role, text: m.text, created: m.created }];
      });
      if (role === 'assistant') setStreaming('');
    }) as never));

    unsubs.push(socket.on('conv:ai-stream-start' as never, (() => {
      setStreaming('');
      addLog('AI is responding…');
    }) as never));

    unsubs.push(socket.on('conv:ai-stream-chunk' as never, ((data: Record<string, unknown>) => {
      const d = data as { chunk: string; accumulated: string };
      setStreaming(d.accumulated);
    }) as never));

    unsubs.push(socket.on('conv:ai-stream-end' as never, ((data: Record<string, unknown>) => {
      const d = data as { text: string };
      addLog(`AI response complete — ${d.text.length} chars`, 'ok');
      setStreaming('');
    }) as never));

    return () => { for (const unsub of unsubs) unsub(); };
  }, [socket, conversationId]);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streaming]);

  async function handleSend(): Promise<void> {
    if (!message.trim() || !subscribed) return;
    setLoading(true);
    const started = Date.now();
    addLog(`Sending: "${message.slice(0, 50)}${message.length > 50 ? '…' : ''}"`);

    try {
      await (socket.send as (type: string, data: object) => Promise<unknown>)('conv:ai-message', {
        conversationId,
        text: message,
      });
      addLog(`Sent in ${fmt(Date.now() - started)}`, 'ok');
      setMessage('');
    } catch (err) {
      addLog(`Send failed: ${err instanceof Error ? err.message : String(err)}`, 'err');
    } finally {
      setLoading(false);
    }
  }

  return (
    <PageLayout
      header={
        <div>
          <a href="/test">← Tests</a>
        </div>
      }
    >
      <div>
        <h1>Chat Test</h1>

        {/* Connection status */}
        <Card>
          <Text size="sm" style={{ opacity: 0.6 }}>
            {subscribed ? `Connected to: ${conversationId}` : 'Connecting…'}
          </Text>
        </Card>

        {/* Messages */}
        <Card>
          <div
            data-id="chat-messages"
            style={{
              minHeight: 200,
              maxHeight: 400,
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              padding: 8,
            }}
          >
            {messages.length === 0 && !streaming && (
              <Text size="sm" style={{ opacity: 0.4, textAlign: 'center', marginTop: 40 }}>
                {subscribed ? 'No messages yet — send one below' : 'Connecting…'}
              </Text>
            )}
            {messages.map((m) => (
              <div
                key={m.id}
                data-role={m.role}
                style={{
                  alignSelf: m.role === 'assistant' ? 'flex-start' : 'flex-end',
                  maxWidth: '80%',
                  padding: '8px 12px',
                  borderRadius: 12,
                  background: m.role === 'assistant' ? 'rgba(255,255,255,0.08)' : 'rgba(80,140,255,0.2)',
                }}
              >
                <Text size="xs" style={{ opacity: 0.5 }}>
                  {m.role === 'assistant' ? 'AI' : 'You'}
                </Text>
                <Text size="sm">{m.text}</Text>
              </div>
            ))}
            {streaming && (
              <div
                data-id="chat-streaming"
                style={{
                  alignSelf: 'flex-start',
                  maxWidth: '80%',
                  padding: '8px 12px',
                  borderRadius: 12,
                  background: 'rgba(255,255,255,0.08)',
                }}
              >
                <Text size="xs" style={{ opacity: 0.5 }}>AI (streaming…)</Text>
                <Text size="sm">{streaming}</Text>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        </Card>

        {/* Input */}
        <Card>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <div style={{ flex: 1 }}>
              <Input
                label="Message"
                value={message}
                onChange={setMessage}
                placeholder={subscribed ? 'Type a message…' : 'Connecting…'}
              />
            </div>
            <Button
              data-id="chat-send"
              onClick={() => { void handleSend(); }}
              disabled={loading || !message.trim() || !subscribed}
            >
              {loading ? 'Sending…' : 'Send'}
            </Button>
          </div>
        </Card>

        {/* How it works */}
        <Card>
          <h2>How it works</h2>
          <ol>
            <li>Page auto-subscribes to conversation <code>{conversationId}</code> on mount</li>
            <li><code>conv:ai-message</code> sends your text and triggers an AI response</li>
            <li>AI responses stream back via <code>conv:ai-stream-chunk</code> messages</li>
            <li>Final messages are broadcast as <code>conv:message</code> to all subscribers</li>
            <li>Server-side: use <code>enableConversations(configurator, config)</code> in your server setup</li>
          </ol>
        </Card>

        {/* Log panel */}
        {logs.length > 0 && (
          <div data-id="chat-logs" style={{ marginTop: 8, fontSize: '0.85em', opacity: 0.7 }}>
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
