import React from 'react';
import { native } from 'ugly-app/native';
import { getActiveProjectPath } from '../hooks/useSocket';
import { findAndCacheGitRepos, type GitRepo } from './findGitRepos';

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
      console.error('[GitPanel:git-spawn]', JSON.stringify({ args, cwd, error: e instanceof Error ? e.message : String(e) }), e instanceof Error ? e.stack : undefined);
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
  const [repos, setRepos] = React.useState<GitRepo[]>([]);
  const [activeRepo, setActiveRepo] = React.useState<string | null>(null);

  // Effective working directory: the selected repo or the active project root.
  const cwd = activeRepo ?? getActiveProjectPath() ?? '';

  // Scan for nested .git dirs on mount.
  React.useEffect(() => {
    const root = getActiveProjectPath();
    console.log('[GitPanel] mount, scanning repos under', root);
    if (root) void findAndCacheGitRepos(root).then((r) => { console.log('[GitPanel] repos loaded', r.length); setRepos(r); });
  }, []);

  const refresh = React.useCallback(async () => {
    if (!cwd) return;
    const [b, s] = await Promise.all([git(['branch', '--show-current'], cwd), git(['status', '--porcelain=v1', '-z', '-uall'], cwd)]);
    // Only parse output when git succeeded — an error (e.g. "fatal: not a git
    // repository") must not be parsed as file paths.
    setBranch(b.ok ? b.out.trim() : '');
    setFiles(s.ok ? parseStatus(s.out) : []);
  }, [cwd]);

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
    if (!cwd) return;
    setActive(f.path);
    setView('changes');
    const args = f.label === 'U' ? ['diff', '--no-color', '--no-index', '--', '/dev/null', f.path] : ['diff', '--no-color', 'HEAD', '--', f.path];
    const r = await git(args, cwd);
    setDiff(r.out || '(no diff)');
  }, [cwd]);

  const commit = React.useCallback(async () => {
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
  }, [files, commitMsg, busy, isChecked, cwd, refresh]);

  const loadHistory = React.useCallback(async () => {
    if (!cwd) return;
    const r = await git(['log', '-n', '50', `--format=${LOG_FMT}`], cwd);
    setCommits(parseLog(r.out));
  }, [cwd]);

  const openCommit = React.useCallback(async (hash: string) => {
    if (!cwd) return;
    setActive(hash);
    const r = await git(['show', '--no-color', hash], cwd);
    setDiff(r.out);
  }, [cwd]);

  React.useEffect(() => {
    if (view === 'history') void loadHistory();
  }, [view, loadHistory]);

  const checkedCount = files.filter((f) => isChecked(f.path)).length;

  return (
    <div data-id="git-panel" style={S.root}>
      <div style={S.bar}>
        {repos.length > 0 ? (
          <select
            data-id="git-repo-select"
            style={S.repoSelect}
            value={activeRepo ?? getActiveProjectPath() ?? ''}
            onChange={(e) => { setActiveRepo(e.target.value || null); }}
          >
            <option value={getActiveProjectPath() ?? ''}>{getActiveProjectPath()?.split('/').pop() ?? '(root)'}</option>
            {repos.map((r) => (
              <option key={r.path} value={r.path}>
                {r.name}
              </option>
            ))}
          </select>
        ) : null}
        <span style={{ ...S.branch, flex: 'none' }}>⎇ {branch || '—'}</span>
        <button data-id="git-tab-changes" style={tabStyle(view === 'changes')} onClick={() => { setView('changes'); }}>
          Changes{files.length ? ` (${files.length})` : ''}
        </button>
        <button data-id="git-tab-history" style={tabStyle(view === 'history')} onClick={() => { setView('history'); }}>
          History
        </button>
        <span style={{ flex: 1 }} />
        <button data-id="git-refresh" style={S.btn} onClick={() => void refresh()}>
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
                  <input type="checkbox" data-id={`git-file-check-${f.path}`} checked={isChecked(f.path)} onChange={() => { toggle(f.path); }} style={S.check} />
                  <button data-id={`git-file-open-${f.path}`} style={S.rowBtn} onClick={() => void openFile(f)} title={f.path}>
                    <span style={badgeStyle(f.label)}>{f.label}</span>
                    <span style={S.rowPath}>{f.path}</span>
                  </button>
                </div>
              ))
            )
          ) : (
            commits.map((c) => (
              <button key={c.hash} data-id={`git-commit-row-${c.hash}`} style={{ ...S.commitRow, ...(active === c.hash ? S.rowActive : {}) }} onClick={() => void openCommit(c.hash)}>
                <span style={S.commitMsg}>{c.message}</span>
                <span style={S.commitMeta}>
                  {c.hash.slice(0, 7)} · {c.author} · {new Date(c.date).toLocaleDateString()}
                </span>
              </button>
            ))
          )}

          {view === 'changes' && files.length > 0 && (
            <div style={S.commitBox}>
              <textarea data-id="git-commit-message" value={commitMsg} onChange={(e) => { setCommitMsg(e.target.value); }} placeholder="Commit message" rows={2} style={S.msg} />
              <button data-id="git-commit-submit" style={S.commitBtn} disabled={busy || !commitMsg.trim() || checkedCount === 0} onClick={() => void commit()}>
                {busy ? 'Committing…' : `Commit ${checkedCount} file${checkedCount === 1 ? '' : 's'}`}
              </button>
              {notice && <span style={S.notice}>{notice}</span>}
            </div>
          )}
        </div>

        <div style={S.diff}><DiffView diff={diff} /></div>
      </div>
    </div>
  );
}


