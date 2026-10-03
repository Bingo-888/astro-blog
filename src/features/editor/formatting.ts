import { isolateHistory } from '@codemirror/commands';
import { ensureSyntaxTree } from '@codemirror/language';
import { type ChangeSpec, EditorSelection, type EditorState, type SelectionRange, type StateCommand } from '@codemirror/state';
import { parseEditorDocument } from './document';

export const toolbarFormats = ['bold', 'italic', 'heading', 'link', 'image', 'note', 'code', 'formula'] as const;
export type EditorFormat = (typeof toolbarFormats)[number];
type Edit = { changes?: ChangeSpec; range: SelectionRange };

function selection(range: SelectionRange, from: number, to: number) {
  return range.anchor > range.head ? EditorSelection.range(to, from) : EditorSelection.range(from, to);
}

function replace(state: EditorState, range: SelectionRange, text: string, start: number, length: number): Edit {
  return {
    changes: { from: range.from, to: range.to, insert: state.toText(text.replace(/\n/g, state.lineBreak)) },
    range: selection(range, range.from + start, range.from + start + length),
  };
}

function unwrapInline(state: EditorState, range: SelectionRange, name: string): Edit | undefined {
  const tree = ensureSyntaxTree(state, range.to, 50);
  for (let outer = tree?.resolveInner(range.from, 1) ?? null; outer; outer = outer.parent) {
    let node = outer;
    if (node.name !== name && range.from === node.from && range.to === node.to) {
      while (['Emphasis', 'StrongEmphasis'].includes(node.name) && node.name !== name) {
        const inner = node.firstChild?.nextSibling;
        if (!inner || inner.from !== node.firstChild?.to || inner.to !== node.lastChild?.from) break;
        node = inner;
      }
    }
    if (node.name !== name) continue;
    const open = node.firstChild;
    const close = node.lastChild;
    if (!open || !close || open === close) continue;
    let from = open.to;
    let to = close.from;
    if (name === 'InlineCode') {
      const content = state.doc.sliceString(from, to);
      if (content.startsWith(' ') && content.endsWith(' ') && content.trim()) {
        from++;
        to--;
      }
    }
    let inner = open.nextSibling;
    // Nested bold/italic can share a *** delimiter run; use the parser's boundaries.
    while (inner && inner.to === close.from && ['Emphasis', 'StrongEmphasis'].includes(inner.name)) {
      from = inner.firstChild?.to ?? from;
      to = inner.lastChild?.from ?? to;
      inner = inner.firstChild?.nextSibling ?? null;
    }
    if (
      range.empty
        ? range.from < from || range.to > to
        : ((range.from < node.from || range.to > node.to) && !(range.from === outer.from && range.to === outer.to)) ||
          range.from > from ||
          range.to < to
    )
      continue;
    // Remove only this format's markers, preserving nested formats and the source selection.
    const contentFrom = name === 'InlineCode' ? from : open.to;
    const contentTo = name === 'InlineCode' ? to : close.from;
    const changes = state.changes([
      { from: node.from, to: contentFrom },
      { from: contentTo, to: node.to },
    ]);
    return { changes, range: range.map(changes) };
  }
}

