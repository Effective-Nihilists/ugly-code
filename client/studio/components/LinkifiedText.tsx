import {
  createContext,
  useContext,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from 'react';

/**
 * Open-URI context. Editor.tsx supplies a handler that routes file://
 * + bare absolute paths to the file panel and http(s):// to the OS
 * browser. Optional — when absent, MdastViewer falls back to its
 * default `window.open` behavior.
 */
export const OpenUriContext = createContext<
  ((uri: string) => void) | undefined
>(undefined);

export const ChatOpenUriProvider = OpenUriContext.Provider;

// Shared regex for URL + absolute-path detection. Built as a string so
// `linkifyProse` (markdown replace) and `LinkifiedText` (React node
// walk) get fresh stateful instances — global regexes can't share
// `lastIndex` across `replace`/`exec` callers.
//
// Branches (capture groups in order):
//   1. URL   — http(s):// or file://
//   2. dq    — inner of "..." absolute path (quotes excluded)
//   3. sq    — inner of '...' absolute path
//   4. bare  — bare absolute path
//   5/6.    — optional `:line[-end]` tail attached to the bare branch
//
// Path-name character class includes Unicode letters/numbers plus a
// curated set of ASCII filename chars that are unambiguous in chat
// prose. `( ) [ ] { } ' " ; : * ? < > | \` and backtick are
// deliberately excluded (markdown / quote / line-suffix collisions).
//
// Spaces are allowed inside a bare path only when the very next token
// ends in `/` or `.` (the user-stated rule), so `/foo bar.md` and
// `/Users/admin/Ugly Studio/chat` linkify, while `/foo and tell me`
// stops at `/foo`.
const PATH_NAME_CLASS = '[\\p{L}\\p{N}_+=,~@#$%&\\-\\/]';
const PATH_NAME_NO_SLASH = '[\\p{L}\\p{N}_+=,~@#$%&\\-]';
// `\\ ` (literal backslash + space) is the shell-style escape for a
// space inside a path. We accept it unconditionally inside the bare
// branch — the explicit escape is a strong signal of intent, no
// lookahead needed. The display + URI strip the backslash via
// `unescapePath`.
const LINKIFY_SOURCE =
  `(\\b(?:https?|file):\\/\\/[^\\s<>)\\]\\[]+)` +
  `|"(\\/[^"\\n]+?)"` +
  `|'(\\/[^'\\n]+?)'` +
  `|((?<![\\w/.])\\/(?:${PATH_NAME_CLASS}|\\.(?=${PATH_NAME_CLASS})| (?=${PATH_NAME_NO_SLASH}+[/.])|\\\\ )+)` +
  `(?::(\\d+)(?:-(\\d+))?)?`;

// Unescape shell-style `\ ` → ` ` for display + click-target URI.
export function unescapePath(p: string): string {
  return p.replace(/\\ /g, ' ');
}

export function newLinkifyRe(): RegExp {
  return new RegExp(LINKIFY_SOURCE, 'gu');
}

// Parse an optional `:line[-end]` suffix off a path captured inside
// quotes (the bare branch already separates these via capture groups).
export function splitLineSuffix(s: string): {
  path: string;
  line?: string;
  endLine?: string;
} {
  const m = /^(.+?)(?::(\d+)(?:-(\d+))?)?$/.exec(s);
  if (!m) return { path: s };
  return {
    // Group 1 (`.+?`) always participates when `m` matched, so it is a
    // guaranteed string here.
    path: m[1],
    ...(m[2] ? { line: m[2] } : {}),
    ...(m[3] ? { endLine: m[3] } : {}),
  };
}

export function lineSuffixOf(line?: string, endLine?: string): string {
  if (!line) return '';
  return `:${line}${endLine ? `-${endLine}` : ''}`;
}

// Skip linkifying a quoted path whose body contains markdown-breaking
// chars. The bare branch can't hit these (excluded from the class),
// but quoted captures accept anything between the quotes.
export function quotedPathLinkifyable(inner: string): boolean {
  if (/[\]`)]/.test(inner)) return false;
  const slashes = (inner.match(/\//g) ?? []).length;
  return slashes >= 2;
}

export function linkifyProse(prose: string): string {
  return prose.replace(
    newLinkifyRe(),
    (
      match: string,
      url: string | undefined,
      dqInner: string | undefined,
      sqInner: string | undefined,
      barePath: string | undefined,
      line: string | undefined,
      endLine: string | undefined,
    ) => {
      if (typeof url === 'string' && url.length > 0) {
        // Strip trailing sentence punctuation so "see https://x.com."
        // doesn't swallow the period into the link.
        const trail = /[.,;:!?'")\]]+$/.exec(url)?.[0] ?? '';
        const clean = trail.length > 0 ? url.slice(0, -trail.length) : url;
        return `[${clean}](${clean})${trail}`;
      }
      if (typeof dqInner === 'string') {
        const linked = makeQuotedMarkdownLink('"', dqInner);
        return linked ?? match;
      }
      if (typeof sqInner === 'string') {
        const linked = makeQuotedMarkdownLink("'", sqInner);
        return linked ?? match;
      }
      if (typeof barePath === 'string' && barePath.length > 0) {
        // Require depth ≥ 2 (`/a/b`) so we don't grab single-segment
        // tokens like `/etc` that more often appear as prose than as
        // openable files.
        const slashes = (barePath.match(/\//g) ?? []).length;
        if (slashes < 2) return match;
        const suffix = lineSuffixOf(line, endLine);
        const cleaned = unescapePath(barePath);
        return `[${cleaned}${suffix}](file://${cleaned}${suffix})`;
      }
      return match;
    },
  );
}

