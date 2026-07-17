import React from 'react';
import { native, permissions } from 'ugly-app/native';
import { ConsoleText } from '../components/ConsoleText';
import { LinkifiedText } from '../components/LinkifiedText';
import { GitRepoSelector, useActiveRepoPath } from './GitRepoSelector';
import { uglyBotAuthJson } from '../hooks/useSocket';

/** The bits of `.uglyapp`'s persisted deployTarget we surface. */
interface DeployTarget {
  workerUrl?: string;
  customDomainUrl?: string;
  appDomain?: string;
  lastDeployedAt?: string;
}

type UglyProcess = ReturnType<typeof native.process.spawn>;
const PUBLISH_TOOLS = ['bash', 'node', 'git', 'npm', 'npx', 'pnpm'];

/**
 * Prod / Deploy panel. Mirrors the monolith's PublishTab: shows the deployed
 * target (live URL + last deploy) and runs the ugly-app deploy pipeline for the
 * open project, streaming the orchestrator's output. The monolith drove a PTY over a
 * sidecar; here we spawn it over the native bridge (same as the scaffold) and
 * stream stdout/stderr into a console.
 */
export function ProdPanel(): React.ReactElement {
  const activeRepo = useActiveRepoPath();
  const [target, setTarget] = React.useState<DeployTarget | null>(null);
  const [output, setOutput] = React.useState('');
  const [running, setRunning] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [stdin, setStdin] = React.useState('');
  const procRef = React.useRef<UglyProcess | null>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  const loadTarget = React.useCallback(async () => {
    const cwd = activeRepo;
    if (!cwd) return;
    try {
      const ua = JSON.parse(await native.fs.readFile(`${cwd}/.uglyapp`)) as {
        deployTarget?: DeployTarget;
      };
      setTarget(ua.deployTarget ?? null);
    } catch {
      // Benign + expected: an unpublished project has no `.uglyapp` yet (ENOENT),
      // and setTarget(null) is the correct "no deploy target" state. Logging here
      // would spam errorLog for every unpublished project — deliberately silent.
      setTarget(null);
    }
  }, [activeRepo]);

  React.useEffect(() => {
    void loadTarget();
  }, [loadTarget]);

  React.useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [output]);

  const deploy = React.useCallback(async () => {
    const cwd = activeRepo;
    if (!cwd || running) return;
    setOutput('');
    setError(null);
    setRunning(true);
    type GrantReq = Parameters<typeof permissions.request>[0];
    await permissions
      .request({
        fs: 'full',
        process: [...PUBLISH_TOOLS],
      } as unknown as GrantReq)
      .catch(() => undefined);
    let buf = '';
    const append = (chunk: string): void => {
      buf += chunk;
      setOutput(buf);
    };
    try {
      // Bridge Studio's login into the CLI's ugly.bot auth file so publish doesn't
      // fail with "not logged in to ugly.bot" for a Studio-only user. Passed via env
      // (not interpolated) so the JWT's quotes don't need shell-escaping.
      const authJson = uglyBotAuthJson();
      // Deliberately `ugly-app publish`, not `ugly-app deploy`: this runs the
      // CLI out of the OPENED PROJECT's node_modules, which may pin an older
      // ugly-app that predates the `deploy` rename. `publish` is a permanent
      // alias, so it works against every version.
      const cmd = authJson
        ? 'mkdir -p "$HOME/.ugly-bot" && printf "%s\\n" "$UGLY_BOT_AUTH_JSON" > "$HOME/.ugly-bot/auth.json"; pnpm exec ugly-app publish'
        : 'pnpm exec ugly-app publish';
      const proc = native.process.spawn('bash', ['-lc', cmd], {
        cwd,
        ...(authJson ? { env: { UGLY_BOT_AUTH_JSON: authJson } } : {}),
      });
      procRef.current = proc;
      proc.onStdout(append);
      proc.onStderr(append);
      proc.onError((e) => {
        // Ship spawn failures to errorLog with the output tail — otherwise a failed
        // deploy is only visible in this panel, never in the logs (undebuggable from
        // another machine / after the fact).
        console.error(
          '[ProdPanel:deploy] spawn-error',
          JSON.stringify({ cwd, error: e, outputTail: buf.slice(-1500) }),
        );
        append(`\n[error: ${e}]\n`);
        setError(e);
        setRunning(false);
      });
      proc.onExit((code) => {
        append(`\n[exit ${code ?? 'null'}]\n`);
        setRunning(false);
        if (code === 0) void loadTarget();
        else {
          // A non-zero publish exit is a real failure — capture it (with the log tail
          // carrying the orchestrator's actual error) to errorLog, not just the UI.
          console.error(
            '[ProdPanel:deploy] nonzero-exit',
            JSON.stringify({ cwd, code, outputTail: buf.slice(-2000) }),
          );
          setError(`publish exited with code ${code ?? 'null'}`);
        }
      });
    } catch (e) {
      console.error(
        '[ProdPanel:deploy]',
        JSON.stringify({
          cwd,
          error: e instanceof Error ? e.message : String(e),
        }),
        e instanceof Error ? e.stack : undefined,
      );
      setError((e as Error).message);
      setRunning(false);
    }
  }, [activeRepo, running, loadTarget]);

  // Send a line to the running publish's stdin (answers its prompts — custom
  // domain, etc.). Echo it into the console so the user sees what they sent.
  const sendStdin = React.useCallback(() => {
    const proc = procRef.current;
    if (!proc || !running) return;
    const line = stdin;
    setStdin('');
    setOutput((o) => `${o}${line}\n`);
    try {
      proc.write(`${line}\n`);
    } catch {
      /* process gone */
    }
  }, [stdin, running]);

  const cancel = React.useCallback(() => {
    try {
      procRef.current?.kill();
    } catch {
      /* already gone */
    }
    setRunning(false);
  }, []);

  const liveUrl = target?.customDomainUrl ?? target?.workerUrl ?? null;

  return (
    <div data-id="prod-panel" style={S.root}>
      <div style={S.header}>
        <GitRepoSelector />
        <div style={S.targetCol}>
          {liveUrl ? (
            <>
              <a
                href={liveUrl}
                target="_blank"
                rel="noreferrer"
                data-id="prod-live-url"
                style={S.url}
                onClick={(e) => {
                  e.preventDefault();
                  void native.system.openExternal({ url: liveUrl });
                }}
              >
                {liveUrl}
              </a>
              {target?.lastDeployedAt && (
                <span style={S.sub}>
                  last deployed{' '}
                  {new Date(target.lastDeployedAt).toLocaleString()}
                </span>
              )}
            </>
          ) : (
            <span style={S.sub}>
              Not deployed yet — deploy to provision your database + Cloudflare
              Workers and go live.
            </span>
          )}
        </div>
        <span style={{ flex: 1 }} />
        {running ? (
          <button data-id="prod-cancel" onClick={cancel} style={S.btn}>
            Cancel
          </button>
        ) : (
          <button
            data-id="prod-deploy"
            onClick={() => void deploy()}
            style={S.deploy}
          >
            {liveUrl ? 'Re-deploy' : 'Deploy'} →
          </button>
        )}
      </div>
      <div ref={scrollRef} data-id="prod-output" style={S.console}>
        <ConsoleText
          text={
            output ||
            (running
              ? 'Starting deploy…'
              : 'Press Deploy to run the ugly-app deploy pipeline (database + Cloudflare Workers + storage provisioning).')
          }
          TextComponent={LinkifiedText}
        />
      </div>
      {running && (
        <div style={S.inputRow}>
          <span style={S.prompt}>›</span>
          <input
            data-id="prod-stdin"
            value={stdin}
            onChange={(e) => {
              setStdin(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') sendStdin();
            }}
            placeholder="answer a prompt (e.g. your custom domain) and press Enter"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            style={S.input}
          />
        </div>
      )}
      {error && <div style={S.error}>{error}</div>}
    </div>
  );
}

