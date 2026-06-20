import React, { useState } from 'react';
import {
  Button,
  callImageGen,
  callTextGen,
  Card,
  Input,
  PageLayout,
} from 'ugly-app/client';
import type { ImageGenModel, TextGenModel } from 'ugly-app/shared';
import { imageGenModels, textGenModels } from 'ugly-app/shared';

type Mode = 'text' | 'image';
interface LogEntry {
  ts: number;
  msg: string;
  kind: 'info' | 'ok' | 'err';
}

function fmt(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export default function AITestPage(): React.ReactElement {
  const [mode, setMode] = useState<Mode>('text');
  const [prompt, setPrompt] = useState('');
  const [textModel, setTextModel] = useState<TextGenModel>(textGenModels[0]!);
  const [imageModel, setImageModel] = useState<ImageGenModel>(
    imageGenModels[0]!,
  );
  const [result, setResult] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);

  function addLog(msg: string, kind: LogEntry['kind'] = 'info'): void {
    const prefix = '[AITest]';
    if (kind === 'err') console.error(prefix, msg);
    else console.log(prefix, msg);
    setLogs((prev) => [...prev, { ts: Date.now(), msg, kind }]);
  }

  async function handleRun(): Promise<void> {
    if (!prompt.trim()) return;
    setLoading(true);
    setResult('');
    setImageUrl('');
    setLogs([]);

    const started = Date.now();
    const model = mode === 'text' ? textModel : imageModel;
    addLog(`Using model: ${model}`);
    addLog(`Sending ${mode} request…`);

    try {
      if (mode === 'text') {
        const text = await callTextGen({
          model: textModel,
          messages: [{ role: 'user', content: prompt }],
        });
        const elapsed = Date.now() - started;
        addLog(`Done in ${fmt(elapsed)} — ${text.length} chars`, 'ok');
        setResult(text);
      } else {
        const url = await callImageGen({
          model: imageModel,
          prompt,
        });
        const elapsed = Date.now() - started;
        addLog(`Done in ${fmt(elapsed)}`, 'ok');
        setImageUrl(url);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addLog(msg, 'err');
    } finally {
      setLoading(false);
    }
  }

  const model = mode === 'text' ? textModel : imageModel;
  const models: readonly string[] =
    mode === 'text' ? textGenModels : imageGenModels;

  return (
    <PageLayout
      header={
        <div>
          <a href="/test">← Tests</a>
        </div>
      }
    >
      <div>
        <h1>AI Test</h1>

        {/* Mode toggle */}
        <div>
          {(['text', 'image'] as Mode[]).map((m) => (
            <button key={m} onClick={() => { setMode(m); }}>
              {m}
            </button>
          ))}
        </div>

        <Card>
          <div>
            <div>
              <label>Model</label>
              <select
                value={model}
                onChange={(e) => {
                  if (mode === 'text') {
                    setTextModel(e.target.value as TextGenModel);
                  } else {
                    setImageModel(e.target.value as ImageGenModel);
                  }
                }}
              >
                {models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>

            <Input
              label="Prompt"
              value={prompt}
              onChange={setPrompt}
              placeholder={
                mode === 'text' ? 'Ask something…' : 'Describe an image…'
              }
            />

            <Button onClick={() => { void handleRun(); }} disabled={loading || !prompt.trim()}>
              {loading ? 'Running…' : 'Run'}
            </Button>
          </div>
        </Card>

        {/* Log panel — always visible once a run starts */}
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

        {/* Text result */}
        {result && (
          <Card>
            <p>Result</p>
            <pre>{result}</pre>
          </Card>
        )}

        {/* Image result */}
        {imageUrl && (
          <Card>
            <p>Result</p>
            <img src={imageUrl} alt="Generated" />
          </Card>
        )}
      </div>
    </PageLayout>
  );
}
