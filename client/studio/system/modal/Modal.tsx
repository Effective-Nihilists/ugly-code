import {
  FloatingFocusManager,
  FloatingOverlay,
  FloatingPortal,
  useDismiss,
  useFloating,
  useId,
  useInteractions,
  useRole,
  useTransitionStyles,
} from '@floating-ui/react';
import React, { useEffect, useMemo } from 'react';
import { useModalStack } from './ModalContext';

export type ModalSize = 'sm' | 'md' | 'lg' | 'xl' | 'full' | number;
export type ModalAnchor = 'center' | 'top';

interface ModalProps {
  open: boolean;
  /** Called whenever the modal should close — Escape, backdrop click, or X. */
  onClose: () => void;

  /**
   * Width preset. `'sm'`=480, `'md'`=640, `'lg'`=860, `'xl'`=1100, `'full'`
   * fills the viewport minus a 16px gutter. Pass a number for a custom width.
   */
  size?: ModalSize;
  /**
   * Vertical anchor. `'center'` (default) centers in viewport. `'top'` places
   * the modal `topOffset` from the top — used by SearchModal (command palette).
   */
  anchor?: ModalAnchor;
  /** Used when `anchor === 'top'`. Defaults to 100. */
  topOffset?: number;

  /** Default true. Set false to disable Escape dismissal (long-running ops). */
  closeOnEscape?: boolean;
  /** Default true. Set false to disable backdrop-click dismissal. */
  closeOnBackdrop?: boolean;

  /** ARIA label for the dialog. Required for accessibility. */
  ariaLabel?: string;
  /**
   * ID of the element labeling the dialog (preferred over `ariaLabel`). Pair
   * with `<Modal.Header>` which auto-sets this.
   */
  ariaLabelledBy?: string;

  /**
   * Element to focus when the modal opens. If omitted, focus goes to the first
   * focusable child (FloatingFocusManager default).
   */
  initialFocus?: React.RefObject<HTMLElement | null>;

  /** Extra style applied to the modal card. */
  cardStyle?: React.CSSProperties;
  /** Class applied to the modal card. */
  cardClassName?: string;
  /** Children rendered inside the card. */
  children: React.ReactNode;
}

const TRANSITION_MS = 180;
// Modals start at z-index 1000; each stacked modal climbs by 10 to stay above
// the previous one's backdrop + card. PopoverHost paints later in the DOM and
// has no z-index of its own, so popovers always sit above modals.
const BASE_MODAL_Z = 1000;
const STACK_Z_STEP = 10;

function resolveSize(size: ModalSize): string {
  if (typeof size === 'number') return `min(${size}px, 100% - 32px)`;
  switch (size) {
    case 'sm':
      return 'min(480px, 100% - 32px)';
    case 'md':
      return 'min(640px, 100% - 32px)';
    case 'lg':
      return 'min(860px, 100% - 32px)';
    case 'xl':
      return 'min(1100px, 100% - 32px)';
    case 'full':
      return 'calc(100vw - 32px)';
    default:
      return 'min(640px, 100% - 32px)';
  }
}

/**
 * Shared fullscreen modal primitive. Renders via portal into `#modal-root`,
 * stacks deterministically with sibling modals, and delegates focus trap,
 * Escape, and backdrop-click handling to floating-ui.
 *
 * Sub-components `<Modal.Header>`, `<Modal.Body>`, `<Modal.Footer>` are
 * available for the common "sticky header / scrollable body / right-aligned
 * footer" pattern — but the modal also accepts arbitrary children for custom
 * layouts (ProgressModal's stage stepper, FinishReviewModal's diff viewer).
 */
