import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AudioRecorder,
  BlobVisualizer,
  Button,
  Card,
  Input,
  MicVisualizer,
  PageLayout,
  WaveVisualizer,
  useApp,
} from 'ugly-app/client';
import type {
  AudioVisualizer,
  BlobStyleType,
  UglyBotSocket,
} from 'ugly-app/client';

// ─── Types ───────────────────────────────────────────────────────────────────

type Tab = 'stt' | 'tts';
type STTMode = 'continuous' | 'push-to-talk';

type CanvasVizType = 'wave';
type VizType = CanvasVizType | 'mic' | BlobStyleType;

const vizOptions: { key: VizType; label: string }[] = [
  { key: 'wave', label: 'Wave' },
  { key: 'mic', label: 'Mic Bars' },
  { key: 'organic', label: 'Blob: Organic' },
  { key: 'metaball', label: 'Blob: Metaball' },
  { key: 'siri', label: 'Blob: Siri' },
  { key: 'particle', label: 'Blob: Particle' },
  { key: 'orbs', label: 'Blob: Orbs' },
];

const canvasVizTypes = new Set<string>(['wave']);
const blobVizTypes = new Set<string>([
  'organic',
  'metaball',
  'siri',
  'particle',
  'orbs',
]);

interface LogEntry {
  ts: number;
  msg: string;
  kind: 'info' | 'ok' | 'err';
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmt(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function createCanvasViz(_type: CanvasVizType): AudioVisualizer {
  // CanvasVizType currently has a single value; expand the switch when more land.
  return new WaveVisualizer();
}

function pcm16ToFloat32(buffer: ArrayBuffer): Float32Array {
  const int16 = new Int16Array(buffer);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    float32[i] = (int16[i] ?? 0) / 32768;
  }
  return float32;
}

// ─── Canvas Visualizer Wrapper ───────────────────────────────────────────────

function CanvasVizView({
  type,
  analyzer,
}: {
  type: CanvasVizType;
  analyzer: AnalyserNode | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const vizRef = useRef<AudioVisualizer | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Match canvas resolution to display size
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    const viz = createCanvasViz(type);
    vizRef.current = viz;
    if (analyzer) viz.setAnalyzer(analyzer);
    void viz.attach(canvas);
    return () => {
      viz.detach();
      vizRef.current = null;
    };
  }, [type, analyzer]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: '100%', height: 200, borderRadius: 8, background: '#111' }}
    />
  );
}

// ─── Visualizer Switcher ─────────────────────────────────────────────────────

function VisualizerView({
  vizType,
  analyzer,
}: {
  vizType: VizType;
  analyzer: AnalyserNode | null;
}) {
  if (canvasVizTypes.has(vizType)) {
    return <CanvasVizView type={vizType as CanvasVizType} analyzer={analyzer} />;
  }
  if (vizType === 'mic') {
    return analyzer ? (
      <MicVisualizer analyzer={analyzer} height={200} />
    ) : (
      <div style={{ height: 200, background: '#111', borderRadius: 8 }} />
    );
  }
  if (blobVizTypes.has(vizType)) {
    return (
      <div style={{ height: 300, display: 'flex', overflow: 'hidden', borderRadius: 8, background: '#111', pointerEvents: 'none' }}>
        <BlobVisualizer
          style={vizType as BlobStyleType}
          analyzer={analyzer}
        />
      </div>
    );
  }
  return null;
}

// ─── Mic Analyzer Hook ──────────────────────────────────────────────────────

function useMicAnalyzer() {
  const ctxRef = useRef<AudioContext | null>(null);
  const analyzerRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [analyzer, setAnalyzer] = useState<AnalyserNode | null>(null);

  const start = useCallback(async () => {
    if (ctxRef.current) return analyzerRef.current;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    const ctx = new AudioContext();
    const source = ctx.createMediaStreamSource(stream);
    const node = ctx.createAnalyser();
    node.fftSize = 2048;
    source.connect(node);
    ctxRef.current = ctx;
    analyzerRef.current = node;
    streamRef.current = stream;
    setAnalyzer(node);
    return node;
  }, []);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => { t.stop(); });
    void ctxRef.current?.close().catch(() => { /* noop */ });
    ctxRef.current = null;
    analyzerRef.current = null;
    streamRef.current = null;
    setAnalyzer(null);
  }, []);

  return { analyzer, start, stop };
}

