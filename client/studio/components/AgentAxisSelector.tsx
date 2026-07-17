/**
 * Three-axis selector for the coding agent.
 *
 * Three button-popover dropdowns matching the `ReasoningSelector`
 * chip style — each button shows a lucide icon + the current value's
 * short label + chevron. The Model axis embeds `ModelSelector`
 * directly (with an icon prop) so there is exactly one model picker
 * in the UI; its `value` is mapped to/from the structured
 * `ModelAxisValue` here.
 *
 * Each control patches one axis on the next user turn; in-flight
 * turns finish on their existing settings. Presentation-only — wiring
 * lives in the host (Editor.tsx / CodingAgentChat.tsx).
 */
import { Cpu, Shield, Workflow, type LucideIcon } from 'lucide-react';
import { type FC, type ReactNode } from 'react';
import {
  ModelSelector,
  type SubscriptionProvider,
} from '../panels/ModelSelector';
import { Popover } from '../system';

export type PermissionAxisValue = 'edit' | 'yolo' | 'claude-plan';

export type ModelAxisValue =
  | { kind: 'auto' }
  | { kind: 'max' }
  | { kind: 'single'; model: string }
  // @deprecated 2026-05-04 — kept readable for resume back-compat.
  // Runtime translates `{kind:'mid', survivor}` to single + super-* pattern.
  | { kind: 'mid'; survivor: string }
  // @deprecated 2026-05-05 — kept readable for resume back-compat.
  // Runtime translates `{kind:'auto-cheap'}` to `{kind:'auto'}`.
  | { kind: 'auto-cheap' }
  // Group-assignment mode (CODING.md §17.17). N peers run concurrently;
  // not exposed in the model selector chip yet (eval-only) but listed
  // here so the wire-side type roundtrips through the UI without
  // narrowing.
  | {
      kind: 'group';
      models: string[];
      personas?: Record<string, string>;
    };

export type PatternAxisValue =
  | 'none'
  | 'auto'
  | 'spec-build-verify'
  | 'super-spec-build-verify'
  | 'quick-edit'
  | 'investigate-fix'
  | 'super-investigate-fix'
  | 'chat-qa'
  | 'chat-advisory';

export interface AgentAxisSelectorProps {
  permission: PermissionAxisValue;
  model: ModelAxisValue;
  pattern: PatternAxisValue;
  onPermissionChange: (next: PermissionAxisValue) => void;
  onModelChange: (next: ModelAxisValue) => void;
  onPatternChange: (next: PatternAxisValue) => void;
  /** Disable the controls while a turn is in flight. */
  disabled?: boolean;
  /** Forwarded to the embedded ModelSelector — see its docs. */
  family?: 'claude' | 'non-claude';
  /** Forwarded to the embedded ModelSelector — opens settings when a
   *  locked subscription row is clicked. */
  onModelNeedsKey?: (provider: SubscriptionProvider) => void;
  /**
   * When `pattern === 'auto'` and the classifier has resolved a concrete
   * pattern, render the pattern dropdown trigger as `auto: <label>`.
   * Null/undefined leaves the bare "Auto" label.
   */
  resolvedPattern?: PatternAxisValue | null;
  /**
   * Server-composed dropdown label for the model axis. When set, the
   * model trigger renders this string verbatim instead of deriving
   * its own label from `model` + `modelMode`. Used for the
   * `auto: <provider>` form once the harness pins an auto-resolved
   * model. Server is the single source of truth so the client doesn't
   * have to reconstruct it from multiple snapshot fields.
   */
  modelDisplayLabel?: string;
  /**
   * Session's agent driver. Only `'claude-code'` exposes the
   * `'claude-plan'` permission value in the dropdown — that mode
   * maps directly onto the claude CLI's `--permission-mode plan`
   * argv. For any other agent (in-process coding-agent, etc.) the
   * Plan row is filtered out at render time. Omitted defaults to
   * the in-process loop.
   */
  agent?: 'claude-code' | 'coding-agent';
  /** Hide the Pattern (plan-engine) pill — the pattern engine is an advanced mode gated behind
   *  a settings opt-in, so the default UI never shows it. */
  hidePattern?: boolean;
}

export interface DropdownOption<T extends string> {
  value: T;
  label: string;
  hint: string;
}

export const PERMISSION_OPTIONS: DropdownOption<PermissionAxisValue>[] = [
  { value: 'edit', label: 'Edit', hint: 'r/w within the project' },
  {
    value: 'yolo',
    label: 'Yolo',
    hint: 'r/w everywhere — full filesystem reach',
  },
  {
    // Claude-cli-only. Hidden from the dropdown unless the session is
    // running on the claude-cli agent — gated downstream in the
    // axis-selector trigger via the `agent` prop.
    value: 'claude-plan',
    label: 'Plan (claude CLI)',
    hint: 'claude --permission-mode plan — research-only turn',
  },
];

