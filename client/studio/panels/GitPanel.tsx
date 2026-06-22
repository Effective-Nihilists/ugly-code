import React from 'react';
import { native } from 'ugly-app/native';
import { getActiveProjectPath } from '../hooks/useSocket';

/** Run a command in the open project, resolve combined output. */
function run(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve) => {
    let out = '';
    try {
      const p = native.process.spawn(cmd, args, { cwd });
      p.onStdout((c) => (out += c));
      p.onStderr((c) => (out += c));
      p.onError((e) => { resolve(`${out}\n[error: ${e}]`); });
      p.onExit(() => { resolve(out); });
    } catch (e) {
      resolve(`[error: ${(e as Error).message}]`);
    }
  });
}

/** Minimal Git view: `git status` + recent log for the open project. */
export function GitPanel(): React.ReactElement {
  const [out, setOut] = React.useState('Loading…');
  const [busy, setBusy] = React.useState(false);

  const refresh = React.useCallback(async () => {
    const cwd = getActiveProjectPath();
    if (!cwd) {
      setOut('No project open.');
      return;
    }
    setBusy(true);
    const status = await run('git', ['-c', 'color.ui=never', 'status'], cwd);
    const log = await run('git', ['-c', 'color.ui=never', 'log', '--oneline', '-20'], cwd);
    setOut(`$ git status\n${status.trimEnd()}\n\n$ git log --oneline -20\n${log.trimEnd()}`);
    setBusy(false);
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div data-id="git-panel" style={S.root}>
      <div style={S.bar}>
        <span style={S.title}>Git</span>
        <span style={{ flex: 1 }} />
        <button style={S.btn} disabled={busy} onClick={() => void refresh()}>
          {busy ? 'Running…' : 'Refresh'}
        </button>
      </div>
      <pre style={S.out}>{out}</pre>
    </div>
  );
}

const S = {
  root: { height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--bg-primary)', color: 'var(--text-primary)', minHeight: 0 },
  bar: { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 },
  title: { fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 13 },
  btn: { background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 12px', fontSize: 12, cursor: 'pointer' },
  out: { flex: 1, overflow: 'auto', margin: 0, padding: 16, fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.5, whiteSpace: 'pre-wrap', color: 'var(--text-primary)' },
} satisfies Record<string, React.CSSProperties>;
