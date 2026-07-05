import React from 'react';
import { permissions } from 'ugly-app/native';
import { InteractiveTerminal } from '../components/InteractiveTerminal';
import { buildScaffoldCommand, parseScaffoldResult, normalizeScaffoldPath } from './scaffoldCommand';
import { isWindows } from '../utils/platform';

/** Bundled tools the scaffold needs. The desktop daemon gates uglyNative.process
 *  on (a) the binary being bundled and (b) a granted `process` capability; we
 *  spawn `bash` and it shells out to npx/pnpm. Requesting up-front is required —
 *  for the first-party IDE origin it's auto-granted (no prompt). */
const SCAFFOLD_TOOLS = ['bash', 'node', 'git', 'npm', 'npx', 'pnpm'];

/**
 * Full-window "Create Project" view. Scaffolding a fresh ugly-app project
 * (`npx ugly-app init` → `pnpm install`) takes ~15-30s. Rather than a silent
 * "Creating…" spinner, we run it inside an interactive terminal: the scaffold
 * command is echoed and its live output streams (the user sees exactly what's
 * running), and the shell is typeable. On success we hand the resolved absolute
 * path back to the shell (which opens the new project); on failure we keep the
 * output + offer a retry.
 */
export function ProjectCreationProgress({
  name,
  parentDir,
  onDone,
  onCancel,
}: {
  name: string;
  parentDir: string;
  onDone: (name: string, path: string) => void;
  onCancel: () => void;
}): React.ReactElement {
  const [attempt, setAttempt] = React.useState(0);
  const [status, setStatus] = React.useState<'running' | 'error'>('running');
  const [error, setError] = React.useState<string | null>(null);
  const [granted, setGranted] = React.useState(false);

  const scaffoldCmd = React.useMemo(() => buildScaffoldCommand(name, parentDir), [name, parentDir]);

  // Grant the process/fs capability before spawning, or the daemon denies the
  // spawn ("requires the process permission"). Re-request on retry (attempt bump);
  // harmless if already granted. Only once granted do we mount the terminal, so
  // its auto-run initialCommand fires after the grant resolves.
  React.useEffect(() => {
    let alive = true;
    setGranted(false);
    setStatus('running');
    setError(null);
    // The facade types `process` as boolean|GrantState, but the daemon accepts a
    // per-binary allowlist array.
    type GrantReq = Parameters<typeof permissions.request>[0];
    void permissions
      .request({ fs: 'full', process: [...SCAFFOLD_TOOLS] } as unknown as GrantReq)
      .catch(() => undefined)
      .finally(() => { if (alive) setGranted(true); });
    return () => { alive = false; };
  }, [attempt]);

  const handleCommandExit = React.useCallback((code: number | null, _command: string, output: string): void => {
    const result = parseScaffoldResult(output, code);
    if (result.ok) {
      // On Windows the bundled Git-Bash prints `/c/Users/...`; normalize to
      // `C:\Users\...` so the project opens at the real path (else Node mangles
      // it to `C:\c\Users\...` → `.uglyapp`/template "not found").
      const raw = result.path || `${parentDir.replace(/\/+$/, '')}/${name}`;
      const path = normalizeScaffoldPath(raw, isWindows);
      onDone(name, path);
    } else {
      setStatus('error');
      setError(`\`ugly-app init\` exited with code ${result.code ?? 'null'}`);
    }
  }, [name, parentDir, onDone]);

  return (
    <div data-id="project-creation-progress" style={S.root}>
      <div style={S.header}>
        <span
          data-id="creation-status"
          className={status === 'running' ? 'us-spin' : undefined}
          style={{ color: status === 'error' ? 'var(--error)' : 'var(--accent)', fontSize: 16 }}
        >
          {status === 'running' ? '⟳' : '✗'}
        </span>
        <span style={S.title}>
          {status === 'running' ? `Creating ${name}…` : `Failed to create ${name}`}
        </span>
        <span style={S.sub}>npx ugly-app init · pnpm install</span>
        <span style={{ flex: 1 }} />
        {status === 'error' && (
          <button data-id="creation-retry" onClick={() => { setAttempt((a) => a + 1); }} style={S.btn}>
            Retry
          </button>
        )}
        <button data-id="creation-cancel" onClick={onCancel} style={S.btn}>
          {status === 'running' ? 'Cancel' : 'Back'}
        </button>
      </div>
      <div data-id="creation-output" style={S.console}>
        {granted ? (
          <InteractiveTerminal
            key={attempt}
            initialCommand={scaffoldCmd}
            onCommandExit={handleCommandExit}
          />
        ) : (
          <div style={S.starting}>Starting…</div>
        )}
      </div>
      {error && <div style={S.error}>{error}</div>}
    </div>
  );
}

const S = {
  root: { height: '100dvh', display: 'flex', flexDirection: 'column', background: 'var(--bg-primary)', color: 'var(--text-primary)', minHeight: 0, boxSizing: 'border-box', paddingLeft: 'var(--safe-area-inset-left)', paddingRight: 'var(--safe-area-inset-right)', paddingBottom: 'var(--safe-area-inset-bottom)' },
  header: { display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', paddingTop: 'calc(12px + var(--safe-area-inset-top))', borderBottom: '1px solid var(--border)', flexShrink: 0 },
  title: { fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 14 },
  sub: { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)' },
  btn: { background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 12px', fontSize: 12, cursor: 'pointer' },
  console: { flex: 1, overflow: 'hidden', background: 'var(--bg-panel)', minHeight: 0 },
  starting: { padding: 14, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-muted)' },
  error: { padding: '8px 16px', borderTop: '1px solid var(--border)', color: 'var(--error)', fontSize: 12, fontFamily: 'var(--font-mono)' },
} satisfies Record<string, React.CSSProperties>;
