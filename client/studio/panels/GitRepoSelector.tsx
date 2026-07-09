/**
 * Shared git repository selector — renders a <select> dropdown listing all git
 * repos found under the project folder. Repos based on ugly-app are flagged with
 * a ★ badge. The selection is persisted in the `?repo=` query string so all
 * panels (feedback, errors, publish, preview, database, events, workers, git)
 * stay in sync.
 *
 * Selecting a repo calls `setActiveRepoPath(repoPath)`, which scopes PANEL
 * handlers (runCli, runDbScript, resolveFeedbackCli, workersGetManifest…) to the
 * chosen repo. The CODING AGENT is unaffected — it always uses the main project
 * root via `getActiveProjectPath()`.
 */
import React from 'react';
import { getActiveProjectPath, setActiveRepoPath } from '../projectPath';
import { findAndCacheGitRepos, getCachedRepos, type GitRepo } from './findGitRepos';

// ── Query-string helpers (shared across panels) ──────────────────────────────

function readQueryParam(key: string): string | null {
  return new URLSearchParams(window.location.search).get(key);
}

function writeQueryParam(key: string, value: string | null): void {
  const url = new URL(window.location.href);
  if (value) url.searchParams.set(key, value);
  else url.searchParams.delete(key);
  window.history.replaceState({}, '', url.pathname + url.search);
}

// ── React hook to read/write a query param ──────────────────────────────────

export function useQueryParam(key: string, defaultValue: string | null = null): [string | null, (v: string | null) => void] {
  const [val, setVal] = React.useState<string | null>(() => readQueryParam(key) ?? defaultValue);

  React.useEffect(() => {
    const onPop = (): void => { setVal(readQueryParam(key) ?? defaultValue); };
    window.addEventListener('popstate', onPop);
    return () => { window.removeEventListener('popstate', onPop); };
  }, [key, defaultValue]);

  const set = React.useCallback((v: string | null) => {
    writeQueryParam(key, v);
    setVal(v);
    window.dispatchEvent(new CustomEvent('ugly-studio:repo-changed', { detail: { repo: v } }));
  }, [key]);

  return [val, set];
}

/** Convenience hook: returns the active repo path from `?repo=`, falling back to
 *  `getActiveProjectPath()` when no repo is selected. */
export function useActiveRepoPath(): string | null {
  const [repo] = useQueryParam(REPO_PARAM);
  return repo ?? getActiveProjectPath() ?? null;
}

// ── The selector component ──────────────────────────────────────────────────

export const REPO_PARAM = 'repo';

const selectStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  background: 'var(--bg-secondary)',
  color: 'var(--text-primary)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  padding: '3px 6px',
  maxWidth: 200,
  outline: 'none',
  flexShrink: 0,
};

export interface GitRepoSelectorProps {
  projectPath?: string;
}

export function GitRepoSelector({ projectPath }: GitRepoSelectorProps): React.ReactElement {
  const [repos, setRepos] = React.useState<GitRepo[]>(() => getCachedRepos());
  const [repoValue, setRepoValue] = useQueryParam(REPO_PARAM);

  // Snapshot the original project root on mount — this is the parent folder
  // that contains the sub-repos. We scan from HERE (not the selected repo) so
  // the dropdown always lists all repos within the project.
  const rootPathRef = React.useRef<string | null>(null);
  rootPathRef.current ??= projectPath ?? getActiveProjectPath();

  // Scan for repos from the ORIGINAL root (not the selected repo).
  React.useEffect(() => {
    const cached = getCachedRepos();
    if (cached.length > 0) {
      setRepos(cached);
      return;
    }
    const root = rootPathRef.current;
    if (!root) return;
    void findAndCacheGitRepos(root).then((r) => { setRepos(r); });
  }, []);

  // Default to the first repo if nothing selected yet.
  React.useEffect(() => {
    if (repos.length > 0 && repoValue == null) {
      setRepoValue(repos[0].path);
    }
  }, [repos, repoValue, setRepoValue]);

  // When the selected repo changes, update the module-level activeRepoPath
  // so ALL panel handlers (runCli, runDbScript, resolveFeedbackCli,
  // workersGetManifest…) scope to the right repo. The coding agent path
  // (activeProjectPath) is NEVER touched — it stays anchored to the main root.
  React.useEffect(() => {
    if (repoValue) {
      setActiveRepoPath(repoValue);
    } else {
      setActiveRepoPath(rootPathRef.current);
    }
  }, [repoValue]);

  // Restore the original root on unmount.
  React.useEffect(() => {
    return () => { setActiveRepoPath(rootPathRef.current); };
  }, []);

  if (repos.length < 2) {
    return (
      <span title={repos[0]?.path ?? ''} style={{ ...selectStyle, opacity: 0.5, cursor: 'default' }}>
        {repos[0]?.name ?? '(no repos)'}
      </span>
    );
  }

  return (
    <select
      data-id="git-repo-select"
      style={selectStyle}
      value={repoValue ?? ''}
      onChange={(e) => { setRepoValue(e.target.value || null); }}
      title="Select a git repo within the project folder"
    >
      {repos.map((r) => (
        <option key={r.path} value={r.path}>
          {r.isUglyApp ? '★ ' : ''}{r.name}
        </option>
      ))}
    </select>
  );
}
