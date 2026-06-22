import React from 'react';
import { native } from 'ugly-app/native';
import { getActiveProjectPath } from '../hooks/useSocket';

// A real git workspace: status (staged/unstaged/untracked) + colored diff +
// stage-select + commit + history, all over `native.process.spawn('git', …)`.
// Mirrors the monolith's GitPanel feature set, trimmed to the core workflow.

/** Run a git command in `cwd`; resolve { ok, out } (stdout, or stderr on fail). */
function git(args: string[], cwd: string): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    try {
      const p = native.process.spawn('git', args, { cwd });
      p.onStdout((c) => (stdout += c));
      p.onStderr((c) => (stderr += c));
      p.onError((e) => { resolve({ ok: false, out: `${stderr}\n${e}` }); });
      p.onExit((code) => { resolve({ ok: code === 0, out: code === 0 ? stdout : `${stdout}${stderr}`.trim() }); });
    } catch (e) {
      resolve({ ok: false, out: (e as Error).message });
    }
  });
}

interface GitFile {
  path: string;
  /** Porcelain XY → a short label + whether it's already staged. */
  label: string;
  staged: boolean;
}
interface Commit {
  hash: string;
  message: string;
  author: string;
  date: number;
}

/** Parse `git status --porcelain=v1 -z -uall` (NUL-separated). */
function parseStatus(out: string): GitFile[] {
  const files: GitFile[] = [];
  for (const entry of out.split('\0')) {
    if (entry.length < 4) continue;
    const x = entry[0];
    const y = entry[1];
    const path = entry.slice(3);
    const code = x === '?' ? '?' : x !== ' ' ? x : y;
    const label = code === '?' ? 'U' : code; // U = untracked
    files.push({ path, label, staged: x !== ' ' && x !== '?' });
  }
  return files;
}

const LOG_FMT = '%H%x1f%s%x1f%aN%x1f%at%x1e';
function parseLog(out: string): Commit[] {
  return out
    .split('\x1e')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [hash, message, author, at] = r.split('\x1f');
      return { hash, message, author, date: Number(at) * 1000 };
    });
}

type View = 'changes' | 'history';

export function GitPanel(): React.ReactElement {
  const [view, setView] = React.useState<View>('changes');
  const [branch, setBranch] = React.useState('');
  const [files, setFiles] = React.useState<GitFile[]>([]);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [deselected, setDeselected] = React.useState<Set<string>>(new Set());
  const [commitMsg, setCommitMsg] = React.useState('');
  const [active, setActive] = React.useState<string | null>(null); // file or commit hash
  const [diff, setDiff] = React.useState('');
  const [commits, setCommits] = React.useState<Commit[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    const cwd = getActiveProjectPath();
    if (!cwd) return;
    const [b, s] = await Promise.all([git(['branch', '--show-current'], cwd), git(['status', '--porcelain=v1', '-z', '-uall'], cwd)]);
    setBranch(b.out.trim());
    setFiles(parseStatus(s.out));
  }, []);

  React.useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 4000);
    return () => { clearInterval(t); };
  }, [refresh]);

  // A file counts as selected-for-commit unless the user unchecked it.
  const isChecked = React.useCallback((p: string) => (selected.size ? selected.has(p) : !deselected.has(p)), [selected, deselected]);
  const toggle = (p: string): void => {
    setDeselected((d) => {
      const n = new Set(d);
      if (isChecked(p)) n.add(p);
      else n.delete(p);
      return n;
    });
    setSelected(new Set()); // switch to "all except deselected" model
  };

  const openFile = React.useCallback(async (f: GitFile) => {
    const cwd = getActiveProjectPath();
    if (!cwd) return;
    setActive(f.path);
    setView('changes');
    const args = f.label === 'U' ? ['diff', '--no-color', '--no-index', '--', '/dev/null', f.path] : ['diff', '--no-color', 'HEAD', '--', f.path];
    const r = await git(args, cwd);
    setDiff(r.out || '(no diff)');
  }, []);

  const commit = React.useCallback(async () => {
    const cwd = getActiveProjectPath();
    const toCommit = files.filter((f) => isChecked(f.path)).map((f) => f.path);
    if (!cwd || !commitMsg.trim() || toCommit.length === 0 || busy) return;
    setBusy(true);
    setNotice(null);
    const add = await git(['add', '-f', '--', ...toCommit], cwd);
    if (!add.ok) {
      setNotice(add.out);
      setBusy(false);
      return;
    }
    const res = await git(['-c', 'user.name=Ugly Studio', '-c', 'user.email=studio@ugly.bot', 'commit', '-m', commitMsg.trim()], cwd);
    setNotice(res.ok ? 'Committed.' : res.out);
    setBusy(false);
    if (res.ok) {
      setCommitMsg('');
      setDiff('');
      setActive(null);
      void refresh();
    }
  }, [files, commitMsg, busy, isChecked, refresh]);

  const loadHistory = React.useCallback(async () => {
    const cwd = getActiveProjectPath();
    if (!cwd) return;
    const r = await git(['log', '-n', '50', `--format=${LOG_FMT}`], cwd);
    setCommits(parseLog(r.out));
  }, []);

  const openCommit = React.useCallback(async (hash: string) => {
    const cwd = getActiveProjectPath();
    if (!cwd) return;
    setActive(hash);
    const r = await git(['show', '--no-color', hash], cwd);
    setDiff(r.out);
  }, []);

  React.useEffect(() => {
    if (view === 'history') void loadHistory();
  }, [view, loadHistory]);

  const checkedCount = files.filter((f) => isChecked(f.path)).length;

  return (
    <div data-id="git-panel" style={S.root}>
      <div style={S.bar}>
        <span style={S.branch}>⎇ {branch || '—'}</span>
        <button style={tabStyle(view === 'changes')} onClick={() => { setView('changes'); }}>
          Changes{files.length ? ` (${files.length})` : ''}
        </button>
        <button style={tabStyle(view === 'history')} onClick={() => { setView('history'); }}>
          History
        </button>
        <span style={{ flex: 1 }} />
        <button style={S.btn} onClick={() => void refresh()}>
          Refresh
        </button>
      </div>

      <div style={S.body}>
        <div style={S.left}>
          {view === 'changes' ? (
            files.length === 0 ? (
              <div style={S.empty}>No changes — working tree clean.</div>
            ) : (
              files.map((f) => (
                <div key={f.path} style={{ ...S.row, ...(active === f.path ? S.rowActive : {}) }}>
                  <input type="checkbox" checked={isChecked(f.path)} onChange={() => { toggle(f.path); }} style={S.check} />
                  <button style={S.rowBtn} onClick={() => void openFile(f)} title={f.path}>
                    <span style={badgeStyle(f.label)}>{f.label}</span>
                    <span style={S.rowPath}>{f.path}</span>
                  </button>
                </div>
              ))
            )
          ) : (
            commits.map((c) => (
              <button key={c.hash} style={{ ...S.commitRow, ...(active === c.hash ? S.rowActive : {}) }} onClick={() => void openCommit(c.hash)}>
                <span style={S.commitMsg}>{c.message}</span>
                <span style={S.commitMeta}>
                  {c.hash.slice(0, 7)} · {c.author} · {new Date(c.date).toLocaleDateString()}
                </span>
              </button>
            ))
          )}

          {view === 'changes' && files.length > 0 && (
            <div style={S.commitBox}>
              <textarea value={commitMsg} onChange={(e) => { setCommitMsg(e.target.value); }} placeholder="Commit message" rows={2} style={S.msg} />
              <button style={S.commitBtn} disabled={busy || !commitMsg.trim() || checkedCount === 0} onClick={() => void commit()}>
                {busy ? 'Committing…' : `Commit ${checkedCount} file${checkedCount === 1 ? '' : 's'}`}
              </button>
              {notice && <span style={S.notice}>{notice}</span>}
            </div>
          )}
        </div>

        <pre style={S.diff}>{colorize(diff)}</pre>
      </div>
    </div>
  );
}

