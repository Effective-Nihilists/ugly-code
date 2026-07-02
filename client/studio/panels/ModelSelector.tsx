/**
 * Back-compat shim. The real implementation lives in
 * `studio/client/components/ModelPicker.tsx` — see that file for the
 * unified single-/multi-select component.
 *
 * Existing call sites (CodingAgentChat, NewSessionModelPicker, the in-
 * chat AgentAxisSelector) still pass a string `value` and a
 * `string -> void` `onChange`, so this wrapper:
 *
 *   - looks the string up in the runtime catalog (framework + live
 *     subscription rows) to hand a `ModelChoice` (object | auto sentinel)
 *     to ModelPicker;
 *   - flattens ModelPicker's `CodingAgentModel | AutoMode` callback back
 *     to the legacy string id when the user picks something;
 *   - maps the legacy `family: 'claude' | 'non-claude' | undefined`
 *     prop to the new picker's `'claude-cli' | 'normal' | 'either'`;
 *   - swallows the deprecated `subscriptionsOnly` and `onNeedsKey` props
 *     — locked stubs are gone, the Subscription Hub is the only
 *     discovery surface now.
 *
 * New code should import `ModelPicker` directly.
 */

import React, { useEffect, useState } from 'react';
import { getCodingAgentModels, type CodingAgentModel } from 'ugly-app/shared';
import {
  ModelPicker,
  type Family,
  type ModelChoice,
} from '../components/ModelPicker';
import { useSocket } from '../hooks/useSocket';

export {
  isWeakModel,
  type AutoMode,
  type ModelChoice,
  type SubscriptionProvider,
} from '../components/ModelPicker';

type LegacySubscriptionProvider = 'z-ai' | 'kimi' | 'minimax' | 'deepseek';

interface ModelSelectorProps {
  value: string;
  onChange: (modelId: string) => void;
  disabled?: boolean;
  icon?: React.ReactNode;
  /** Deprecated — ignored. Once locked stubs went away, framework + configured-subscriptions is the only "normal" mode. */
  subscriptionsOnly?: boolean;
  /** Legacy family filter. Maps to ModelPicker's family axis. */
  family?: 'claude' | 'non-claude';
  /**
   * Deprecated — locked rows are gone, so this never fires. The
   * provider union mirrors the historical SubscriptionProvider so
   * legacy call sites that still pass a deepseek-aware handler
   * type-check.
   */
  onNeedsKey?: (provider: LegacySubscriptionProvider) => void;
  displayLabel?: string;
}

const FRAMEWORK_MODELS = getCodingAgentModels();

function mapFamily(family: 'claude' | 'non-claude' | undefined): Family {
  if (family === 'claude') return 'claude-cli';
  if (family === 'non-claude') return 'normal';
  return 'either';
}

function isAutoString(v: string): v is 'auto' | 'auto:cheap' | 'auto:max' {
  return v === 'auto' || v === 'auto:cheap' || v === 'auto:max';
}

export function ModelSelector(props: ModelSelectorProps): React.ReactElement {
  const socket = useSocket();
  const [subscriptionModels, setSubscriptionModels] = useState<
    CodingAgentModel[]
  >([]);

  useEffect(() => {
    let cancelled = false;
    const fetchList = () => {
      socket
        .request('getCodingAgentSubscriptionModels', {})
        .then((r) => {
          if (!cancelled) setSubscriptionModels(r.models as CodingAgentModel[]);
        })
        .catch(() => {
          if (!cancelled) setSubscriptionModels([]);
        });
    };
    fetchList();
    const onChange = () => { fetchList(); };
    window.addEventListener('zai-subscription-changed', onChange);
    window.addEventListener('kimi-subscription-changed', onChange);
    window.addEventListener('minimax-subscription-changed', onChange);
    return () => {
      cancelled = true;
      window.removeEventListener('zai-subscription-changed', onChange);
      window.removeEventListener('kimi-subscription-changed', onChange);
      window.removeEventListener('minimax-subscription-changed', onChange);
    };
  }, [socket]);

  const family = mapFamily(props.family);

  // Resolve string `value` → ModelChoice. Auto sentinels pass through as
  // strings; concrete ids are looked up in the live catalog (framework +
  // subscription rows). When a persisted id falls out of the catalog
  // (e.g. user removed the corresponding subscription key), fall back to
  // 'auto' so the trigger still renders something sane.
  const choice: ModelChoice = (() => {
    if (isAutoString(props.value)) return props.value;
    const catalog = [...FRAMEWORK_MODELS, ...subscriptionModels];
    const found = catalog.find((m) => m.id === props.value);
    return found ?? 'auto';
  })();

  return (
    <ModelPicker
      mode="single"
      value={choice}
      onChange={(next) => {
        if (typeof next === 'string') props.onChange(next);
        else props.onChange(next.id);
      }}
      family={family}
      showAutoOptions
      {...(props.disabled !== undefined ? { disabled: props.disabled } : {})}
      {...(props.icon !== undefined ? { icon: props.icon } : {})}
      {...(props.displayLabel !== undefined
        ? { displayLabel: props.displayLabel }
        : {})}
    />
  );
}
