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
  const procRef = React.useRef<{ kill: (signal?: string) => void } | null>(null);
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
      procRef.current = p;
      p.onStdout((chunk) => { setLog((l) => l + chunk); });
      p.onStderr((chunk) => { setLog((l) => l + chunk); });
      p.onError((e) => {
        procRef.current = null;
        setLog((l) => `${l}[error: ${e}]\n`);
        setBusy(false);
      });
      p.onExit((code) => {
        procRef.current = null;
        setLog((l) => `${l}${code === 0 ? '' : `[exit ${code ?? 'null'}]\n`}`);
        setBusy(false);
        inputRef.current?.focus();
      });
    } catch (e) {
      console.error('[TerminalPanel:spawn-bash]', JSON.stringify({ cmd: c, cwd, error: e instanceof Error ? e.message : String(e) }), e instanceof Error ? e.stack : undefined);
      setLog((l) => `${l}[error: ${(e as Error).message}]\n`);
      setBusy(false);
    }
  }, [cmd, busy]);

  // Tab: complete the last token as a filesystem path against the project dir.
  // The runner is one-shot `bash -lc` with no PTY, so real shell/command
  // completion isn't available — this covers the common "finish a filename" case
  // (single match completes fully; multiple share their longest common prefix).
  const complete = React.useCallback(async () => {
    const cwd = getActiveProjectPath();
    if (!cwd) return;
    const tokens = cmd.split(/(\s+)/); // keep separators so we can rejoin verbatim
    const lastIdx = tokens.length - 1;
    const last = tokens[lastIdx] ?? '';
    if (!last || /\s/.test(last)) return;
    const slash = last.lastIndexOf('/');
    const dirPart = slash >= 0 ? last.slice(0, slash + 1) : '';
    const partial = slash >= 0 ? last.slice(slash + 1) : last;
    const abs = dirPart.startsWith('/') || dirPart.startsWith('~');
    const baseDir = (abs ? dirPart : `${cwd}/${dirPart}`).replace(/\/+$/, '') || '/';
    try {
      const entries = await native.fs.readdir(baseDir);
      const matches = entries.filter((en) => en.name.startsWith(partial));
      if (matches.length === 0) return;
      let completedTok: string;
      if (matches.length === 1) {
        completedTok = dirPart + matches[0].name + (matches[0].isDirectory ? '/' : ' ');
      } else {
        const lcp = matches.reduce((pre, m) => {
          let i = 0;
          while (i < pre.length && i < m.name.length && pre[i] === m.name[i]) i++;
          return pre.slice(0, i);
        }, matches[0].name);
        if (lcp.length <= partial.length) return; // nothing unambiguous to add
        completedTok = dirPart + lcp;
      }
      tokens[lastIdx] = completedTok;
      setCmd(tokens.join(''));
    } catch { /* dir unreadable — nothing to complete */ }
  }, [cmd]);

  // Up/down arrows walk shell history (standard CLI behavior).
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Tab') { e.preventDefault(); void complete(); return; }
    // Ctrl+C: interrupt the running command (real SIGINT), else clear the line —
    // matching a shell. Without this the one-shot runner had no way to stop a
    // hung command.
    if (e.ctrlKey && (e.key === 'c' || e.key === 'C')) {
      e.preventDefault();
      if (busy && procRef.current) {
        try { procRef.current.kill('SIGINT'); } catch { /* already exited */ }
        setLog((l) => `${l}^C\n`);
      } else if (cmd) {
        setCmd('');
        setLog((l) => `${l}^C\n`);
      }
      return;
    }
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
