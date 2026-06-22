import React, { useEffect, useMemo, useState } from 'react';
import { getCodingAgentModels, type CodingAgentModel } from 'ugly-app/shared';
import {
  agenticCostTier,
  agenticPriceIndex,
  DEFAULT_POOL_PINNED_IDS,
  SUBSCRIPTION_ORDER,
  subscriptionLabel,
  subscriptionOf,
  sweTier,
  type SubscriptionKey,
} from '../shared/model-rankings';
import { useSocket } from '../hooks/useSocket';
import { Popover } from '../system';

/**
 * Unified model picker. One component for every model-selection surface
 * in the studio (in-chat chip, settings rows, new-session modal). Single
 * vs multi-select via the `mode` discriminant; family filter ('claude-cli'
 * vs 'normal' vs 'either') is the only other shape knob.
 *
 * Subscription gating: BYO providers (z.ai / Kimi / MiniMax) and Claude
 * CLI only render when the server reports the user has them configured.
 * No locked stubs, no "Set up" rows — Subscription Hub is the only
 * discovery surface. Framework providers (Anthropic / OpenAI / Google /
 * open-weight / DeepSeek) all collapse into the "ugly.bot" group.
 *
 * Pseudo-options ("default", "inherit", "none") are gone — the runtime
 * cascade handles those via 'auto' (see studio/server/coding-agent/
 * model-cascade.ts).
 */

// ──────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────

// `'auto:cheap'` is gone (collapsed into `'auto'` 2026-05-05) but kept
// in the union for one release so persisted strings render correctly
// while the runtime's translator migrates them on read.
const AUTO_MODES = ['auto', 'auto:cheap', 'auto:max'] as const;
export type AutoMode = (typeof AUTO_MODES)[number];

/** What a single-select picker emits. Real model OR auto sentinel. */
export type ModelChoice = CodingAgentModel | AutoMode;

export type Family = 'claude-cli' | 'normal' | 'either';

interface ModelPickerCommonProps {
  /**
   * Which auto sentinels to render at the top of the dropdown.
   *   - `true`: show all three (Auto / Auto · Cheap / Auto · Max) —
   *     used by the in-chat picker where the user picks a session
   *     strategy.
   *   - `AutoMode[]`: show only the listed sentinels — used by the
   *     settings rows where only `'auto'` (cascade trigger) is
   *     sensible; `'auto:cheap'` and `'auto:max'` are session-strategy
   *     concepts that don't apply to aux/judge/pollinator/picker.
   *   - falsy: hide the entire Auto section.
   */
  showAutoOptions?: boolean | AutoMode[];
  family?: Family;
  disabled?: boolean;
  icon?: React.ReactNode;
  /** Override the trigger text — used when the parent renders its own label (e.g. AgentAxisSelector's "auto: <provider>"). */
  displayLabel?: string;
  /** 'chip' = compact in-chat trigger; 'row' = full-width settings row trigger. */
  triggerStyle?: 'chip' | 'row';
  /** Wraps the trigger in a settings-row layout (label on the left, hint below, control on the right). */
  rowLabel?: string;
  rowHint?: string;
}

interface ModelPickerSingleProps extends ModelPickerCommonProps {
  mode: 'single';
  value: ModelChoice;
  onChange: (choice: ModelChoice) => void;
}

interface ModelPickerMultiProps extends ModelPickerCommonProps {
  mode: 'multi';
  values: CodingAgentModel[];
  onChangeMany: (models: CodingAgentModel[]) => void;
}

export type ModelPickerProps = ModelPickerSingleProps | ModelPickerMultiProps;

// ──────────────────────────────────────────────────────────────────
// Static helpers
// ──────────────────────────────────────────────────────────────────

const BASE_MODELS = getCodingAgentModels()
  .slice()
  .sort((a, b) => {
    const swA = a.sweBenchVerified ?? -1;
    const swB = b.sweBenchVerified ?? -1;
    if (swA !== swB) return swB - swA;
    return a.costPerM - b.costPerM;
  });