export const PATTERN_OPTIONS: DropdownOption<PatternAxisValue>[] = [
  { value: 'auto', label: 'Auto', hint: 'classifier picks per turn' },
  { value: 'none', label: 'No plan', hint: 'no step engine — flat loop' },
  {
    value: 'spec-build-verify',
    label: 'Spec → Build → Verify',
    hint: 'non-trivial features',
  },
  {
    value: 'super-spec-build-verify',
    label: 'Super Spec → Build → Verify',
    hint: 'wide SPEC + synthesis — for hard novel features',
  },
  { value: 'quick-edit', label: 'Quick edit', hint: 'one-shot small change' },
  {
    value: 'investigate-fix',
    label: 'Investigate → Fix',
    hint: 'bug or perf with unknown root cause',
  },
  {
    value: 'super-investigate-fix',
    label: 'Super Investigate → Fix',
    hint: 'wide DIAGNOSE + synthesis — for stub-traps and misleading-stack bugs',
  },
  { value: 'chat-qa', label: 'Chat (Q&A)', hint: 'direct factual answer' },
  {
    value: 'chat-advisory',
    label: 'Chat (advisory)',
    hint: 'recommendations, no edits',
  },
];

/**
 * Generic button-popover dropdown styled to match ReasoningSelector
 * (icon + label + chevron). Used for the Permission and Pattern axes.
 * The Model axis uses a real ModelSelector instead so its richer
 * affordances (cost badges, subscription locks) come along for free.
 */
export function AxisDropdown<T extends string>({
  value,
  options,
  onChange,
  disabled,
  Icon,
  axisLabel,
  displayLabel,
}: {
  value: T;
  options: DropdownOption<T>[];
  onChange: (next: T) => void;
  disabled?: boolean;
  Icon: LucideIcon;
  /** Used in the button title attribute for accessibility. */
  axisLabel: string;
  /**
   * Override the trigger label without touching `value`. Used by the
   * Pattern axis to render `auto: <resolved>` while keeping the
   * dropdown's selected option still bound to the user's mode.
   */
  displayLabel?: string;
}) {
  const selected = options.find((o) => o.value === value) ?? options[0];
  const triggerLabel = displayLabel ?? selected.label;
  // Say what the setting MEANS, not just its name. The trigger renders a bare word
  // ("Edit", "None", "High") and the tooltip only repeated it — so a first-time user
  // reads a row of anonymous pills and leaves them all alone. That matters most for the
  // permission axis: its default decides whether the agent touches your files or a
  // worktree copy, and not understanding it is how people lose track of their change.
  // Every option already carries a `hint`; it was just never shown here.
  const describe = `${axisLabel}: ${triggerLabel}${selected.hint ? ` — ${selected.hint}` : ''}`;

  const trigger = (
    <button
      data-id="agent-axis-trigger"
      type="button"
      disabled={disabled}
      aria-label={describe}
      data-us-tooltip={describe}
      data-us-tooltip-placement="top"
      style={{
        background: 'var(--bg-secondary, #1a1a2e)',
        border: '1px solid var(--border, #2a2a3e)',
        borderRadius: 6,
        padding: '4px 8px',
        color: 'var(--text-primary, #e0e0e0)',
        fontSize: 12,
        cursor: disabled ? 'not-allowed' : 'pointer',
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        opacity: disabled ? 0.5 : 1,
        whiteSpace: 'nowrap',
        flexShrink: 0,
      }}
    >
      <Icon size={13} />
      <span style={{ whiteSpace: 'nowrap' }}>{triggerLabel}</span>
      <svg
        width="10"
        height="6"
        viewBox="0 0 10 6"
        fill="none"
        style={{ marginLeft: 2 }}
      >
        <path
          d="M1 1L5 5L9 1"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    </button>
  );

  return (
    <Popover
      trigger={trigger}
      placement="bottom-start"
      minWidth={240}
      disabled={disabled}
    >
      {(ctx) =>
        options.map((o) => {
          const isSelected = o.value === value;
          return (
            <button
              key={o.value}
              data-id={`agent-axis-option-${o.value}`}
              role="menuitem"
              type="button"
              onClick={() => {
                onChange(o.value);
                ctx.close();
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                width: '100%',
                padding: '8px 10px',
                background: isSelected
                  ? 'var(--bg-hover, rgba(255,85,0,0.1))'
                  : 'transparent',
                border: 'none',
                borderRadius: 6,
                cursor: 'pointer',
                color: 'var(--text-primary, #e0e0e0)',
                fontSize: 12,
                textAlign: 'left',
              }}
            >
              <span
                style={{
                  flex: 1,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                }}
              >
                <span>{o.label}</span>
                <span
                  style={{ color: 'var(--text-muted, #666)', fontSize: 10 }}
                >
                  {o.hint}
                </span>
              </span>
            </button>
          );
        })
      }
    </Popover>
  );
}

