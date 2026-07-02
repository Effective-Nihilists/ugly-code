// Pure helpers for the custom file/folder picker (FilePicker.tsx). Kept separate from the
// React component so the navigation + filtering logic is unit-testable. Paths are treated
// as plain strings (the desktop fs resolves '~'); folders are always shown so the user can
// navigate into them, files only when the mode allows.
import type { HostDirent } from 'ugly-app/native';

export type PickMode = 'folder' | 'file' | 'both';

export interface PickEntry {
  name: string;
  isDirectory: boolean;
}

/**
 * The initial directory to open. The host expands a leading '~' to its home dir, so
 * '~'-based paths (e.g. the default '~/Documents/Ugly Studio') pass through; an empty start
 * defaults to the host home. The picker falls back to '~' then '/' if a path can't be read.
 */
export function resolveStart(startPath?: string): string {
  return startPath?.trim() ? startPath : '~';
}

/** Go up one directory, preserving a leading '~' or '/'. Root paths return themselves. */
export function parentPath(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  if (trimmed === '') return '/'; // path was '/' (all slashes) → stay at root
  const idx = trimmed.lastIndexOf('/');
  if (idx < 0) return trimmed; // '~' or a bare segment — already at top
  if (idx === 0) return '/'; // '/foo' → '/'
  return trimmed.slice(0, idx);
}

/** Join a directory and an entry name into a path. */
export function joinPath(dir: string, name: string): string {
  return `${dir.replace(/\/+$/, '')}/${name}`;
}

/** The last segment of a path (for display). */
export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx >= 0 ? trimmed.slice(idx + 1) || '/' : trimmed;
}

/** A file name matches when no extensions are given, or it ends with one of them. */
export function matchesExtension(name: string, extensions?: string[]): boolean {
  if (!extensions || extensions.length === 0) return true;
  const lower = name.toLowerCase();
  return extensions.some((ext) => {
    const e = ext.toLowerCase();
    return lower.endsWith(e.startsWith('.') ? e : `.${e}`);
  });
}

/**
 * Folders first (always — they're navigable regardless of mode), then files when the mode
 * permits, filtered by extension. Dot-entries are hidden unless `showHidden`. Each group is
 * sorted case-insensitively.
 */
export function filterEntries(
  entries: HostDirent[],
  mode: PickMode,
  extensions: string[] | undefined,
  showHidden: boolean,
): PickEntry[] {
  const visible = entries.filter((e) => showHidden || !e.name.startsWith('.'));
  const folders = visible
    .filter((e) => e.isDirectory)
    .sort((a, b) => a.name.localeCompare(b.name));
  const files =
    mode === 'folder'
      ? []
      : visible
          .filter((e) => e.isFile && matchesExtension(e.name, extensions))
          .sort((a, b) => a.name.localeCompare(b.name));
  return [...folders, ...files].map((e) => ({ name: e.name, isDirectory: e.isDirectory }));
}
