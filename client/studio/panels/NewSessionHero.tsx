import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AgentAxisSelector,
  type ModelAxisValue,
  type PatternAxisValue,
  type PermissionAxisValue,
} from '../components/AgentAxisSelector';
import { useIsMobile } from '../hooks/useIsMobile';
import { useSocket } from '../hooks/useSocket';
import {
  setStudioUserSetting,
  useStudioUserSetting,
  useStudioUserSettingsHydrated,
} from '../hooks/useStudioUserSetting';
import { shortcut } from '../utils/platform';
import { type SubscriptionProvider } from './ModelSelector';
import {
  ReasoningSelector,
  supportsReasoningClient,
  type ReasoningEffort,
} from './ReasoningSelector';

/**
 * Render text with each word in its own animated <span> so the
 * headline cascades in left-to-right rather than appearing all at
 * once. Mirrors the picker hero's pattern (see ProjectOnboarding).
 */
function splitWords(
  text: string,
  baseDelayMs: number,
  stepMs: number,
): React.ReactNode[] {
  return text.split(' ').map((word, i, arr) => (
    <span
      key={i}
      className="us-word"
      style={{ animationDelay: `${baseDelayMs + i * stepMs}ms` }}
    >
      {word}
      {i < arr.length - 1 ? ' ' : ''}
    </span>
  ));
}

/**
 * Inline "new session" surface — fills the center+right area of the
 * unified workspace when the user clicks "+ New session" or the
 * project has no sessions yet. Reuses the project-home hero (prompt
 * textarea + Permission/Model/Pattern/Reasoning selectors) so the
 * persistent sidebar stays visible and there's no full-page modal.
 *
 * Owns its own axis state via `useStudioUserSetting` (project-wide
 * defaults that survive restarts), the eval-mode handoff effect
 * (sessionStorage bridge from ProjectOnboarding), and the in-flight
 * session-create progress modal.
 */

export const MODEL_SETTING_KEY = 'codingAgentModel';
export const PERMISSION_SETTING_KEY = 'codingAgentPermissionMode';
export const MODEL_MODE_SETTING_KEY = 'codingAgentModelMode';
export const PATTERN_SETTING_KEY = 'codingAgentPatternMode';
export const REASONING_SETTING_KEY = 'codingAgentReasoningEffort';
export const BRANCH_MODE_SETTING_KEY = 'codingAgentBranchMode';

/**
 * Max pixel height the prompt textarea will auto-grow to before it
 * starts internal scrolling. Roughly 10 lines at the current
 * font-size/line-height.
 */
const PROMPT_MAX_HEIGHT = 320;

/**
 * Captured form values for the in-flight `codingAgentChatCreate`
 * RPC. The hero unmounts as soon as the user clicks Start (the parent
 * flips out of `new-session` mode), so SessionLayout owns the RPC and
 * just needs these values to fire it. Lives here because NewSessionHero
 * is the surface that produces them.
 */
export interface NewSessionStartParams {
  /** Prompt to dispatch as the first message; empty allowed. */
  prompt: string;
  /** Wire-level model seed — usually the picked id or 'auto'. */
  seedModel: string;
  /** Eval-mode toggle — false hides MCP tools from the agent. */
  exposeMcp?: boolean;
  /** Eval-task handoff carried via sessionStorage. */
  pendingEvalTask: { taskName: string; firstTurnPrompt: string } | null;
  permissionMode: PermissionAxisValue;
  modelMode: ModelAxisValue;
  patternMode: PatternAxisValue;
  reasoningEffort: ReasoningEffort;
  /** Worktree isolation or main branch. */
  branchMode: 'worktree' | 'main';
}

export interface NewSessionHeroProps {
  /** Captures the form values and hands them to SessionLayout, which
   *  owns the in-flight RPC + progress UI. The hero unmounts
   *  immediately after — `pendingSessions` keeps the progress visible. */
  onStartCreation: (params: NewSessionStartParams) => void;
  /** Resume handoff for eval-mode (sessionStorage bridge) — the
   *  picker wrote a sessionId and the user wants to jump straight in. */
  onResumeSession?: (sessionId: string) => void;
  /** Opens the settings modal. When `provider` is set the modal
   * scrolls to that subscription's key-setup section. */
  onOpenSettings: (provider?: SubscriptionProvider) => void;
}

