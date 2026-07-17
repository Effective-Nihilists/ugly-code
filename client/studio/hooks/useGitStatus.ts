import { useCallback, useEffect, useState } from 'react';
import { useIsTabActive } from '../state/ProjectScopeContext';
import { useSocket } from './useSocket';

interface GitFile {
  path: string;
  status: string;
}

/**
 * Poll `gitStatus` for branch + remote + changed files.
 *
 * Optional `cwd` scopes the status to a specific worktree (typically
 * a session's private worktree path). When absent, the RPC defaults
 * to the main project path on the server. The Git tab inside a
 * session view passes the session's worktree path so the panel
 * reflects the session's branch/changes rather than main.
 */
export function useGitStatus(pollIntervalMs = 5000, cwd?: string) {
  const socket = useSocket();
  const isTabActive = useIsTabActive();
  const [branch, setBranch] = useState('main');
  const [remote, setRemote] = useState<string | undefined>(undefined);
  const [files, setFiles] = useState<GitFile[]>([]);

  const refresh = useCallback(async () => {
    try {
      const input = cwd ? { cwd } : {};
      const result = await socket.request('gitStatus', input);
      setBranch(result.branch);
      setRemote(result.remote);
      setFiles(result.files);
    } catch (e) {
      console.error(
        '[useGitStatus:gitStatus]',
        JSON.stringify({
          cwd: cwd ?? null,
          error: e instanceof Error ? e.message : String(e),
        }),
        e instanceof Error ? e.stack : undefined,
      );
    }
  }, [socket, cwd]);

  // Poll only while this tab is visible. Hidden tabs (other open
  // projects in the multi-tab shell) would otherwise hit `gitStatus`
  // every 5s in the background — N open tabs = N×poll, all wasted
  // until the user looks. Refresh once on becoming active again so
  // the panel shows fresh data the moment it's visible.
  useEffect(() => {
    if (!isTabActive) return;
    void refresh();
    const interval = setInterval(refresh, pollIntervalMs);
    return () => {
      clearInterval(interval);
    };
  }, [refresh, pollIntervalMs, isTabActive]);

  return { branch, remote, files, changedCount: files.length, refresh };
}
