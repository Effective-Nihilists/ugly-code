import React from 'react';
import { native, permissions, isNativeAvailable, nativePlatform } from 'ugly-app/native';
import type { HostDirent } from 'ugly-app/native';
import AgentPanel from '../agent/AgentPanel';

// ── ugly-code: the IDE, as a web app ─────────────────────────────────────────
// The first functional slice — a file browser + editor that reaches the local
// filesystem entirely through the unified UglyNative SDK (`ugly-app/native`),
// fulfilled by the Ugly Studio desktop browser's daemon. No app server involved:
// fs/process are native capabilities, AI (later) is a direct fetch to ugly.bot.

function joinPath(dir: string, name: string): string {
  if (dir === '/' || dir === '') return '/' + name;
  return dir.replace(/\/+$/, '') + '/' + name;
}
function parentOf(dir: string): string {
  if (dir === '/' || dir === '') return '/';
  const p = dir.replace(/\/+$/, '').split('/').slice(0, -1).join('/');
  return p === '' ? '/' : p;
}

export default function CodeEditorPage(): React.ReactElement {
  const available = isNativeAvailable();
  const platform = nativePlatform();

  const [cwd, setCwd] = React.useState('/');
  const [entries, setEntries] = React.useState<HostDirent[]>([]);
  const [openFile, setOpenFile] = React.useState<string | null>(null);
  const [content, setContent] = React.useState('');
  const [dirty, setDirty] = React.useState(false);
  const [status, setStatus] = React.useState('');

  // Terminal: run commands via native.process (desktop-only).
  const [cmd, setCmd] = React.useState('echo hello from ugly-code');
  const [output, setOutput] = React.useState('');
  const [running, setRunning] = React.useState(false);

  function runCommand() {
    const parts = cmd.trim().split(/\s+/);
    if (parts.length === 0 || !parts[0]) return;
    const [bin, ...args] = parts;
    setOutput((o) => o + `$ ${cmd}\n`);
    setRunning(true);
    try {
      const proc = native.process.spawn(bin, args, { cwd });
      proc.onStdout((chunk) => { setOutput((o) => o + chunk); });
      proc.onStderr((chunk) => { setOutput((o) => o + chunk); });
      proc.onError((err) => { setOutput((o) => o + `error: ${err}\n`); });
      proc.onExit((code) => {
        setOutput((o) => o + `\n[exit ${code}]\n`);
        setRunning(false);
      });
    } catch (e) {
      console.error('[CodeEditorPage:runCommand]', JSON.stringify({ cmd, cwd, error: e instanceof Error ? e.message : String(e) }), e instanceof Error ? e.stack : undefined);
      setOutput((o) => o + `error: ${(e as Error).message}\n`);
      setRunning(false);
    }
  }

  const list = React.useCallback(async (dir: string) => {
    setStatus(`reading ${dir}…`);
    try {
      const items = await native.fs.readdir(dir);
      items.sort((a, b) =>
        a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1,
      );
      setEntries(items);
      setCwd(dir);
      setStatus(`${items.length} items`);
    } catch (e) {
      console.error('[CodeEditorPage:list]', JSON.stringify({ dir, error: e instanceof Error ? e.message : String(e) }), e instanceof Error ? e.stack : undefined);
      setStatus(`error: ${(e as Error).message}`);
    }
  }, []);

  // On mount: request fs, then list the home directory.
  React.useEffect(() => {
    if (!available) return;
    void (async () => {
      try {
        await permissions.request({ fs: 'full' });
        await list('/');
      } catch (e) {
        console.error('[CodeEditorPage:mountFsInit]', JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), e instanceof Error ? e.stack : undefined);
        setStatus(`permission error: ${(e as Error).message}`);
      }
    })();
  }, [available, list]);

  async function openEntry(entry: HostDirent) {
    const path = joinPath(cwd, entry.name);
    if (entry.isDirectory) {
      await list(path);
      return;
    }
    setStatus(`opening ${path}…`);
    try {
      const text = await native.fs.readFile(path);
      setOpenFile(path);
      setContent(text);
      setDirty(false);
      setStatus(`opened ${path}`);
    } catch (e) {
      console.error('[CodeEditorPage:openEntry]', JSON.stringify({ path, error: e instanceof Error ? e.message : String(e) }), e instanceof Error ? e.stack : undefined);
      setStatus(`error: ${(e as Error).message}`);
    }
  }

  async function save() {
    if (!openFile) return;
    setStatus(`saving ${openFile}…`);
    try {
      await native.fs.writeFile(openFile, content);
      setDirty(false);
      setStatus(`saved ${openFile}`);
    } catch (e) {
      console.error('[CodeEditorPage:save]', JSON.stringify({ openFile, error: e instanceof Error ? e.message : String(e) }), e instanceof Error ? e.stack : undefined);
      setStatus(`error: ${(e as Error).message}`);
    }
  }

  if (!available) {
    return (
      <div data-id="no-native" style={S.fallback}>
        <div style={{ fontWeight: 800, fontSize: 22 }}>Ugly Code</div>
        <p style={{ color: '#988e80', maxWidth: 420, textAlign: 'center' }}>
          This is the IDE — it runs inside the <b>Ugly Studio</b> browser, which gives it
          access to your filesystem and tools. Get Ugly Studio, then open{' '}
          <code>code.ugly.bot</code> inside it.
        </p>
        <a data-id="download-studio" href="https://studio.ugly.bot" style={S.cta}>
          Download Ugly Studio
        </a>
        <div data-id="platform" style={S.tag}>platform: {platform}</div>
      </div>
    );
  }

  return (
    <div style={S.root}>
      <header style={S.header}>
        <span style={{ fontFamily: 'monospace', fontWeight: 800 }}>UGLY·CODE</span>
        <span data-id="cwd" style={S.cwd}>{cwd}</span>
        <span data-id="platform" style={S.tag}>{platform}</span>
        <span style={{ flex: 1 }} />
        <button data-id="save-btn" onClick={() => { void save(); }} disabled={!openFile || !dirty} style={S.save}>
          {dirty ? 'Save ●' : 'Saved'}
        </button>
      </header>
      <div style={S.body}>
        <nav data-id="file-tree" style={S.tree}>
          {cwd !== '/' && (
            <div data-id="up-dir" style={S.entry} onClick={() => { void list(parentOf(cwd)); }}>
              ⬆ ..
            </div>
          )}
          {entries.map((e) => (
            <div
              key={e.name}
              data-id="fs-entry"
              data-name={e.name}
              data-dir={e.isDirectory ? '1' : '0'}
              style={S.entry}
              onClick={() => { void openEntry(e); }}
            >
              {e.isDirectory ? '📁' : '📄'} {e.name}
            </div>
          ))}
        </nav>
        <main style={S.main}>
          {openFile ? (
            <textarea
              data-id="editor-textarea"
              value={content}
              onChange={(ev) => {
                setContent(ev.target.value);
                setDirty(true);
              }}
              spellCheck={false}
              style={S.editor}
            />
          ) : (
            <div style={S.empty}>Select a file to edit.</div>
          )}
        </main>
        <AgentPanel />
      </div>
      <section data-id="terminal" style={S.terminal}>
        <div style={S.termBar}>
          <span style={{ color: '#ff6a1f' }}>❯</span>
          <input
            data-id="cmd-input"
            value={cmd}
            onChange={(e) => { setCmd(e.target.value); }}
            onKeyDown={(e) => { if (e.key === 'Enter' && !running) runCommand(); }}
            spellCheck={false}
            style={S.cmdInput}
          />
          <button data-id="run-btn" onClick={runCommand} disabled={running} style={S.run}>
            {running ? 'Running…' : 'Run'}
          </button>
        </div>
        {output && <pre data-id="terminal-output" style={S.termOut}>{output}</pre>}
      </section>
      <footer data-id="status" style={S.status}>{status}</footer>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', height: '100vh', background: '#0c0b0a', color: '#efe9e1', paddingTop: 'var(--safe-area-inset-top)', paddingLeft: 'var(--safe-area-inset-left)', paddingRight: 'var(--safe-area-inset-right)' },
  header: { display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', borderBottom: '1px solid #2c2620' },
  cwd: { fontFamily: 'monospace', fontSize: 12, color: '#988e80' },
  tag: { fontFamily: 'monospace', fontSize: 11, color: '#ff6a1f', border: '1px solid #d44e0a', borderRadius: 6, padding: '2px 7px' },
  save: { fontFamily: 'monospace', fontSize: 12, background: '#ff6a1f', color: '#1a0e06', border: 'none', borderRadius: 7, padding: '6px 12px', cursor: 'pointer' },
  body: { flex: 1, display: 'flex', minHeight: 0 },
  tree: { width: 240, flex: 'none', borderRight: '1px solid #2c2620', overflow: 'auto', padding: 6 },
  entry: { fontFamily: 'monospace', fontSize: 13, padding: '5px 8px', borderRadius: 6, cursor: 'pointer', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  main: { flex: 1, minWidth: 0, display: 'flex' },
  editor: { flex: 1, background: '#0b0907', color: '#efe9e1', border: 'none', outline: 'none', fontFamily: 'monospace', fontSize: 13, padding: 16, resize: 'none' },
  empty: { margin: 'auto', color: '#5f574c', fontFamily: 'monospace' },
  terminal: { borderTop: '1px solid #2c2620', background: '#0b0907', maxHeight: 220, display: 'flex', flexDirection: 'column', paddingBottom: 'var(--safe-area-inset-bottom)' },
  termBar: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px' },
  cmdInput: { flex: 1, background: '#141210', color: '#efe9e1', border: '1px solid #2c2620', borderRadius: 6, fontFamily: 'monospace', fontSize: 13, padding: '6px 10px', outline: 'none' },
  run: { fontFamily: 'monospace', fontSize: 12, background: '#ff6a1f', color: '#1a0e06', border: 'none', borderRadius: 7, padding: '6px 14px', cursor: 'pointer' },
  termOut: { margin: 0, padding: '0 12px 10px', overflow: 'auto', fontFamily: 'monospace', fontSize: 12, color: '#cabfaa', whiteSpace: 'pre-wrap' },
  status: { fontFamily: 'monospace', fontSize: 11, color: '#988e80', padding: '6px 14px', borderTop: '1px solid #2c2620' },
  fallback: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, height: '100vh', background: '#0c0b0a', color: '#efe9e1' },
  cta: { fontFamily: 'monospace', fontSize: 14, fontWeight: 700, background: '#ff6a1f', color: '#1a0e06', textDecoration: 'none', borderRadius: 8, padding: '10px 18px' },
};
