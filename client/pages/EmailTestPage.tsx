import React, { useState } from 'react';
import { Button, Card, PageLayout, useApp } from 'ugly-app/client';

interface SentEntry {
  userId: string;
  subject: string;
  id: string | null;
  sentAt: string;
}

interface LogEntry {
  ts: number;
  msg: string;
  kind: 'info' | 'ok' | 'err';
}

function fmt(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export default function EmailTestPage(): React.ReactElement {
  const { socket, userId: currentUserId } = useApp();
  const [userId, setUserId] = useState(currentUserId);
  const [subject, setSubject] = useState('Test email from ugly-app');
  const [html, setHtml] = useState('<h1>Hello!</h1>\n<p>This is a test email sent from ugly-app.</p>');
  const [replyId, setReplyId] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<SentEntry[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);

  function addLog(msg: string, kind: LogEntry['kind'] = 'info') {
    const prefix = '[EmailTest]';
    if (kind === 'err') console.error(prefix, msg);
    else console.log(prefix, msg);
    setLogs((prev) => [...prev, { ts: Date.now(), msg, kind }]);
  }

  async function handleSend(): Promise<void> {
    const trimmedUserId = userId.trim();
    if (!trimmedUserId) return;

    setSending(true);
    const started = Date.now();
    addLog(`Sending to user ${trimmedUserId} — subject: "${subject.trim() || 'Test email'}"${replyId.trim() ? ` — replyId: ${replyId.trim()}` : ''}`);
    try {
      await socket.request('sendTestEmail', {
        userId: trimmedUserId,
        subject: subject.trim() || 'Test email',
        html,
        id: replyId.trim() || undefined,
      });
      addLog(`Sent in ${fmt(Date.now() - started)}`, 'ok');
      setSent((prev) => [
        { userId: trimmedUserId, subject, id: replyId.trim() || null, sentAt: new Date().toISOString() },
        ...prev,
      ]);
    } catch (err) {
      addLog(`Failed: ${err instanceof Error ? err.message : String(err)}`, 'err');
    } finally {
      setSending(false);
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
        <h1>Email Test</h1>

        <Card>
          <h2>Send Email</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <label>
              <div style={{ marginBottom: 4, fontWeight: 500 }}>User ID</div>
              <input
                type="text"
                value={userId}
                onChange={(e) => { setUserId(e.target.value); }}
                placeholder="User ID to send email to"
                style={{ width: '100%', padding: 8, borderRadius: 4, border: '1px solid #444' }}
              />
            </label>
            <label>
              <div style={{ marginBottom: 4, fontWeight: 500 }}>Subject</div>
              <input
                type="text"
                value={subject}
                onChange={(e) => { setSubject(e.target.value); }}
                placeholder="Email subject"
                style={{ width: '100%', padding: 8, borderRadius: 4, border: '1px solid #444' }}
              />
            </label>
            <label>
              <div style={{ marginBottom: 4, fontWeight: 500 }}>Reply ID (optional)</div>
              <input
                type="text"
                value={replyId}
                onChange={(e) => { setReplyId(e.target.value); }}
                placeholder="e.g. order-123"
                style={{ width: '100%', padding: 8, borderRadius: 4, border: '1px solid #444' }}
              />
              <div style={{ fontSize: '0.8em', color: '#888', marginTop: 2 }}>
                Sets the +tag in the from address for reply correlation
              </div>
            </label>
            <label>
              <div style={{ marginBottom: 4, fontWeight: 500 }}>HTML Body</div>
              <textarea
                value={html}
                onChange={(e) => { setHtml(e.target.value); }}
                rows={6}
                style={{ width: '100%', padding: 8, borderRadius: 4, border: '1px solid #444', fontFamily: 'monospace', fontSize: '0.9em' }}
              />
            </label>
            <Button onClick={() => { void handleSend(); }} disabled={sending || !userId.trim()}>
              {sending ? 'Sending…' : 'Send Email'}
            </Button>
          </div>
        </Card>

        {/* Log panel */}
        {logs.length > 0 && (
          <div style={{ marginTop: 8, fontSize: '0.85em', opacity: 0.7 }}>
            {logs.map((entry, i) => (
              <div key={i}>
                {entry.kind === 'err' ? '✗' : entry.kind === 'ok' ? '✓' : '·'}{' '}
                {entry.msg}
              </div>
            ))}
            {sending && <div>· waiting…</div>}
          </div>
        )}

        {sent.length > 0 && (
          <Card>
            <h2>Sent Emails</h2>
            {sent.map((entry, i) => (
              <div key={i} style={{ marginBottom: 12, paddingBottom: 12, borderBottom: '1px solid #333' }}>
                <div><strong>User:</strong> {entry.userId}</div>
                <div><strong>Subject:</strong> {entry.subject}</div>
                {entry.id && <div><strong>Reply ID:</strong> {entry.id}</div>}
                <div style={{ fontSize: '0.8em', color: '#888' }}>{entry.sentAt}</div>
              </div>
            ))}
          </Card>
        )}

        <Card>
          <h2>How it works</h2>
          <ol>
            <li><code>sendEmail()</code> sends email via ugly.bot</li>
            <li>Emails are sent from <code>{'<projectId>'}@ugly.bot</code></li>
            <li>Replies are routed back to your app via <code>setOnEmail()</code> handler</li>
          </ol>
          <pre style={{ background: '#1a1a1a', padding: 12, borderRadius: 4, fontSize: '0.85em', overflow: 'auto' }}>{`// server/index.ts
import { sendEmail } from 'ugly-app';

await sendEmail({
  userId: 'user-id-here',
  subject: 'Hello',
  html: '<p>Hi there!</p>',
  id: 'thread-123', // optional — becomes <projectId>+thread-123@ugly.bot
});

// Receive replies:
configurator.setOnEmail(async (inbound) => {
  console.log(inbound.from, inbound.id, inbound.text);
});`}</pre>
        </Card>
      </div>
    </PageLayout>
  );
}
