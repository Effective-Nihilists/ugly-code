import React from 'react';

/**
 * Empty portal target for `<Modal>` instances. Mounted exactly once by
 * `AppProvider`, BEFORE `PopoverHost` in the sibling chain — popovers paint
 * above modals via DOM order alone (a `<Popover>` opened from inside a
 * `<Modal>` is always visible).
 *
 * `<Modal>` renders into this element via `<FloatingPortal id="modal-root">`.
 */
export function ModalHost(): React.ReactElement {
  return <div id="modal-root" />;
}
