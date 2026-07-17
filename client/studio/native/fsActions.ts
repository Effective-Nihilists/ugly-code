// Thin wrappers over two UglyNative channels that predate the installed ugly-app
// contract, so — like `recentProjects.ts:selfDevice` — we reach them through the
// low-level `invoke` escape hatch with a cast rather than the typed `native.*`
// facade.
//
//  • `system.revealPath` opens a path in Finder/Explorer on THIS device (the
//    `system` namespace is never proxied). Callers must only offer it for paths
//    that live on the same computer.
//  • `fs.trash` moves a file/folder to the OS Trash. It rides the proxied `fs`
//    namespace, so it reaches whichever host physically holds the path — deletes
//    work on remote/cross-device sessions too.

import { installUglyNative } from 'ugly-app/native';

function invoke(channel: string, payload?: unknown): Promise<unknown> {
  const native = installUglyNative();
  return (native.invoke as (c: string, p?: unknown) => Promise<unknown>)(
    channel,
    payload,
  );
}

/** Reveal a file (selected in its folder) or open a directory in the OS file manager. */
export function revealInFinder(path: string): Promise<unknown> {
  return invoke('system.revealPath', { path });
}

/** Move a file or folder to the OS Trash/Recycle Bin on its owning host. */
export function trashPath(path: string): Promise<unknown> {
  return invoke('fs.trash', { path });
}
