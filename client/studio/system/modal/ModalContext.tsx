import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react';
import type React from 'react';

/**
 * Per-modal handle managed by `<Modal>`. The host portal renders nothing on
 * its own — each open modal still owns its DOM tree (backdrop + card) and
 * appears via React portal directly into the `#modal-root` host. The stack
 * just hands each modal a `stackIndex` so z-indices can climb deterministically
 * when modals are layered (Settings → SubscriptionHub).
 */
export interface ModalStackEntry {
  id: string;
}

interface ModalStackApi {
  register(): { id: string; release: () => void };
  /** All open modals in mount order. Index in this array is the stackIndex. */
  stack: ModalStackEntry[];
}

const ModalStackContext = createContext<ModalStackApi | null>(null);

export function ModalStackProvider({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  const [stack, setStack] = useState<ModalStackEntry[]>([]);
  const idCounter = useRef(0);

  const register = useCallback<ModalStackApi['register']>(() => {
    idCounter.current += 1;
    const id = `modal-${idCounter.current}`;
    setStack((s) => [...s, { id }]);
    const release = (): void => {
      setStack((s) => s.filter((entry) => entry.id !== id));
    };
    return { id, release };
  }, []);

  const value = useMemo<ModalStackApi>(
    () => ({ register, stack }),
    [register, stack],
  );

  return (
    <ModalStackContext.Provider value={value}>
      {children}
    </ModalStackContext.Provider>
  );
}

export function useModalStack(): ModalStackApi {
  const ctx = useContext(ModalStackContext);
  if (!ctx) {
    throw new Error('useModalStack must be used inside <AppProvider>');
  }
  return ctx;
}

/**
 * Modal count refcount — preserved from the legacy ModalRegistry API. Chrome
 * (StudioTopBar nav buttons) gates on this so it can disable while any modal
 * is mounted. Derived from the stack length so callers don't have to register
 * twice.
 */
export function useAnyModalOpen(): boolean {
  const ctx = useContext(ModalStackContext);
  return (ctx?.stack.length ?? 0) > 0;
}

/**
 * Legacy back-compat shim — old `useRegisterModal(open)` API. New callers
 * should mount `<Modal>` instead; this exists only so non-migrated callers
 * (if any survive) keep working during the transition. Marks itself in the
 * stack while `open` is true.
 */
import { useEffect } from 'react';
export function useRegisterModal(open: boolean): void {
  const ctx = useContext(ModalStackContext);
  useEffect(() => {
    if (!open || !ctx) return;
    const handle = ctx.register();
    return handle.release;
  }, [open, ctx]);
}