// ─── TTS Output Analyzer Hook ───────────────────────────────────────────────

function useTTSAnalyzer() {
  const ctxRef = useRef<AudioContext | null>(null);
  const analyzerRef = useRef<AnalyserNode | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const nextStartRef = useRef(0);
  const [analyzer, setAnalyzer] = useState<AnalyserNode | null>(null);

  const init = useCallback(() => {
    if (ctxRef.current) return;
    const ctx = new AudioContext({ sampleRate: 24000 });
    void ctx.resume();
    const node = ctx.createAnalyser();
    node.fftSize = 2048;
    const gain = ctx.createGain();
    gain.connect(node);
    node.connect(ctx.destination);
    ctxRef.current = ctx;
    analyzerRef.current = node;
    gainRef.current = gain;
    nextStartRef.current = 0;
    setAnalyzer(node);
  }, []);

  const playChunk = useCallback((base64Audio: string) => {
    const ctx = ctxRef.current;
    const gain = gainRef.current;
    if (!ctx || !gain) return;
    if (ctx.state === 'suspended') void ctx.resume();
    const binary = atob(base64Audio);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const float32 = pcm16ToFloat32(bytes.buffer);
    const buffer = ctx.createBuffer(1, float32.length, 24000);
    buffer.getChannelData(0).set(float32);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(gain);
    const now = ctx.currentTime;
    if (nextStartRef.current < now) nextStartRef.current = now;
    source.start(nextStartRef.current);
    nextStartRef.current += buffer.duration;
  }, []);

  const close = useCallback(() => {
    void ctxRef.current?.close().catch(() => { /* noop */ });
    ctxRef.current = null;
    analyzerRef.current = null;
    gainRef.current = null;
    setAnalyzer(null);
  }, []);

  return { analyzer, init, playChunk, close };
}

// ─── STT Section ─────────────────────────────────────────────────────────────

let sttCounter = 0;

