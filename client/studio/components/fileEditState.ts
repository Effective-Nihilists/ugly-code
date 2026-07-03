// Pure decisions for the file editor's dirty state + external (on-disk) changes.

export function isDirty(current: string, saved: string): boolean {
  return current !== saved;
}

/** What to do when the open file's on-disk mtime may have changed:
 *  - unchanged on disk → noop
 *  - changed + clean buffer → reload from disk
 *  - changed + unsaved edits → show the "changed on disk" banner (no clobber) */
export function externalChangeAction(opts: {
  dirty: boolean;
  mtimeChanged: boolean;
}): 'reload' | 'banner' | 'noop' {
  if (!opts.mtimeChanged) return 'noop';
  return opts.dirty ? 'banner' : 'reload';
}
