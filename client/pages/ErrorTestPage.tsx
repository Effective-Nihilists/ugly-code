import React, { useState } from 'react';
import { Button, Card, captureClientError, PageLayout } from 'ugly-app/client';

interface LogEntry {
  ts: number;
  msg: string;
  kind: 'info' | 'ok' | 'err';
}

export default function ErrorTestPage(): React.ReactElement {
  const [logs, setLogs] = useState<LogEntry[]>([]);

  function addLog(msg: string, kind: LogEntry['kind'] = 'info'): void {
    setLogs((prev) => [...prev, { ts: Date.now(), msg, kind }]);
  }

  function handleClientConsoleError(): void {
    const msg = `[ErrorTest] console.error test ${Date.now()}`;
    console.error(msg);
    addLog(`Sent console.error: ${msg}`, 'ok');
  }

  function handleCaptureClientError(): void {
    const msg = `[ErrorTest] captureClientError test ${Date.now()}`;
    captureClientError(msg, new Error('Test client error'), { source: 'ErrorTestPage' });
    addLog(`Sent captureClientError: ${msg}`, 'ok');
  }

  function handleUnhandledError(): void {
    const msg = `[ErrorTest] unhandled throw test ${Date.now()}`;
    addLog(`Throwing unhandled error: ${msg}`, 'ok');
    setTimeout(() => {
      throw new Error(msg);
    }, 50);
  }

  function handleUnhandledRejection(): void {
    const msg = `[ErrorTest] unhandled rejection test ${Date.now()}`;
    addLog(`Triggering unhandled rejection: ${msg}`, 'ok');
    void Promise.reject(new Error(msg));
  }

  async function handleServerError(): Promise<void> {
    const msg = `[ErrorTest] server error test ${Date.now()}`;
    addLog(`Triggering server error via /api/triggerTestError...`);
    try {
      const res = await fetch('/api/triggerTestError', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: { message: msg } }),
      });
      const json = (await res.json()) as { error?: string; result?: unknown };
      if (json.error) {
        addLog(`Server returned error: ${json.error}`, 'ok');
      } else {
        addLog(`Server returned unexpected success`, 'err');
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
        <h1>Error Test</h1>

        <Card>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <h3>Client Errors</h3>
            <Button data-id="btn-console-error" onClick={handleClientConsoleError}>
              Trigger console.error
            </Button>
            <Button data-id="btn-capture-error" onClick={handleCaptureClientError}>
              Trigger captureClientError
            </Button>
            <Button data-id="btn-unhandled-error" onClick={handleUnhandledError}>
              Trigger Unhandled Error
            </Button>
            <Button data-id="btn-unhandled-rejection" onClick={handleUnhandledRejection}>
              Trigger Unhandled Rejection
            </Button>
          </div>
        </Card>

        <Card>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <h3>Server Errors</h3>
            <Button data-id="btn-server-error" onClick={() => { void handleServerError(); }}>
              Trigger Server Error
            </Button>
          </div>
        </Card>

        {logs.length > 0 && (
          <div data-id="error-test-logs">
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
