import React from 'react';
import { Modal } from './modal/Modal';

// A small confirm dialog over the shared Modal primitive, for destructive
// actions (delete file / folder / project). `onConfirm` may be async — while it
// runs the buttons disable and the confirm button shows `busyLabel`, and Escape/
// backdrop dismissal is suppressed so the op can't be half-cancelled. On success
// the dialog calls `onClose`; on failure it surfaces the error inline and stays
// open so the user can retry or cancel.

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Delete',
  busyLabel = 'Deleting…',
  cancelLabel = 'Cancel',
  danger = true,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
  busyLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
}): React.ReactElement | null {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Reset transient state each time the dialog (re)opens.
  React.useEffect(() => {
    if (open) {
      setBusy(false);
      setError(null);
    }
  }, [open]);

  const confirm = React.useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }, [onConfirm, onClose]);

  if (!open) return null;

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!busy) onClose();
      }}
      size="sm"
      closeOnEscape={!busy}
      closeOnBackdrop={!busy}
      ariaLabel={title}
    >
      <Modal.Header hideClose>{title}</Modal.Header>
      <Modal.Body style={{ padding: '18px 20px' }}>
        <div
          style={{
            fontSize: 14,
            lineHeight: 1.5,
            color: 'var(--text-primary)',
          }}
        >
          {message}
        </div>
        {error && (
          <div
            data-id="confirm-dialog-error"
            style={{
              marginTop: 12,
              fontSize: 12.5,
              color: 'var(--danger, #e5484d)',
            }}
          >
            {error}
          </div>
        )}
      </Modal.Body>
      <Modal.Footer>
        <button
          type="button"
          data-id="confirm-dialog-cancel"
          onClick={onClose}
          disabled={busy}
          style={{
            fontFamily: 'var(--font-label)',
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            color: 'var(--text-secondary)',
            background: 'transparent',
            border: '1px solid var(--border)',
            padding: '8px 14px',
            cursor: busy ? 'default' : 'pointer',
            opacity: busy ? 0.5 : 1,
          }}
        >
          {cancelLabel}
        </button>
        <button
          type="button"
          data-id="confirm-dialog-confirm"
          onClick={() => void confirm()}
          disabled={busy}
          style={{
            fontFamily: 'var(--font-label)',
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            color: '#fff',
            background: danger
              ? 'var(--danger, #e5484d)'
              : 'var(--accent, #FF5500)',
            border: 'none',
            padding: '8px 16px',
            cursor: busy ? 'default' : 'pointer',
            opacity: busy ? 0.7 : 1,
          }}
        >
          {busy ? busyLabel : confirmLabel}
        </button>
      </Modal.Footer>
    </Modal>
  );
}