function makeQuotedMarkdownLink(quote: string, inner: string): string | null {
  if (!quotedPathLinkifyable(inner)) return null;
  const { path, line, endLine } = splitLineSuffix(inner);
  const suffix = lineSuffixOf(line, endLine);
  return `${quote}[${path}${suffix}](file://${path}${suffix})${quote}`;
}

// Inline counterpart of `autolinkChatMarkdown` for plain-text tool
// input/output blocks (bash output, python tracebacks, grep file
// headers, etc.). Splits the text on the same URL+path regex and
// returns a node array where each match becomes an <a> bound to
// `OpenUriContext.openUri`. Whitespace is preserved verbatim — drop
// the result inside a parent that already controls wrapping (`<pre>`
// or `whiteSpace: 'pre-wrap'`).
export function LinkifiedText({ text }: { text: string }): ReactElement {
  const openUri = useContext(OpenUriContext);
  if (!openUri || text.length === 0) return <>{text}</>;
  const parts: ReactNode[] = [];
  const re = newLinkifyRe();
  const pushPathLink = (
    key: string,
    path: string,
    suffix: string,
    bracketing: { open: string; close: string } | null,
  ) => {
    if (bracketing) parts.push(bracketing.open);
    const display = `${path}${suffix}`;
    const uri = `file://${path}${suffix}`;
    parts.push(
      <a
        key={key}
        data-id={`linkified-path-${key}`}
        href={uri}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          openUri(uri);
        }}
        style={inlineLinkStyle}
      >
        {display}
      </a>,
    );
    if (bracketing) parts.push(bracketing.close);
  };
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const url: string | undefined = m[1];
    const dqInner: string | undefined = m[2];
    const sqInner: string | undefined = m[3];
    const barePath: string | undefined = m[4];
    const line: string | undefined = m[5];
    const endLine: string | undefined = m[6];
    const key = `lk-${m.index}`;
    if (typeof url === 'string' && url.length > 0) {
      const trail = /[.,;:!?'")\]]+$/.exec(url)?.[0] ?? '';
      const clean = trail.length > 0 ? url.slice(0, -trail.length) : url;
      parts.push(
        <a
          key={key}
          data-id={`linkified-url-${key}`}
          href={clean}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            openUri(clean);
          }}
          style={inlineLinkStyle}
        >
          {clean}
        </a>,
      );
      if (trail.length > 0) parts.push(trail);
    } else if (typeof dqInner === 'string') {
      if (!quotedPathLinkifyable(dqInner)) {
        parts.push(m[0]);
      } else {
        const { path, line: ql, endLine: qe } = splitLineSuffix(dqInner);
        pushPathLink(key, path, lineSuffixOf(ql, qe), {
          open: '"',
          close: '"',
        });
      }
    } else if (typeof sqInner === 'string') {
      if (!quotedPathLinkifyable(sqInner)) {
        parts.push(m[0]);
      } else {
        const { path, line: ql, endLine: qe } = splitLineSuffix(sqInner);
        pushPathLink(key, path, lineSuffixOf(ql, qe), {
          open: "'",
          close: "'",
        });
      }
    } else if (typeof barePath === 'string' && barePath.length > 0) {
      const slashes = (barePath.match(/\//g) ?? []).length;
      if (slashes < 2) {
        parts.push(m[0]);
      } else {
        pushPathLink(
          key,
          unescapePath(barePath),
          lineSuffixOf(line, endLine),
          null,
        );
      }
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

export const inlineLinkStyle: CSSProperties = {
  color: 'var(--accent)',
  textDecoration: 'underline',
  textUnderlineOffset: 2,
  cursor: 'pointer',
};
