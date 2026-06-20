/**
 * Renderer-side state for the multi-project tab strip.
 *
 * Each open tab is `{ tabId, projectPath, projectName }` where
 * `projectPath = null` means the tab is showing `ProjectOnboarding`
 * (a "picker tab" — born empty, becomes a project tab when the user
 * picks one). The active tab determines which project the editor
 * shell renders against.
 *
 * Backend pairing:
 *   - `listOpenProjects` rehydrates the tab strip on mount + after
 *     any open / close so the server's registry stays the source of
 *     truth for "which projects are open."
 *   - `openProject` adds a project to the registry (and switches the
 *     server's active pointer to it). Called when the user picks a
 *     project inside a picker tab.
 *   - `setActiveProject` switches the server's active pointer without
 *     re-running the openProject lifecycle. Called on tab click.
 *   - `closeProject({ projectPath })` removes one tab's project from
 *     the registry without tearing down the others.
 *
 * This keeps existing single-project handlers working unchanged —
 * they continue reading the server's active pointer, which now
 * tracks whichever tab is focused.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { onCustomMessage, useSocket } from '../hooks/useSocket';
import { getStudioUserSettingSync } from '../hooks/useStudioUserSetting';
import { bootMark } from '../utils/startupTiming';

/**
 * Per-open-project aggregate of live-session activity. Drives the
 * status dot on each project tab in the top-bar. All three booleans
 * can be true simultaneously; the tab picks the highest-priority one
 * in the order `thinkingDone > thinking > blocked > idle`.
 */
export interface ProjectAggregate {
  thinkingDone: boolean;
  thinking: boolean;
  blocked: boolean;
}

export interface ProjectTab {
  /** Stable client-generated id; survives tab switches and re-renders. */
  tabId: string;
  /**
   * Project root path. `null` while the tab is showing the project
   * picker (a fresh `+` tab before the user opens anything) OR while
   * the tab is in `creating` state (the path isn't known until the
   * sidecar's initProject resolves).
   */
  projectPath: string | null;
  /**
   * Display label for the tab strip. `null` while on the picker;
   * populated with the user-typed name while in `creating` state.
   */
  projectName: string | null;
  /**
   * True when the sidecar hibernated this project's root dev server
   * (idle > 15min while not active, or force-evicted on RSS pressure).
   * Surfaced in the tab strip so the user knows the dev URL is dark
   * until they switch in. Picker tabs are always `false`.
   */
  hibernated: boolean;
  /**
   * When set, the tab is in the middle of `initProject` /
   * `evalCreateProject`. The tab strip renders it as a non-closable
   * spinner tab (the user can still switch away to other tabs), and
   * the body renders `ProjectCreationProgress` instead of
   * `ProjectOnboarding` or the workspace. `taskId` is the sidecar's
   * AbortController key — closing the tab fires `cancelTask({ taskId })`.
   * `error` carries the failure message once the RPC throws so the
   * inline view can show a dismissable error.
   */
  creating?: {
    taskId: string;
    parentDir: string;
    /** Set when the creation RPC throws — flips the inline view to
     *  an errored state with a Close button. */
    error?: string;
  };
}

