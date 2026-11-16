/**
 * Line-oriented Markdown for terminal replies. Replies are committed piece by piece while streaming,
 * so parsing works per source line; the only state carried between pieces is whether a code fence is open.
 * A table is the exception: the controller commits it in one piece once it is complete, so its columns align.
 */
import { displayWidth, truncateWidth } from './width';

export type SyntaxTone = 'keyword' | 'string' | 'number' | 'comment';

/**
 * href: a link target, rendered as a terminal hyperlink where the terminal supports them; linkFallback: the
 * " (url)" after a link's text, shown only where it does not. border: table rules.
 */
export interface Span {
  text: string; bold?: boolean; italic?: boolean; code?: boolean; strike?: boolean; underline?: boolean; dim?: boolean; tone?: SyntaxTone;
  href?: string; linkFallback?: boolean; border?: boolean;
}

export interface MdLine {
  block: 'text' | 'heading1' | 'heading' | 'quote' | 'item' | 'code' | 'rule' | 'table';
  /** List marker or quote bar, printed before the spans. */
  prefix?: string;
  spans: Span[];
}

const FENCE = /^\s*(```|~~~)/;

/** Whether a code fence is open after `text`, given whether one was open before it. */
export function fenceAfter(text: string, open: boolean): boolean {
  for (const line of text.split('\n')) if (FENCE.test(line)) open = !open;
  return open;
}

const INLINE = /(`+)(.+?)\1|\*\*(.+?)\*\*|__(.+?)__|~~(.+?)~~|\[([^\]\n]+)\]\(([^)\s]+)\)|(?<![\w*\\])\*(?![\s*])(.+?)(?<![\s\\])\*(?![\w*])|(?<![\w_\\])_(?![\s_])(.+?)(?<![\s\\])_(?![\w_])/g;

export function parseInline(text: string, style: Omit<Span, 'text'> = {}): Span[] {
  const spans: Span[] = [];
  const plain = (value: string) => { if (value) spans.push({ ...style, text: value }); };
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    plain(text.slice(last, match.index));
    last = match.index + match[0].length;
    const [, , code, bold1, bold2, strike, linkText, url, italic1, italic2] = match;
    if (code !== undefined) spans.push({ ...style, text: code, code: true });
    else if (bold1 !== undefined || bold2 !== undefined) spans.push(...parseInline((bold1 ?? bold2)!, { ...style, bold: true }));
    else if (strike !== undefined) spans.push(...parseInline(strike, { ...style, strike: true }));
    else if (linkText !== undefined) {
      spans.push(...parseInline(linkText, { ...style, underline: true, href: url! }));
      // Shown only where the terminal cannot make the text itself a link.
      if (url !== linkText) spans.push({ ...style, text: ` (${url})`, dim: true, linkFallback: true });
    } else spans.push(...parseInline((italic1 ?? italic2)!, { ...style, italic: true }));
  }
  plain(text.slice(last));
  return spans;
}

const KEYWORDS = new Set(`abstract as async await break case catch class const continue def default defer del do elif else enum export extends
false fi final finally fn for from func function go if impl import in instanceof interface is lambda let loop match mod mut new nil none
None null of package pass private protected pub public raise return self static struct super switch then this throw throws trait true True
False try type typeof undefined use var void while with yield`.split(/\s+/));

