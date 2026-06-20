/**
 * Renderer-side OS detection + shortcut formatter. Studio is always
 * Electron so the UA reliably names the host OS; used to render
 * keyboard-shortcut hints in the host's native idiom (`⌘⏎` on Mac,
 * `Ctrl+Enter` on Windows/Linux — Win+Enter is OS-reserved by
 * Narrator so Windows users always get the Ctrl convention).
 */
export const isMac = /Mac|iPhone|iPad/i.test(navigator.userAgent);
export const isWindows = /Windows/i.test(navigator.userAgent);
export const isLinux = !isMac && !isWindows && /Linux/i.test(navigator.userAgent);

/**
 * Localized name of the host OS's file manager, used for context-menu
 * labels like "Reveal in <FileManager>". Mac → Finder, Windows →
 * Explorer, anything else → File Manager.
 */
export const fileManagerName: string = isMac
  ? 'Finder'
  : isWindows
    ? 'Explorer'
    : 'File Manager';

const MAC_GLYPHS: Record<string, string> = {
  Enter: '⏎',
  Shift: '⇧',
  Alt: '⌥',
  Ctrl: '⌃',
  Tab: '⇥',
};

/**
 * Format a Cmd/Ctrl-keyed shortcut. Keys are passed in order, e.g.
 * `shortcut('Shift', 'Enter')` → `⌘⇧⏎` on Mac, `Ctrl+Shift+Enter` on
 * Windows. Single-letter keys (`'A'`, `'T'`) pass through unchanged.
 */
export function shortcut(...keys: string[]): string {
  if (isMac) {
    return '⌘' + keys.map((k) => MAC_GLYPHS[k] ?? k).join('');
  }
  return 'Ctrl+' + keys.join('+');
}
