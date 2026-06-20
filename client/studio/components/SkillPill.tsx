import { X } from 'lucide-react';

interface Props {
  name: string;
  onRemove: () => void;
}

/**
 * Compact pill chip shown inside the chat input when a skill has been
 * selected via the `/` autocomplete. On send, the chip is consumed and
 * the skill invocation is prepended to the outgoing message (invisibly)
 * — the chat history shows only `/skill-name` plus the user's text.
 */
export function SkillPill({ name, onRemove }: Props) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        background: 'var(--accent-dim, rgba(255,128,0,0.15))',
        color: 'var(--accent)',
        border: '1px solid var(--accent)',
        borderRadius: 12,
        padding: '2px 4px 2px 8px',
        fontSize: 11,
        fontFamily: 'inherit',
        lineHeight: 1.4,
        flexShrink: 0,
        alignSelf: 'center',
        maxWidth: 180,
      }}
    >
      <span
        style={{
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        /{name}
      </span>
      <button
        onClick={onRemove}
        title="Remove skill"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'transparent',
          border: 'none',
          padding: 0,
          width: 14,
          height: 14,
          color: 'var(--accent)',
          cursor: 'pointer',
          flexShrink: 0,
        }}
      >
        <X size={11} />
      </button>
    </span>
  );
}
