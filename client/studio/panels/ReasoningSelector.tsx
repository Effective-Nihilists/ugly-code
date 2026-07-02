import { Brain } from 'lucide-react';
import { useRef } from 'react';
import type { ReasoningEffort } from '../shared/api';
import { Popover } from '../system';

export type { ReasoningEffort };

interface ReasoningSelectorProps {
  value: ReasoningEffort;
  onChange: (next: ReasoningEffort) => void;
  /**
   * When false, the control is hidden entirely — used when the selected
   * model doesn't expose a reasoning-budget knob. We render nothing
   * instead of a disabled button so the toolbar doesn't accumulate
   * dead affordances.
   */
  visible: boolean;
  /**
   * When true, the trigger renders as a dimmed, unclickable pill. Used
   * during an active turn — reasoning effort is captured into
   * TurnContext at turn start and can't change mid-turn, so the UI
   * matches the other axis selectors (Permission / Model / Pattern)
   * which all dim while streaming.
   */
  disabled?: boolean;
}

const OPTIONS: {
  value: ReasoningEffort;
  label: string;
  description: string;
}[] = [
  {
    value: 'off',
    label: 'Off',
    description: 'No reasoning budget — model answers directly',
  },
  {
    value: 'low',
    label: 'Low',
    description: 'Short reasoning burst (~1k tokens / `low` effort)',
  },
  {
    value: 'medium',
    label: 'Medium',
    description: 'Balanced default (~8k tokens / `medium` effort)',
  },
  {
    value: 'high',
    label: 'High',
    description: 'Long reasoning chain (~16k tokens / `high` effort)',
  },
];

export function ReasoningSelector({
  value,
  onChange,
  visible,
  disabled,
}: ReasoningSelectorProps) {
  // Hooks must run unconditionally — render `null` after the hooks below.
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  if (!visible) return null;

  const selected = OPTIONS.find((o) => o.value === value) ?? OPTIONS[0];

  const trigger = (
    <button
      data-id="reasoning-selector-trigger"
      ref={triggerRef}
      type="button"
      disabled={disabled}
      aria-label={`Reasoning: ${selected.label}`}
      data-us-tooltip={`Reasoning: ${selected.label}`}
      data-us-tooltip-placement="top"
      // Visual parity with the Permission / Model / Pattern axis
      // dropdowns — same bg / border / text color regardless of
      // whether reasoning is "off" or actively budgeted. The label
      // text already conveys the active level (Off / Low / Medium /
      // High); the prior blue tint made this control read as a
      // separate widget family from its row neighbors.
      style={{
        background: 'var(--bg-secondary, #1a1a2e)',
        border: '1px solid var(--border, #2a2a3e)',
        borderRadius: 6,
        padding: '4px 8px',
        color: 'var(--text-primary, #e0e0e0)',
        fontSize: 12,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        whiteSpace: 'nowrap',
        flexShrink: 0,
      }}
    >
      <Brain size={13} />
      <span style={{ whiteSpace: 'nowrap' }}>{selected.label}</span>
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
      minWidth={260}
      disabled={disabled}
    >
      {(ctx) =>
        OPTIONS.map((opt) => {
          const isSelected = opt.value === value;
          return (
            <button
              key={opt.value}
              data-id={`reasoning-selector-option-${opt.value}`}
              role="menuitem"
              type="button"
              onClick={() => {
                onChange(opt.value);
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
                <span>{opt.label}</span>
                <span
                  style={{ color: 'var(--text-muted, #666)', fontSize: 10 }}
                >
                  {opt.description}
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
 * Whether a model accepts a reasoning-effort knob. Looks up the
 * model in the framework catalog (sourced from ugly-app's
 * `getCodingAgentModels()`, whose `supportsReasoning` field is
 * derived from each model's catalog `thinkingSupport`).
 *
 * `'auto'` returns true: auto-tune may pick a reasoning-capable
 * model per turn; the user's chosen effort should apply at that
 * point. Non-reasoning picks ignore the field.
 *
 * For per-session correctness, prefer reading `snapshot.supportsReasoning`
 * directly — that's the resolved authoritative value for the
 * currently-running session's model (including subscription /
 * Claude-CLI / BYO routes that aren't in the framework catalog).
 * This function is a synchronous fallback used by places that don't
 * have a snapshot (settings page model preview, etc.).
 */
import { getCodingAgentModels } from 'ugly-app/shared';

const FRAMEWORK_MODELS_INDEX = new Map(
  getCodingAgentModels().map((m) => [m.id, m] as const),
);

export function supportsReasoningClient(id: string): boolean {
  if (id === 'auto') return true;
  const framework = FRAMEWORK_MODELS_INDEX.get(id);
  if (framework) return framework.supportsReasoning;
  // External-CLI + generic-Anthropic ids aren't in the framework catalog.
  // As a synchronous backstop (no models list available) fall through to
  // provider-prefix heuristics — both expose reasoning-capable models; the
  // chat header uses the snapshot field for the precise per-session answer.
  if (id === 'claude-code' || id.startsWith('claude-code:')) return true;
  if (id.startsWith('anthropic:')) return true;
  return false;
}