export interface ProjectsContextValue {
  openTabs: ProjectTab[];
  activeTabId: string | null;
  activeTab: ProjectTab | null;
  /** Add a fresh picker tab (no projectPath) and switch to it. */
  newPickerTab(): void;
  /**
   * Open a project — either updates the active picker tab in-place
   * (turning it into a project tab) or, if the project is already
   * open in another tab, switches to that tab instead of duplicating.
   */
  openProjectInActiveTab(projectPath: string, projectName: string): void;
  /**
   * Promote the active picker tab into a "creating" tab. Used at the
   * moment the user clicks Create in ProjectOnboarding so the tab strip
   * shows a labelled spinner tab immediately and the user can switch
   * away to other open tabs while the sidecar runs `initProject`. The
   * returned `tabId` is the same tab — passed to the inline progress
   * view so it can later call `completeProjectCreation` /
   * `failProjectCreation` / `cancelProjectCreation` on the right tab.
   */
  beginProjectCreation(name: string, parentDir: string, taskId: string): string;
  /**
   * Resolve a creating tab into a real project tab. Reuses the same
   * de-dup logic as `openProjectInActiveTab`: if the same path is
   * already open in another tab, drops the creating tab and switches
   * to the existing one instead of duplicating.
   */
  completeProjectCreation(
    tabId: string,
    projectPath: string,
    projectName: string,
  ): void;
  /**
   * Mark a creating tab as errored. The inline progress view keeps
   * showing the streamed log + the error block; user dismisses via the
   * tab's `×` or the inline Close button (both route through
   * `cancelProjectCreation` to remove the tab cleanly).
   */
  failProjectCreation(tabId: string, error: string): void;
  /**
   * Cancel an in-flight creating tab. Fires `cancelTask({ taskId })`
   * so the sidecar aborts the scaffold/pnpm install, then removes the
   * tab from the strip. Safe to call on an already-errored tab — it
   * just removes the tab (cancelTask on a settled task is a no-op).
   */
  cancelProjectCreation(tabId: string): void;
  /** Switch the active tab. Pushes the server's active pointer too. */
  switchTab(tabId: string): void;
  /**
   * Close a tab. If it's the active tab, the next tab to the right
   * becomes active (or to the left if it was the rightmost). Closing
   * the last tab opens a fresh picker tab so the shell always has
   * something to render.
   */
  closeTab(tabId: string): void;
  /**
   * Move a tab to a new position in the strip (drag-to-reorder).
   * `fromTabId` is the dragged tab; `toIndex` is the destination
   * 0-based slot. No server-side coordination — tab order is a
   * per-window UI concern, not a backend concept.
   */
  reorderTab(fromTabId: string, toIndex: number): void;
  /** Re-fetch open projects from the server (used after open/close). */
  refresh(): Promise<void>;
  /**
   * False until the first `listOpenProjects` round-trip lands (success
   * OR failure — a flaky network must not wedge the UI forever). Used
   * by the BootLoader gate so the workspace mounts directly on warm
   * starts instead of flashing the project picker for a frame.
   */
  hydrated: boolean;
  /**
   * Pre-fetched `layout.json` content for the active project, fetched
   * in parallel with `listOpenProjects` so `useLayout` can hydrate
   * synchronously when EditorInner mounts. `loaded === false` means
   * "still in flight"; `loaded === true` means "done — content is the
   * truth, including the null/missing case." Used to skip the 400ms
   * flash where useLayout's own readLayout fetch hadn't returned yet.
   *
   * `projectPath` records which project the content belongs to (the
   * server's active project at preload time). useLayout only honours
   * the seed when its tab's projectPath matches — every other tab's
   * layout still goes through the normal per-mount fetch.
   */
  preloadedLayout: {
    loaded: boolean;
    content: string | null;
    projectPath: string | null;
  };
  /**
   * Per-project live-session activity aggregates keyed by project
   * path. Drives the status dot on each project tab in the top-bar.
   * Seeded by `getOpenProjectAggregates` on mount and kept fresh via
   * the `project:aggregate-changed` push broadcast. Missing entries
   * are treated as idle.
   */
  aggregates: Record<string, ProjectAggregate>;
}

const ProjectsContext = createContext<ProjectsContextValue | null>(null);