function inline(state: EditorState, range: SelectionRange, action: 'bold' | 'italic' | 'code' | 'formula'): Edit {
  const nodeName = { bold: 'StrongEmphasis', italic: 'Emphasis', code: 'InlineCode', formula: '' }[action];
  const unwrapped = nodeName && unwrapInline(state, range, nodeName);
  if (unwrapped) return unwrapped;
  const selected = state.doc.sliceString(range.from, range.to);
  const placeholders = { bold: '重点文字', italic: '强调文字', code: '代码', formula: 'E = mc^2' };
  const before = action === 'code' ? '' : (selected.match(/^\s*/)?.[0] ?? '');
  const after = action === 'code' || !selected.trim() ? '' : (selected.match(/\s*$/)?.[0] ?? '');
  const content = (action === 'code' ? selected : selected.trim()) || placeholders[action];
  let mark = { bold: '**', italic: '*', code: '`', formula: '$' }[action];
  if (action === 'code') {
    const longest = Math.max(0, ...Array.from(content.matchAll(/`+/g), (match) => match[0].length));
    mark = '`'.repeat(longest + 1);
  }
  if (action === 'formula') {
    const surrounds =
      state.doc.sliceString(range.from - 1, range.from) === '$' && state.doc.sliceString(range.to, range.to + 1) === '$';
    const escaped = range.from > 1 && state.doc.sliceString(range.from - 2, range.from - 1) === '\\';
    const display =
      state.doc.sliceString(range.from - 2, range.from) === '$$' || state.doc.sliceString(range.to, range.to + 2) === '$$';
    if (surrounds && !escaped && !display) {
      const changes = state.changes([
        { from: range.from - 1, to: range.from },
        { from: range.to, to: range.to + 1 },
      ]);
      return { changes, range: range.map(changes) };
    }
    if (content.startsWith('$') && content.endsWith('$') && !content.startsWith('$$') && content.length > 2)
      return replace(state, range, `${before}${content.slice(1, -1)}${after}`, before.length, content.length - 2);
  }
  const pad =
    action === 'code' &&
    (content.startsWith('`') || content.endsWith('`') || (content.startsWith(' ') && content.endsWith(' ') && content.trim()))
      ? ' '
      : '';
  const prefix = `${before}${mark}${pad}`;
  return replace(state, range, `${prefix}${content}${pad}${mark}${after}`, prefix.length, content.length);
}

function emphasis(state: EditorState, range: SelectionRange, action: 'bold' | 'italic'): Edit {
  const unwrapped = unwrapInline(state, range, action === 'bold' ? 'StrongEmphasis' : 'Emphasis');
  if (unwrapped) return unwrapped;
  const text = state.doc.sliceString(range.from, range.to);
  if (!text.includes('\n')) return inline(state, range, action);
  const edits: ChangeSpec[] = [];
  let offset = range.from;
  for (const line of text.split('\n')) {
    if (line.trim()) {
      const edit = inline(state, EditorSelection.range(offset, offset + line.length), action);
      if (edit.changes) edits.push(edit.changes);
    }
    offset += line.length + 1;
  }
  const changes = state.changes(edits);
  return {
    changes,
    range: selection(range, changes.mapPos(range.from, 1), changes.mapPos(range.to, -1)),
  };
}

function blockMarkersMatch(action: 'note' | 'code' | 'formula', open: string, close: string) {
  if (action === 'note') return open === ':::info' && close === ':::';
  if (action === 'formula') return open === '$$' && close === '$$';
  return /^`{3,}[^`]*$/.test(open) && close === open.match(/^`+/)?.[0];
}

function unwrapBlock(state: EditorState, range: SelectionRange, action: 'note' | 'code' | 'formula'): Edit | undefined {
  const selected = state.doc.sliceString(range.from, range.to).split('\n');
  if (selected.length >= 3 && blockMarkersMatch(action, selected[0], selected[selected.length - 1])) {
    const text = selected.slice(1, -1).join('\n');
    return replace(state, range, text, 0, text.length);
  }
  const first = state.doc.lineAt(range.from);
  const last = state.doc.lineAt(range.to);
  if (range.from === first.from && range.to === last.to && first.number > 1 && last.number < state.doc.lines) {
    const open = state.doc.line(first.number - 1);
    const close = state.doc.line(last.number + 1);
    const matches = blockMarkersMatch(action, open.text, close.text);
    if (matches) {
      const changes = state.changes([
        { from: open.from, to: first.from },
        { from: last.to, to: close.to },
      ]);
      return { changes, range: range.map(changes) };
    }
  }
  return undefined;
}

function block(state: EditorState, range: SelectionRange, action: 'note' | 'code' | 'formula'): Edit {
  const text = state.doc.sliceString(range.from, range.to) || { note: '补充说明', code: '代码', formula: 'E = mc^2' }[action];
  const fence = '`'.repeat(Math.max(3, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length + 1)));
  const open = { note: ':::info', code: fence, formula: '$$' }[action];
  const close = { note: ':::', code: fence, formula: '$$' }[action];
  const prefix = `${range.from > 0 && state.doc.sliceString(range.from - 1, range.from) !== '\n' ? '\n' : ''}${open}\n`;
  const suffix = `\n${close}${range.to < state.doc.length && state.doc.sliceString(range.to, range.to + 1) !== '\n' ? '\n' : ''}`;
  return replace(state, range, `${prefix}${text}${suffix}`, prefix.length, text.length);
}

function link(state: EditorState, range: SelectionRange, image: boolean): Edit {
  const tree = ensureSyntaxTree(state, range.to, 50);
  for (let node = tree?.resolveInner(range.from, 1) ?? null; node; node = node.parent) {
    if (node.name !== (image ? 'Image' : 'Link') || range.to > node.to) continue;
    const url = node.getChild('URL');
    if (url) return { range: EditorSelection.range(url.from, url.to) };
  }
  const text = state.doc.sliceString(range.from, range.to);
  const isURL = /^https?:\/\/\S+$/i.test(text);
  const label = (text && !isURL ? text : image ? '描述图片内容' : '链接文字').replace(/[\\[\]]/g, '\\$&');
  const url = (isURL ? text : image ? 'https://example.com/image.webp' : 'https://example.com').replace(/[\\()]/g, '\\$&');
  const prefix = `${image ? '!' : ''}[`;
  const value = `${prefix}${label}](${url})`;
  return replace(
    state,
    range,
    value,
    text && !isURL ? prefix.length + label.length + 2 : prefix.length,
    text && !isURL ? url.length : label.length,
  );
}

function heading(state: EditorState) {
  const lines = new Set<number>();
  for (const range of state.selection.ranges) {
    const last = state.doc.lineAt(range.empty ? range.to : range.to - 1).number;
    for (let number = state.doc.lineAt(range.from).number; number <= last; number++) lines.add(number);
  }
  const content = [...lines].map((number) => state.doc.line(number));
  const remove = content.filter((line) => line.text.trim()).every((line) => /^##[ \t]+/.test(line.text));
  const edits = content.flatMap((line) => {
    if (!line.text.trim()) {
      return state.selection.ranges.some((range) => range.empty && state.doc.lineAt(range.from).number === line.number)
        ? [{ from: line.from, to: line.to, insert: '## 小节标题' }]
        : [];
    }
    const existing = line.text.match(/^#{1,6}[ \t]+/)?.[0] ?? '';
    return [{ from: line.from, to: line.from + existing.length, insert: remove ? '' : '## ' }];
  });
  const changes = state.changes(edits);
  const ranges = state.selection.ranges.map((range) => {
    const line = state.doc.lineAt(range.from);
    if (range.empty && !line.text.trim()) {
      const from = changes.mapPos(line.from, -1) + 3;
      return EditorSelection.range(from, from + '小节标题'.length);
    }
    return range.map(changes);
  });
  return { changes, selection: EditorSelection.create(ranges, state.selection.mainIndex) };
}

export function formatEditorSelection(target: Parameters<StateCommand>[0], action: EditorFormat): boolean {
  const { state } = target;
  if (state.readOnly) return false;
  const source = state.doc.toString();
  const bodyStart = source.length - parseEditorDocument(source).body.length;
  if (state.selection.ranges.some((range) => range.from < bodyStart)) return false;
  const edits =
    action === 'heading'
      ? heading(state)
      : state.changeByRange((range) => {
          if (action === 'bold' || action === 'italic') return emphasis(state, range, action);
          if (action === 'link' || action === 'image') return link(state, range, action === 'image');
          const unwrapped = unwrapBlock(state, range, action);
          if (unwrapped) return unwrapped;
          if (action === 'note' || state.doc.sliceString(range.from, range.to).includes('\n'))
            return block(state, range, action);
          return inline(state, range, action);
        });
  target.dispatch(
    state.update({ ...edits, userEvent: 'input.format', annotations: isolateHistory.of('full'), scrollIntoView: true }),
  );
  return true;
}
