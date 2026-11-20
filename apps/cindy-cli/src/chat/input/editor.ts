import { displayWidth, graphemes, stripAnsi, truncateWidth } from '../width.js';

export interface Editor { value: string; cursor: number; preferredColumn?: number }
export interface InputUnit { text: string; start: number; end: number; atomic: boolean }
export interface CursorStop { offset: number; column: number }
export interface InputRow { text: string; start: number; end: number; width: number; stops: CursorStop[] }
export interface InputLayout { rows: InputRow[]; cursorRow: number; cursorColumn: number }
export interface InputViewport extends InputLayout {
  top: number;
  hiddenAbove: number;
  hiddenBelow: number;
  beforeCursor: string;
  atCursor: string;
  afterCursor: string;
}

const WORD = /[\p{L}\p{N}_]/u;

/** Markers retain the exact existing localized syntax, and behave like single editor units. */
export function inputUnits(value: string): InputUnit[] {
  const result: InputUnit[] = [];
  const markers = /\[(?:(?:Pasted text|粘贴的文本) #\d+[^\]\r\n]*|(?:Image|图片) #\d+)\]/g;
  let from = 0;
  const append = (end: number) => {
    for (const item of graphemes(value.slice(from, end))) {
      result.push({ text: item.segment, start: from + item.index, end: from + item.end, atomic: false });
    }
  };
  for (const match of value.matchAll(markers)) {
    append(match.index);
    result.push({ text: match[0], start: match.index, end: match.index + match[0].length, atomic: true });
    from = match.index + match[0].length;
  }
  append(value.length);
  return result;
}

/** Repair stale/raw UTF-16 offsets without changing source text. */
export function snapCursor(value: string, cursor: number, bias: 'left' | 'right' = 'left'): number {
  const index = Math.max(0, Math.min(value.length, Number.isFinite(cursor) ? Math.floor(cursor) : 0));
  for (const unit of inputUnits(value)) {
    if (index > unit.start && index < unit.end) return bias === 'left' ? unit.start : unit.end;
  }
  return index;
}

function rowAt(offset: number): InputRow {
  return { text: '', start: offset, end: offset, width: 0, stops: [{ offset, column: 0 }] };
}

/** Source offsets always address the original string; narrow markers are shortened only in this projection. */
export function layoutInput(value: string, width: number, cursor = value.length): InputLayout {
  const max = Math.max(1, Math.floor(width));
  const rows: InputRow[] = [];
  let row = rowAt(0);
  for (const unit of inputUnits(value)) {
    if (unit.text === '\n' || unit.text === '\r\n' || unit.text === '\r') {
      rows.push(row);
      if (row.width === max) {
        // The automatic wrap and hard break share the next row. Both sides of
        // the newline remain valid source offsets without placing a caret in
        // the input's right padding or adding a spurious blank display row.
        row = rowAt(unit.start);
        row.end = unit.end;
        row.stops.push({ offset: unit.end, column: 0 });
      } else row = rowAt(unit.end);
      continue;
    }
    let shown = stripAnsi(unit.text).replace(/\t/g, '  ').replace(/[\p{Control}]/gu, '');
    let cells = displayWidth(shown);
    if (cells > max) {
      shown = unit.atomic ? truncateWidth(shown, max) : '�';
      cells = displayWidth(shown);
    }
    if (row.width > 0 && row.width + cells > max) {
      rows.push(row);
      row = rowAt(unit.start);
    }
    row.text += shown;
    row.width += cells;
    row.end = unit.end;
    row.stops.push({ offset: unit.end, column: row.width });
  }
  rows.push(row);
  // A full final row needs another cell for the caret; do not let Ink wrap it implicitly.
  if (row.width === max) rows.push(rowAt(value.length));
  const offset = snapCursor(value, cursor);
  let cursorRow = 0;
  let cursorColumn = 0;
  for (let index = 0; index < rows.length; index++) {
    const stop = rows[index]!.stops.find(item => item.offset === offset);
    // At a soft wrap the start of the following row wins over the preceding end.
    if (stop) { cursorRow = index; cursorColumn = stop.column; }
  }
  return { rows, cursorRow, cursorColumn };
}

/** Vertical motion uses terminal columns and keeps the preferred column across short rows. */
export function moveVertical(editor: Editor, delta: -1 | 1, width: number): Editor | null {
  const layout = layoutInput(editor.value, width, editor.cursor);
  const nextIndex = layout.cursorRow + delta;
  const next = layout.rows[nextIndex];
  if (!next) return null;
  const preferredColumn = editor.preferredColumn ?? layout.cursorColumn;
  // A soft-wrap boundary belongs to the following row. Selecting its preceding-row
  // copy would leave the cursor in place when moving up from that following row.
  const following = layout.rows[nextIndex + 1];
  const candidates = next.stops.filter(item => !following?.stops.some(other => other.offset === item.offset));
  const stop = (candidates.length ? candidates : next.stops).reduce((best, item) =>
    item.column === best.column || Math.abs(item.column - preferredColumn) < Math.abs(best.column - preferredColumn) ? item : best);
  return { value: editor.value, cursor: stop.offset, preferredColumn };
}

export function inputViewport(editor: Editor, width: number, maxRows: number, previousTop = 0): InputViewport {
  const layout = layoutInput(editor.value, width, editor.cursor);
  const count = Math.max(1, Math.floor(maxRows));
  let top = Math.max(0, Math.min(previousTop, layout.rows.length - count));
  if (layout.cursorRow < top) top = layout.cursorRow;
  if (layout.cursorRow >= top + count) top = layout.cursorRow - count + 1;
  const rows = layout.rows.slice(top, top + count);
  const cursorRow = layout.cursorRow - top;
  const active = rows[cursorRow]!;
  let beforeCursor = '';
  let atCursor = ' ';
  let afterCursor = '';
  let used = 0;
  let found = false;
  for (const item of graphemes(active.text)) {
    if (!found && used >= layout.cursorColumn && item.width > 0) { atCursor = item.segment; found = true; }
    else if (found) afterCursor += item.segment;
    else beforeCursor += item.segment;
    used += item.width;
  }
  return { rows, cursorRow, cursorColumn: layout.cursorColumn, top, hiddenAbove: top,
    hiddenBelow: layout.rows.length - top - rows.length, beforeCursor, atCursor, afterCursor };
}

export const edit = {
  left({ value, cursor }: Editor): number {
    const index = snapCursor(value, cursor, 'right');
    return inputUnits(value).findLast(unit => unit.start < index)?.start ?? 0;
  },
  right({ value, cursor }: Editor): number {
    const index = snapCursor(value, cursor);
    return inputUnits(value).find(unit => unit.end > index)?.end ?? value.length;
  },
  lineStart({ value, cursor }: Editor): number {
    const index = snapCursor(value, cursor);
    return index === 0 ? 0 : value.lastIndexOf('\n', index - 1) + 1;
  },
  lineEnd({ value, cursor }: Editor): number {
    const end = value.indexOf('\n', snapCursor(value, cursor));
    return end < 0 ? value.length : snapCursor(value, end);
  },
  wordLeft({ value, cursor }: Editor): number {
    const boundary = snapCursor(value, cursor, 'right');
    const units = inputUnits(value).filter(unit => unit.start < boundary);
    let index = units.length - 1;
    if (units[index]?.atomic) return units[index]!.start;
    while (index >= 0 && !units[index]!.atomic && !WORD.test(units[index]!.text)) index--;
    if (units[index]?.atomic) return units[index]!.start;
    while (index >= 0 && !units[index]!.atomic && WORD.test(units[index]!.text)) index--;
    return units[index + 1]?.start ?? 0;
  },
  wordRight({ value, cursor }: Editor): number {
    const boundary = snapCursor(value, cursor);
    const units = inputUnits(value).filter(unit => unit.end > boundary);
    let index = 0;
    if (units[index]?.atomic) return units[index]!.end;
    while (index < units.length && !units[index]!.atomic && !WORD.test(units[index]!.text)) index++;
    if (units[index]?.atomic) return units[index]!.end;
    while (index < units.length && !units[index]!.atomic && WORD.test(units[index]!.text)) index++;
    return units[index - 1]?.end ?? value.length;
  },
  remove({ value }: Editor, from: number, to: number): Editor {
    const start = snapCursor(value, Math.min(from, to));
    if (from === to) return { value, cursor: start };
    const end = snapCursor(value, Math.max(from, to), 'right');
    return { value: value.slice(0, start) + value.slice(end), cursor: start };
  },
  insert(editor: Editor, text: string): Editor {
    const cursor = snapCursor(editor.value, editor.cursor);
    const value = editor.value.slice(0, cursor) + text + editor.value.slice(cursor);
    return { value, cursor: snapCursor(value, cursor + text.length, 'right') };
  },
  backspace(editor: Editor): Editor { return edit.remove(editor, edit.left(editor), editor.cursor); },
  delete(editor: Editor): Editor { return edit.remove(editor, editor.cursor, edit.right(editor)); },
  vertical(editor: Editor, delta: -1 | 1, width = Infinity): number | null {
    return moveVertical(editor, delta, width)?.cursor ?? null;
  },
};