/** Local Claude Code CLI rows — shown only when the `claude` binary is detected
 *  on the user's machine (provider 'claude-cli' so the family filter groups them
 *  under the Claude CLI tab). Selecting one routes turns to the local CLI runner. */
const CLAUDE_CLI_MODELS = [
  { id: 'claude-code', name: 'Claude CLI', provider: 'claude-cli', contextWindow: 200000, speed: 'medium', vision: true, reasoning: 'strong', supportsReasoning: true, smartness: 5, sweBenchVerified: 72, costPerM: 0 },
  { id: 'claude-code:opus', name: 'Claude CLI · Opus', provider: 'claude-cli', contextWindow: 200000, speed: 'slow', vision: true, reasoning: 'strong', supportsReasoning: true, smartness: 5, sweBenchVerified: 74, costPerM: 0 },
  { id: 'claude-code:sonnet', name: 'Claude CLI · Sonnet', provider: 'claude-cli', contextWindow: 200000, speed: 'medium', vision: true, reasoning: 'strong', supportsReasoning: true, smartness: 5, sweBenchVerified: 72, costPerM: 0 },
] as unknown as CodingAgentModel[];

/** Old export kept for back-compat with reasoning-detection helpers. */
export function isWeakModel(modelId: string): boolean {
  return BASE_MODELS.find((m) => m.id === modelId)?.reasoning === 'weak';
}

/** Old export kept for back-compat with callers that mapped subscription IDs to provider keys. */
export type SubscriptionProvider = 'z-ai' | 'kimi' | 'minimax' | 'deepseek';

const AUTO_DESCRIPTIONS: Record<AutoMode, string> = {
  'auto':
    'Cheap router; never elevates to Max. (Difficulty drives Pattern-axis super-promotion instead — pick a Super pattern manually for the wide-SPEC fan-out.)',
  // Deprecated; legacy persisted value renders with the same description as plain 'auto'.
  'auto:cheap':
    'Cheap router; never elevates to Max. (Legacy alias for plain Auto.)',
  'auto:max':
    'Runs 4 models in parallel each turn; a picker LLM chooses the winner. Higher cost, higher quality.',
};

const AUTO_LABELS: Record<AutoMode, string> = {
  'auto': 'Auto',
  'auto:cheap': 'Auto · Cheap',
  'auto:max': 'Auto · Max',
};

function isAutoMode(v: unknown): v is AutoMode {
  return typeof v === 'string' && (AUTO_MODES as readonly string[]).includes(v);
}

function familyAllows(family: Family, key: SubscriptionKey): boolean {
  if (family === 'claude-cli') return key === 'claude-cli';
  if (family === 'normal') return key !== 'claude-cli';
  return true; // 'either'
}

function sortBySweAndCost(a: CodingAgentModel, b: CodingAgentModel): number {
  const swA = a.sweBenchVerified ?? -1;
  const swB = b.sweBenchVerified ?? -1;
  if (swA !== swB) return swB - swA;
  const pA = agenticPriceIndex(a.id, a.costPerM);
  const pB = agenticPriceIndex(b.id, b.costPerM);
  return pA - pB;
}

/**
 * Subscription model names embed the provider as a prefix
 * (e.g. `'z.ai · GLM-5.1'`, `'Kimi · K2.6'`, `'Claude Code · Opus'`)
 * because the trigger button shows them flat — the user needs to know
 * which subscription the picked model belongs to.
 *
 * Inside the dropdown the section header already announces the
 * subscription, so the `'<provider> · '` prefix on each row is just
 * visual noise. Strip it for in-list rendering; the trigger keeps the
 * full name verbatim.
 */
function stripSubscriptionPrefix(name: string): string {
  const idx = name.indexOf(' · ');
  return idx === -1 ? name : name.slice(idx + 3);
}