export function NewSessionHero({
  onStartCreation,
  onResumeSession,
  onOpenSettings,
}: NewSessionHeroProps): React.ReactElement {
  const socket = useSocket();
  const isMobile = useIsMobile();
  const [prompt, setPrompt] = useState('');
  // The axis defaults below hydrate async (default → persisted). Hold the intro
  // until that lands so the fade-up plays ONCE with the real values — otherwise
  // the late re-render flips the model-dependent ReasoningSelector on/off and
  // swaps axis values mid/post-transition, which reads as a blink. ensureHydration
  // always resolves fast (empty cache even on failure), so this never hangs.
  const settingsHydrated = useStudioUserSettingsHydrated();

  // Persisted per-user axis defaults — survive restarts and are what
  // every NEW session inherits. Fresh sessions apply them via
  // fire-and-forget setter RPCs after `codingAgentChatCreate`.
  const [permissionMode, setPermissionMode] =
    useStudioUserSetting<PermissionAxisValue>(PERMISSION_SETTING_KEY, 'edit');
  const [modelMode, setModelMode] = useStudioUserSetting<ModelAxisValue>(
    MODEL_MODE_SETTING_KEY,
    { kind: 'single', model: 'deepseek_v4_pro' },
  );
  const [patternMode, setPatternMode] = useStudioUserSetting<PatternAxisValue>(
    PATTERN_SETTING_KEY,
    'none',
  );
  const [reasoningEffort, setReasoningEffort] =
    useStudioUserSetting<ReasoningEffort>(REASONING_SETTING_KEY, 'high');
  const [branchMode, setBranchMode] =
    useStudioUserSetting<'worktree' | 'main'>(BRANCH_MODE_SETTING_KEY, 'worktree');

  // When the user pins a single model via the Model axis, also write
  // that id to the legacy `codingAgentModel` slot so non-hero
  // session-creation paths get the same seed.
  const handleModelModeChange = useCallback(
    (next: ModelAxisValue) => {
      setModelMode(next);
      if (next.kind === 'single') {
        setStudioUserSetting(socket, MODEL_SETTING_KEY, next.model);
      }
    },
    [setModelMode, socket],
  );

  // Auto-grow textarea — resets to `auto` then locks to scrollHeight
  // so the textarea grows freely up to PROMPT_MAX_HEIGHT, then
  // scrolls internally past the cap.
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const el = promptRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const next = Math.min(el.scrollHeight, PROMPT_MAX_HEIGHT);
    el.style.height = `${next}px`;
    el.style.overflowY =
      el.scrollHeight > PROMPT_MAX_HEIGHT ? 'auto' : 'hidden';
  }, [prompt]);

  // Eval-mode handoff from ProjectOnboarding's picker. Two sessionStorage
  // bridges:
  //   • `eval-pending-task`       = JSON { taskName, firstTurnPrompt }
  //   • `eval-pending-session-id` = compositeId (resume a prior run)
  const [pendingEvalTask, setPendingEvalTask] = useState<{
    taskName: string;
    firstTurnPrompt: string;
  } | null>(null);
  useEffect(() => {
    const sessionResume = sessionStorage.getItem('eval-pending-session-id');
    if (sessionResume && onResumeSession) {
      sessionStorage.removeItem('eval-pending-session-id');
      onResumeSession(sessionResume);
      return;
    }
    const taskJson = sessionStorage.getItem('eval-pending-task');
    if (!taskJson) return;
    sessionStorage.removeItem('eval-pending-task');
    try {
      const parsed = JSON.parse(taskJson) as {
        taskName: string;
        firstTurnPrompt: string;
      };
      setPendingEvalTask(parsed);
    } catch {
      /* corrupt blob — ignore */
    }
  }, [onResumeSession]);

  // Pre-fill the prompt with the eval task's first turn so the user
  // can review it before clicking Start. Only seeds when empty so we
  // never overwrite something the user typed.
  const lastSeededTaskRef = useRef<string | null>(null);
  useEffect(() => {
    if (!pendingEvalTask) return;
    if (lastSeededTaskRef.current === pendingEvalTask.taskName) return;
    lastSeededTaskRef.current = pendingEvalTask.taskName;
    setPrompt((cur) =>
      cur.length === 0 ? pendingEvalTask.firstTurnPrompt : cur,
    );
  }, [pendingEvalTask]);

  const handleSubmit = useCallback(
    (e: React.SyntheticEvent) => {
      e.preventDefault();
      // Wire-level `model` is the seed; for auto/cheap/max the server
      // resolves the concrete id at turn time, so we leave it as
      // 'auto' and let `codingAgentSetModelMode` carry the strategy.
      const seedModel = modelMode.kind === 'single' ? modelMode.model : 'auto';
      console.log(
        `[session-origin] NewSessionHero.handleSubmit handoff seedModel=${seedModel} permissionMode=${permissionMode}`,
      );
      const params: NewSessionStartParams = {
        prompt,
        seedModel,
        // Eval-mode sessions skip MCP registration so the eval
        // grader's tool catalog doesn't get inflated.
        ...(pendingEvalTask ? { exposeMcp: false } : {}),
        pendingEvalTask,
        permissionMode,
        modelMode,
        patternMode,
        reasoningEffort,
        branchMode,
      };
      // Hand off and reset local state — the hero unmounts almost
      // immediately as SessionLayout swaps the center pane to
      // <SessionCreationProgress>.
      setPrompt('');
      setPendingEvalTask(null);
      onStartCreation(params);
    },
    [
      prompt,
      permissionMode,
      modelMode,
      patternMode,
      reasoningEffort,
      branchMode,
      onStartCreation,
      pendingEvalTask,
    ],
  );

  // Hold a matching-background placeholder until settings hydrate, then mount the
  // hero so its intro animations run a single time against the persisted values.
  if (!settingsHydrated) {
    return <div style={{ flex: 1, minHeight: 0, background: 'var(--bg-primary)' }} />;
  }

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        overflowY: 'auto',
        background: 'var(--bg-primary)',
        color: 'var(--text-primary)',
        position: 'relative',
        // Center the hero in the available area — both axes. The
        // content stays at its natural width (capped 900px below) and
        // is pushed toward the optical middle of the workspace
        // instead of pinned to the top-left.
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <style>{`
        @keyframes ugly-pulse-ring {
          0% { transform: scale(0.8); opacity: 0.8; }
          75%, 100% { transform: scale(2); opacity: 0; }
        }
      `}</style>
      <div
        style={{
          width: '100%',
          maxWidth: 900,
          // border-box + responsive padding: without border-box, width:100% +
          // 40px padding renders 80px WIDER than the viewport → horizontal
          // overflow on mobile (the hero/input ran off the right edge).
          boxSizing: 'border-box',
          padding: 'clamp(20px, 5vw, 40px)',
          margin: '0 auto',
        }}
      >
        <section>
          {/* Per-word stagger — matches the picker hero's
              splitWords pattern. Words pop in left-to-right starting
              after the workspace's center fade-up (160ms) so they
              read as part of the same arrival, not a fresh animation. */}
          <h1
            style={{
              fontFamily: 'var(--font-heading)',
              fontWeight: 800,
              // Lower min so "What do you want" fits a ~360px phone without
              // clipping; still scales up to 92px on desktop.
              fontSize: 'clamp(34px, 7.5vw, 92px)',
              lineHeight: 0.96,
              overflowWrap: 'break-word',
              letterSpacing: '-0.04em',
              color: 'var(--text-primary)',
              margin: '0 0 44px 0',
            }}
          >
            {splitWords('What do you want', 80, 80)}
            <br />
            {splitWords('to', 80 + 4 * 80, 80)}{' '}
            <span
              className="us-word-pop"
              style={{
                color: 'var(--accent)',
                fontStyle: 'italic',
                animationDelay: '560ms',
              }}
            >
              change?
            </span>
          </h1>

          {pendingEvalTask && (
            <div
              data-id="eval-pending-banner"
              style={{
                marginBottom: 16,
                padding: '12px 16px',
                border: '1px solid var(--accent)',
                background: 'var(--bg-secondary)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                  minWidth: 0,
                }}
              >
                <div
                  style={{
                    fontFamily: 'var(--font-label)',
                    fontSize: 10,
                    letterSpacing: '0.16em',
                    textTransform: 'uppercase',
                    fontWeight: 700,
                    color: 'var(--accent)',
                  }}
                >
                  Eval task ready
                </div>
                <div
                  style={{
                    fontWeight: 700,
                    fontSize: 14,
                    color: 'var(--text-primary)',
                  }}
                >
                  {pendingEvalTask.taskName}
                </div>
                <div
                  style={{
                    fontSize: 12,
                    color: 'var(--text-secondary)',
                    lineHeight: 1.45,
                  }}
                >
                  Pick a model + reasoning below (Claude CLIs are an option),
                  then hit Start.
                </div>
              </div>
              <button
                data-id="new-session-hero-cancel-eval-task"
                type="button"
                onClick={() => { setPendingEvalTask(null); }}
                title="Cancel eval task — start a regular session instead"
                style={{
                  fontFamily: 'var(--font-label)',
                  fontSize: 10,
                  letterSpacing: '0.14em',
                  textTransform: 'uppercase',
                  fontWeight: 700,
                  color: 'var(--text-secondary)',
                  background: 'transparent',
                  border: '1px solid var(--border)',
                  padding: '5px 10px',
                  cursor: 'pointer',
                  flexShrink: 0,
                }}
              >
                Cancel
              </button>
            </div>
          )}

          <form
            className="us-fade-up"
            style={{ animationDuration: '480ms', animationDelay: '440ms' }}
            onSubmit={(e) => { handleSubmit(e); }}
          >
            <div
              style={{
                display: 'flex',
                // Stack the START button below the input on mobile so neither runs
                // off the right edge; keep them side-by-side on desktop.
                flexDirection: isMobile ? 'column' : 'row',
                alignItems: isMobile ? 'stretch' : 'flex-start',
                background: 'var(--bg-panel)',
                border: '2px solid var(--border)',
                transition: 'border-color 160ms ease, box-shadow 160ms ease',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'row',
                  alignItems: 'flex-start',
                  flex: 1,
                  minWidth: 0,
                }}
              >
              <span
                style={{
                  fontFamily: 'var(--font-label)',
                  fontWeight: 700,
                  fontSize: 24,
                  color: 'var(--accent)',
                  padding: '22px 20px 0 22px',
                  lineHeight: 1,
                }}
              >
                &gt;
              </span>
              <textarea
                data-id="home-prompt-input"
                ref={promptRef}
                value={prompt}
                onChange={(e) => { setPrompt(e.target.value); }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    handleSubmit(e);
                  }
                }}
                placeholder="Describe a change, a bug, or an experiment…"
                autoFocus
                rows={1}
                style={{
                  flex: 1,
                  background: 'none',
                  border: 'none',
                  color: 'var(--text-primary)',
                  fontSize: 18,
                  fontWeight: 500,
                  padding: '22px 0',
                  outline: 'none',
                  letterSpacing: '-0.01em',
                  fontFamily: 'inherit',
                  resize: 'none',
                  lineHeight: 1.4,
                  minHeight: 96,
                  minWidth: 0,
                  overflowY: 'hidden',
                }}
              />
              </div>
              <button
                data-id="home-start-session"
                type="submit"
                style={{
                  alignSelf: 'stretch',
                  padding: isMobile ? '16px 24px' : '0 24px',
                  margin: 0,
                  background:
                    'linear-gradient(135deg, #FF8041 0%, #FF5500 50%, #E63900 100%)',
                  color: '#ffffff',
                  fontFamily: 'var(--font-heading)',
                  fontWeight: 800,
                  fontSize: 13,
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  border: 'none',
                  cursor: 'pointer',
                }}
              >
                Start →
              </button>
            </div>
          </form>
          <div
            className="us-fade-up"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              marginTop: 12,
              animationDuration: '480ms',
              animationDelay: '500ms',
            }}
          >
            <BranchModeToggle value={branchMode} onChange={setBranchMode} />
          </div>
          <div
            className="us-fade-up"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 16,
              marginTop: 16,
              flexWrap: 'wrap',
              animationDuration: '480ms',
              animationDelay: '560ms',
            }}
          >
            <div
              style={{
                fontFamily: 'var(--font-label)',
                fontSize: 11.5,
                color: 'var(--text-muted)',
              }}
            >
              <span
                style={{
                  color: 'var(--text-primary)',
                  background: 'var(--bg-secondary)',
                  border: '1px solid var(--border)',
                  padding: '2px 7px',
                  fontWeight: 600,
                  marginRight: 6,
                }}
              >
                {shortcut('Enter')}
              </span>
              to start · spec first
            </div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                flexWrap: 'wrap',
              }}
            >
              <AgentAxisSelector
                permission={permissionMode}
                model={modelMode}
                pattern={patternMode}
                agent={
                  modelMode.kind === 'single' &&
                  (modelMode.model === 'claude-code' ||
                    modelMode.model.startsWith('claude-code:'))
                    ? 'claude-code'
                    : 'coding-agent'
                }
                onPermissionChange={setPermissionMode}
                onModelChange={handleModelModeChange}
                onPatternChange={setPatternMode}
                onModelNeedsKey={(provider) => { onOpenSettings(provider); }}
              />
              <ReasoningSelector
                value={reasoningEffort}
                onChange={setReasoningEffort}
                visible={supportsReasoningClient(
                  modelMode.kind === 'single' ? modelMode.model : 'auto',
                )}
              />
            </div>
          </div>
        </section>
      </div>

      {/* Session-create progress now renders inline in SessionLayout
          via <SessionCreationProgress>, keyed to the pending row in
          the sidebar so other sessions / project tabs stay
          interactive while creation runs. */}
    </div>
  );
}
/**
 * Two-segment toggle: Worktree (isolated branch) vs Main branch (direct on project).
 */