function makeTabId(): string {
  return `tab_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function basenameForPath(p: string): string {
  const parts = p.split(/[\\/]/);
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i]) return parts[i];
  }
  return p;
}

/**
 * Read `?openProject=<path>` from the page URL — set when the user
 * uses "Open in New Window" on a tab. When present, this window
 * SUPPRESSES the listOpenProjects rehydration (so it doesn't race
 * with the source window's tab list via the shared persistence file)
 * and starts with one tab pointing at the requested project.
 */
/**
 * Tear-out diagnostic logger. The renderer's installed
 * `consoleCapture` (utils/consoleCapture.ts) mirrors every
 * console.log to the sidecar tagged with the source window id, so
 * multi-window triaging just works via the existing log pipeline.
 */
function tlog(msg: string): void {
  console.log(`[tear-out] ${msg}`);
}

function readSeedFromUrl(): {
  projectPath: string;
  projectName: string;
} | null {
  if (typeof window === 'undefined' || !window.location) return null;
  try {
    const params = new URLSearchParams(window.location.search);
    const projectPath = params.get('openProject');
    tlog(
      `readSeedFromUrl: location.search=${window.location.search} openProject=${projectPath}`,
    );
    if (!projectPath) return null;
    const parts = projectPath.split(/[\\/]/);
    let name = projectPath;
    for (let i = parts.length - 1; i >= 0; i--) {
      if (parts[i]) {
        name = parts[i];
        break;
      }
    }
    tlog(
      `readSeedFromUrl resolved projectName=${name} for path=${projectPath}`,
    );
    return { projectPath, projectName: name };
  } catch {
    return null;
  }
}

export function ProjectsProvider({ children }: { children: React.ReactNode }) {
  const socket = useSocket();
  const seed = useMemo(() => readSeedFromUrl(), []);
  // Tear-out windows (?openProject=) seed synchronously with their
  // one project; normal windows start empty and let `refresh()`
  // populate from the server's open-projects registry. The empty
  // case used to seed an initial picker tab, but rendering the picker
  // for a frame before listOpenProjects returns caused a visible
  // flash on warm starts. We now hold the BootLoader (via `hydrated`)
  // until the server roundtrip lands.
  const [openTabs, setOpenTabs] = useState<ProjectTab[]>(() =>
    seed
      ? [
          {
            tabId: makeTabId(),
            projectPath: seed.projectPath,
            projectName: seed.projectName,
            hibernated: false,
          },
        ]
      : [],
  );
  const [activeTabId, setActiveTabId] = useState<string | null>(
    () => openTabs[0]?.tabId ?? null,
  );
  // Seeded windows skip the refresh path (see init effect below), so
  // their hydrated flag flips synchronously. Normal windows wait on
  // refresh() to set it.
  const [hydrated, setHydrated] = useState(() => seed !== null);
  const [preloadedLayout, setPreloadedLayout] = useState<{
    loaded: boolean;
    content: string | null;
    projectPath: string | null;
  }>({ loaded: false, content: null, projectPath: null });
  // Per-project session-activity aggregates. Seeded once on mount
  // via `getOpenProjectAggregates`, refreshed live via the
  // `project:aggregate-changed` broadcast wired in the effect below.
  const [aggregates, setAggregates] = useState<
    Record<string, ProjectAggregate>
  >({});

  const activeTab = useMemo(
    () => openTabs.find((t) => t.tabId === activeTabId) ?? null,
    [openTabs, activeTabId],
  );

  /**
   * Sync the local tab strip with the server's registry. Called on
   * mount and after every open/close so the rehydrated state from
   * `~/.ugly-studio/open-projects.json` shows up as real tabs.
   *
   * Preserves any picker tabs (`projectPath === null`) the user has
   * opened locally — the server doesn't know about those, and we
   * don't want a refresh to delete them mid-pick.
   */
  // Force a picker tab into the strip if it's empty. Used by the
  // failure paths in `refresh()` and the hydration safety timeout so
  // the shell isn't left with `openTabs.length === 0` after the
  // BootLoader releases. Also lifts activeTabId onto the new tab.
  const ensureAtLeastOnePickerTab = useCallback(() => {
    setOpenTabs((prev) => {
      if (prev.length > 0) return prev;
      const tabId = makeTabId();
      queueMicrotask(() => setActiveTabId(tabId));
      return [
        {
          tabId,
          projectPath: null,
          projectName: null,
          hibernated: false,
        },
      ];
    });
  }, []);

  const refresh = useCallback(async () => {
    const isFirstRefresh = !firstHydrationDoneRef.current;
    if (isFirstRefresh) bootMark('projects:refresh-start');
    try {
      const res = await socket.request('listOpenProjects', {});
      if (isFirstRefresh) {
        bootMark('projects:refresh-end', {
          projectCount: res.projects.length,
          activePath: res.activePath,
          hasLayout: !!res.activeLayoutContent,
        });
        // Seed preloadedLayout from the bundled layout content so
        // EditorInner's useLayout can hydrate synchronously on first
        // mount. Only fires on the first refresh — subsequent 30s
        // polls don't re-publish (tabs may have switched and the
        // server's activePath might not match the user's current
        // focus anymore).
        setPreloadedLayout({
          loaded: true,
          content: res.activeLayoutContent ?? null,
          projectPath: res.activePath,
        });
      }
      tlog(
        `refresh: server projects=[${res.projects
          .map((p) => p.path)
          .join(', ')}] activePath=${res.activePath} dismissed=[${Array.from(
          dismissedPathsRef.current,
        ).join(', ')}]`,
      );
      setOpenTabs((prev) => {
        // On the FIRST hydration after mount, if the server has any
        // open projects (that this window hasn't dismissed), discard
        // the renderer's initial picker tab — the user wants to land
        // on their previously-open work, not a fresh picker.
        const visibleServerProjects = res.projects.filter(
          (p) => !dismissedPathsRef.current.has(p.path),
        );
        tlog(
          `refresh: prev=[${prev
            .map((t) => `${t.tabId}->${t.projectPath ?? 'picker'}`)
            .join(' | ')}] visibleAfterDismiss=[${visibleServerProjects
            .map((p) => p.path)
            .join(', ')}]`,
        );
        const isFirstHydrationWithProjects =
          !firstHydrationDoneRef.current && visibleServerProjects.length > 0;
        firstHydrationDoneRef.current = true;
        // Server projects map to existing tabs. Match by path first;
        // if no path match exists, claim a creating tab by projectName
        // (the sidecar registers the project with `openProject` partway
        // through initProject — before the renderer's initProject RPC
        // returns the final path. Without this claim, refresh would
        // mint a duplicate tab while the creating tab still has
        // projectPath=null. See "creating-tab duplicate" race tracked
        // for bot-swarm3 on 2026-06-01.) When claimed, keep the
        // creating field set so ProjectCreationProgress retains
        // ownership; completeProjectCreation will clear it on RPC
        // resolution.
        const claimedCreatingTabIds = new Set<string>();
        const projectTabs: ProjectTab[] = visibleServerProjects.map((p) => {
          const byPath = prev.find((t) => t.projectPath === p.path);
          const byName = byPath
            ? null
            : prev.find(
                (t) =>
                  t.creating != null &&
                  t.projectPath === null &&
                  t.projectName === p.name &&
                  !claimedCreatingTabIds.has(t.tabId),
              );
          const existing = byPath ?? byName ?? null;
          if (byName) claimedCreatingTabIds.add(byName.tabId);
          return {
            tabId: existing?.tabId ?? makeTabId(),
            projectPath: p.path,
            projectName: p.name,
            hibernated: p.hibernated,
            ...(existing?.creating ? { creating: existing.creating } : {}),
          };
        });
        // Drop empty picker tabs on first hydration, but ALWAYS keep
        // creating tabs that weren't claimed above (still no matching
        // server project — initProject hasn't reached the openProject
        // step yet). Claimed creating tabs were folded into projectTabs.
        const pickerTabs = prev.filter(
          (t) =>
            t.projectPath === null &&
            !claimedCreatingTabIds.has(t.tabId) &&
            (t.creating != null || !isFirstHydrationWithProjects),
        );
        // Project tabs first, then any in-flight picker tabs at the right.
        const combined = [...projectTabs, ...pickerTabs];
        if (combined.length === 0) {
          combined.push({
            tabId: makeTabId(),
            projectPath: null,
            projectName: null,
            hibernated: false,
          });
        }
        // Recompute the active tab from `combined` (not from the
        // pre-update openTabsRef which still has the old list) so the
        // first-hydration case — where the initial picker just got
        // dropped — correctly lands on the server's active project
        // instead of pointing at a discarded tab id.
        const currentActive = activeTabIdRef.current;
        const stillExists =
          currentActive !== null &&
          combined.some((t) => t.tabId === currentActive);
        let nextActive: string | null;
        if (stillExists) {
          nextActive = currentActive;
        } else if (res.activePath) {
          const matched = combined.find(
            (t) => t.projectPath === res.activePath,
          );
          nextActive = matched?.tabId ?? combined[0]?.tabId ?? null;
        } else {
          nextActive = combined[0]?.tabId ?? null;
        }
        if (nextActive !== currentActive) {
          // Defer to a microtask so React schedules it after this
          // setOpenTabs commit rather than batching them into one
          // render with mismatched (old tabs, new active) state.
          queueMicrotask(() => setActiveTabId(nextActive));
        }
        return combined;
      });
    } catch (err) {
      if (isFirstRefresh) bootMark('projects:refresh-error');
      console.warn('[ProjectsContext] listOpenProjects failed', err);
      // First refresh failed — the initial openTabs is empty (we don't
      // seed a picker tab eagerly anymore). Insert one now so the
      // editor shell has something to render once the BootLoader gate
      // releases. The picker-no-projects landing is the right UX when
      // we have no signal about open projects.
      if (isFirstRefresh) {
        ensureAtLeastOnePickerTab();
        // Mark preloadedLayout settled-but-empty so the BootLoader's
        // workspace gate releases — no project tab means no layout
        // to wait for, but EditorWithBootGate still consults this.
        setPreloadedLayout((cur) =>
          cur.loaded ? cur : { loaded: true, content: null, projectPath: null },
        );
      }
    } finally {
      // Flip `hydrated` on the first refresh regardless of success —
      // a flaky network must not wedge the BootLoader open forever.
      // The first-hydration branch inside the try writes
      // firstHydrationDoneRef on success only; latch it here so the
      // failure path is also recognised as "first refresh done" and
      // we don't re-fire this finally on the next 30s poll tick.
      if (isFirstRefresh) {
        firstHydrationDoneRef.current = true;
        bootMark('projects:hydrated');
        setHydrated(true);
      }
    }
  }, [socket]);

  // Keep a ref of openTabs so `refresh`'s setActiveTabId callback can
  // inspect the latest tabs synchronously without re-running on every
  // tab change (which would cause an infinite refresh loop).
  const openTabsRef = React.useRef(openTabs);
  useEffect(() => {
    openTabsRef.current = openTabs;
  }, [openTabs]);

  // Has the first listOpenProjects response landed? Gates the
  // "drop initial picker if server has projects" logic so the user
  // lands on their last open project(s) on app launch instead of a
  // fresh picker. Subsequent refreshes preserve picker tabs the
  // user opened deliberately.
  const firstHydrationDoneRef = React.useRef(false);

  // Per-window "this window doesn't want to see these projects"
  // set. Populated by `tearOutTab` — the project stays in the
  // shared registry (so the new window can show it) but this
  // window's refresh poll filters it out so we don't duplicate
  // the tab. Cleared for a path when the user re-opens it via
  // the picker (their intent is clear).
  const dismissedPathsRef = React.useRef<Set<string>>(new Set());

  // Mirror of activeTabId so `refresh()` can compute the next active
  // tab from the just-rebuilt list without bouncing through React
  // state. Updated synchronously inside switchTab/closeTab/etc and
  // via effect for any other path.
  const activeTabIdRef = React.useRef(activeTabId);
  useEffect(() => {
    activeTabIdRef.current = activeTabId;
  }, [activeTabId]);

  // Initial hydration. Two modes:
  //   - Seeded ("Open in New Window"): the new window is dedicated to
  //     the one project the user dragged out. Fire `openProject` so
  //     the shared sidecar registers the project (idempotent) and
  //     keep the tab strip narrow to just that project. We DON'T
  //     rehydrate from `listOpenProjects` — the user opted into a
  //     focused window, not a mirror of every tab. The 30s poll is
  //     also skipped; the user can add more tabs explicitly via the
  //     `+` button if they want.
  //   - Normal: rehydrate from `listOpenProjects` + poll every 30s
  //     so the hibernation badge updates within half a minute.
  useEffect(() => {
    if (seed) {
      void socket
        .request('openProject', { path: seed.projectPath })
        .catch(() => undefined);
      // Tear-out windows don't go through the warm-start preload
      // path; release the workspace gate immediately so EditorInner
      // mounts and useLayout does its own fetch (single ~50ms flash
      // is acceptable here — the window was opened intentionally
      // and the user expects a transition).
      setPreloadedLayout({
        loaded: true,
        content: null,
        projectPath: seed.projectPath,
      });
      return;
    }
    void refresh();
    // Safety net: if the first listOpenProjects request never resolves
    // (e.g. the user is signed out so the WS never connects, or the
    // sidecar is hung), flip hydrated anyway after a few seconds so
    // the BootLoader doesn't stay pinned forever. UglyLoginLanding has
    // its own BOOT_MAX_DISPLAY_MS safety; this just makes sure our
    // extraGate doesn't override it indefinitely.
    const hydrationTimeout = setTimeout(() => {
      if (!firstHydrationDoneRef.current) {
        firstHydrationDoneRef.current = true;
        bootMark('projects:hydrate-timeout');
        // Initial openTabs is empty — ensure the shell has at least a
        // picker tab to render when extraGate releases below.
        ensureAtLeastOnePickerTab();
        setHydrated(true);
      }
      // Same safety: a layout preload that never returns must not
      // wedge the splash forever either.
      setPreloadedLayout((cur) =>
        cur.loaded ? cur : { loaded: true, content: null, projectPath: null },
      );
    }, 5_000);
    const id = setInterval(() => void refresh(), 30_000);
    return () => {
      clearInterval(id);
      clearTimeout(hydrationTimeout);
    };
  }, [refresh, seed, socket]);

  // Per-project session-activity aggregates. Seed once on mount, then
  // merge every `project:aggregate-changed` broadcast — the server
  // recomputes + sends one of these whenever a `session_state` event
  // fires (debounced 100ms per project). The map is keyed by project
  // path so we can render every tab from a single source without
  // having to walk the per-tab session lists from the client.
  useEffect(() => {
    let cancelled = false;
    void socket
      .request('getOpenProjectAggregates', {})
      .then((res) => {
        if (!cancelled) setAggregates(res.aggregates);
      })
      .catch(() => {
        /* aggregates default to empty; tabs render as idle */
      });
    const unsub = onCustomMessage((msg) => {
      if (msg.type !== 'project:aggregate-changed') return;
      const projectPath = (msg as { projectPath?: string }).projectPath;
      const aggregate = (msg as { aggregate?: ProjectAggregate }).aggregate;
      if (typeof projectPath !== 'string' || !aggregate) return;
      setAggregates((prev) => ({ ...prev, [projectPath]: aggregate }));
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [socket]);

  // "Thinking-done" sound: fire once per false→true transition of any
  // project's `thinkingDone` flag. Gated on the `notifyOnThinkingDone`
  // user setting — reading sync so we don't fire on the very first
  // render before settings hydrate. Switching tabs while a badge is
  // already present does NOT replay; the transition must happen on
  // the server side (a turn finishing on an unviewed session).
  const prevAggregatesRef = useRef<Record<string, ProjectAggregate>>({});
  useEffect(() => {
    const prev = prevAggregatesRef.current;
    let anyFresh = false;
    for (const [proj, agg] of Object.entries(aggregates)) {
      const before = prev[proj];
      if (agg.thinkingDone && !before?.thinkingDone) {
        anyFresh = true;
        break;
      }
    }
    prevAggregatesRef.current = aggregates;
    if (!anyFresh) return;
    const enabled = getStudioUserSettingSync<boolean>('notifyOnThinkingDone');
    if (!enabled) return;
    void import('../audio/thinkingDoneSound').then((mod) => {
      mod.playThinkingDoneSound();
    });
  }, [aggregates]);

  // Phase 3: each EditorInner subtree wraps itself in
  // <ProjectScopeProvider> with its tab's projectPath, so request
  // scoping is per-subtree (not a module-level pointer that races
  // when N tabs are mounted at once). No effect needed here.

  const switchTab = useCallback(
    (tabId: string) => {
      setActiveTabId(tabId);
      const tab = openTabsRef.current.find((t) => t.tabId === tabId);
      if (tab?.projectPath) {
        // Fire-and-forget: backend follows the renderer; on failure
        // (e.g. project closed under us) the next refresh corrects.
        void socket
          .request('setActiveProject', { projectPath: tab.projectPath })
          .catch(() => undefined);
      }
    },
    [socket],
  );

  const newPickerTab = useCallback(() => {
    // Dedupe: at most one picker tab in state at a time. If one
    // already exists (e.g. from cold-start init or a previous `+`
    // press), just switch to it. Avoids accumulating hidden
    // pickers since the tab strip no longer renders picker tabs.
    setOpenTabs((prev) => {
      const existingPicker = prev.find((t) => t.projectPath === null);
      if (existingPicker) {
        setActiveTabId(existingPicker.tabId);
        return prev;
      }
      const id = makeTabId();
      setActiveTabId(id);
      return [
        ...prev,
        {
          tabId: id,
          projectPath: null,
          projectName: null,
          hibernated: false,
        },
      ];
    });
  }, []);

  const openProjectInActiveTab = useCallback(
    (projectPath: string, projectName: string) => {
      // User explicitly re-opened this project — clear any earlier
      // local dismissal so the refresh poll stops filtering it out.
      dismissedPathsRef.current.delete(projectPath);
      setOpenTabs((prev) => {
        // De-dupe: if this project is already open in another tab,
        // drop the active picker tab and switch to the existing tab.
        const existing = prev.find((t) => t.projectPath === projectPath);
        if (existing) {
          // Remove any picker tab (the one currently active) since the
          // user's intent was satisfied by switching to the existing one.
          const filtered = prev.filter(
            (t) => t.projectPath !== null || t.tabId !== activeTabId,
          );
          setActiveTabId(existing.tabId);
          return filtered.length > 0 ? filtered : prev;
        }
        // Convert the active tab in-place (typical picker → project flow).
        return prev.map((t) =>
          t.tabId === activeTabId ? { ...t, projectPath, projectName } : t,
        );
      });
    },
    [activeTabId],
  );

  const beginProjectCreation = useCallback(
    (name: string, parentDir: string, taskId: string): string => {
      // Mutates the active picker tab in-place. The tab strip's filter
      // already shows picker tabs that have `creating` set, and the
      // EditorInner body branch swaps in ProjectCreationProgress
      // instead of ProjectOnboarding for those tabs.
      let promotedTabId: string | null = null;
      setOpenTabs((prev) => {
        const active = prev.find((t) => t.tabId === activeTabIdRef.current);
        if (active && active.projectPath === null && !active.creating) {
          promotedTabId = active.tabId;
          return prev.map((t) =>
            t.tabId === active.tabId
              ? { ...t, projectName: name, creating: { taskId, parentDir } }
              : t,
          );
        }
        // No picker tab active — mint a new tab and switch to it. Rare
        // (the picker is normally the active tab when the user clicks
        // Create), but happens when the user starts an eval task from
        // the floating button while another project tab is focused.
        const newTabId = makeTabId();
        promotedTabId = newTabId;
        queueMicrotask(() => setActiveTabId(newTabId));
        return [
          ...prev,
          {
            tabId: newTabId,
            projectPath: null,
            projectName: name,
            hibernated: false,
            creating: { taskId, parentDir },
          },
        ];
      });
      // setOpenTabs ran synchronously so promotedTabId is set.
      return promotedTabId as unknown as string;
    },
    [],
  );

  const completeProjectCreation = useCallback(
    (tabId: string, projectPath: string, projectName: string) => {
      dismissedPathsRef.current.delete(projectPath);
      setOpenTabs((prev) => {
        const existing = prev.find(
          (t) => t.projectPath === projectPath && t.tabId !== tabId,
        );
        if (existing) {
          // De-dupe: drop the creating tab and focus the existing one.
          const filtered = prev.filter((t) => t.tabId !== tabId);
          setActiveTabId(existing.tabId);
          return filtered.length > 0 ? filtered : prev;
        }
        return prev.map((t) =>
          t.tabId === tabId
            ? {
                ...t,
                projectPath,
                projectName,
                creating: undefined,
              }
            : t,
        );
      });
    },
    [],
  );

  const failProjectCreation = useCallback((tabId: string, error: string) => {
    setOpenTabs((prev) =>
      prev.map((t) =>
        t.tabId === tabId && t.creating
          ? { ...t, creating: { ...t.creating, error } }
          : t,
      ),
    );
  }, []);

  const cancelProjectCreation = useCallback(
    (tabId: string) => {
      const tab = openTabsRef.current.find((t) => t.tabId === tabId);
      const taskId = tab?.creating?.taskId;
      if (taskId) {
        void socket.request('cancelTask', { taskId }).catch(() => undefined);
      }
      // Remove the tab and reconcile activeTabId. Mirrors closeTab's
      // tail (next-tab-to-the-right → fresh picker if empty).
      setOpenTabs((prev) => {
        const idx = prev.findIndex((t) => t.tabId === tabId);
        if (idx === -1) return prev;
        const next = prev.filter((t) => t.tabId !== tabId);
        if (next.length === 0) {
          next.push({
            tabId: makeTabId(),
            projectPath: null,
            projectName: null,
            hibernated: false,
          });
        }
        if (activeTabIdRef.current === tabId) {
          const replacement = next[Math.min(idx, next.length - 1)];
          setActiveTabId(replacement.tabId);
          if (replacement.projectPath) {
            void socket
              .request('setActiveProject', {
                projectPath: replacement.projectPath,
              })
              .catch(() => undefined);
          }
        }
        return next;
      });
    },
    [socket],
  );

  const closeTab = useCallback(
    (tabId: string) => {
      // Closing the last project tab is allowed — the user lands on
      // the project picker (a fresh picker tab is added below if
      // closing would empty the strip).
      const tabToClose = openTabsRef.current.find((t) => t.tabId === tabId);
      // Creating tabs route through cancelProjectCreation so the
      // sidecar's AbortController fires before the tab disappears.
      if (tabToClose?.creating) {
        cancelProjectCreation(tabId);
        return;
      }
      // If it's a project tab, ask the server to remove just that
      // project from the registry. Picker tabs are renderer-only.
      if (tabToClose?.projectPath) {
        void socket
          .request('closeProject', { projectPath: tabToClose.projectPath })
          .catch(() => undefined);
      }
      setOpenTabs((prev) => {
        const idx = prev.findIndex((t) => t.tabId === tabId);
        if (idx === -1) return prev;
        const next = prev.filter((t) => t.tabId !== tabId);
        // If closing emptied the strip, add a picker tab so the body
        // renders the project picker (ProjectOnboarding) — that's
        // the natural landing surface after closing all projects.
        if (next.length === 0) {
          next.push({
            tabId: makeTabId(),
            projectPath: null,
            projectName: null,
            hibernated: false,
          });
        }
        if (activeTabId === tabId) {
          const replacement = next[Math.min(idx, next.length - 1)];
          setActiveTabId(replacement.tabId);
          if (replacement.projectPath) {
            void socket
              .request('setActiveProject', {
                projectPath: replacement.projectPath,
              })
              .catch(() => undefined);
          }
        }
        return next;
      });
    },
    [activeTabId, socket],
  );

  /**
   * Reorder a tab within the strip. Pure renderer-side concern —
   * the server has no opinion on tab order, so no IPC is needed.
   * `toIndex` is the destination slot in the post-removal array
   * (i.e. drop "between tab 2 and tab 3" → toIndex=2). A drop on
   * the dragged tab's own slot is a no-op.
   */
  const reorderTab = useCallback((fromTabId: string, toIndex: number) => {
    setOpenTabs((prev) => {
      const fromIndex = prev.findIndex((t) => t.tabId === fromTabId);
      if (fromIndex === -1) return prev;
      const clamped = Math.max(0, Math.min(prev.length - 1, toIndex));
      if (clamped === fromIndex) return prev;
      const next = prev.slice();
      const [moved] = next.splice(fromIndex, 1);
      next.splice(clamped, 0, moved);
      return next;
    });
  }, []);

  const value: ProjectsContextValue = useMemo(
    () => ({
      openTabs,
      activeTabId,
      activeTab,
      newPickerTab,
      openProjectInActiveTab,
      beginProjectCreation,
      completeProjectCreation,
      failProjectCreation,
      cancelProjectCreation,
      switchTab,
      closeTab,
      reorderTab,
      refresh,
      hydrated,
      preloadedLayout,
      aggregates,
    }),
    [
      openTabs,
      activeTabId,
      activeTab,
      newPickerTab,
      openProjectInActiveTab,
      beginProjectCreation,
      completeProjectCreation,
      failProjectCreation,
      cancelProjectCreation,
      switchTab,
      closeTab,
      reorderTab,
      refresh,
      hydrated,
      preloadedLayout,
      aggregates,
    ],
  );

  return (
    <ProjectsContext.Provider value={value}>
      {children}
    </ProjectsContext.Provider>
  );
}

export function useProjects(): ProjectsContextValue {
  const ctx = useContext(ProjectsContext);
  if (!ctx) {
    throw new Error('useProjects must be used inside ProjectsProvider');
  }
  return ctx;
}

export function useActiveProjectPath(): string | null {
  return useProjects().activeTab?.projectPath ?? null;
}

export { basenameForPath };