const CODE = /(\/\/.*$|(?<=^|\s)#(?!!).*$|\/\*.*?\*\/)|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`(?:[^`\\]|\\.)*`?)|\b(0x[\da-f]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)\b|([A-Za-z_$][\w$]*)/gi;

/**
 * Language-agnostic highlighting of one code line: comments, strings, numbers and common keywords.
 * Each line stands alone (replies stream line by line), so a block comment or string spanning lines is not tracked.
 */
export function highlightCode(line: string): Span[] {
  const spans: Span[] = [];
  let last = 0;
  const push = (text: string, tone?: SyntaxTone) => {
    const previous = spans.at(-1);
    if (previous && previous.tone === tone) previous.text += text;
    else spans.push(tone ? { text, tone } : { text });
  };
  for (const match of line.matchAll(CODE)) {
    const [whole, comment, string, number, word] = match;
    if (word !== undefined && !KEYWORDS.has(word)) continue;
    if (match.index > last) push(line.slice(last, match.index));
    push(whole, comment !== undefined ? 'comment' : string !== undefined ? 'string' : number !== undefined ? 'number' : 'keyword');
    last = match.index + whole.length;
  }
  if (last < line.length || !spans.length) push(line.slice(last));
  return spans;
}

/** A source line that can belong to a Markdown table (`| a | b |`). */
export function isTableRow(line: string): boolean {
  return /^\s*\|.*\|\s*$/.test(line);
}

function isTableRule(line: string): boolean {
  return isTableRow(line) && tableCells(line).every(cell => /^:?-+:?$/.test(cell));
}

function tableCells(line: string): string[] {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  // `\|` inside a cell is a literal bar.
  return inner.split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'));
}

function spansWidth(spans: Span[]): number { return spans.reduce((width, span) => width + displayWidth(span.text), 0); }

function cutSpans(spans: Span[], width: number): Span[] {
  const out: Span[] = [];
  let left = width;
  for (const span of spans) {
    const own = displayWidth(span.text);
    if (own <= left) { out.push(span); left -= own; continue; }
    if (left > 0) out.push({ ...span, text: truncateWidth(span.text, left) });
    break;
  }
  return out;
}

/**
 * A complete table drawn with box rules, columns padded to their widest cell. When it is wider than `width`,
 * the widest columns give up columns first and their cells end with ….
 */
function renderTable(rows: string[], align: Array<'left' | 'center' | 'right'>, width: number): MdLine[] {
  const cells = rows.map((row, index) => {
    const values = tableCells(row);
    return Array.from({ length: align.length }, (_, column) => parseInline(values[column] ?? '', index === 0 ? { bold: true } : {}));
  });
  const widths = align.map((_, column) => Math.max(1, ...cells.map(row => spansWidth(row[column]!))));
  // Frame: "│ " + cells joined by " │ " + " │".
  const frame = 4 + (widths.length - 1) * 3;
  while (frame + widths.reduce((sum, value) => sum + value, 0) > width) {
    const widest = widths.indexOf(Math.max(...widths));
    if (widths[widest]! <= 3) break;
    widths[widest]!--;
  }
  const rule = (left: string, middle: string, right: string): MdLine => ({
    block: 'table', spans: [{ text: `${left}${widths.map(value => '─'.repeat(value + 2)).join(middle)}${right}`, border: true }],
  });
  const row = (values: Span[][]): MdLine => {
    const spans: Span[] = [{ text: '│ ', border: true }];
    values.forEach((value, column) => {
      const cut = cutSpans(value, widths[column]!);
      const pad = widths[column]! - spansWidth(cut);
      const before = align[column] === 'right' ? pad : align[column] === 'center' ? Math.floor(pad / 2) : 0;
      if (before) spans.push({ text: ' '.repeat(before) });
      spans.push(...cut);
      if (pad - before) spans.push({ text: ' '.repeat(pad - before) });
      spans.push({ text: column === values.length - 1 ? ' │' : ' │ ', border: true });
    });
    return { block: 'table', spans };
  };
  return [rule('┌', '┬', '┐'), row(cells[0]!), rule('├', '┼', '┤'), ...cells.slice(1).map(row), rule('└', '┴', '┘')];
}

/** Source lines of `text` as terminal lines; fence lines themselves are not shown. `width` bounds tables. */
export function parseMarkdown(text: string, inCode = false, width = 120): MdLine[] {
  const out: MdLine[] = [];
  let code = inCode;
  const source = text.split('\n');
  for (let index = 0; index < source.length; index++) {
    const line = source[index]!;
    if (FENCE.test(line)) { code = !code; continue; }
    if (code) { out.push({ block: 'code', spans: highlightCode(line) }); continue; }
    // A header row followed by a |---|:---:| rule starts a table; it runs while rows look like table rows.
    if (isTableRow(line) && isTableRule(source[index + 1] ?? '')) {
      const align = tableCells(source[index + 1]!).map(cell => (cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : 'left') as 'left' | 'center' | 'right');
      const rows = [line];
      let next = index + 2;
      while (next < source.length && isTableRow(source[next]!)) rows.push(source[next++]!);
      out.push(...renderTable(rows, align, width));
      index = next - 1;
      continue;
    }
    let match: RegExpExecArray | null;
    if ((match = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))) out.push({ block: match[1]!.length === 1 ? 'heading1' : 'heading', spans: parseInline(match[2]!, { bold: true }) });
    else if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) out.push({ block: 'rule', spans: [] });
    else if ((match = /^\s*>\s?(.*)$/.exec(line))) out.push({ block: 'quote', prefix: '▎ ', spans: parseInline(match[1]!, { italic: true, dim: true }) });
    else if ((match = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(line))) {
      const marker = /\d/.test(match[2]!) ? match[2]! : '-';
      out.push({ block: 'item', prefix: `${match[1]!.replace(/\t/g, '  ')}${marker} `, spans: parseInline(match[3]!) });
    } else out.push({ block: 'text', spans: parseInline(line) });
  }
  return out;
}