/** Render a diff with +/- /header coloring. */
function colorize(diff: string): React.ReactNode {
  if (!diff) return <span style={{ color: 'var(--text-muted)' }}>Select a file to see its diff.</span>;
  return diff.split('\n').map((line, i) => {
    let color = 'var(--text-primary)';
    if (line.startsWith('+') && !line.startsWith('+++')) color = '#22863a';
    else if (line.startsWith('-') && !line.startsWith('---')) color = '#cb2431';
    else if (line.startsWith('@@')) color = 'var(--accent)';
    else if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('+++') || line.startsWith('---')) color = 'var(--text-muted)';
    return (
      <div key={i} style={{ color }}>
        {line || ' '}
      </div>
    );
  });
}

function badgeStyle(label: string): React.CSSProperties {
  const map: Record<string, string> = { M: 'var(--accent)', A: '#22863a', D: '#cb2431', U: 'var(--text-muted)', R: 'var(--accent)' };
  return { ...S.badge, color: map[label] ?? 'var(--text-muted)' };
}
function tabStyle(active: boolean): React.CSSProperties {
  return { ...S.tab, ...(active ? { color: 'var(--accent)', borderColor: 'var(--accent)' } : {}) };
}

const S = {
  root: { height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--bg-primary)', color: 'var(--text-primary)', minHeight: 0 },
  bar: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', borderBottom: '1px solid var(--border)', flexShrink: 0 },
  branch: { fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, marginRight: 6 },
  tab: { fontFamily: 'var(--font-mono)', fontSize: 12, background: 'transparent', color: 'var(--text-muted)', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 10px', cursor: 'pointer' },
  btn: { fontFamily: 'var(--font-mono)', fontSize: 12, background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 12px', cursor: 'pointer' },
  body: { flex: 1, minHeight: 0, display: 'flex' },
  left: { width: 300, flex: 'none', borderRight: '1px solid var(--border)', overflow: 'auto', display: 'flex', flexDirection: 'column' },
  empty: { padding: 16, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-muted)' },
  row: { display: 'flex', alignItems: 'center', gap: 6, padding: '2px 8px' },
  rowActive: { background: 'var(--accent-dim)' },
  check: { accentColor: 'var(--accent)' },
  rowBtn: { flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8, background: 'transparent', border: 'none', cursor: 'pointer', padding: '4px 2px', textAlign: 'left' as const, color: 'var(--text-primary)' },
  badge: { fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700, width: 14, flex: 'none' },
  rowPath: { fontFamily: 'var(--font-mono)', fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  commitRow: { display: 'flex', flexDirection: 'column', gap: 2, padding: '8px 12px', background: 'transparent', border: 'none', borderBottom: '1px solid var(--border)', cursor: 'pointer', textAlign: 'left' as const, color: 'var(--text-primary)' },
  commitMsg: { fontFamily: 'var(--font-mono)', fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  commitMeta: { fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)' },
  commitBox: { marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 8, padding: 10, borderTop: '1px solid var(--border)' },
  msg: { fontFamily: 'var(--font-mono)', fontSize: 12, background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 6, padding: 8, resize: 'vertical' as const, outline: 'none' },
  commitBtn: { fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 6, padding: '6px 12px', cursor: 'pointer' },
  notice: { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'pre-wrap' },
  diff: { flex: 1, minWidth: 0, overflow: 'auto', margin: 0, padding: 14, fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.45, whiteSpace: 'pre' as const, background: 'var(--bg-panel)' },
} satisfies Record<string, React.CSSProperties>;