/**
 * The Model axis is a thin adapter over ModelSelector. The underlying
 * picker emits string ids ('auto', 'auto:max', or a concrete model
 * id); we map those to/from the structured `ModelAxisValue` the
 * server persists.
 *
 * Legacy persisted `{kind:'auto-cheap'}` is rendered as 'auto' (the
 * runtime translates it to `{kind:'auto'}` on session-create); the
 * picker doesn't surface auto-cheap as a separate option anymore.
 */
function ModelAxisDropdown({
  value,
  onChange,
  disabled,
  family,
  onNeedsKey,
  icon,
  displayLabel,
}: {
  value: ModelAxisValue;
  onChange: (next: ModelAxisValue) => void;
  disabled?: boolean;
  family?: 'claude' | 'non-claude';
  onNeedsKey?: (provider: SubscriptionProvider) => void;
  icon?: ReactNode;
  displayLabel?: string;
}) {
  const stringValue =
    value.kind === 'auto' || value.kind === 'auto-cheap'
      ? 'auto'
      : value.kind === 'max'
        ? 'auto:max'
        : value.kind === 'mid'
          ? value.survivor
          : value.kind === 'group'
            ? `auto:group(${value.models.length})`
            : value.model;
  const handleChange = (s: string) => {
    if (s === 'auto') onChange({ kind: 'auto' });
    else if (s === 'auto:max') onChange({ kind: 'max' });
    else onChange({ kind: 'single', model: s });
  };
  return (
    <ModelSelector
      value={stringValue}
      onChange={handleChange}
      subscriptionsOnly
      {...(disabled !== undefined && { disabled })}
      {...(family !== undefined && { family })}
      {...(onNeedsKey !== undefined && { onNeedsKey })}
      {...(icon !== undefined && { icon })}
      {...(displayLabel !== undefined && { displayLabel })}
    />
  );
}

export const AgentAxisSelector: FC<AgentAxisSelectorProps> = ({
  permission,
  model,
  pattern,
  onPermissionChange,
  onModelChange,
  onPatternChange,
  disabled,
  family,
  onModelNeedsKey,
  resolvedPattern,
  modelDisplayLabel,
  agent,
  hidePattern,
}) => {
  // 'claude-plan' is a claude-cli-only value — the CLI's
  // `--permission-mode plan` argv branch. For any other agent, drop
  // it from the dropdown so users can't pick an unreachable mode.
  const permissionOptions =
    agent === 'claude-code'
      ? PERMISSION_OPTIONS
      : PERMISSION_OPTIONS.filter((o) => o.value !== 'claude-plan');
  // Pattern: when the user picked "auto" and the classifier has
  // resolved a concrete pattern, render the trigger as `auto: <label>`
  // (lowercased so the prefix and suffix read as one phrase).
  let patternDisplayLabel: string | undefined;
  if (
    pattern === 'auto' &&
    resolvedPattern &&
    resolvedPattern !== 'auto' &&
    resolvedPattern !== 'none'
  ) {
    const opt = PATTERN_OPTIONS.find((o) => o.value === resolvedPattern);
    if (opt) patternDisplayLabel = `auto: ${opt.label.toLowerCase()}`;
  }

  return (
    <div
      data-id="agent-axis-selector"
      style={{
        display: 'inline-flex',
        // Keep the three pills on one line. The chat-panel strip that
        // hosts this component sits directly above the textarea and
        // sets its own `flexWrap: 'nowrap'` + `overflowX: 'auto'`, so
        // a too-narrow panel scrolls horizontally instead of breaking
        // the row into two lines (which used to push the message list
        // down on every resize).
        flexWrap: 'nowrap',
        alignItems: 'center',
        gap: 6,
      }}
    >
      <AxisDropdown
        value={permission}
        options={permissionOptions}
        onChange={onPermissionChange}
        Icon={Shield}
        axisLabel="Permission"
        {...(disabled !== undefined && { disabled })}
      />
      <ModelAxisDropdown
        value={model}
        onChange={onModelChange}
        icon={<Cpu size={13} />}
        {...(disabled !== undefined && { disabled })}
        {...(family !== undefined && { family })}
        {...(onModelNeedsKey !== undefined && { onNeedsKey: onModelNeedsKey })}
        {...(modelDisplayLabel !== undefined && {
          displayLabel: modelDisplayLabel,
        })}
      />
      {/* Pattern axis drives the in-process pattern engine
          (spec-build-verify, investigate-fix, etc). Claude-cli runs
          its own agent loop and ignores the studio pattern engine
          entirely, so the dropdown would be a no-op there. Hide it
          for claude-cli sessions to remove the dead control. */}
      {agent !== 'claude-code' && !hidePattern && (
        <AxisDropdown
          value={pattern}
          options={PATTERN_OPTIONS}
          onChange={onPatternChange}
          Icon={Workflow}
          axisLabel="Pattern"
          {...(disabled !== undefined && { disabled })}
          {...(patternDisplayLabel !== undefined && {
            displayLabel: patternDisplayLabel,
          })}
        />
      )}
    </div>
  );
};
