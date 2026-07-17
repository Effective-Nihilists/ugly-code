import React, { useCallback, useMemo } from 'react';
import { getCodingAgentModels, type CodingAgentModel } from 'ugly-app/shared';
import {
  PATTERN_OPTIONS,
  PERMISSION_OPTIONS,
  type ModelAxisValue,
  type PatternAxisValue,
  type PermissionAxisValue,
} from '../components/AgentAxisSelector';
import { ModelPicker } from '../components/ModelPicker';
import { useSocket } from '../hooks/useSocket';
import { useGlmCodingKey } from '../hooks/useGlmCodingKey';
import {
  setStudioUserSetting,
  useStudioUserSetting,
} from '../hooks/useStudioUserSetting';
import { PERSONAS, type PersonaId } from '../agent/patterns/peer-personas';
import { DEFAULT_POOL_PINNED_IDS } from '../shared/model-rankings';
import { Modal } from '../system';
import {
  MODEL_MODE_SETTING_KEY,
  MODEL_SETTING_KEY,
  PATTERN_SETTING_KEY,
  PERMISSION_SETTING_KEY,
  REASONING_SETTING_KEY,
  BRANCH_MODE_SETTING_KEY,
} from './NewSessionHero';
import type { ReasoningEffort } from './ReasoningSelector';

/**
 * Studio settings panel — surfaces the coding-agent "3-axis" per-user
 * defaults (Pattern / Permission / Model mode) that every NEW session
 * inherits. Persists via `useStudioUserSetting` against the exact same
 * keys NewSessionHero reads, so this panel and the new-session hero
 * share one source of truth.
 *
 * Unlike the in-chat AgentAxisSelector chip (which only exposes
 * auto/max/single on the model axis), this panel additionally lets the
 * user configure the currently-unsettable `max` and `group` model
 * modes — including a peer-model multi-select + per-peer persona
 * assignment for group-assignment mode (CODING.md §17.17).
 *
 * Scope: per-user DEFAULTS only. Applying to a live in-flight session
 * is out of scope — no RPCs beyond the settings write-through.
 */

type ModelModeKind = 'auto' | 'max' | 'single' | 'group';

const MODEL_MODE_CHOICES: {
  kind: ModelModeKind;
  label: string;
  hint: string;
}[] = [
  { kind: 'auto', label: 'Auto', hint: 'cheap router picks a model per turn' },
  {
    kind: 'max',
    label: 'Max',
    hint: 'runs the default peer pool in parallel; a picker LLM keeps the winner',
  },
  {
    kind: 'single',
    label: 'Single',
    hint: 'pin one model for every turn',
  },
  {
    kind: 'group',
    label: 'Group',
    hint: 'run N chosen peers concurrently, each with an optional persona',
  },
];

const labelCss: React.CSSProperties = {
  fontFamily: 'var(--font-label)',
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: 'var(--accent)',
  marginBottom: 6,
};

const hintCss: React.CSSProperties = {
  fontSize: 11.5,
  color: 'var(--text-muted, #888)',
  marginTop: 6,
  lineHeight: 1.45,
};

const selectCss: React.CSSProperties = {
  width: '100%',
  background: 'var(--bg-secondary, #1a1a2e)',
  border: '1px solid var(--border, #2a2a3e)',
  borderRadius: 6,
  padding: '8px 10px',
  color: 'var(--text-primary, #e0e0e0)',
  fontSize: 13,
  fontFamily: 'inherit',
  cursor: 'pointer',
};

function Section({
  title,
  children,
  hint,
}: {
  title: string;
  children: React.ReactNode;
  hint?: string;
}): React.ReactElement {
  return (
    <div
      style={{ padding: '18px 20px', borderBottom: '1px solid var(--border)' }}
    >
      <div style={labelCss}>{title}</div>
      {children}
      {hint && <div style={hintCss}>{hint}</div>}
    </div>
  );
}

/**
 * The Z.ai GLM Coding Plan key. The only provider credential the studio stores.
 *
 * Lives in the Neon per-user settings doc (not the host-disk studio settings)
 * because the SERVER reads it to forward on each agentStep. Until one is saved,
 * the `GLM Coding Plan` model is hidden from the picker and the server refuses
 * the turn — ugly.bot never falls back to a shared Z.ai account.
 */