function STTSection({ socket }: { socket: UglyBotSocket }) {
  const [sttMode, setSTTMode] = useState<STTMode>('continuous');
  const [vizType, setVizType] = useState<VizType>('mic');
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [transcriptHistory, setTranscriptHistory] = useState<string[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);

  const mic = useMicAnalyzer();
  const streamIdRef = useRef<string | null>(null);
  const recorderRef = useRef<AudioRecorder | null>(null);
  const chunkCountRef = useRef(0);
  const unsubsRef = useRef<(() => void)[]>([]);

  function addLog(msg: string, kind: LogEntry['kind'] = 'info') {
    const prefix = '[STT]';
    if (kind === 'err') console.error(prefix, msg);
    else console.log(prefix, msg);
    setLogs((prev) => [...prev, { ts: Date.now(), msg, kind }]);
  }

  function unsubAll() {
    for (const unsub of unsubsRef.current) unsub();
    unsubsRef.current = [];
  }

  function subscribe(streamId: string) {
    unsubAll();
    unsubsRef.current.push(
      socket.on('stt:transcript', (data) => {
        if (data.streamId !== streamId) return;
        addLog(`Transcript${data.isFinal ? ' (final)' : ''}: ${data.text}`, data.isFinal ? 'ok' : 'info');
        setTranscript(data.text);
        if (data.isFinal && data.text) {
          const finalText = data.text;
          setTranscriptHistory((prev) => [...prev, finalText]);
          setTranscript('');
        }
      }),
      socket.on('stt:error', (data) => {
        if (data.streamId !== streamId) return;
        const errMsg = typeof data.message === 'string' ? data.message : JSON.stringify(data.message);
        addLog(`STT error: ${errMsg}`, 'err');
        stopListening();
      }),
      socket.on('stt:stopped', (data) => {
        if (data.streamId && data.streamId !== streamId) return;
        addLog(`STT stopped — sent ${chunkCountRef.current} audio chunks`, 'ok');
        unsubAll();
        socket.release();
      }),
    );
  }

  async function startListening() {
    const streamId = `stt-${++sttCounter}`;
    streamIdRef.current = streamId;
    setTranscript('');
    setLogs([]);
    chunkCountRef.current = 0;

    const started = Date.now();
    addLog(`Mode: ${sttMode}${sttMode === 'continuous' ? ' (VAD enabled)' : ''}`);

    // Start mic + socket in parallel for faster startup
    recorderRef.current ??= new AudioRecorder();
    const micReady = Promise.all([
      mic.start(),
      recorderRef.current.start((audio) => {
        chunkCountRef.current++;
        console.log(`[STT] audio chunk #${chunkCountRef.current} (${audio.length} b64 chars)`);
        socket.send('stt:audio', { streamId, audio });
      }),
    ]);

    await socket.acquire();
    subscribe(streamId);

    socket.send('stt:start', {
      streamId,
      mode: sttMode === 'continuous' ? 'realtime' : 'batch',
      enableVAD: sttMode === 'continuous',
    });

    // Wait for ready
    await new Promise<void>((resolve) => {
      let resolved = false;
      const unsub = socket.on('stt:ready', (data) => {
        if (!data.streamId || data.streamId === streamId) {
          resolved = true;
          unsub();
          resolve();
        }
      });
      setTimeout(() => {
        if (!resolved) {
          unsub();
          resolve();
        }
      }, 5000);
    });

    addLog(`Ready in ${fmt(Date.now() - started)}`, 'ok');

    await micReady;
    addLog('Recording started', 'ok');

    setListening(true);
    addLog('Listening…');
  }

  function stopListening() {
    recorderRef.current?.stop();
    mic.stop();
    if (streamIdRef.current) {
      socket.send('stt:stop', { streamId: streamIdRef.current });
    }
    // Don't unsubAll/release here — wait for stt:stopped handler to clean up
    setListening(false);
  }

  // Push-to-talk handlers
  function handlePTTDown() {
    if (!listening) void startListening();
  }
  function handlePTTUp() {
    if (listening) stopListening();
  }

  // Cleanup on unmount
  useEffect(() => { // eslint-disable-line react-hooks/exhaustive-deps
    return () => {
      recorderRef.current?.stop();
      mic.stop();
      if (streamIdRef.current) {
        socket.send('stt:stop', { streamId: streamIdRef.current });
      }
      unsubAll();
      socket.release();
    };
  }, []);

  return (
    <div>
      {/* Mode toggle */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        {(['continuous', 'push-to-talk'] as STTMode[]).map((m) => (
          <button
            key={m}
            onClick={() => { if (!listening) setSTTMode(m); }}
            style={{ fontWeight: sttMode === m ? 'bold' : 'normal' }}
          >
            {m === 'continuous' ? 'Continuous (VAD)' : 'Push to Talk'}
          </button>
        ))}
      </div>

      {/* Visualizer picker */}
      <div style={{ marginBottom: 12 }}>
        <label>Visualizer: </label>
        <select
          value={vizType}
          onChange={(e) => { setVizType(e.target.value as VizType); }}
        >
          {vizOptions.map((v) => (
            <option key={v.key} value={v.key}>{v.label}</option>
          ))}
        </select>
      </div>

      {/* Visualizer */}
      <Card>
        <VisualizerView vizType={vizType} analyzer={mic.analyzer} />
      </Card>

      {/* Controls */}
      <div style={{ marginTop: 12 }}>
        {sttMode === 'continuous' ? (
          <Button
            data-id="stt-toggle"
            onClick={listening ? stopListening : () => void startListening()}
          >
            {listening ? 'Stop Listening' : 'Start Listening'}
          </Button>
        ) : (
          <button
            data-id="stt-ptt"
            onPointerDown={handlePTTDown}
            onPointerUp={handlePTTUp}
            onPointerLeave={listening ? handlePTTUp : undefined}
            style={{
              padding: '8px 16px',
              fontSize: 16,
              borderRadius: 8,
              border: 'none',
              cursor: 'pointer',
              background: listening
                ? 'var(--app-error, #dc2626)'
                : 'var(--app-primary, #2563eb)',
              color: '#fff',
              userSelect: 'none',
              touchAction: 'none',
            }}
          >
            {listening ? 'Release to Stop' : 'Hold to Talk'}
          </button>
        )}
      </div>

      {/* Transcript */}
      {(transcript || transcriptHistory.length > 0) && (
        <Card>
          <p><strong>Transcript</strong></p>
          {transcriptHistory.map((t, i) => (
            <p key={i}>{t}</p>
          ))}
          {transcript && (
            <p style={{ opacity: 0.6, fontStyle: 'italic' }}>{transcript}</p>
          )}
        </Card>
      )}

      {/* Logs */}
      {logs.length > 0 && (
        <div data-id="stt-logs" style={{ marginTop: 8, fontSize: '0.85em', opacity: 0.7 }}>
          {logs.map((entry, i) => (
            <div key={i} data-log-kind={entry.kind}>
              {entry.kind === 'err' ? '✗' : entry.kind === 'ok' ? '✓' : '·'}{' '}
              {entry.msg}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── TTS Section ─────────────────────────────────────────────────────────────

let ttsCounter = 0;

function TTSSection({ socket }: { socket: UglyBotSocket }) {
  const [text, setText] = useState('The quick brown fox jumps over the lazy dog. Hello, this is a text to speech test.');
  const [voice, setVoice] = useState('');
  const [vizType, setVizType] = useState<VizType>('wave');
  const [playing, setPlaying] = useState(false);
  const [currentWord, setCurrentWord] = useState('');
  const [wordHistory, setWordHistory] = useState<{ word: string; active: boolean }[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);

  const ttsAudio = useTTSAnalyzer();
  const streamIdRef = useRef<string | null>(null);
  const playStartRef = useRef(0);
  const pendingWordsRef = useRef<{ word: string; idx?: number; startMs?: number }[]>([]);
  const wordTimersRef = useRef<{ timer: ReturnType<typeof setTimeout>; word: string; idx: number | undefined; startMs: number | undefined }[]>([]);
  const unsubsRef = useRef<(() => void)[]>([]);

  function addLog(msg: string, kind: LogEntry['kind'] = 'info') {
    const prefix = '[TTS]';
    if (kind === 'err') console.error(prefix, msg);
    else console.log(prefix, msg);
    setLogs((prev) => [...prev, { ts: Date.now(), msg, kind }]);
  }

  function unsubAll() {
    for (const unsub of unsubsRef.current) unsub();
    unsubsRef.current = [];
  }

  function applyWord(word: string, idx: number | undefined) {
    setCurrentWord(word);
    if (typeof idx === 'number') {
      addLog(`Highlight word[${idx}]="${word}"`, 'ok');
      setWordHistory((prev) => {
        const next = prev.map((w) => ({ ...w, active: false }));
        if (idx < next.length) {
          next[idx] = { ...next[idx]!, active: true };
        }
        return next;
      });
    }
  }

  function scheduleWord(word: string, idx: number | undefined, startMs: number | undefined) {
    const delay = typeof startMs === 'number' && playStartRef.current
      ? startMs - (Date.now() - playStartRef.current)
      : 0;
    if (delay > 10) {
      const timer = setTimeout(() => {
        applyWord(word, idx);
        wordTimersRef.current = wordTimersRef.current.filter((t) => t.timer !== timer);
      }, delay);
      wordTimersRef.current.push({ timer, word, idx, startMs });
    } else {
      applyWord(word, idx);
    }
  }

  function flushPendingWords() {
    for (const w of pendingWordsRef.current) {
      scheduleWord(w.word, w.idx, w.startMs);
    }
    pendingWordsRef.current = [];
  }

  function subscribe(streamId: string) {
    unsubAll();
    addLog(`Subscribing to events for stream ${streamId}`);
    unsubsRef.current.push(
      socket.on('tts:chunk', (data) => {
        addLog(`Got tts:chunk streamId=${data.streamId} (expected=${streamId}) audioLen=${data.audio.length}`);
        if (data.streamId !== streamId) return;
        if (data.audio) {
          const isFirst = !playStartRef.current;
          if (isFirst) {
            playStartRef.current = Date.now();
            flushPendingWords();
          }
          ttsAudio.playChunk(data.audio);
          addLog(`Queued audio chunk (${data.audio.length} b64 chars)`, 'ok');
        }
      }),
      socket.on('tts:word', (data) => {
        if (data.streamId !== streamId) return;
        const word = data.word;
        const extras = data as Record<string, unknown> & { wordIndex?: number };
        const idx = extras.wordIndex;
        addLog(`Word: "${word}" idx=${idx} startMs=${data.startMs}`);
        if (!playStartRef.current) {
          // Audio hasn't started yet — queue for later
          pendingWordsRef.current.push({ word, ...(idx !== undefined ? { idx } : {}), startMs: data.startMs });
        } else {
          scheduleWord(word, idx, data.startMs);
        }
      }),
      socket.on('tts:done', (data) => {
        addLog(`Got tts:done streamId=${data.streamId}`);
        if (data.streamId !== streamId) return;

        // Flush any words that were never scheduled (arrived before first audio chunk)
        for (const w of pendingWordsRef.current) {
          scheduleWord(w.word, w.idx, w.startMs);
        }
        pendingWordsRef.current = [];

        const finish = () => {
          playStartRef.current = 0;
          setPlaying(false);
          setCurrentWord('');
          addLog('Playback complete', 'ok');
          unsubAll();
          socket.release();
        };

        // Wait for all word timers to fire naturally before finishing
        if (wordTimersRef.current.length > 0) {
          // Find the max remaining delay across all pending word timers
          const elapsed = playStartRef.current ? Date.now() - playStartRef.current : 0;
          let maxRemainingMs = 0;
          for (const t of wordTimersRef.current) {
            if (typeof t.startMs === 'number') {
              const remaining = t.startMs - elapsed;
              if (remaining > maxRemainingMs) maxRemainingMs = remaining;
            }
          }
          // Schedule finish after all words have fired (+ small buffer)
          setTimeout(finish, maxRemainingMs + 100);
        } else {
          finish();
        }
      }),
      socket.on('tts:error', (data) => {
        addLog(`Got tts:error streamId=${data.streamId} msg=${data.message}`, 'err');
        if (data.streamId !== streamId) return;
        for (const t of wordTimersRef.current) clearTimeout(t.timer);
        wordTimersRef.current = [];
        pendingWordsRef.current = [];
        playStartRef.current = 0;
        setPlaying(false);
        addLog(`TTS error: ${data.message}`, 'err');
        unsubAll();
        socket.release();
      }),
    );
  }

  async function handlePlay() {
    if (!text.trim()) return;
    const streamId = `tts-${++ttsCounter}`;
    streamIdRef.current = streamId;
    playStartRef.current = 0;
    pendingWordsRef.current = [];
    for (const t of wordTimersRef.current) clearTimeout(t.timer);
    wordTimersRef.current = [];

    setPlaying(true);
    setCurrentWord('');
    setLogs([]);

    // Build word list for transcript highlighting
    const words = text.trim().split(/\s+/).map((w) => ({ word: w, active: false }));
    setWordHistory(words);

    ttsAudio.init();
    addLog(`Voice: ${voice || 'default'}`);
    addLog(`Stream ID: ${streamId}`);
    addLog('Acquiring socket…');

    try {
      await socket.acquire();
      addLog('Socket acquired', 'ok');
    } catch (err) {
      addLog(`Socket acquire failed: ${err}`, 'err');
      setPlaying(false);
      return;
    }

    subscribe(streamId);

    const payload = {
      streamId,
      text: text.trim(),
      ...(voice ? { voice } : {}),
      requestVisemes: false,
    };
    addLog(`Sending tts:start ${JSON.stringify(payload).slice(0, 200)}`);
    socket.send('tts:start', payload);
    addLog('tts:start sent, waiting for chunks…');
  }

  function handleStop() {
    if (streamIdRef.current) {
      socket.send('tts:cancel', { streamId: streamIdRef.current });
    }
    for (const t of wordTimersRef.current) clearTimeout(t.timer);
    wordTimersRef.current = [];
    pendingWordsRef.current = [];
    playStartRef.current = 0;
    unsubAll();
    socket.release();
    setPlaying(false);
    setCurrentWord('');
  }

  useEffect(() => { // eslint-disable-line react-hooks/exhaustive-deps
    return () => {
      if (streamIdRef.current) {
        socket.send('tts:cancel', { streamId: streamIdRef.current });
      }
      unsubAll();
      socket.release();
      ttsAudio.close();
    };
  }, []);

  return (
    <div>
      {/* Visualizer picker */}
      <div style={{ marginBottom: 12 }}>
        <label>Visualizer: </label>
        <select
          value={vizType}
          onChange={(e) => { setVizType(e.target.value as VizType); }}
        >
          {vizOptions.map((v) => (
            <option key={v.key} value={v.key}>{v.label}</option>
          ))}
        </select>
      </div>

      {/* Visualizer */}
      <Card>
        <VisualizerView vizType={vizType} analyzer={ttsAudio.analyzer} />
      </Card>

      {/* Input */}
      <div style={{ marginTop: 12 }}>
        <Input
          label="Text to speak"
          value={text}
          onChange={setText}
          placeholder="Enter text for TTS…"
        />
        <Input
          label="Voice ID (optional)"
          value={voice}
          onChange={setVoice}
          placeholder="e.g. inworld-alex"
        />
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <Button onClick={() => { void handlePlay(); }} disabled={playing || !text.trim()}>
            {playing ? 'Playing…' : 'Play'}
          </Button>
          {playing && <Button onClick={handleStop}>Stop</Button>}
        </div>
      </div>

      {/* Word-by-word transcript */}
      {wordHistory.length > 0 && (
        <Card>
          <p><strong>Transcript</strong></p>
          <p style={{ lineHeight: 1.8 }}>
            {wordHistory.map((w, i) => (
              <span
                key={i}
                data-word-index={i}
                data-active={w.active ? 'true' : 'false'}
                style={{
                  padding: '2px 4px',
                  borderRadius: 4,
                  background: w.active ? 'var(--app-primary, #3b82f6)' : 'transparent',
                  color: w.active ? 'white' : 'inherit',
                  transition: 'background 0.15s',
                }}
              >
                {w.word}{' '}
              </span>
            ))}
          </p>
          {currentWord && (
            <p style={{ fontSize: '0.85em', opacity: 0.6 }}>
              Current: {currentWord}
            </p>
          )}
        </Card>
      )}

      {/* Logs */}
      {logs.length > 0 && (
        <div style={{ marginTop: 8, fontSize: '0.85em', opacity: 0.7 }}>
          {logs.map((entry, i) => (
            <div key={i}>
              {entry.kind === 'err' ? '✗' : entry.kind === 'ok' ? '✓' : '·'}{' '}
              {entry.msg}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main Page ───────────────────────────────────────────────────────────────

export default function AudioTestPage(): React.ReactElement {
  const { uglyBotSocket } = useApp();
  const [tab, setTab] = useState<Tab>('stt');

  return (
    <PageLayout
      header={
        <div>
          <a href="/test">← Tests</a>
        </div>
      }
    >
      <div>
        <h1>Audio Test — TTS & STT</h1>

        {/* Tab toggle */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          {([
            { key: 'stt' as Tab, label: 'Speech-to-Text' },
            { key: 'tts' as Tab, label: 'Text-to-Speech' },
          ]).map((t) => (
            <button
              key={t.key}
              onClick={() => { setTab(t.key); }}
              style={{ fontWeight: tab === t.key ? 'bold' : 'normal' }}
            >
              {t.label}
            </button>
          ))}
        </div>

        {uglyBotSocket ? (
          tab === 'stt' ? (
            <STTSection socket={uglyBotSocket} />
          ) : (
            <TTSSection socket={uglyBotSocket} />
          )
        ) : (
          <p>UglyBot socket not available. Make sure the app is configured with an app token.</p>
        )}
      </div>
    </PageLayout>
  );
}
