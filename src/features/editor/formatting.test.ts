import assert from 'node:assert/strict';
import test from 'node:test';
import { history, redo, undo } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { EditorSelection, EditorState } from '@codemirror/state';
import { type EditorFormat, formatEditorSelection } from './formatting';

function editor(doc: string, from: number, to = from, newline = '\n') {
  let state = EditorState.create({
    doc,
    selection: { anchor: from, head: to },
    extensions: [markdown(), history(), EditorState.lineSeparator.of(newline), EditorState.allowMultipleSelections.of(true)],
  });
  const target = {
    get state() {
      return state;
    },
    dispatch: (transaction: ReturnType<EditorState['update']>) => {
      state = transaction.state;
    },
  };
  return {
    target,
    format: (action: EditorFormat) => formatEditorSelection(target, action),
    get source() {
      return state.sliceDoc();
    },
    get selected() {
      return state.doc.sliceString(state.selection.main.from, state.selection.main.to);
    },
  };
}

for (const [action, expected] of [
  ['bold', '**选中文字**'],
  ['italic', '*选中文字*'],
  ['code', '`选中文字`'],
  ['formula', '$选中文字$'],
] as const) {
  test(`${action} preserves the selection and toggles without losing source`, () => {
    const value = editor('选中文字', 0, 4);
    assert.equal(value.format(action), true);
    assert.equal(value.source, expected);
    assert.equal(value.selected, '选中文字');
    value.format(action);
    assert.equal(value.source, '选中文字');
    assert.equal(value.selected, '选中文字');
  });
}

test('nested emphasis toggles only the requested format', () => {
  const bold = editor('***文字***', 3, 5);
  bold.format('bold');
  assert.equal(bold.source, '*文字*');
  assert.equal(bold.selected, '文字');
  const italic = editor('***文字***', 3, 5);
  italic.format('italic');
  assert.equal(italic.source, '**文字**');
  assert.equal(italic.selected, '文字');
  const escaped = editor('\\*文字\\*', 2, 4);
  escaped.format('italic');
  assert.equal(escaped.source, '\\**文字*\\*');
});

test('formatting preserves reverse selections and keeps outer spaces out of emphasis', () => {
  const value = editor('前面 文字 后面', 5, 3);
  value.format('bold');
  assert.equal(value.source, '前面 **文字** 后面');
  assert.ok(value.target.state.selection.main.anchor > value.target.state.selection.main.head);
  const spaces = editor('  文字  ', 0, 6);
  spaces.format('bold');
  assert.equal(spaces.source, '  **文字**  ');
});

test('emphasis across paragraphs handles each nonempty line and toggles back', () => {
  const source = '第一行\n\n第二行';
  const value = editor(source, 0, source.length);
  value.format('bold');
  assert.equal(value.source, '**第一行**\n\n**第二行**');
  value.format('bold');
  assert.equal(value.source, source);
});

test('empty selection selects the inserted placeholder for replacement', () => {
  const value = editor('正文', 2);
  value.format('bold');
  assert.equal(value.source, '正文**重点文字**');
  assert.equal(value.selected, '重点文字');
  value.target.dispatch(value.target.state.update(value.target.state.replaceSelection('新的文字')));
  assert.equal(value.source, '正文**新的文字**');
});

test('formatting is one undo event, separate from preceding typing', () => {
  const value = editor('文字', 0, 2);
  value.target.dispatch(value.target.state.update({ changes: { from: 2, insert: '。' }, userEvent: 'input.type' }));
  value.format('bold');
  assert.equal(value.source, '**文字**。');
  assert.equal(undo(value.target), true);
  assert.equal(value.source, '文字。');
  assert.equal(redo(value.target), true);
  assert.equal(value.source, '**文字**。');
});

test('multiple ranges are formatted in one transaction', () => {
  const value = editor('甲和乙', 0);
  value.target.dispatch(
    value.target.state.update({
      selection: EditorSelection.create([EditorSelection.range(0, 1), EditorSelection.range(2, 3)]),
    }),
  );
  value.format('bold');
  assert.equal(value.source, '**甲**和**乙**');
  assert.equal(value.target.state.selection.ranges.length, 2);
  assert.equal(undo(value.target), true);
  assert.equal(value.source, '甲和乙');
});

