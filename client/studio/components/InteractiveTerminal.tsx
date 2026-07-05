import React from 'react';
import { native } from 'ugly-app/native';

export interface InteractiveTerminalProps {
  /** cwd for spawned commands. undefined ⇒ spawn with no cwd (dir may not exist yet). */
  cwd?: string;
  /** Run exactly once on mount, echoed as `$ <cmd>` and executed like a typed command. */
  initialCommand?: string;
  /** Fires when each command exits, with that command's accumulated stdout+stderr. */
  onCommandExit?: (code: number | null, command: string, output: string) => void;
}

/** Minimal interactive terminal: runs one `bash -lc` command at a time in `cwd`
 *  and streams output, with an inline prompt at the tail (like a real CLI).
 *  Not a full PTY. Extracted from TerminalPanel so the new-project flow can reuse
 *  it with an injected initialCommand. */
export function InteractiveTerminal({ cwd, initialCommand, onCommandExit }: InteractiveTerminalProps): React.ReactElement {
  const [log, setLog] = React.useState('');
  const [cmd, setCmd] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [history, setHistory] = React.useState<string[]>([]);
  const histIdx = React.useRef<number>(-1);
  const procRef = React.useRef<{ kill: (signal?: string) => void } | null>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const cwdRef = React.useRef<string | undefined>(cwd);
  cwdRef.current = cwd;

  React.useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [log]);

  // Run an arbitrary command string (typed or injected). Reads cwd via ref so the
  // parent can hand off a new cwd (e.g. after project creation) without races.
  const runCommand = React.useCallback((c: string): void => {
    const command = c.trim();
    if (!command) return;
    const runCwd = cwdRef.current;
    setHistory((h) => (h[h.length - 1] === command ? h : [...h, command]));
    histIdx.current = -1;
    setLog((l) => `${l}$ ${command}\n`);
    setBusy(true);
    try {
      // Per-command buffer so onCommandExit gets this command's own output
      // (the creation flow parses the trailing `pwd` line from it).
      let outBuf = '';
      const push = (chunk: string): void => { outBuf += chunk; setLog((l) => l + chunk); };
      const p = native.process.spawn('bash', ['-lc', command], runCwd ? { cwd: runCwd } : {});
      procRef.current = p;
      p.onStdout(push);
      p.onStderr(push);
      p.onError((e) => {
        procRef.current = null;
        setLog((l) => `${l}[error: ${e}]\n`);
        setBusy(false);
        onCommandExit?.(null, command, outBuf);
      });
      p.onExit((code) => {
        procRef.current = null;
        setLog((l) => `${l}${code === 0 ? '' : `[exit ${code ?? 'null'}]\n`}`);
        setBusy(false);
        inputRef.current?.focus();
        onCommandExit?.(code, command, outBuf);
      });
    } catch (e) {
      console.error('[InteractiveTerminal:spawn-bash]', JSON.stringify({ cmd: command, cwd: runCwd, error: e instanceof Error ? e.message : String(e) }), e instanceof Error ? e.stack : undefined);
      setLog((l) => `${l}[error: ${(e as Error).message}]\n`);
      setBusy(false);
      onCommandExit?.(null, command, '');
    }
  }, [onCommandExit]);

  const submit = React.useCallback(() => {
    if (busy) return;
    const c = cmd.trim();
    if (!c) return;
    setCmd('');
    runCommand(c);
  }, [cmd, busy, runCommand]);

  // Auto-run the injected command exactly once on mount.
  const ranInitial = React.useRef(false);
  React.useEffect(() => {
    if (ranInitial.current || !initialCommand) return;
    ranInitial.current = true;
    runCommand(initialCommand);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount only
  }, []);

  // Tab: complete the last token as a filesystem path against cwd.
  const complete = React.useCallback(async () => {
    const runCwd = cwdRef.current;
    if (!runCwd) return;
    const tokens = cmd.split(/(\s+)/); // keep separators so we can rejoin verbatim
    const lastIdx = tokens.length - 1;
    const last = tokens[lastIdx] ?? '';
    if (!last || /\s/.test(last)) return;
    const slash = last.lastIndexOf('/');
    const dirPart = slash >= 0 ? last.slice(0, slash + 1) : '';
    const partial = slash >= 0 ? last.slice(slash + 1) : last;
    const abs = dirPart.startsWith('/') || dirPart.startsWith('~');
    const baseDir = (abs ? dirPart : `${runCwd}/${dirPart}`).replace(/\/+$/, '') || '/';
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

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Tab') { e.preventDefault(); void complete(); return; }
    // Ctrl+C: interrupt the running command (real SIGINT), else clear the line.
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

  // Kill any running proc on unmount.
  React.useEffect(() => () => { try { procRef.current?.kill(); } catch { /* gone */ } }, []);

  return (
    <div data-id="interactive-terminal" style={S.root} onClick={() => inputRef.current?.focus()}>
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
