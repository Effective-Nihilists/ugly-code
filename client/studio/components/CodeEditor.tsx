/**
 * A lightweight syntax-highlighted code editor — a transparent <textarea> over a
 * highlighted <pre> underlay (the classic react-simple-code-editor technique), so
 * we get real editing (caret, selection, undo, IME) with token colors and zero
 * extra dependencies (highlight.js is already vendored for the File panel).
 *
 * Used for the Database panel's JSON document editor and the raw-SQL console.
 */

import { useLayoutEffect, useMemo, useRef } from 'react';
import hljs from 'highlight.js/lib/common';
import 'highlight.js/styles/github.css';

export type CodeLanguage = 'json' | 'sql';

interface CodeEditorProps {
  value: string;
  onChange?: (next: string) => void;
  language: CodeLanguage;
  minHeight?: number;
  maxHeight?: number;
  readOnly?: boolean;
  placeholder?: string;
  dataId?: string;
  /** Cmd/Ctrl+Enter (e.g. "run query"). */
  onSubmit?: () => void;
  /** A subtle red/green tint around the box (prod-write affordance). */
  accent?: 'danger' | 'none';
}

const FONT: React.CSSProperties = {
  fontFamily:
    'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
  fontSize: 12.5,
  lineHeight: 1.5,
  tabSize: 2,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  margin: 0,
  padding: 10,
  border: 0,
  boxSizing: 'border-box',
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function CodeEditor({
  value,
  onChange,
  language,
  minHeight = 120,
  maxHeight,
  readOnly,
  placeholder,
  dataId,
  onSubmit,
  accent = 'none',
}: CodeEditorProps) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const preRef = useRef<HTMLPreElement>(null);

  // Highlight (best-effort; a trailing newline needs a space so the last line
  // keeps its height under the textarea).
  const html = useMemo(() => {
    const src = value.endsWith('\n') ? value + ' ' : value;
    try {
      return hljs.highlight(src, { language }).value;
    } catch {
      return escapeHtml(src);
    }
  }, [value, language]);

  // Keep the highlighted underlay scroll-synced with the textarea.
  useLayoutEffect(() => {
    const ta = taRef.current;
    const pre = preRef.current;
    if (!ta || !pre) return;
    const sync = (): void => {
      pre.scrollTop = ta.scrollTop;
      pre.scrollLeft = ta.scrollLeft;
    };
    ta.addEventListener('scroll', sync);
    return () => {
      ta.removeEventListener('scroll', sync);
    };
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (onSubmit && (e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      onSubmit();
      return;
    }
    // Tab inserts two spaces instead of leaving the field.
    if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      const ta = e.currentTarget;
      const { selectionStart: s, selectionEnd: en } = ta;
      const next = value.slice(0, s) + '  ' + value.slice(en);
      onChange?.(next);
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = s + 2;
      });
    }
  };

  const border =
    accent === 'danger' ? 'var(--error, #dc2626)' : 'var(--border-primary)';

  return (
    <div
      data-id={dataId}
      style={{
        position: 'relative',
        minHeight,
        maxHeight,
        border: `1px solid ${border}`,
        borderRadius: 4,
        background: 'var(--bg-secondary)',
        overflow: 'hidden',
      }}
    >
      <pre
        ref={preRef}
        aria-hidden
        className="hljs"
        style={{
          ...FONT,
          position: 'absolute',
          inset: 0,
          overflow: 'auto',
          background: 'transparent',
          pointerEvents: 'none',
        }}
        dangerouslySetInnerHTML={{
          __html: html || (placeholder ? '' : '&nbsp;'),
        }}
      />
      <textarea
        ref={taRef}
        data-id={dataId ? `${dataId}-input` : undefined}
        value={value}
        readOnly={readOnly}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        placeholder={placeholder}
        onChange={(e) => onChange?.(e.target.value)}
        onKeyDown={onKeyDown}
        style={{
          ...FONT,
          position: 'relative',
          width: '100%',
          height: '100%',
          minHeight,
          maxHeight,
          resize: 'vertical',
          overflow: 'auto',
          background: 'transparent',
          color: 'transparent',
          caretColor: 'var(--text-primary)',
          outline: 'none',
        }}
      />
    </div>
  );
}
