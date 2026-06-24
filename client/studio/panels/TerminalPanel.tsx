import React from 'react';
import { native } from 'ugly-app/native';
import { getActiveProjectPath } from '../hooks/useSocket';

/** Minimal terminal: run a `bash -lc` command in the open project and stream
 *  its output. Not a full PTY — one command at a time — but the prompt is inline
 *  at the tail of the output stream (like a real CLI), not a separate control. */
export function TerminalPanel(): React.ReactElement {
  const [log, setLog] = React.useState('');
  const [cmd, setCmd] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [history, setHistory] = React.useState<string[]>([]);
  const histIdx = React.useRef<number>(-1);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [log]);

  const submit = React.useCallback(() => {
    const cwd = getActiveProjectPath();
    const c = cmd.trim();
    if (!c || busy) return;
    if (!cwd) {
      setLog((l) => `${l}No project open.\n`);
      return;
    }
    setCmd('');
    setHistory((h) => (h[h.length - 1] === c ? h : [...h, c]));
    histIdx.current = -1;
    setLog((l) => `${l}$ ${c}\n`);
    setBusy(true);
    try {
      const p = native.process.spawn('bash', ['-lc', c], { cwd });
      p.onStdout((chunk) => { setLog((l) => l + chunk); });
      p.onStderr((chunk) => { setLog((l) => l + chunk); });
      p.onError((e) => {
        setLog((l) => `${l}[error: ${e}]\n`);
        setBusy(false);
      });
      p.onExit((code) => {
        setLog((l) => `${l}${code === 0 ? '' : `[exit ${code ?? 'null'}]\n`}`);
        setBusy(false);
        inputRef.current?.focus();
      });
    } catch (e) {
      setLog((l) => `${l}[error: ${(e as Error).message}]\n`);
      setBusy(false);
    }
  }, [cmd, busy]);

  // Up/down arrows walk shell history (standard CLI behavior).
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') { submit(); return; }
    if (e.key === 'ArrowUp' && history.length > 0) {
      e.preventDefault();
      const i = histIdx.current < 0 ? history.length - 1 : Math.max(0, histIdx.current - 1);
      histIdx.current = i;
      setCmd(history[i]);
    } else if (e.key === 'ArrowDown' && histIdx.current >= 0) {
      e.preventDefault();
      const i = histIdx.current + 1;
      if (i >= history.length) { histIdx.current = -1; setCmd(''); }
      else { histIdx.current = i; setCmd(history[i]); }
    }
  };

  return (
    <div data-id="terminal-panel" style={S.root} onClick={() => inputRef.current?.focus()}>
      <div ref={scrollRef} style={S.out}>
        {log
          ? <span style={S.stream}>{log}</span>
          : <span style={S.hint}>Run a command in the project (e.g. `npm test`, `git status`).{'\n'}</span>}
        {/* Inline prompt — sits at the tail of the stream and moves down as output arrives. */}
        <div style={S.promptLine}>
          <span style={S.prompt}>$&nbsp;</span>
          <input
            ref={inputRef}
            data-id="terminal-input"
            value={cmd}
            onChange={(e) => { setCmd(e.target.value); }}
            onKeyDown={onKeyDown}
            placeholder={busy ? 'running…' : ''}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            autoFocus
            style={S.input}
          />
        </div>
      </div>
    </div>
  );
}

const S = {
  root: { height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--bg-primary)', color: 'var(--text-primary)', minHeight: 0, cursor: 'text' },
  out: { flex: 1, overflow: 'auto', padding: 16, fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.5, color: 'var(--text-primary)' },
  stream: { whiteSpace: 'pre-wrap' as const },
  hint: { whiteSpace: 'pre-wrap' as const, color: 'var(--text-muted)' },
  promptLine: { display: 'flex', alignItems: 'baseline' },
  prompt: { fontFamily: 'var(--font-mono)', color: 'var(--accent)', fontWeight: 700, whiteSpace: 'pre' as const },
  input: { flex: 1, background: 'transparent', border: 'none', outline: 'none', padding: 0, margin: 0, fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.5, color: 'var(--text-primary)' },
} satisfies Record<string, React.CSSProperties>;