test('link and image keep labels and select the editable destination', () => {
  for (const action of ['link', 'image'] as const) {
    const value = editor('我的文字', 0, 4);
    value.format(action);
    assert.match(value.source, action === 'image' ? /^!\[我的文字\]\(/ : /^\[我的文字\]\(/);
    assert.match(value.selected, /^https:\/\//);
  }
  const existing = editor('[文字](https://example.com)', 1, 3);
  existing.format('link');
  assert.equal(existing.source, '[文字](https://example.com)');
  assert.equal(existing.selected, 'https://example.com');
  const url = editor('https://example.com/a(b)', 0, 24);
  url.format('link');
  assert.equal(url.source, '[链接文字](https://example.com/a\\(b\\))');
  assert.equal(url.selected, '链接文字');
  const label = editor('方[括]号', 0, 5);
  label.format('link');
  assert.equal(label.source, '[方\\[括\\]号](https://example.com)');
});

test('inline code chooses a safe delimiter and keeps literal backticks', () => {
  const value = editor('a `字` b', 0, 7);
  value.format('code');
  assert.equal(value.source, '``a `字` b``');
  value.format('code');
  assert.equal(value.source, 'a `字` b');
});

for (const action of ['note', 'code', 'formula'] as const) {
  test(`${action} wraps multiline source in independent lines and toggles back`, () => {
    const source = '第一行\n第二行';
    const value = editor(source, 0, source.length);
    value.format(action);
    assert.equal(value.selected, source);
    assert.equal(
      value.source,
      `${{ note: ':::info', code: '```', formula: '$$' }[action]}\n${source}\n${{ note: ':::', code: '```', formula: '$$' }[action]}`,
    );
    value.format(action);
    assert.equal(value.source, source);
  });
}

test('heading applies to covered lines, excludes the next line and merges shared lines', () => {
  const value = editor('甲\n乙\n丙', 0, 4);
  value.format('heading');
  assert.equal(value.source, '## 甲\n## 乙\n丙');
  value.format('heading');
  assert.equal(value.source, '甲\n乙\n丙');
  const empty = editor('', 0);
  empty.format('heading');
  assert.equal(empty.source, '## 小节标题');
  assert.equal(empty.selected, '小节标题');
  const multi = editor('同一行', 0);
  multi.target.dispatch(
    multi.target.state.update({
      selection: EditorSelection.create([EditorSelection.range(0, 1), EditorSelection.range(2, 3)]),
    }),
  );
  multi.format('heading');
  assert.equal(multi.source, '## 同一行');
});

test('BOM, frontmatter, comments and CRLF survive formatting and undo', () => {
  const frontmatter = '\uFEFF---\r\ntitle: 原标题 # 注释\r\ncustom: null\r\n---\r\n\r\n';
  const source = `${frontmatter}正文`;
  const offset = frontmatter.replace(/\r\n/g, '\n').length;
  const value = editor(source, offset, offset + 2, '\r\n');
  value.format('bold');
  assert.equal(value.source, `${frontmatter}**正文**`);
  undo(value.target);
  assert.equal(value.source, source);
  const metadata = editor(source, 5, 10, '\r\n');
  assert.equal(metadata.format('bold'), false);
  assert.equal(metadata.source, source);
});

for (const source of ['`字', ' 字 ', ' 字', '字 ', '  ']) {
  test(`inline code keeps literal whitespace and delimiters: ${JSON.stringify(source)}`, () => {
    const value = editor(source, 0, source.length);
    value.format('code');
    assert.equal(value.selected, source);
    value.format('code');
    assert.equal(value.source, source);
  });
}

test('a selected complete block can be unwrapped without replacing its content', () => {
  for (const [action, source] of [
    ['note', ':::info\n原文\n:::'],
    ['code', '```js\n原文\n```'],
    ['formula', '$$\n原文\n$$'],
  ] as const) {
    const value = editor(source, 0, source.length);
    value.format(action);
    assert.equal(value.source, '原文');
    assert.equal(value.selected, '原文');
  }
});

test('block formatting retains CRLF and selects only the original content', () => {
  const source = '\uFEFF---\r\ntitle: 测试 # 原注释\r\n---\r\n\r\n第一行\r\n第二行';
  const offset = source.replace(/\r\n/g, '\n').indexOf('第一行');
  const value = editor(source, offset, offset + 7, '\r\n');
  value.format('note');
  assert.equal(value.source, source.replace('第一行\r\n第二行', ':::info\r\n第一行\r\n第二行\r\n:::'));
  assert.equal(value.selected, '第一行\n第二行');
  value.format('note');
  assert.equal(value.source, source);
});

for (const space of ['\u3000', '\u00a0']) {
  test(`emphasis preserves Unicode edge whitespace ${JSON.stringify(space)}`, () => {
    const value = editor(`${space}文字${space}`, 0, 4);
    value.format('bold');
    assert.equal(value.source, `${space}**文字**${space}`);
  });
}

test('existing multiline and fully selected nested emphasis toggles correctly', () => {
  const multiline = editor('**one\ntwo**', 2, 9);
  multiline.format('bold');
  assert.equal(multiline.source, 'one\ntwo');
  for (const [action, expected] of [
    ['bold', '*abc*'],
    ['italic', '**abc**'],
  ] as const) {
    const value = editor('***abc***', 0, 9);
    value.format(action);
    assert.equal(value.source, expected);
  }
});
