import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from 'react';
import { EditorState, Compartment } from '@codemirror/state';
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  hoverTooltip,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { searchKeymap } from '@codemirror/search';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { markdown } from '@codemirror/lang-markdown';
import { oneDark } from '@codemirror/theme-one-dark';
import { useTheme } from '../theme/ThemeProvider';
import { languageForPath, type CmLanguage, type EditorPos } from './editorLsp';

export interface CmEditorHandle {
  revealLine(line1: number): void;
}

interface Props {
  path: string;
  value: string;
  onChange(next: string): void;
  onSave(): void;
  onDefinition(pos: EditorPos): void;
  onImplementation(pos: EditorPos): void;
  onReferences(pos: EditorPos): void;
  hoverAt(pos: EditorPos): Promise<string | null>;
  readOnly?: boolean;
}

function langExt(lang: CmLanguage | null) {
  switch (lang) {
    case 'javascript':
      return [javascript({ typescript: true, jsx: true })];
    case 'python':
      return [python()];
    case 'css':
      return [css()];
    case 'html':
      return [html()];
    case 'markdown':
      return [markdown()];
    default:
      return [];
  }
}

/** CM offset → 0-indexed LSP position. */
function posAt(view: EditorView, offset: number): EditorPos {
  const line = view.state.doc.lineAt(offset);
  return { line: line.number - 1, character: offset - line.from };
}

export const CodeMirrorFileEditor = forwardRef<CmEditorHandle, Props>(
  function CodeMirrorFileEditor(props, ref) {
    const host = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const theme = useRef(new Compartment());
    const { mode } = useTheme();
    // Keep the latest callbacks reachable from the (once-built) keymap.
    const cb = useRef(props);
    cb.current = props;

    useImperativeHandle(
      ref,
      () => ({
        revealLine(line1: number) {
          const v = viewRef.current;
          if (!v) return;
          const line = v.state.doc.line(
            Math.max(1, Math.min(line1, v.state.doc.lines)),
          );
          v.dispatch({
            selection: { anchor: line.from },
            effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
          });
          v.focus();
        },
      }),
      [],
    );

    // Build the view once per file (path change) — value updates dispatched below.
    useEffect(() => {
      if (!host.current) return;
      const posOf = (v: EditorView): EditorPos =>
        posAt(v, v.state.selection.main.head);
      const state = EditorState.create({
        doc: props.value,
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          history(),
          keymap.of([
            {
              key: 'Mod-s',
              preventDefault: true,
              run: () => {
                cb.current.onSave();
                return true;
              },
            },
            {
              key: 'F12',
              preventDefault: true,
              run: (v) => {
                cb.current.onDefinition(posOf(v));
                return true;
              },
            },
            {
              key: 'Mod-F12',
              preventDefault: true,
              run: (v) => {
                cb.current.onImplementation(posOf(v));
                return true;
              },
            },
            {
              key: 'Shift-F12',
              preventDefault: true,
              run: (v) => {
                cb.current.onReferences(posOf(v));
                return true;
              },
            },
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
          ]),
          ...langExt(languageForPath(props.path)),
          hoverTooltip(async (v, pos) => {
            const text = await cb.current.hoverAt(posAt(v, pos));
            if (!text) return null;
            return {
              pos,
              create: () => {
                const dom = document.createElement('div');
                dom.className = 'cm-lsp-hover';
                dom.textContent = text;
                dom.style.cssText =
                  'padding:6px 8px;max-width:520px;white-space:pre-wrap;font-family:var(--font-mono);font-size:12px';
                return { dom };
              },
            };
          }),
          theme.current.of(mode === 'dark' ? oneDark : []),
          EditorView.editable.of(!props.readOnly),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) cb.current.onChange(u.state.doc.toString());
          }),
        ],
      });
      const view = new EditorView({ state, parent: host.current });
      viewRef.current = view;
      return () => {
        view.destroy();
        viewRef.current = null;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps -- rebuild only on file switch
    }, [props.path]);

    // External value change (reload) → replace the doc when it diverges.
    useEffect(() => {
      const v = viewRef.current;
      if (v && props.value !== v.state.doc.toString()) {
        v.dispatch({
          changes: { from: 0, to: v.state.doc.length, insert: props.value },
        });
      }
    }, [props.value]);

    // Theme toggle without rebuilding the view.
    useEffect(() => {
      viewRef.current?.dispatch({
        effects: theme.current.reconfigure(mode === 'dark' ? oneDark : []),
      });
    }, [mode]);

    return (
      <div
        ref={host}
        data-id="code-editor"
        style={{ flex: 1, minHeight: 0, overflow: 'auto' }}
      />
    );
  },
);
