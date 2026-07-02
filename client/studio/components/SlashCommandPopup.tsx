import { type Skill } from '../hooks/useSlashCommands';

interface Props {
  items: Skill[];
  selectedIdx: number;
  onHover: (idx: number) => void;
  onSelect: (skill: Skill) => void;
}

export function SlashCommandPopup({
  items,
  selectedIdx,
  onHover,
  onSelect,
}: Props) {
  if (items.length === 0) {
    return (
      <div
        className="us-fade-down"
        style={{
          position: 'absolute',
          bottom: '100%',
          left: 0,
          right: 0,
          marginBottom: 6,
          background: 'var(--bg-panel)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          padding: '8px 12px',
          fontSize: 12,
          color: 'var(--text-muted)',
          boxShadow: '0 4px 14px rgba(0,0,0,0.25)',
          pointerEvents: 'none',
          zIndex: 20,
          transformOrigin: 'bottom center',
        }}
      >
        No skills found
      </div>
    );
  }

  return (
    <div
      className="us-fade-down"
      style={{
        position: 'absolute',
        bottom: '100%',
        left: 0,
        right: 0,
        marginBottom: 6,
        background: 'var(--bg-panel)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: 4,
        maxHeight: 240,
        overflowY: 'auto',
        boxShadow: '0 4px 14px rgba(0,0,0,0.25)',
        zIndex: 20,
        transformOrigin: 'bottom center',
      }}
      onMouseDown={(e) => { e.preventDefault(); } /* keep textarea focus */}
    >
      {items.map((skill, idx) => {
        const selected = idx === selectedIdx;
        return (
          <div
            key={`${skill.scope}:${skill.name}`}
            className="us-interactive"
            onMouseEnter={() => { onHover(idx); }}
            onClick={() => { onSelect(skill); }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 10px',
              borderRadius: 6,
              cursor: 'pointer',
              background: selected ? 'var(--bg-secondary)' : 'transparent',
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: 'var(--text-primary)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                /{skill.name}
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: 'var(--text-muted)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {skill.description || '—'}
              </div>
            </div>
            <span
              style={{
                fontSize: 9,
                textTransform: 'uppercase',
                letterSpacing: 0.5,
                color:
                  skill.scope === 'project'
                    ? 'var(--accent)'
                    : 'var(--text-muted)',
                border: '1px solid var(--border)',
                borderRadius: 4,
                padding: '1px 5px',
                flexShrink: 0,
              }}
            >
              {skill.scope}
            </span>
          </div>
        );
      })}
    </div>
  );
}
