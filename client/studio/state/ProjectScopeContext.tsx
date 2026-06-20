/**
 * Per-subtree React context that pins a `projectPath` for everything
 * below it. Read by [../hooks/useSocket.ts] to auto-inject
 * `projectPath` into every request originating from this subtree.
 *
 * Phase 2 used a module-level pointer (one active project for the
 * whole renderer). Phase 3 mounts N project editors at once (only
 * the active one is visible), so each subtree needs its own pinned
 * `projectPath` independent of which tab is currently focused. Without
 * this, requests from a hidden tab's effects/timers would silently
 * carry the *visible* tab's projectPath and corrupt its data view.
 *
 * Context value `null` = unscoped (the request goes through with
 * whatever input the caller supplied; the server falls back to its
 * legacy active pointer). Pre-Phase-3 component trees that aren't
 * wrapped in `<ProjectScopeProvider>` see this default — same
 * behavior as before.
 */

import React, { createContext, useContext } from 'react';

export const ProjectScopeContext = createContext<string | null>(null);

/**
 * Per-subtree "is this tab currently visible?" context. Set to
 * `false` for tabs hidden via `display: none` in the multi-tab shell
 * so polling/streaming effects can skip work while the user isn't
 * looking. Default `true` keeps pre-Phase-3 trees (no shell wrapping)
 * behaving exactly as before.
 *
 * Subscribers should treat this as a hint, not a hard guarantee:
 * one-shot fetches on real user actions still run regardless; only
 * recurring background work (timers, polls, animations) should gate
 * on it.
 */
export const IsTabActiveContext = createContext<boolean>(true);

export function ProjectScopeProvider({
  projectPath,
  isActive = true,
  children,
}: {
  projectPath: string | null;
  /** Pass `false` for hidden tabs so descendants can pause polling. */
  isActive?: boolean;
  children: React.ReactNode;
}) {
  return (
    <ProjectScopeContext.Provider value={projectPath}>
      <IsTabActiveContext.Provider value={isActive}>
        {children}
      </IsTabActiveContext.Provider>
    </ProjectScopeContext.Provider>
  );
}

/**
 * Returns whether the enclosing tab is currently the active (visible)
 * one. Components with recurring background work (`setInterval`,
 * `setTimeout`-loops, `requestAnimationFrame`, periodic
 * `socket.request` polls) should subscribe and skip the work when
 * `false` to avoid N parallel polls when N tabs are mounted.
 *
 * Trees that aren't wrapped in `<ProjectScopeProvider>` see the
 * default value `true` — preserves legacy behavior.
 */
export function useIsTabActive(): boolean {
  return useContext(IsTabActiveContext);
}
