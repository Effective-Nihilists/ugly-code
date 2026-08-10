import React from 'react';
import { Menu, type MenuNode } from 'ugly-app/client';

// A lightweight right-click / kebab menu. Serves both the file tree and the
// project-picker kebab.
//
// The positioning, portalling, dismissal and keyboard handling all come from
// ugly-app's shared overlay tier now; what used to live here was a private copy
// of the same five behaviours. The copy clamped rather than flipped, so a menu
// opened near the bottom of the tree slid up over the row it belonged to
// instead of opening above it. The shared version flips, and picks the side
// with the most room when neither fits.
//
// Appearance comes from the studio's own CSS variables via the `OverlayProvider`
// mounted in `client/main.tsx` — every theme redefines them, so all four themes
// follow without anything here knowing about them.

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

const slug = (label: string): string =>
  label.toLowerCase().replace(/[^a-z0-9]+/g, '-');

export function ContextMenu({
  anchor,
  items,
  onClose,
}: {
  anchor: ContextMenuAnchor;
  items: ContextMenuItem[];
  onClose: () => void;
}): React.ReactElement | null {
  const visible = React.useMemo(() => items.filter((i) => !i.hidden), [items]);

  // Ids are label slugs so `data-id="menu-item-delete"` stays readable, with a
  // counter suffix for the rare duplicate label — an id has to be unique for
  // the pick lookup to be unambiguous.
  const { nodes, handlers } = React.useMemo(() => {
    const used = new Map<string, number>();
    const map = new Map<string, () => void>();
    const out: MenuNode[] = [];
    visible.forEach((item, i) => {
      const base = slug(item.label);
      const n = used.get(base) ?? 0;
      used.set(base, n + 1);
      const id = n === 0 ? base : `${base}-${n}`;
      map.set(id, item.onClick);
      // Divider before the first danger item that follows a non-danger one.
      if (item.danger && i > 0 && !visible[i - 1].danger)
        out.push({ separator: true });
      out.push({
        id,
        label: item.label,
        ...(item.danger ? { danger: true } : {}),
        ...(item.disabled ? { disabled: true } : {}),
      });
    });
    return { nodes: out, handlers: map };
  }, [visible]);

  const overlayAnchor = React.useMemo(
    () => ({ kind: 'point' as const, x: anchor.x, y: anchor.y }),
    [anchor.x, anchor.y],
  );

  if (visible.length === 0) return null;

  return (
    <Menu
      open
      anchor={overlayAnchor}
      items={nodes}
      width={MENU_W}
      side="bottom"
      align="start"
      onPick={(id) => {
        handlers.get(id)?.();
      }}
      onDismiss={onClose}
      data-id="context-menu"
    />
  );
}