export function Modal({
  open,
  onClose,
  size = 'lg',
  anchor = 'center',
  topOffset = 100,
  closeOnEscape = true,
  closeOnBackdrop = true,
  ariaLabel,
  ariaLabelledBy,
  initialFocus,
  cardStyle,
  cardClassName,
  children,
}: ModalProps): React.ReactElement | null {
  const stack = useModalStack();
  const [handle, setHandle] = React.useState<{
    id: string;
    release: () => void;
  } | null>(null);

  // Register with the stack when the modal opens, release on close. We track
  // the handle in state so re-renders don't double-register; the cleanup
  // happens via the release function from `register()`.
  useEffect(() => {
    if (!open) return;
    const h = stack.register();
    setHandle(h);
    return () => {
      h.release();
      setHandle(null);
    };
  }, [open, stack]);

  const stackIndex = useMemo(() => {
    if (!handle) return 0;
    return Math.max(
      0,
      stack.stack.findIndex((e) => e.id === handle.id),
    );
  }, [handle, stack.stack]);

  // Only the TOP modal reacts to outside-press / Escape. Without this, a modal
  // opened FROM another modal (rendered as a sibling portal on top — e.g. the
  // settings → "how modes work" explainer) makes every click inside the child
  // count as an outside-press for the PARENT, so dismissing the child also tears
  // down the parent. Escape has the same problem: both contexts would fire.
  const isTopModal = useMemo(() => {
    if (!handle) return true;
    return (
      stack.stack.findIndex((e) => e.id === handle.id) ===
      stack.stack.length - 1
    );
  }, [handle, stack.stack]);

  const { refs, context } = useFloating({
    open,
    onOpenChange: (next) => {
      if (!next) onClose();
    },
  });

  const dismiss = useDismiss(context, {
    // Gate on isTopModal so a stacked child modal's interactions don't dismiss
    // the parent underneath it (see isTopModal above).
    outsidePress: closeOnBackdrop && isTopModal,
    escapeKey: closeOnEscape && isTopModal,
    // Modals are root-level interactive surfaces — pointerdown outside the
    // card (i.e. on the backdrop) should dismiss when allowed.
    outsidePressEvent: 'mousedown',
  });
  const role = useRole(context, { role: 'dialog' });
  const { getFloatingProps } = useInteractions([dismiss, role]);

  const { isMounted, styles: transitionStyles } = useTransitionStyles(context, {
    duration: TRANSITION_MS,
    initial: { opacity: 0, transform: 'scale(0.96)' },
  });

  // Floating-UI's useId can be undefined on the first SSR pass; fall back so
  // the context (which requires `string`) always has a value.
  const autoLabelId = useId() ?? '';
  const labelledBy = ariaLabelledBy ?? autoLabelId;

  if (!isMounted) return null;

  const zIndex = BASE_MODAL_Z + stackIndex * STACK_Z_STEP;

  return (
    <FloatingPortal id="modal-root">
      <ModalLabelIdContext.Provider value={labelledBy}>
        <ModalCloseContext.Provider value={onClose}>
          <FloatingOverlay
            lockScroll
            style={{
              zIndex,
              background: 'rgba(5, 6, 9, 0.72)',
              backdropFilter: 'blur(6px)',
              WebkitBackdropFilter: 'blur(6px)',
              display: 'flex',
              alignItems: anchor === 'top' ? 'flex-start' : 'center',
              justifyContent: 'center',
              padding: anchor === 'top' ? `${topOffset}px 16px 16px` : 16,
              opacity: transitionStyles.opacity,
              transition: `opacity ${TRANSITION_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`,
            }}
          >
            <FloatingFocusManager
              context={context}
              modal
              initialFocus={initialFocus ?? 0}
              returnFocus
            >
              <div
                ref={refs.setFloating}
                {...getFloatingProps()}
                aria-modal
                aria-label={ariaLabelledBy ? undefined : ariaLabel}
                aria-labelledby={ariaLabelledBy ?? undefined}
                style={{
                  width: resolveSize(size),
                  maxHeight:
                    anchor === 'top'
                      ? `calc(100vh - ${topOffset + 16}px)`
                      : '88vh',
                  background: 'var(--bg-primary)',
                  color: 'var(--text-primary)',
                  border: '1px solid var(--border)',
                  display: 'flex',
                  flexDirection: 'column',
                  minHeight: 0,
                  position: 'relative',
                  overflow: 'hidden',
                  boxShadow: '0 24px 60px rgba(0, 0, 0, 0.5)',
                  outline: 'none',
                  transform: transitionStyles.transform,
                  transition: `transform ${TRANSITION_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`,
                  ...cardStyle,
                }}
                className={cardClassName}
              >
                {children}
              </div>
            </FloatingFocusManager>
          </FloatingOverlay>
        </ModalCloseContext.Provider>
      </ModalLabelIdContext.Provider>
    </FloatingPortal>
  );
}

// Internal contexts — let `<Modal.Header>` reach the auto-generated aria-
// labelledby id and the onClose handler without prop-drilling.
const ModalLabelIdContext = React.createContext<string>('');
const ModalCloseContext = React.createContext<() => void>(() => {
  /* noop */
});

/**
 * Sticky header. Sets the dialog's `aria-labelledby` to its own id so screen
 * readers announce the heading. Includes a close button on the right unless
 * `hideClose` is set.
 */
function ModalHeader({
  children,
  hideClose,
  closeLabel = 'Close · Esc',
}: {
  children: React.ReactNode;
  hideClose?: boolean;
  closeLabel?: string;
}): React.ReactElement {
  const labelId = React.useContext(ModalLabelIdContext);
  const onClose = React.useContext(ModalCloseContext);
  return (
    <div
      style={{
        position: 'sticky',
        top: 0,
        background: 'var(--bg-primary)',
        borderBottom: '1px solid var(--border)',
        padding: '14px 20px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        zIndex: 1,
        flexShrink: 0,
      }}
    >
      <div
        id={labelId}
        style={{
          fontFamily: 'var(--font-heading)',
          fontWeight: 800,
          fontSize: 16,
          letterSpacing: '-0.02em',
          color: 'var(--text-primary)',
          textTransform: 'uppercase',
        }}
      >
        {children}
      </div>
      {!hideClose && (
        <button
          data-id="modal-header-close"
          type="button"
          onClick={onClose}
          aria-label="Close dialog"
          style={{
            fontFamily: 'var(--font-label)',
            fontSize: 10.5,
            fontWeight: 700,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: 'var(--text-secondary)',
            background: 'transparent',
            border: '1px solid var(--border)',
            padding: '5px 11px',
            cursor: 'pointer',
          }}
        >
          {closeLabel}
        </button>
      )}
    </div>
  );
}

/** Scrollable body region. Takes whatever vertical space the header/footer leave. */
function ModalBody({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
}): React.ReactElement {
  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        overflow: 'auto',
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** Right-aligned footer (button row). */
function ModalFooter({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div
      style={{
        padding: '14px 20px',
        borderTop: '1px solid var(--border)',
        background: 'var(--bg-panel)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: 12,
        flexShrink: 0,
      }}
    >
      {children}
    </div>
  );
}

Modal.Header = ModalHeader;
Modal.Body = ModalBody;
Modal.Footer = ModalFooter;
