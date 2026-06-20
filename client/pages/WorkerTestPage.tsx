import React, { useState } from 'react';
import { Button, Card, PageLayout } from 'ugly-app/client';

interface LogEntry {
  ts: number;
  msg: string;
  kind: 'info' | 'ok' | 'err';
}

export default function WorkerTestPage(): React.ReactElement {
  const [logs, setLogs] = useState<LogEntry[]>([]);

  function addLog(msg: string, kind: LogEntry['kind'] = 'info'): void {
    setLogs((prev) => [...prev, { ts: Date.now(), msg, kind }]);
  }

  async function handleThrowException(): Promise<void> {
    const msg = `[WorkerTest] throw exception test ${Date.now()}`;
    addLog(`Triggering worker throw via /api/testWorkerThrow...`);
    try {
      const res = await fetch('/api/testWorkerThrow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: { message: msg } }),
      });
      const json = (await res.json()) as { error?: string; result?: unknown };
      if (json.error) {
        addLog(`Server returned error (expected): ${json.error}`, 'ok');
      } else {
        addLog(`Server returned unexpected success`, 'err');
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      addLog(`Fetch failed: ${errMsg}`, 'err');
    }
  }

  async function handleDbMutation(): Promise<void> {
    const text = `worker-test-${Date.now()}`;
    addLog(`Triggering DB mutation via /api/testWorkerDbMutation...`);
    try {
      const res = await fetch('/api/testWorkerDbMutation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: { text } }),
      });
      const json = (await res.json()) as { error?: string; result?: { id: string; verified: boolean } };
      if (json.error) {
        addLog(`Server error: ${json.error}`, 'err');
      } else if (json.result?.verified) {
        addLog(`DB write/read/delete verified (id: ${json.result.id})`, 'ok');
      } else {
        addLog(`DB mutation returned but verification failed`, 'err');
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      addLog(`Fetch failed: ${errMsg}`, 'err');
    }
  }

  async function handleConsoleError(): Promise<void> {
    const msg = `[WorkerTest] console.error test ${Date.now()}`;
    addLog(`Triggering server console.error via /api/testWorkerConsoleError...`);
    try {
      const res = await fetch('/api/testWorkerConsoleError', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: { message: msg } }),
      });
      const json = (await res.json()) as { error?: string; result?: { logged: boolean } };
      if (json.error) {
        addLog(`Server error: ${json.error}`, 'err');
      } else if (json.result?.logged) {
        addLog(`Server console.error logged: ${msg}`, 'ok');
      } else {
        addLog(`Unexpected response`, 'err');
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      addLog(`Fetch failed: ${errMsg}`, 'err');
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
        <h1>Worker Task Test</h1>

        <Card>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <h3>Throw Exception</h3>
            <Button data-id="btn-worker-throw" onClick={() => { void handleThrowException(); }}>
              Trigger Worker Throw
            </Button>
          </div>
        </Card>

        <Card>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <h3>DB Mutation</h3>
            <Button data-id="btn-worker-db" onClick={() => { void handleDbMutation(); }}>
              Trigger DB Write / Read / Delete
            </Button>
          </div>
        </Card>

        <Card>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <h3>Console Error</h3>
            <Button data-id="btn-worker-console-error" onClick={() => { void handleConsoleError(); }}>
              Trigger Server console.error
            </Button>
          </div>
        </Card>

        {logs.length > 0 && (
          <div data-id="worker-test-logs">
            {logs.map((entry, i) => (
              <div key={i}>
                {entry.kind === 'err' ? '\u2717' : entry.kind === 'ok' ? '\u2713' : '\u00b7'}{' '}
                {entry.msg}
              </div>
            ))}
          </div>
        )}
      </div>
    </PageLayout>
  );
}
