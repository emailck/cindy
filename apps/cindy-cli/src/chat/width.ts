import { stripVTControlCharacters } from 'node:util';
import { eastAsianWidth } from 'get-east-asian-width';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const invisible = /^[\p{Mark}\p{Control}\p{Format}\p{Surrogate}]$/u;
const emojiPresentation = /\p{Emoji_Presentation}/u;
const regionalIndicator = /\p{Regional_Indicator}/gu;

export const stripAnsi = stripVTControlCharacters;

/** Width of one extended grapheme. Ambiguous characters use the narrow terminal convention. */
export function charWidth(char: string): number {
  const plain = stripAnsi(char);
  if (!plain) return 0;
  const flags = plain.match(regionalIndicator)?.length ?? 0;
  if (flags) return flags > 1 ? 2 : 1;
  const keycap = /^[#*0-9]\uFE0F?\u20E3$/u.test(plain);
  const incompleteKeycap = /^[#*0-9]\uFE0F$/u.test(plain);
  if (keycap || (!incompleteKeycap && (emojiPresentation.test(plain) || /\p{Emoji}\uFE0F/u.test(plain)))) return 2;
  let width = 0;
  for (const point of plain) {
    if (!invisible.test(point)) width += eastAsianWidth(point.codePointAt(0)!, { ambiguousAsWide: false });
  }
  return width;
}

export interface Grapheme { segment: string; index: number; end: number; width: number }

/** Offsets refer to the supplied string, which is never normalized. */
export function graphemes(text: string): Grapheme[] {
  return Array.from(segmenter.segment(text), ({ segment, index }) => ({ segment, index, end: index + segment.length, width: charWidth(segment) }));
}

export function displayWidth(text: string): number {
  return graphemes(stripAnsi(text)).reduce((width, item) => width + item.width, 0);
}

/** Plain text cut to at most width columns; terminal escapes are deliberately removed. */
export function truncateWidth(text: string, width: number): string {
  const max = Math.max(0, Math.floor(width));
  const plain = stripAnsi(text);
  if (displayWidth(plain) <= max) return plain;
  if (max < 1) return '';
  let out = '';
  let used = 0;
  for (const item of graphemes(plain)) {
    if (used + item.width > max - 1) break;
    out += item.segment;
    used += item.width;
  }
  return `${out}…`;
}

/** Plain terminal rows; tabs render as two spaces. Never splits a grapheme cluster. */
export function wrapLine(line: string, width: number): string[] {
  const max = Math.max(1, Math.floor(width));
  const rows: string[] = [];
  let row = '';
  let used = 0;
  for (const item of graphemes(stripAnsi(line).replace(/\t/g, '  '))) {
    if (item.segment === '\n' || item.segment === '\r\n') { rows.push(row); row = ''; used = 0; continue; }
    if (used > 0 && used + item.width > max) { rows.push(row); row = ''; used = 0; }
    const shown = item.width > max ? '�' : item.segment;
    row += shown;
    used += item.width > max ? 1 : item.width;
  }
  rows.push(row);
  return rows;
}