function GlmCodingKeySection(): React.ReactElement {
  const { key, hydrated, save } = useGlmCodingKey();
  const [draft, setDraft] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const configured = !!key;
  const commit = async (next: string | null): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await save(next);
      setDraft('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title="GLM Coding Plan key"
      hint="Your Z.ai Coding Plan key. Turns run on your own flat-rate subscription — ugly.bot relays the request and bills nothing. Without a key the model is hidden."
    >
      {configured ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 12, color: '#4caf50' }}>
            {/* Never echo the key back; show only that one is set. */}
            Key configured
          </span>
          <button
            data-id="settings-glm-key-remove"
            type="button"
            disabled={busy}
            onClick={() => void commit(null)}
            style={{
              fontFamily: 'var(--font-label)',
              fontSize: 10.5,
              fontWeight: 700,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              color: 'var(--text-secondary)',
              background: 'transparent',
              border: '1px solid var(--border)',
              padding: '4px 10px',
              cursor: busy ? 'default' : 'pointer',
            }}
          >
            Remove
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            data-id="settings-glm-key-input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={
              hydrated ? 'Paste your Z.ai Coding Plan key' : 'Loading…'
            }
            value={draft}
            disabled={!hydrated || busy}
            onChange={(e) => {
              setDraft(e.target.value);
            }}
            style={{ ...selectCss, flex: 1 }}
          />
          <button
            data-id="settings-glm-key-save"
            type="button"
            disabled={!hydrated || busy || draft.trim() === ''}
            onClick={() => void commit(draft)}
            style={{
              fontFamily: 'var(--font-label)',
              fontSize: 10.5,
              fontWeight: 700,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              color: 'var(--text-secondary)',
              background: 'transparent',
              border: '1px solid var(--border)',
              padding: '4px 12px',
              cursor: draft.trim() === '' || busy ? 'default' : 'pointer',
              opacity: draft.trim() === '' || busy ? 0.5 : 1,
            }}
          >
            Save
          </button>
        </div>
      )}
      {error && (
        <div style={{ fontSize: 12, color: '#e53935', marginTop: 6 }}>
          {error}
        </div>
      )}
    </Section>
  );
}