function BranchModeToggle({
  value,
  onChange,
}: {
  value: 'worktree' | 'main';
  onChange: (v: 'worktree' | 'main') => void;
}): React.ReactElement {
  const seg: React.CSSProperties = {
    fontFamily: 'var(--font-mono)',
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: '0.04em',
    padding: '4px 10px',
    border: '1px solid var(--border)',
    background: 'transparent',
    color: 'var(--text-muted)',
    cursor: 'pointer',
    flexShrink: 0,
  };
  const active: React.CSSProperties = {
    ...seg,
    background: 'var(--accent-dim)',
    color: 'var(--accent)',
    borderColor: 'var(--accent)',
  };
  const left = value === 'worktree' ? { ...active, borderTopLeftRadius: 5, borderBottomLeftRadius: 5 } : { ...seg, borderTopLeftRadius: 5, borderBottomLeftRadius: 5 };
  const right = value === 'main' ? { ...active, borderTopRightRadius: 5, borderBottomRightRadius: 5 } : { ...seg, borderTopRightRadius: 5, borderBottomRightRadius: 5 };
  return (
    <>
      <button type="button" data-id="branch-mode-worktree" onClick={() => { onChange('worktree'); }} style={left} title="Git worktree on a new branch — isolated from other sessions">
        ⑂ Worktree
      </button>
      <button type="button" data-id="branch-mode-main" onClick={() => { onChange('main'); }} style={right} title="Work directly on the main branch — share the working directory">
        ⎇ Main branch
      </button>
    </>
  );
}
