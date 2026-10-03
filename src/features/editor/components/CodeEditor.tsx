import { defaultKeymap, history, historyKeymap, redo, undo } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, placeholder } from '@codemirror/view';
import { type Ref, useEffect, useImperativeHandle, useRef } from 'react';
import { parseEditorDocument } from '../document';

export interface CodeEditorHandle {
  insert: (source: string) => void;
  undo: () => void;
  redo: () => void;
  focus: () => void;
}

interface Props {
  source: string;
  draftId: string;
  onChange: (source: string) => void;
  ref?: Ref<CodeEditorHandle>;
}

export default function CodeEditor({ source, draftId, onChange, ref }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const change = useRef(onChange);
  change.current = onChange;
  const initial = useRef(source);
  initial.current = source;

  useEffect(() => {
    if (!container.current) return;
    container.current.dataset.draftId = draftId;
    const editor = new EditorView({
      parent: container.current,
      state: EditorState.create({
        doc: initial.current,
        selection: {
          anchor: initial.current
            .slice(0, initial.current.length - parseEditorDocument(initial.current).body.length)
            .replace(/\r\n/g, '\n').length,
        },
        extensions: [
          EditorState.lineSeparator.of(initial.current.includes('\r\n') ? '\r\n' : '\n'),
          markdown(),
          history(),
          lineNumbers(),
          syntaxHighlighting(defaultHighlightStyle),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorView.lineWrapping,
          placeholder('写下你的想法…'),
          EditorView.contentAttributes.of({ 'aria-label': 'Markdown 源码', spellcheck: 'false', autocapitalize: 'off' }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) change.current(update.state.sliceDoc());
          }),
          EditorView.theme({
            '&': { height: '100%' },
            '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--editor-mono)' },
            '.cm-content': { padding: '22px 18px', fontSize: 'var(--editor-code-size, 15px)', lineHeight: '1.85' },
            '.cm-content span': { textDecoration: 'none' },
            '.cm-gutters': { background: 'transparent', border: 'none', color: 'hsl(var(--muted-foreground) / .45)' },
            '&.cm-focused': { outline: 'none' },
            '.cm-cursor': { borderLeftColor: 'hsl(var(--primary))' },
          }),
        ],
      }),
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
  }, [draftId]);

  useEffect(() => {
    const editor = view.current;
    if (editor && editor.state.sliceDoc() !== source)
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: source } });
  }, [source]);

  useImperativeHandle(
    ref,
    () => ({
      insert: (text) => {
        const editor = view.current;
        if (!editor) return;
        const normalized = text.replace(/\r?\n/g, editor.state.lineBreak);
        if (text.includes('\n')) {
          const source = editor.state.doc.toString();
          const bodyStart = source.length - parseEditorDocument(source).body.length;
          if (editor.state.selection.main.from < bodyStart) editor.dispatch({ selection: { anchor: bodyStart } });
          const position = editor.state.selection.main.from;
          const prefix =
            position > 0 && editor.state.doc.sliceString(position - 1, position) !== '\n' ? editor.state.lineBreak : '';
          const suffix = normalized.endsWith(editor.state.lineBreak) ? '' : editor.state.lineBreak;
          editor.dispatch(editor.state.replaceSelection(`${prefix}${normalized}${suffix}`));
        } else editor.dispatch(editor.state.replaceSelection(normalized));
        editor.focus();
      },
      undo: () => {
        if (view.current) undo(view.current);
      },
      redo: () => {
        if (view.current) redo(view.current);
      },
      focus: () => view.current?.focus(),
    }),
    [],
  );

  return <div ref={container} className="editor-code" />;
}
