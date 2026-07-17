/**
 * Dev / Prod database toggle — reusable segmented control for switching
 * between dev-tunnel and production data sources.
 */

interface DevProdToggleProps {
  mode: 'dev' | 'prod';
  onModeChange: (mode: 'dev' | 'prod') => void;
  disabled?: boolean;
}

export function DevProdToggle({
  mode,
  onModeChange,
  disabled,
}: DevProdToggleProps) {
  return (
    <div
      data-id="dev-prod-toggle"
      style={{
        display: 'inline-flex',
        borderRadius: 6,
        overflow: 'hidden',
        border: '1px solid var(--border-primary)',
      }}
    >
      <ToggleButton
        data-id="devprod-toggle-dev"
        label="Dev"
        active={mode === 'dev'}
        onClick={() => {
          onModeChange('dev');
        }}
        disabled={disabled}
      />
      <ToggleButton
        data-id="devprod-toggle-prod"
        label="Prod"
        active={mode === 'prod'}
        onClick={() => {
          onModeChange('prod');
        }}
        disabled={disabled}
      />
    </div>
  );
}

function ToggleButton({
  label,
  active,
  onClick,
  disabled,
  'data-id': dataId,
}: {
  'label': string;
  'active': boolean;
  'onClick': () => void;
  'disabled'?: boolean;
  'data-id'?: string;
}) {
  return (
    <button
      data-id={dataId ?? `toggle-${label.toLowerCase()}`}
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: '4px 12px',
        fontSize: 12,
        fontWeight: active ? 600 : 400,
        color: active ? 'var(--text-on-accent, #fff)' : 'var(--text-secondary)',
        background: active
          ? label === 'Prod'
            ? 'var(--accent-warning, #d97706)'
            : 'var(--accent-primary, #3b82f6)'
          : 'transparent',
        border: 'none',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        transition: 'background 150ms, color 150ms',
      }}
    >
      {label}
    </button>
  );
}
