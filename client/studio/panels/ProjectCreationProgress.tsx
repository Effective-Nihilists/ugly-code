import React from 'react';
import { native, permissions } from 'ugly-app/native';
import { ConsoleText } from '../components/ConsoleText';

/** Bundled tools the scaffold needs. The desktop daemon gates uglyNative.process
 *  on (a) the binary being bundled and (b) a granted `process` capability; we
 *  spawn `bash` and it shells out to npx/pnpm. Requesting up-front is required —
 *  for the first-party IDE origin it's auto-granted (no prompt). */
const SCAFFOLD_TOOLS = ['bash', 'node', 'git', 'npm', 'npx', 'pnpm'];

type UglyProcess = ReturnType<typeof native.process.spawn>;

/**
 * Full-window progress view for "Create Project". Scaffolding a fresh ugly-app
 * project (`npx ugly-app init` → `pnpm install`) takes ~15-30s, so instead of a
 * silent "Creating…" button we spawn it client-side over native.process and
 * stream the live CLI output (the same text you'd see in a terminal) into a
 * console. On success we hand the resolved absolute path back to the shell,
 * which opens the new project; on failure we keep the output + offer a retry.
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
  const [output, setOutput] = React.useState('');
  const [status, setStatus] = React.useState<'running' | 'error'>('running');
  const [error, setError] = React.useState<string | null>(null);
  const [attempt, setAttempt] = React.useState(0);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const procRef = React.useRef<UglyProcess | null>(null);

  React.useEffect(() => {
    // A leading `~` is NOT expanded inside the double quotes below — map to $HOME.
    const parent = (parentDir.trim() || '~').replace(/^~(?=$|\/)/, '$HOME');
    const q = (s: string): string => s.replace(/"/g, '\\"');
    // `cd <name> && pwd` prints the created project's absolute path last.
    const cmd =
      `mkdir -p "${q(parent)}" && cd "${q(parent)}" && ` +
      `npx -y ugly-app@latest init "${q(name)}" && cd "${q(name)}" && pwd`;

    let buf = '';
    let settled = false;
    const append = (chunk: string): void => {
      buf += chunk;
      setOutput(buf);
    };
    setOutput('');
    setStatus('running');
    setError(null);

    void (async () => {
    // Grant the process/fs capability before spawning, or the daemon denies the
    // spawn ("requires the process permission"). The facade types `process` as
    // boolean|GrantState, but the daemon accepts a per-binary allowlist array.
    type GrantReq = Parameters<typeof permissions.request>[0];
    await permissions
      .request({ fs: 'full', process: [...SCAFFOLD_TOOLS] } as unknown as GrantReq)
      .catch(() => undefined);
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- the effect cleanup can flip `settled` during this await (TS can't see the closure mutation)
    if (settled) return;
    try {
      const proc = native.process.spawn('bash', ['-lc', cmd], {});
      procRef.current = proc;
      proc.onStdout(append);
      proc.onStderr(append);
      proc.onError((e) => {
        if (settled) return;
        settled = true;
        console.error('[ProjectCreationProgress:createProject:procError]', JSON.stringify({ name, parentDir, error: e }));
        setStatus('error');
        setError(e);
      });
      proc.onExit((code) => {
        if (settled) return;
        settled = true;
        if (code === 0) {
          const lines = buf.trim().split('\n').map((l) => l.trim()).filter(Boolean);
          onDone(name, lines[lines.length - 1] ?? `${parent}/${name}`);
        } else {
          setStatus('error');
          setError(`\`ugly-app init\` exited with code ${code ?? 'null'}`);
        }
      });
    } catch (e) {
      console.error('[ProjectCreationProgress:createProject]', JSON.stringify({ name, parentDir, error: e instanceof Error ? e.message : String(e) }), e instanceof Error ? e.stack : undefined);
      setStatus('error');
      setError((e as Error).message);
    }
    })();

    return () => {
      settled = true;
      try {
        procRef.current?.kill();
      } catch {
        /* already gone */
      }
    };
    // Re-run on retry (attempt bump).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  React.useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [output]);

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
      <div ref={scrollRef} data-id="creation-output" style={S.console}>
        <ConsoleText text={output || 'Starting…'} />
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
  console: { flex: 1, overflow: 'auto', padding: 14, fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.5, whiteSpace: 'pre-wrap', background: 'var(--bg-panel)', minHeight: 0 },
  error: { padding: '8px 16px', borderTop: '1px solid var(--border)', color: 'var(--error)', fontSize: 12, fontFamily: 'var(--font-mono)' },
} satisfies Record<string, React.CSSProperties>;
