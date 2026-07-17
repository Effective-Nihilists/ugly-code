import React from 'react';
import { useActiveRepoPath } from '../panels/GitRepoSelector';
import { InteractiveTerminal } from '../components/InteractiveTerminal';

/** The Terminal tab: an interactive terminal bound to the selected repo's dir
 *  (falls back to the active project root when no repo is selected). */
export function TerminalPanel(): React.ReactElement {
  const cwd = useActiveRepoPath();
  if (!cwd) {
    return (
      <div data-id="terminal-panel" style={S.empty}>
        No project open.
      </div>
    );
  }
  return (
    <div data-id="terminal-panel" style={S.root}>
      <InteractiveTerminal cwd={cwd} />
    </div>
  );
}

const S = {
  root: { height: '100%', minHeight: 0 },
  empty: {
    height: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'var(--text-muted)',
    fontFamily: 'var(--font-mono)',
    fontSize: 12,
    background: 'var(--bg-primary)',
  },
} satisfies Record<string, React.CSSProperties>;
