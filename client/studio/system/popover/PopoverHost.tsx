import React from 'react';

/**
 * Empty portal target for `<Popover>` instances. Mounted exactly once by
 * `AppProvider`, AFTER `ModalHost` in the sibling chain — so popovers paint
 * above modals via DOM order alone, with no z-index arithmetic.
 *
 * `<Popover>` renders into this element via `<FloatingPortal id="popover-root">`.
 */
export function PopoverHost(): React.ReactElement {
  return <div id="popover-root" />;
}