// ── GitHub-Desktop-style diff view ───────────────────────────────────────────
type DiffRowType = 'meta' | 'file' | 'hunk' | 'add' | 'del' | 'context';
interface DiffRow { type: DiffRowType; oldNo?: number; newNo?: number; text: string }

/** Parse a unified diff (incl. `git show` output) into rows with old/new line numbers. */
function parseDiff(diff: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git') || line.startsWith('diff --no-index')) { rows.push({ type: 'file', text: line }); inHunk = false; continue; }
    if (/^(index |--- |\+\+\+ |new file|deleted file|similarity |rename |copy |old mode|new mode|Binary )/.test(line)) { rows.push({ type: 'file', text: line }); continue; }
    if (line.startsWith('@@')) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m) { oldNo = Number(m[1]); newNo = Number(m[2]); }
      rows.push({ type: 'hunk', text: line });
      inHunk = true;
      continue;
    }
    if (!inHunk) { rows.push({ type: 'meta', text: line }); continue; }
    if (line.startsWith('\\')) { rows.push({ type: 'meta', text: line }); continue; } // "\ No newline at end of file"
    if (line.startsWith('+')) { rows.push({ type: 'add', newNo, text: line.slice(1) }); newNo++; continue; }
    if (line.startsWith('-')) { rows.push({ type: 'del', oldNo, text: line.slice(1) }); oldNo++; continue; }
    rows.push({ type: 'context', oldNo, newNo, text: line.startsWith(' ') ? line.slice(1) : line });
    oldNo++; newNo++;
  }
  return rows;
}

function DiffView({ diff }: { diff: string }): React.ReactElement {
  if (!diff) return <span style={{ display: 'block', padding: '8px 14px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>Select a file to see its diff.</span>;
  const rows = parseDiff(diff);
  return (
    <div style={D.inner}>
      {rows.map((r, i) => {
        if (r.type === 'file') {
          // Surface the human path from `diff --git a/… b/…`; hide index/mode noise.
          if (!r.text.startsWith('diff --git')) return null;
          const m = /b\/(.+)$/.exec(r.text);
          return <div key={i} style={D.fileHeader}>{m ? m[1] : r.text}</div>;
        }
        if (r.type === 'meta') return r.text ? <div key={i} style={D.meta}>{r.text}</div> : null;
        if (r.type === 'hunk') return <div key={i} style={D.hunk}>{r.text}</div>;
        const tint = r.type === 'add' ? D.addRow : r.type === 'del' ? D.delRow : undefined;
        const gut = r.type === 'add' ? D.addGutter : r.type === 'del' ? D.delGutter : undefined;
        const sign = r.type === 'add' ? '+' : r.type === 'del' ? '-' : ' ';
        return (
          <div key={i} style={{ ...D.row, ...tint }}>
            <span style={{ ...D.gutter, ...gut }}>{r.oldNo ?? ''}</span>
            <span style={{ ...D.gutter, ...gut }}>{r.newNo ?? ''}</span>
            <span style={D.sign}>{sign}</span>
            <span style={D.content}>{r.text || ' '}</span>
          </div>
        );
      })}
    </div>
  );
}

const D = {
  inner: { minWidth: 'max-content', fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.5 },
  fileHeader: { position: 'sticky' as const, top: 0, padding: '6px 12px', fontWeight: 700, color: 'var(--text-primary)', background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border)' },
  meta: { padding: '0 12px', color: 'var(--text-muted)', whiteSpace: 'pre' as const },
  hunk: { padding: '2px 12px', color: 'var(--accent)', background: 'var(--bg-secondary)', whiteSpace: 'pre' as const, borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)' },
  row: { display: 'flex', alignItems: 'stretch' },
  addRow: { background: 'rgba(46,160,67,0.15)' },
  delRow: { background: 'rgba(248,81,73,0.15)' },
  gutter: { flex: 'none', width: 44, textAlign: 'right' as const, padding: '0 8px', color: 'var(--text-muted)', userSelect: 'none' as const, boxSizing: 'border-box' as const },
  addGutter: { background: 'rgba(46,160,67,0.25)', color: 'var(--text-secondary)' },
  delGutter: { background: 'rgba(248,81,73,0.25)', color: 'var(--text-secondary)' },
  sign: { flex: 'none', width: 16, textAlign: 'center' as const, color: 'var(--text-muted)', userSelect: 'none' as const },
  content: { whiteSpace: 'pre' as const, paddingRight: 16, color: 'var(--text-primary)' },
} satisfies Record<string, React.CSSProperties>;

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
  repoSelect: { fontFamily: 'var(--font-mono)', fontSize: 11, background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 6, padding: '3px 6px', maxWidth: 160, outline: 'none' },
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
  diff: { flex: 1, minWidth: 0, overflow: 'auto', margin: 0, padding: '8px 0', background: 'var(--bg-panel)' },
} satisfies Record<string, React.CSSProperties>;
