import React, { useState } from 'react';
import { Card, PageLayout, useApp } from 'ugly-app/client';

interface UploadEntry {
  name: string;
  size: number;
  type: string;
  url: string;
}

interface LogEntry {
  ts: number;
  msg: string;
  kind: 'info' | 'ok' | 'err';
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fmt(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export default function UploadTestPage(): React.ReactElement {
  const { socket } = useApp();
  const [uploads, setUploads] = useState<UploadEntry[]>([]);
  const [uploading, setUploading] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [dragOver, setDragOver] = useState(false);

  function addLog(msg: string, kind: LogEntry['kind'] = 'info') {
    const prefix = '[UploadTest]';
    if (kind === 'err') console.error(prefix, msg);
    else console.log(prefix, msg);
    setLogs((prev) => [...prev, { ts: Date.now(), msg, kind }]);
  }

  async function uploadFile(file: File): Promise<void> {
    setUploading(true);
    const started = Date.now();
    addLog(`Uploading "${file.name}" (${formatSize(file.size)}, ${file.type || 'unknown type'})`);
    try {
      const key = `uploads/${Date.now()}-${file.name}`;
      addLog(`Key: ${key}`);
      const url = await socket.uploadFile(file, key);
      addLog(`Done in ${fmt(Date.now() - started)} — ${url}`, 'ok');
      setUploads((prev) => [...prev, { name: file.name, size: file.size, type: file.type, url }]);
    } catch (err) {
      addLog(`Failed: ${err instanceof Error ? err.message : String(err)}`, 'err');
    } finally {
      setUploading(false);
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>): void {
    const file = e.target.files?.[0];
    if (file) void uploadFile(file);
  }

  function handleDrop(e: React.DragEvent): void {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) void uploadFile(file);
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
        <h1>Upload Test</h1>

        <Card>
          <div
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => { setDragOver(false); }}
            onDrop={handleDrop}
            style={{
              border: `2px dashed ${dragOver ? '#4f8' : '#666'}`,
              borderRadius: 8,
              padding: 32,
              textAlign: 'center',
              transition: 'border-color 0.2s',
            }}
          >
            <p>{dragOver ? 'Drop file here' : 'Drag & drop a file here, or click below'}</p>
            <input
              type="file"
              onChange={handleFileChange}
              disabled={uploading}
              style={{ marginTop: 8 }}
            />
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
            {uploading && <div>· waiting…</div>}
          </div>
        )}

        {uploads.length > 0 && (
          <Card>
            <h2>Uploaded Files</h2>
            {uploads.map((entry, i) => (
              <div key={i} style={{ marginBottom: 16 }}>
                <div>
                  <strong>{entry.name}</strong> — {formatSize(entry.size)} — {entry.type || 'unknown type'}
                </div>
                <div style={{ fontSize: '0.85em', wordBreak: 'break-all' }}>
                  <a href={entry.url} target="_blank" rel="noreferrer">{entry.url}</a>
                </div>
                {entry.type.startsWith('image/') && (
                  <img
                    src={entry.url}
                    alt={entry.name}
                    style={{ maxWidth: 320, maxHeight: 240, marginTop: 8, borderRadius: 4 }}
                  />
                )}
              </div>
            ))}
          </Card>
        )}

        <Card>
          <h2>How it works</h2>
          <ol>
            <li><code>socket.uploadFile(file, key)</code> requests a presigned URL from the server</li>
            <li>The file is PUT directly to the storage backend (MinIO locally, R2 in prod)</li>
            <li>The returned URL points to the uploaded file in the temp bucket</li>
            <li>To keep files long-term, promote them to the public bucket via <code>ctx.storage.moveToPublic()</code></li>
          </ol>
        </Card>
      </div>
    </PageLayout>
  );
}