const S = {
  root: {
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--bg-primary)',
    color: 'var(--text-primary)',
    minHeight: 0,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '12px 16px',
    borderBottom: '1px solid var(--border)',
    background: 'var(--bg-panel)',
    flexShrink: 0,
  },
  targetCol: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 },
  url: {
    fontFamily: 'var(--font-mono)',
    fontSize: 13,
    color: 'var(--accent)',
    textDecoration: 'none',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  sub: {
    fontFamily: 'var(--font-mono)',
    fontSize: 11,
    color: 'var(--text-muted)',
  },
  btn: {
    background: 'var(--bg-secondary)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    padding: '6px 14px',
    fontSize: 12,
    cursor: 'pointer',
  },
  deploy: {
    background: 'var(--accent)',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    padding: '6px 16px',
    fontSize: 12,
    fontWeight: 700,
    cursor: 'pointer',
  },
  console: {
    flex: 1,
    overflow: 'auto',
    padding: 14,
    fontFamily: 'var(--font-mono)',
    fontSize: 12,
    lineHeight: 1.5,
    whiteSpace: 'pre-wrap',
    background: 'var(--bg-panel)',
    minHeight: 0,
  },
  inputRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 16px',
    borderTop: '1px solid var(--border)',
    background: 'var(--bg-panel)',
    flexShrink: 0,
  },
  prompt: {
    fontFamily: 'var(--font-mono)',
    color: 'var(--accent)',
    fontWeight: 700,
  },
  input: {
    flex: 1,
    background: 'transparent',
    border: 'none',
    outline: 'none',
    fontFamily: 'var(--font-mono)',
    fontSize: 12,
    color: 'var(--text-primary)',
  },
  error: {
    padding: '8px 16px',
    borderTop: '1px solid var(--border)',
    color: 'var(--error)',
    fontSize: 12,
    fontFamily: 'var(--font-mono)',
  },
} satisfies Record<string, React.CSSProperties>;
