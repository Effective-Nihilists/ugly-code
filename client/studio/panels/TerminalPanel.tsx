import React from 'react';
import { native } from 'ugly-app/native';
import { getActiveProjectPath } from '../hooks/useSocket';

/** Minimal terminal: run a `bash -lc` command in the open project and stream
 *  its output. Not a full PTY — one command at a time — but enough to run
 *  builds/tests/git from the workspace. */
export function TerminalPanel(): React.ReactElement {
  const [log, setLog] = React.useState('');
  const [cmd, setCmd] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const scrollRef = React.useRef<HTMLDivElement>(null);

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
      });
    } catch (e) {
      setLog((l) => `${l}[error: ${(e as Error).message}]\n`);
      setBusy(false);
    }
  }, [cmd, busy]);

  return (
    <div data-id="terminal-panel" style={S.root}>
      <div ref={scrollRef} style={S.out}>
        {log || 'Run a command in the project (e.g. `npm test`, `git status`).'}
      </div>
      <div style={S.inputRow}>
        <span style={S.prompt}>$</span>
        <input
          data-id="terminal-input"
          value={cmd}
          onChange={(e) => { setCmd(e.target.value); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
          placeholder={busy ? 'running…' : 'type a command and press Enter'}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          style={S.input}
        />
      </div>
    </div>
  );
}

const S = {
  root: { height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--bg-primary)', color: 'var(--text-primary)', minHeight: 0 },
  out: { flex: 1, overflow: 'auto', padding: 16, fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.5, whiteSpace: 'pre-wrap', color: 'var(--text-primary)' },
  inputRow: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px', borderTop: '1px solid var(--border)', background: 'var(--bg-panel)', flexShrink: 0 },
  prompt: { fontFamily: 'var(--font-mono)', color: 'var(--accent)', fontWeight: 700 },
  input: { flex: 1, background: 'transparent', border: 'none', outline: 'none', fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-primary)' },
} satisfies Record<string, React.CSSProperties>;