/** Format the agentic-coding weighted-cost subtitle ("$2.10/M est"). */
function formatPriceSubtitle(model: CodingAgentModel): string {
  if (model.costPerM === 0) return 'subscription';
  const idx = agenticPriceIndex(model.id, model.costPerM);
  if (!Number.isFinite(idx) || idx <= 0) return `$${model.costPerM}/M in`;
  const display = idx >= 1 ? idx.toFixed(2) : idx.toFixed(3);
  return `$${display}/M est`;
}

// ──────────────────────────────────────────────────────────────────
// Inline UI primitives
// ──────────────────────────────────────────────────────────────────

function CostTierBadge({ model }: { model: CodingAgentModel }) {
  const idx = agenticPriceIndex(model.id, model.costPerM);
  const tier = agenticCostTier(idx);
  const title =
    `Cost tier: ${tier.label} (~$${idx.toFixed(2)}/M effective tokens, ` +
    `weighted for agentic coding: 80% cache_read / 5% cache_write / 5% input / 10% output)`;
  return (
    <span
      title={title}
      style={{
        color: tier.color,
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: 0.5,
        minWidth: 32,
        textAlign: 'right',
      }}
    >
      {tier.label}
    </span>
  );
}

function SweBenchBadge({ score }: { score: number | undefined }) {
  if (score === undefined) {
    return (
      <span
        title="Not benchmarked on SWE-bench Verified"
        style={{
          color: 'rgba(255,255,255,0.3)',
          fontSize: 10,
          minWidth: 30,
          textAlign: 'right',
        }}
      >
        —
      </span>
    );
  }
  const tier = sweTier(score);
  const title =
    `SWE-bench Verified: ${score.toFixed(1)}% — vendor-published. ` +
    `Cross-vendor scores aren't strictly apples-to-apples (different harnesses / scaffolds / dates).`;
  return (
    <span
      title={title}
      style={{
        color: tier.color,
        fontSize: 10,
        fontWeight: 700,
        minWidth: 30,
        textAlign: 'right',
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      {score.toFixed(0)}
    </span>
  );
}

function ChevronDown() {
  return (
    <svg
      width="10"
      height="6"
      viewBox="0 0 10 6"
      fill="none"
      style={{ marginLeft: 2 }}
      aria-hidden
    >
      <path
        d="M1 1L5 5L9 1"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

// ──────────────────────────────────────────────────────────────────
// Main component
// ──────────────────────────────────────────────────────────────────

export function ModelPicker(props: ModelPickerProps): React.ReactElement {
  const {
    showAutoOptions,
    family = 'normal',
    disabled,
    icon,
    displayLabel,
    triggerStyle = 'chip',
    rowLabel,
    rowHint,
  } = props;

  const socket = useSocket();
  const [subscriptionModels, setSubscriptionModels] = useState<
    CodingAgentModel[]
  >([]);
  // Detect the local Claude CLI; when present, surface the claude-cli rows.
  const [claudeCliAvailable, setClaudeCliAvailable] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void import('../agent/claudeCliDetect').then(({ detectClaudeCli }) =>
      import('../hooks/useSocket').then(({ getActiveProjectPath }) =>
        detectClaudeCli(getActiveProjectPath()).then((p) => {
          if (!cancelled) setClaudeCliAvailable(!!p);
        }),
      ),
    );
    return () => { cancelled = true; };
  }, []);
  // Collapsed ugly.bot section shows only the auto-pool (pinned) models +
  // Step 3.5 Flash + any currently-selected catalog row. Expanding reveals
  // the full ugly.bot framework catalog.
  const [uglyBotExpanded, setUglyBotExpanded] = useState(false);

  // ── Subscription model fetch + live refresh on key add/remove
  useEffect(() => {
    let cancelled = false;
    const fetchList = () => {
      socket
        .request('getCodingAgentSubscriptionModels', {})
        .then((r) => {
          if (!cancelled) {
            setSubscriptionModels(r.models as CodingAgentModel[]);
          }
        })
        .catch(() => {
          if (!cancelled) setSubscriptionModels([]);
        });
    };
    fetchList();
    const onChangeEvent = () => fetchList();
    window.addEventListener('zai-subscription-changed', onChangeEvent);
    window.addEventListener('kimi-subscription-changed', onChangeEvent);
    window.addEventListener('minimax-subscription-changed', onChangeEvent);
    return () => {
      cancelled = true;
      window.removeEventListener('zai-subscription-changed', onChangeEvent);
      window.removeEventListener('kimi-subscription-changed', onChangeEvent);
      window.removeEventListener('minimax-subscription-changed', onChangeEvent);
    };
  }, [socket]);

  // ── Group all available models by subscription, applying family filter
  const groups = useMemo(() => {
    const all: CodingAgentModel[] = [
      ...BASE_MODELS,
      ...subscriptionModels,
      ...(claudeCliAvailable ? CLAUDE_CLI_MODELS : []),
    ];
    const bySub = new Map<SubscriptionKey, CodingAgentModel[]>();
    for (const model of all) {
      const sub = subscriptionOf(model);
      if (!familyAllows(family, sub)) continue;
      const arr = bySub.get(sub) ?? [];
      arr.push(model);
      bySub.set(sub, arr);
    }
    // Sort within each group by SWE-bench desc, then weighted price asc.
    for (const arr of bySub.values()) arr.sort(sortBySweAndCost);
    return bySub;
  }, [family, subscriptionModels, claudeCliAvailable]);

  // ── Trigger label resolution
  const triggerText = useMemo(() => {
    if (displayLabel !== undefined) return displayLabel;
    if (props.mode === 'single') {
      if (typeof props.value === 'string' && isAutoMode(props.value)) {
        return AUTO_LABELS[props.value];
      }
      if (typeof props.value === 'object') return props.value.name;
      return '—';
    }
    // multi
    if (props.values.length === 0) return 'default (none)';
    if (props.values.length === 1) return props.values[0]!.name;
    return `${props.values.length} selected`;
  }, [displayLabel, props]);

  // ── Selection handlers. `close` is supplied by the Popover render-prop
  // and called for single-select picks (the menu dismisses after a choice);
  // multi-select keeps the menu open so the user can toggle several rows.
  const isSingle = props.mode === 'single';
  const selectedSet = !isSingle
    ? new Set((props.values ?? []).map((m) => m.id))
    : null;

  const selectModel = (model: CodingAgentModel, close: () => void) => {
    if (props.mode === 'single') {
      props.onChange(model);
      close();
    } else {
      const next = new Set(selectedSet);
      if (next.has(model.id)) next.delete(model.id);
      else next.add(model.id);
      // Preserve catalog ordering for stability across re-renders.
      const ordered: CodingAgentModel[] = [];
      for (const arr of groups.values()) {
        for (const m of arr) if (next.has(m.id)) ordered.push(m);
      }
      props.onChangeMany(ordered);
    }
  };

  const selectAuto = (mode: AutoMode, close: () => void) => {
    if (props.mode !== 'single') return;
    props.onChange(mode);
    close();
  };

  const isModelSelected = (model: CodingAgentModel): boolean => {
    if (props.mode === 'single') {
      const v = props.value;
      return typeof v === 'object' && v.id === model.id;
    }
    return selectedSet?.has(model.id) ?? false;
  };

  const isAutoSelected = (mode: AutoMode): boolean => {
    if (props.mode !== 'single') return false;
    return typeof props.value === 'string' && props.value === mode;
  };

  // ── Trigger button
  const chipTrigger: React.CSSProperties = {
    background: 'var(--bg-secondary, #1a1a2e)',
    border: '1px solid var(--border, #2a2a3e)',
    borderRadius: 6,
    padding: '4px 10px',
    color: 'var(--text-primary, #e0e0e0)',
    fontSize: 12,
    cursor: disabled ? 'not-allowed' : 'pointer',
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    opacity: disabled ? 0.5 : 1,
    whiteSpace: 'nowrap',
    flexShrink: 0,
  };
  const rowTrigger: React.CSSProperties = {
    ...chipTrigger,
    padding: '6px 10px',
    minWidth: 220,
    textAlign: 'left',
    justifyContent: 'space-between',
  };
  const triggerCss = triggerStyle === 'row' ? rowTrigger : chipTrigger;

  const trigger = (
    <button type="button" disabled={disabled} style={triggerCss}>
      {icon}
      <span
        style={{
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {triggerText}
      </span>
      <ChevronDown />
    </button>
  );

  // ── Popup
  const popupGroupHeader: React.CSSProperties = {
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: 'var(--text-muted, #888)',
    padding: '8px 10px 4px',
  };

  const renderModelRow = (model: CodingAgentModel, close: () => void) => {
    const selected = isModelSelected(model);
    return (
      <button
        key={model.id}
        type="button"
        role="menuitem"
        onClick={() => selectModel(model, close)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          padding: '8px 10px',
          background: selected
            ? 'color-mix(in srgb, var(--accent, #ff5500) 18%, transparent)'
            : 'transparent',
          border: 'none',
          borderRadius: 6,
          cursor: 'pointer',
          color: 'var(--text-primary, #e0e0e0)',
          fontSize: 12,
          textAlign: 'left',
        }}
      >
        {props.mode === 'multi' && (
          <input
            type="checkbox"
            checked={selected}
            readOnly
            style={{ pointerEvents: 'none', flexShrink: 0 }}
          />
        )}
        <span
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
            minWidth: 0,
          }}
        >
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {stripSubscriptionPrefix(model.name)}
          </span>
          <span
            style={{ color: 'var(--text-muted, #666)', fontSize: 10 }}
            title={
              'Agentic-coding weighted estimate: ' +
              '80% cache_read + 5% cache_write + 5% input + 10% output'
            }
          >
            {formatPriceSubtitle(model)}
          </span>
        </span>
        <SweBenchBadge score={model.sweBenchVerified} />
        <CostTierBadge model={model} />
      </button>
    );
  };

  const renderAutoRow = (mode: AutoMode, close: () => void) => (
    <button
      key={mode}
      type="button"
      role="menuitem"
      onClick={() => selectAuto(mode, close)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        padding: '8px 10px',
        background: isAutoSelected(mode)
          ? 'color-mix(in srgb, var(--accent, #ff5500) 18%, transparent)'
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
        style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}
      >
        <span>{AUTO_LABELS[mode]}</span>
        <span style={{ color: 'var(--text-muted, #666)', fontSize: 10 }}>
          {AUTO_DESCRIPTIONS[mode]}
        </span>
      </span>
    </button>
  );

  const renderPopupContent = (close: () => void): React.ReactNode => {
    // Auto rows belong to the ugly.bot subscription — the auto-mode
    // router only routes through ugly.bot's framework catalog, never
    // BYO providers or the Claude CLI runner. Render them as a
    // prefix to the ugly.bot section, never as their own group.
    // Drop the deprecated 'auto:cheap' from the offered list —
    // the picker no longer surfaces it as a selectable option,
    // though we still render the label correctly when a session
    // resumes with that legacy value (the runtime translator
    // migrates it to plain 'auto' on next save).
    const VISIBLE_AUTO_MODES: readonly AutoMode[] = ['auto', 'auto:max'];
    const autoModes: readonly AutoMode[] =
      !showAutoOptions || props.mode !== 'single'
        ? []
        : showAutoOptions === true
        ? VISIBLE_AUTO_MODES
        : (showAutoOptions as AutoMode[]).filter((m) => m !== 'auto:cheap');

    const sections = SUBSCRIPTION_ORDER.filter((key) => {
      if (!familyAllows(family, key)) return false;
      const arr = groups.get(key);
      return arr !== undefined && arr.length > 0;
    });

    if (sections.length === 0) {
      return (
        <div
          style={{
            padding: '12px 10px',
            fontSize: 11,
            color: 'var(--text-muted, #888)',
            textAlign: 'center',
          }}
        >
          {family === 'claude-cli'
            ? 'Claude CLI not installed. Install `claude` to enable.'
            : 'No subscriptions configured. Add a key in Settings → Subscriptions.'}
        </div>
      );
    }

    return sections.map((key) => {
      const bucket = groups.get(key)!;
      if (key !== 'ugly.bot') {
        return (
          <div key={key}>
            <div style={popupGroupHeader}>{subscriptionLabel(key)}</div>
            {bucket.map((m) => renderModelRow(m, close))}
          </div>
        );
      }
      // ugly.bot section: render auto rows, then the default-pool
      // pinned rows (in the exact order declared in
      // `DEFAULT_POOL_PINNED_IDS`), then the remainder of the
      // ugly.bot catalog sorted by SWE-bench + cost. The pinned
      // list mirrors the server's DEFAULT_MAX_POOL so the picker's
      // top entries match what max-mode actually runs.
      //
      // The "rest" tail collapses behind a Show more toggle by
      // default — only Step 3.5 Flash (called out as a featured
      // strong-tier model) plus any currently-selected catalog row
      // stay visible while collapsed, so the user never loses sight
      // of what they have picked.
      const STEPFUN_ID = 'step_3_5_flash';
      const pinnedSet = new Set(DEFAULT_POOL_PINNED_IDS);
      const byId = new Map(bucket.map((m) => [m.id, m]));
      const pinnedRows = DEFAULT_POOL_PINNED_IDS.map((id) =>
        byId.get(id),
      ).filter((m): m is CodingAgentModel => m !== undefined);
      const restRows = bucket.filter((m) => !pinnedSet.has(m.id));

      const featuredIds = new Set<string>([STEPFUN_ID]);
      for (const m of restRows) {
        if (isModelSelected(m)) featuredIds.add(m.id);
      }
      const featuredRows = restRows.filter((m) => featuredIds.has(m.id));
      const hiddenRows = restRows.filter((m) => !featuredIds.has(m.id));
      const hasHidden = hiddenRows.length > 0;

      return (
        <div key={key}>
          <div style={popupGroupHeader}>{subscriptionLabel(key)}</div>
          {autoModes.map((m) => renderAutoRow(m, close))}
          {pinnedRows.map((m) => renderModelRow(m, close))}
          {featuredRows.map((m) => renderModelRow(m, close))}
          {uglyBotExpanded &&
            hiddenRows.map((m) => renderModelRow(m, close))}
          {hasHidden && (
            <button
              type="button"
              onClick={() => setUglyBotExpanded((v) => !v)}
              style={{
                display: 'block',
                width: '100%',
                padding: '6px 10px',
                margin: '2px 0',
                background: 'transparent',
                border: 'none',
                color: 'var(--text-muted, #888)',
                fontSize: 11,
                textAlign: 'left',
                cursor: 'pointer',
              }}
            >
              {uglyBotExpanded
                ? '− Show fewer'
                : `+ Show ${hiddenRows.length} more`}
            </button>
          )}
        </div>
      );
    });
  };

  // `<Popover>` portals the dropdown into PopoverHost (which sits AFTER
  // ModalHost in the DOM), so opening the picker from inside a modal
  // (SettingsModal, SubscriptionHub) renders above the modal automatically —
  // no z-index arithmetic needed. Floating-UI handles flip / shift / scroll-
  // and-resize tracking, so the popup stays glued to the trigger even when
  // the viewport changes mid-open.
  const picker = (
    <Popover
      trigger={trigger}
      placement="bottom-start"
      minWidth={320}
      maxHeight={560}
      disabled={disabled}
    >
      {({ close }) => renderPopupContent(close)}
    </Popover>
  );

  if (rowLabel === undefined) {
    return picker;
  }
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '8px 0',
        borderBottom: '1px solid var(--border, #2a2a3e)',
      }}
    >
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 13 }}>{rowLabel}</div>
        {rowHint && (
          <div
            style={{
              fontSize: 11,
              color: 'var(--text-muted, #888)',
              marginTop: 2,
            }}
          >
            {rowHint}
          </div>
        )}
      </div>
      {picker}
    </div>
  );
}
