import React from 'react';
import { createPortal } from 'react-dom';

// A lightweight right-click / kebab menu. Positioned at a viewport point (the
// cursor for a right-click, or a trigger button's corner) and clamped to stay
// on-screen. Dismisses on outside pointerdown, Escape, scroll, resize or blur.
// Renders via portal so tree/row overflow never clips it. Serves both the file
// tree and the project-picker kebab.

export interface ContextMenuItem {
  label: string;
  onClick: () => void;
  /** Renders in the danger color and is grouped after a divider. */
  danger?: boolean;
  disabled?: boolean;
  /** Omit the item entirely (e.g. "Open in Finder" off-device). */
  hidden?: boolean;
}

export interface ContextMenuAnchor {
  x: number;
  y: number;
}

const MENU_W = 220;

export function ContextMenu({
  anchor,
  items,
  onClose,
}: {
  anchor: ContextMenuAnchor;
  items: ContextMenuItem[];
  onClose: () => void;
}): React.ReactElement | null {
  const ref = React.useRef<HTMLDivElement>(null);
  const [pos, setPos] = React.useState<{ left: number; top: number }>({
    left: anchor.x,
    top: anchor.y,
  });

  const visible = items.filter((i) => !i.hidden);

  // Clamp into the viewport once the real height is known.
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const margin = 8;
    const left = Math.min(anchor.x, window.innerWidth - width - margin);
    const top = Math.min(anchor.y, window.innerHeight - height - margin);
    setPos({ left: Math.max(margin, left), top: Math.max(margin, top) });
  }, [anchor.x, anchor.y]);

  React.useEffect(() => {
    const onPointerDown = (e: PointerEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    // Capture scroll anywhere (the tree scrolls) so the menu doesn't drift.
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onClose, true);
    window.addEventListener('resize', onClose);
    window.addEventListener('blur', onClose);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onClose, true);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  if (visible.length === 0) return null;

  return createPortal(
    <div
      ref={ref}
      role="menu"
      data-id="context-menu"
      style={{
        position: 'fixed',
        left: pos.left,
        top: pos.top,
        zIndex: 3000,
        minWidth: MENU_W,
        background: 'var(--bg-panel)',
        border: '1px solid var(--border)',
        borderRadius: 6,
        boxShadow: '0 12px 32px rgba(0, 0, 0, 0.45)',
        padding: 4,
        fontFamily: 'var(--font-label)',
      }}
      onClick={(e) => {
        e.stopPropagation();
      }}
    >
      {visible.map((item, i) => {
        // Divider before the first danger item that follows a non-danger one.
        const showDivider = !!item.danger && i > 0 && !visible[i - 1].danger;
        return (
          <React.Fragment key={`${item.label}-${i}`}>
            {showDivider && (
              <div
                style={{
                  height: 1,
                  background: 'var(--border)',
                  margin: '4px 0',
                }}
              />
            )}
            <button
              type="button"
              role="menuitem"
              disabled={item.disabled}
              data-id={`context-menu-item-${item.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}
              onClick={() => {
                if (item.disabled) return;
                onClose();
                item.onClick();
              }}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '8px 10px',
                border: 'none',
                borderRadius: 4,
                background: 'transparent',
                cursor: item.disabled ? 'default' : 'pointer',
                fontSize: 13,
                fontWeight: 600,
                color: item.disabled
                  ? 'var(--text-muted)'
                  : item.danger
                    ? 'var(--danger, #e5484d)'
                    : 'var(--text-primary)',
                opacity: item.disabled ? 0.5 : 1,
              }}
              onMouseEnter={(e) => {
                if (!item.disabled)
                  e.currentTarget.style.background =
                    'var(--bg-hover, rgba(127,127,127,0.12))';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent';
              }}
            >
              {item.label}
            </button>
          </React.Fragment>
        );
      })}
    </div>,
    document.body,
  );
}
