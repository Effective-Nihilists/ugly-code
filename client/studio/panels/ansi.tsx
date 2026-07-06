import React from 'react';

// Minimal ANSI SGR (color) support for the dev-server log view. The dev server is
// spawned with FORCE_COLOR=1, so its output carries `\x1b[..m` color codes; we
// render them as styled spans (and strip them where we only need plain text, e.g.
// the "server ready" marker match).

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Remove all ANSI SGR escape codes — for regex matching on log text. */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

// Standard + bright 16-color palette (terminal-ish, tuned for a dark log panel).
const FG: Record<number, string> = {
  30: '#666', 31: '#f14c4c', 32: '#23d18b', 33: '#e5e510', 34: '#3b8eea',
  35: '#d670d6', 36: '#29b8db', 37: '#e5e5e5',
  90: '#888', 91: '#f14c4c', 92: '#23d18b', 93: '#f5f543', 94: '#3b8eea',
  95: '#d670d6', 96: '#29b8db', 97: '#fff',
};

interface Style { color?: string; fontWeight?: number; opacity?: number }

function applyCode(style: Style, code: number): Style {
  if (code === 0) return {}; // reset
  if (code === 1) return { ...style, fontWeight: 700 };
  if (code === 2) return { ...style, opacity: 0.7 };
  if (code === 22) { const { fontWeight, opacity, ...rest } = style; void fontWeight; void opacity; return rest; }
  if (code === 39) { const { color, ...rest } = style; void color; return rest; }
  if (FG[code]) return { ...style, color: FG[code] };
  return style; // ignore bg / unsupported
}

/** Parse ANSI-colored text into styled spans. */
export function ansiToNodes(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let style: Style = {};
  let last = 0;
  let key = 0;
  const push = (chunk: string): void => {
    if (!chunk) return;
    nodes.push(
      Object.keys(style).length
        ? <span key={key++} style={style}>{chunk}</span>
        : <React.Fragment key={key++}>{chunk}</React.Fragment>,
    );
  };
  for (const m of text.matchAll(ANSI_RE)) {
    const idx = m.index;
    if (idx > last) push(text.slice(last, idx));
    const codes = m[0].slice(2, -1).split(';').map((n) => (n === '' ? 0 : Number(n)));
    for (const c of codes) style = applyCode(style, c);
    last = idx + m[0].length;
  }
  if (last < text.length) push(text.slice(last));
  return nodes;
}
