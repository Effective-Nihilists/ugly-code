import {
  autoUpdate,
  flip,
  FloatingFocusManager,
  FloatingPortal,
  offset,
  shift,
  size as sizeMiddleware,
  useClick,
  useDismiss,
  useFloating,
  useInteractions,
  useListNavigation,
  useRole,
  useTransitionStyles,
  type Placement,
} from '@floating-ui/react';
import React, {
  cloneElement,
  isValidElement,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from 'react';

export type { Placement };

interface PopoverRenderContext {
  close(): void;
}

interface PopoverProps {
  /** Controlled open state. Omit for uncontrolled (the trigger toggles open via click). */
  open?: boolean;
  onOpenChange?: (next: boolean) => void;

  /**
   * Trigger element. Must be a single ReactElement (a button-ish). Floating-UI
   * clones it to wire ref + ARIA + click handlers. The trigger remains visually
   * styled by the caller.
   */
  trigger: ReactElement;

  /**
   * Popover content. Render-prop form gives the child a `close()` callback so
   * menu items can close the popover after selection without the parent
   * needing to thread state down.
   */
  children:
    | React.ReactNode
    | ((ctx: PopoverRenderContext) => React.ReactNode);

  /** Floating UI placement. Defaults to 'bottom-start'. */
  placement?: Placement;
  /** Gap in CSS px between trigger edge and popover edge. Default 4. */
  offset?: number;
  /** Minimum popover width. */
  minWidth?: number;
  /**
   * Maximum popover height. Floating-UI's size middleware clamps this to the
   * available viewport room, and the popover scrolls internally if its content
   * is taller than the clamp.
   */
  maxHeight?: number;
  /** Match the popover's width to the trigger's measured width. */
  matchTriggerWidth?: boolean;
  /** ARIA role for the popover content. Defaults to 'menu'. */
  role?: 'menu' | 'dialog' | 'listbox';
  /**
   * Enables keyboard arrow-key navigation through descendant `role="menuitem"`
   * children. Default true for `role: 'menu'` / `role: 'listbox'`.
   */
  keyboardNav?: boolean;
  /** Extra style applied to the popover container (after defaults). */
  style?: React.CSSProperties;
  /** Class applied to the popover container. */
  className?: string;
  /** Disable the popover entirely — trigger renders but never opens. */
  disabled?: boolean;
}

const FLOATING_TRANSITION_MS = 120;

/**
 * Shared popover/dropdown primitive. Renders into the app-level PopoverHost
 * via FloatingPortal — escapes ancestor overflow/transform/filter clipping,
 * lives later in the DOM than ModalHost so popovers always paint above modals.
 *
 * Positioning, flipping, viewport clamping, scroll/resize tracking, click-
 * outside dismissal, Escape key, focus trap, and ARIA wiring are all handled
 * by floating-ui internally — callers only supply the trigger and the content.
 */
export function Popover({
  open: controlledOpen,
  onOpenChange,
  trigger,
  children,
  placement = 'bottom-start',
  offset: offsetPx = 4,
  minWidth,
  maxHeight = 360,
  matchTriggerWidth = false,
  role = 'menu',
  keyboardNav,
  style,
  className,
  disabled = false,
}: PopoverProps): React.ReactElement {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : uncontrolledOpen;
  const setOpen = (next: boolean): void => {
    if (!isControlled) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };

  // Refs for arrow-key navigation through descendant role=menuitem children.
  // floating-ui needs the array reference itself stable — we rebuild contents
  // on every render via callback refs in the rendered list items.
  const listRef = useRef<(HTMLElement | null)[]>([]);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const labelId = useId();

  // We position via `top`/`left` rather than floating-ui's default
  // `floatingStyles` (which uses `transform: translate(...)`). Reason: the
  // open-animation `transform: scale(...)` from `useTransitionStyles` would
  // overwrite the positioning transform, leaving the popup at (0, 0). Using
  // `top`/`left` keeps the `transform` slot free for the scale animation.
  const { refs, x, y, context } = useFloating({
    strategy: 'fixed',
    open,
    onOpenChange: (next) => {
      if (disabled && next) return;
      setOpen(next);
    },
    placement,
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(offsetPx),
      flip({ padding: 16 }),
      shift({ padding: 16 }),
      sizeMiddleware({
        padding: 16,
        apply({ availableHeight, availableWidth, elements, rects }) {
          const clampedHeight = Math.min(maxHeight, availableHeight);
          const clampedWidth = Math.min(
            availableWidth,
            // Reserve a minimum width so floating-ui's size middleware doesn't
            // shrink to zero on cramped viewports; the popover will still
            // scroll horizontally past its content's intrinsic min-width.
            Math.max(minWidth ?? 0, 240),
          );
          elements.floating.style.maxHeight = `${clampedHeight}px`;
          if (matchTriggerWidth) {
            elements.floating.style.width = `${rects.reference.width}px`;
          } else if (minWidth !== undefined) {
            elements.floating.style.minWidth = `${minWidth}px`;
            elements.floating.style.maxWidth = `${clampedWidth}px`;
          }
        },
      }),
    ],
  });

  const click = useClick(context, { enabled: !disabled });
  const dismiss = useDismiss(context, {
    outsidePress: true,
    escapeKey: true,
  });
  const roleProps = useRole(context, { role });
  // Keyboard nav defaults: on for menu/listbox, off for dialog.
  const navEnabled = keyboardNav ?? role !== 'dialog';
  const listNav = useListNavigation(context, {
    listRef,
    activeIndex,
    onNavigate: setActiveIndex,
    enabled: navEnabled,
    loop: true,
    virtual: false,
  });

  const { getReferenceProps, getFloatingProps } = useInteractions([
    click,
    dismiss,
    roleProps,
    listNav,
  ]);

  // Mount transition (fade + small scale-in). Floating-UI's hook gates the
  // unmount on the exit transition completing, so we don't need a separate
  // useMountTransition here.
  const { isMounted, styles: transitionStyles } = useTransitionStyles(context, {
    duration: FLOATING_TRANSITION_MS,
    initial: { opacity: 0, transform: 'scale(0.98)' },
  });

  // Clone the trigger to wire floating-ui's reference ref + interaction props.
  // The original trigger keeps its own onClick / disabled / style — we merge
  // them through getReferenceProps so the caller's handlers still fire.
  const triggerEl = useMemo(() => {
    if (!isValidElement(trigger)) {
      throw new Error('<Popover> requires a single ReactElement trigger');
    }
    interface TriggerProps { ref?: React.Ref<HTMLElement> }
    const triggerWithRef = trigger as ReactElement<TriggerProps>;
    return cloneElement(triggerWithRef, {
      ref: refs.setReference,
      ...getReferenceProps({
        // Forward existing onClick on the trigger so callers can still observe
        // click events for analytics / focus management.
        onClick: (triggerWithRef.props as { onClick?: React.MouseEventHandler })
          .onClick,
      }),
      'aria-haspopup': role,
      'aria-expanded': open,
      'aria-controls': open ? labelId : undefined,
    } as TriggerProps & Record<string, unknown>);
  }, [trigger, refs.setReference, getReferenceProps, role, open, labelId]);

  // Render-prop form gives children a close() handle.
  const close = (): void => { setOpen(false); };
  const renderedContent =
    typeof children === 'function'
      ? (children as (ctx: PopoverRenderContext) => React.ReactNode)({ close })
      : children;

  return (
    <>
      {triggerEl}
      {isMounted && (
        <FloatingPortal id="popover-root">
          <FloatingFocusManager
            context={context}
            modal={false}
            initialFocus={-1}
          >
            <div
              ref={refs.setFloating}
              id={labelId}
              {...getFloatingProps()}
              style={{
                position: 'fixed',
                top: y,
                left: x,
                // Must outrank StudioTopBar (z-index 10000) — the topbar
                // deliberately sits above modals (z-index 1000-9999) so its
                // drag region / window controls / feedback button stay
                // reachable while a modal is open. Popovers, however, are
                // always interactive content the user just summoned, so they
                // need to outrank everything — including any popover opened
                // from inside the topbar itself (ZoomBadge, FeedbackButton).
                zIndex: 10001,
                ...transitionStyles,
                background: 'var(--bg-secondary, #1a1a2e)',
                border: '1px solid var(--border, #2a2a3e)',
                borderRadius: 8,
                boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
                padding: 4,
                overflowY: 'auto',
                outline: 'none',
                ...style,
              }}
              className={className}
            >
              {renderedContent}
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      )}
    </>
  );
}
