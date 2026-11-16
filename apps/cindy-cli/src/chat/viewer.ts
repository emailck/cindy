/**
 * The Ctrl+O viewer's content: every transcript row whose full text is folded away (tool output, a diff,
 * thinking, a local command's output), in transcript order, as plain rows the viewer scrolls through.
 */
import type { Line } from './controller';
import type { Translate } from '../i18n';
import { OUTPUT_KEEP, toolDisplayName, type DiffRow } from './tools';
import { wrapLine } from './width';

export type ViewTone = 'add' | 'remove' | 'muted' | 'faint' | 'error';
export interface ViewRow { text: string; tone?: ViewTone }
export interface ViewItem { id: string; title: string; rows: ViewRow[] }

function textRows(text: string, tone?: ViewTone): ViewRow[] {
  return text.split('\n').map(row => (tone ? { text: row, tone } : { text: row }));
}

export function diffRowsText(rows: readonly DiffRow[]): ViewRow[] {
  const width = Math.max(0, ...rows.map(row => String(row.line ?? '').length));
  return rows.map(row => ({
    text: `${width ? `${String(row.line ?? '').padStart(width)} ` : ''}${row.sign} ${row.text}`,
    tone: row.sign === '+' ? 'add' : row.sign === '-' ? 'remove' : 'faint',
  }));
}

function title(name: string, summary: string): string {
  return `${toolDisplayName(name)}${summary ? `(${summary})` : ''}`;
}

export function viewItems(lines: readonly Line[], t: Translate): ViewItem[] {
  const items: ViewItem[] = [];
  const truncatedNote = (truncated?: boolean): ViewRow[] => (truncated ? [{ text: '' }, { text: t('viewer.truncated', { count: OUTPUT_KEEP.toLocaleString() }), tone: 'faint' }] : []);
  for (const line of lines) {
    if (line.kind === 'tool') {
      if (line.detail?.kind === 'todos') continue;
      const rows: ViewRow[] = [];
      if (line.detail?.kind === 'edit') rows.push(...diffRowsText(line.detail.rows));
      else if (line.detail?.kind === 'write') rows.push(...textRows(line.detail.preview.join('\n'), 'muted'));
      if (line.result !== undefined && line.detail?.kind !== 'edit' && line.detail?.kind !== 'write') {
        rows.push(...textRows(line.result || t('tool.noContent'), line.error ? 'error' : undefined), ...truncatedNote(line.truncated));
      } else if (line.error && line.result) rows.push({ text: '' }, ...textRows(line.result, 'error'));
      if (rows.length) items.push({ id: line.id, title: title(line.name, line.summary), rows });
    } else if (line.kind === 'group') {
      for (const item of line.items) {
        if (item.result === undefined) continue;
        items.push({ id: `${line.id}:${item.id}`, title: title(item.name, item.summary), rows: textRows(item.result || t('tool.noContent'), item.error ? 'error' : undefined) });
      }
    } else if (line.kind === 'thinking') {
      items.push({ id: line.id, title: t('viewer.thinking'), rows: textRows(line.text, 'muted') });
    } else if (line.kind === 'local' && line.output !== undefined) {
      items.push({ id: line.id, title: `! ${line.command}`, rows: textRows(line.output || t('tool.noContent')) });
    }
  }
  return items;
}

/** An item's rows wrapped to the terminal width: each entry is one terminal row. */
export function wrapView(rows: readonly ViewRow[], width: number): ViewRow[] {
  return rows.flatMap(row => wrapLine(row.text, width).map(text => (row.tone ? { text, tone: row.tone } : { text })));
}