export function StudioSettingsModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): React.ReactElement {
  const socket = useSocket();

  // ── Persisted per-user axis defaults (shared with NewSessionHero).
  const [patternMode, setPatternMode] = useStudioUserSetting<PatternAxisValue>(
    PATTERN_SETTING_KEY,
    'none',
  );
  const [permissionMode, setPermissionMode] =
    useStudioUserSetting<PermissionAxisValue>(PERMISSION_SETTING_KEY, 'edit');
  const [modelMode, setModelMode] = useStudioUserSetting<ModelAxisValue>(
    MODEL_MODE_SETTING_KEY,
    { kind: 'single', model: 'deepseek_v4_pro' },
  );
  const [reasoningEffort, setReasoningEffort] =
    useStudioUserSetting<ReasoningEffort>(REASONING_SETTING_KEY, 'high');
  const [branchMode, setBranchMode] = useStudioUserSetting<'worktree' | 'main'>(
    BRANCH_MODE_SETTING_KEY,
    'worktree',
  );

  // Catalog lookup — the multi-select works in `CodingAgentModel`
  // objects but the persisted group value stores string ids.
  const byId = useMemo(() => {
    const map = new Map<string, CodingAgentModel>();
    for (const m of getCodingAgentModels()) map.set(m.id, m);
    return map;
  }, []);

  // Mirror a single-model pick into the legacy `codingAgentModel` slot
  // (matches NewSessionHero.handleModelModeChange) so non-hero
  // session-creation paths inherit the same seed.
  const applyModelMode = useCallback(
    (next: ModelAxisValue) => {
      setModelMode(next);
      if (next.kind === 'single') {
        setStudioUserSetting(socket, MODEL_SETTING_KEY, next.model);
      }
    },
    [setModelMode, socket],
  );

  const currentKind: ModelModeKind =
    modelMode.kind === 'auto' ||
    modelMode.kind === 'max' ||
    modelMode.kind === 'single' ||
    modelMode.kind === 'group'
      ? modelMode.kind
      : // Legacy 'mid' / 'auto-cheap' resume values collapse to Auto.
        'auto';

  // Seed a fresh value when the user switches model-mode kind.
  const handleKindChange = useCallback(
    (kind: ModelModeKind) => {
      if (kind === 'auto') applyModelMode({ kind: 'auto' });
      else if (kind === 'max') applyModelMode({ kind: 'max' });
      else if (kind === 'single') {
        const seed =
          modelMode.kind === 'single'
            ? modelMode.model
            : (DEFAULT_POOL_PINNED_IDS[0] ?? 'deepseek_v4_pro');
        applyModelMode({ kind: 'single', model: seed });
      } else {
        // group — seed from the default peer pool when we don't already
        // have a group selection to carry over.
        const seed =
          modelMode.kind === 'group' && modelMode.models.length > 0
            ? modelMode.models
            : [...DEFAULT_POOL_PINNED_IDS];
        applyModelMode({ kind: 'group', models: seed });
      }
    },
    [applyModelMode, modelMode],
  );

  // ── Single-mode picker binding.
  const singleValue: CodingAgentModel | 'auto' =
    modelMode.kind === 'single'
      ? (byId.get(modelMode.model) ?? 'auto')
      : 'auto';

  // ── Group-mode picker binding.
  const groupModels = modelMode.kind === 'group' ? modelMode.models : [];
  const groupPersonas =
    modelMode.kind === 'group' ? (modelMode.personas ?? {}) : {};
  const groupValues = useMemo(
    () =>
      groupModels
        .map((id) => byId.get(id))
        .filter((m): m is CodingAgentModel => m !== undefined),
    [groupModels, byId],
  );

  const handleGroupModels = useCallback(
    (models: CodingAgentModel[]) => {
      const ids = models.map((m) => m.id);
      // Drop personas for models that are no longer selected.
      const personas: Record<string, string> = {};
      for (const id of ids) {
        const p = groupPersonas[id];
        if (p) personas[id] = p;
      }
      applyModelMode({
        kind: 'group',
        models: ids,
        ...(Object.keys(personas).length > 0 ? { personas } : {}),
      });
    },
    [applyModelMode, groupPersonas],
  );

  const handleGroupPersona = useCallback(
    (modelId: string, persona: PersonaId | '') => {
      // Rebuild without the cleared key (no dynamic delete): default/'' → drop it.
      const personas: Record<string, string> = {};
      for (const [k, v] of Object.entries(groupPersonas))
        if (k !== modelId) personas[k] = v;
      if (persona !== '' && persona !== 'default') personas[modelId] = persona;
      applyModelMode({
        kind: 'group',
        models: groupModels,
        ...(Object.keys(personas).length > 0 ? { personas } : {}),
      });
    },
    [applyModelMode, groupModels, groupPersonas],
  );

  const personaIds = Object.keys(PERSONAS) as PersonaId[];

  return (
    <Modal open={open} onClose={onClose} size="md" ariaLabel="Studio settings">
      <Modal.Header>Settings</Modal.Header>
      <Modal.Body>
        {/* ── GLM Coding Plan key ── */}
        <GlmCodingKeySection />

        {/* ── Pattern default ── */}
        <Section
          title="Pattern default"
          hint="The step engine every new session starts with. Auto lets a classifier pick per turn."
        >
          <select
            data-id="settings-pattern-select"
            value={patternMode}
            onChange={(e) => {
              setPatternMode(e.target.value as PatternAxisValue);
            }}
            style={selectCss}
          >
            {PATTERN_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label} — {o.hint}
              </option>
            ))}
          </select>
        </Section>

        {/* ── Permission default ── */}
        <Section
          title="Permission default"
          hint="How much filesystem reach a new session's agent gets."
        >
          <select
            data-id="settings-permission-select"
            value={permissionMode}
            onChange={(e) => {
              setPermissionMode(e.target.value as PermissionAxisValue);
            }}
            style={selectCss}
          >
            {PERMISSION_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label} — {o.hint}
              </option>
            ))}
          </select>
        </Section>

        {/* ── Model mode default ── */}
        <Section
          title="Model mode default"
          hint={MODEL_MODE_CHOICES.find((c) => c.kind === currentKind)?.hint}
        >
          <div
            style={{
              display: 'flex',
              gap: 6,
              flexWrap: 'wrap',
              marginBottom: 12,
            }}
          >
            {MODEL_MODE_CHOICES.map((c) => {
              const active = c.kind === currentKind;
              return (
                <button
                  key={c.kind}
                  type="button"
                  data-id={`settings-model-mode-${c.kind}`}
                  onClick={() => {
                    handleKindChange(c.kind);
                  }}
                  style={{
                    padding: '6px 14px',
                    borderRadius: 6,
                    border: `1px solid ${active ? 'var(--accent)' : 'var(--border, #2a2a3e)'}`,
                    background: active
                      ? 'color-mix(in srgb, var(--accent, #ff5500) 18%, transparent)'
                      : 'var(--bg-secondary, #1a1a2e)',
                    color: 'var(--text-primary, #e0e0e0)',
                    fontSize: 12.5,
                    fontWeight: active ? 700 : 500,
                    cursor: 'pointer',
                  }}
                >
                  {c.label}
                </button>
              );
            })}
          </div>

          {currentKind === 'single' && (
            <ModelPicker
              mode="single"
              value={singleValue}
              onChange={(choice) => {
                if (typeof choice === 'object') {
                  applyModelMode({ kind: 'single', model: choice.id });
                } else {
                  // Auto sentinel picked from within the single picker.
                  applyModelMode({ kind: 'auto' });
                }
              }}
              triggerStyle="row"
              rowLabel="Pinned model"
              rowHint="Used for every turn of a new session."
            />
          )}

          {currentKind === 'group' && (
            <div>
              <ModelPicker
                mode="multi"
                values={groupValues}
                onChangeMany={handleGroupModels}
                triggerStyle="row"
                rowLabel="Peer pool"
                rowHint="Models that run concurrently each turn."
              />
              {groupValues.length === 0 ? (
                <div style={hintCss}>
                  No peers selected — the runtime default pool is used.
                </div>
              ) : (
                <div style={{ marginTop: 12, display: 'grid', gap: 8 }}>
                  {groupValues.map((m) => (
                    <div
                      key={m.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 12,
                      }}
                    >
                      <span
                        style={{
                          flex: 1,
                          minWidth: 0,
                          fontSize: 12.5,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {m.name}
                      </span>
                      <select
                        data-id={`settings-group-persona-${m.id}`}
                        value={groupPersonas[m.id] ?? ''}
                        onChange={(e) => {
                          handleGroupPersona(
                            m.id,
                            e.target.value as PersonaId | '',
                          );
                        }}
                        style={{ ...selectCss, width: 260, cursor: 'pointer' }}
                      >
                        <option value="">No persona</option>
                        {personaIds
                          .filter((id) => id !== 'default')
                          .map((id) => (
                            <option key={id} value={id}>
                              {id} — {PERSONAS[id].description}
                            </option>
                          ))}
                      </select>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {currentKind === 'max' && (
            <div style={hintCss}>
              Max mode runs the default peer pool (
              {DEFAULT_POOL_PINNED_IDS.length} models) in parallel each turn and
              a picker LLM keeps the winning diff. No extra configuration
              needed.
            </div>
          )}
        </Section>

        {/* ── Reasoning default ── */}
        <Section
          title="Reasoning default"
          hint="Controls how much the model thinks before answering each turn. High = deeper reasoning, low = faster."
        >
          <select
            data-id="settings-reasoning-select"
            value={reasoningEffort}
            onChange={(e) => {
              setReasoningEffort(e.target.value as ReasoningEffort);
            }}
            style={selectCss}
          >
            <option value="high">High — thorough reasoning</option>
            <option value="medium">Medium — balanced</option>
            <option value="low">Low — fast</option>
          </select>
        </Section>

        {/* ── Branch isolation default ── */}
        <Section
          title="Branch isolation"
          hint="Every new session creates a git worktree by default (isolated from other sessions). Switch to main branch to work directly on the project directory."
        >
          <select
            data-id="settings-branch-mode-select"
            value={branchMode}
            onChange={(e) => {
              setBranchMode(e.target.value as 'worktree' | 'main');
            }}
            style={selectCss}
          >
            <option value="worktree">Worktree (isolated branch)</option>
            <option value="main">Main branch (no isolation)</option>
          </select>
        </Section>
      </Modal.Body>
      <Modal.Footer>
        <button
          type="button"
          data-id="settings-done"
          onClick={onClose}
          style={{
            fontFamily: 'var(--font-label)',
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            color: 'var(--text-primary)',
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border)',
            padding: '8px 18px',
            cursor: 'pointer',
          }}
        >
          Done
        </button>
      </Modal.Footer>
    </Modal>
  );
}
