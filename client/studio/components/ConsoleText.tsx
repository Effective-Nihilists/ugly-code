import Anser from 'anser';
import { Fragment, type ComponentType, type CSSProperties } from 'react';

interface ConsoleTextProps {
  text: string;
  errorTone?: boolean;
  // Optional renderer for plain-text chunks. CodingAgentChat passes
  // its `LinkifiedText` here so file paths inside colored output stay
  // clickable. Surfaces without an OpenUri context (ProgressModal)
  // omit it and get raw text.
  TextComponent?: ComponentType<{ text: string }>;
}

const NAMED_ANSI = new Set([
  'ansi-black',
  'ansi-red',
  'ansi-green',
  'ansi-yellow',
  'ansi-blue',
  'ansi-magenta',
  'ansi-cyan',
  'ansi-white',
  'ansi-bright-black',
  'ansi-bright-red',
  'ansi-bright-green',
  'ansi-bright-yellow',
  'ansi-bright-blue',
  'ansi-bright-magenta',
  'ansi-bright-cyan',
  'ansi-bright-white',
]);

const NAMED_INDEX = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
];
const CUBE_LEVELS = [0, 95, 135, 175, 215, 255];

// xterm 256-color palette. 0-15 map to themed CSS vars so they track
// the active theme; 16-231 are the 6x6x6 RGB cube; 232-255 grayscale.
function paletteColor(n: number): string | undefined {
  if (n < 0 || n > 255) return undefined;
  if (n < 16) {
    const name = NAMED_INDEX[n % 8];
    const bright = n >= 8 ? 'bright-' : '';
    return `var(--ansi-${bright}${name})`;
  }
  if (n >= 232) {
    const level = 8 + (n - 232) * 10;
    return `rgb(${level}, ${level}, ${level})`;
  }
  const c = n - 16;
  const r = CUBE_LEVELS[Math.floor(c / 36)];
  const g = CUBE_LEVELS[Math.floor((c % 36) / 6)];
  const b = CUBE_LEVELS[c % 6];
  return `rgb(${r}, ${g}, ${b})`;
}

function resolveColor(
  name: string | null,
  truecolor: string | null,
): string | undefined {
  if (!name) return undefined;
  if (NAMED_ANSI.has(name)) return `var(--${name})`;
  if (name === 'ansi-truecolor' && truecolor) return `rgb(${truecolor})`;
  if (name.startsWith('ansi-palette-')) {
    const n = parseInt(name.slice('ansi-palette-'.length), 10);
    if (Number.isFinite(n)) return paletteColor(n);
  }
  return undefined;
}

function chunkStyle(
  chunk: Anser.AnserJsonEntry,
  errorTone: boolean,
): CSSProperties {
  const style: CSSProperties = {};
  const fg = resolveColor(chunk.fg, chunk.fg_truecolor);
  const bg = resolveColor(chunk.bg, chunk.bg_truecolor);
  if (fg) style.color = fg;
  else if (errorTone) style.color = 'var(--error)';
  if (bg) style.backgroundColor = bg;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- older anser builds omit `decorations` at runtime despite the type
  const decorations = chunk.decorations ?? [];
  if (decorations.includes('bold')) style.fontWeight = 600;
  if (decorations.includes('italic')) style.fontStyle = 'italic';
  if (decorations.includes('dim')) style.opacity = 0.7;
  const underline = decorations.includes('underline');
  const strike = decorations.includes('strikethrough');
  if (underline && strike) style.textDecoration = 'underline line-through';
  else if (underline) style.textDecoration = 'underline';
  else if (strike) style.textDecoration = 'line-through';
  return style;
}

export function ConsoleText({
  text,
  errorTone = false,
  TextComponent,
}: ConsoleTextProps) {
  if (text.length === 0) return null;
  const chunks = Anser.ansiToJson(text, {
    use_classes: true,
    remove_empty: true,
  });
  return (
    <>
      {chunks.map((chunk, i) => {
        if (!chunk.content) return null;
        const style = chunkStyle(chunk, errorTone);
        const inner = TextComponent ? (
          <TextComponent text={chunk.content} />
        ) : (
          chunk.content
        );
        if (Object.keys(style).length === 0) {
          return <Fragment key={i}>{inner}</Fragment>;
        }
        return (
          <span key={i} style={style}>
            {inner}
          </span>
        );
      })}
    </>
  );
}
