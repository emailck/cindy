/** Terminal Markdown: structural blocks stay together while streaming; spans retain semantic styling. */
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

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const QUOTE = /^ {0,3}>\s?/;

interface Fence { marker: string; length: number }
function openingFence(line: string): Fence | null {
  const match = FENCE.exec(line);
  if (!match || (match[1]![0] === '`' && match[2]!.includes('`'))) return null;
  return { marker: match[1]![0]!, length: match[1]!.length };
}
function closesFence(line: string, fence: Fence): boolean {
  const match = FENCE.exec(line);
  return !!match && match[1]![0] === fence.marker && match[1]!.length >= fence.length && !match[2]!.trim();
}

/** Compatibility helper for callers starting within a conventional backtick fence. */
export function fenceAfter(text: string, open: boolean): boolean {
  let fence: Fence | null = open ? { marker: '`', length: 3 } : null;
  for (const line of text.split('\n')) {
    if (fence) { if (closesFence(line, fence)) fence = null; }
    else fence = openingFence(line);
  }
  return fence !== null;
}

/** Incomplete inline markup can still change styles on earlier lines of a paragraph. */
function hasUnclosedInline(text: string): boolean {
  const delimiters: string[] = [];
  let code = '';
  let brackets = 0;
  let destination = 0;
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '\\') { index++; continue; }
    const char = text[index]!;
    if (char === '`') {
      const ticks = /^`+/.exec(text.slice(index))![0];
      if (!code) code = ticks; else if (code === ticks) code = '';
      index += ticks.length - 1; continue;
    }
    if (code) continue;
    if (char === '[') brackets++;
    if (char === ']' && brackets) {
      brackets--;
      if (text[index + 1] === '(') { destination++; index++; }
    } else if (destination && char === '(') destination++;
    else if (destination && char === ')') destination--;
    if (!'*_~'.includes(char)) continue;
    const run = new RegExp(`^${char === '*' ? '\\*' : char}+`).exec(text.slice(index))![0];
    let remaining = run.length;
    if (!/\s/.test(text[index - 1] ?? ' ')) {
      while (remaining && delimiters.at(-1)?.[0] === char && delimiters.at(-1)!.length <= remaining) remaining -= delimiters.pop()!.length;
    }
    if (remaining && !/\s/.test(text[index + run.length] ?? ' ') && !(char === '_' && /[\p{L}\p{N}]/u.test(text[index - 1] ?? ''))) {
      if (char !== '~' || remaining >= 2) delimiters.push(char.repeat(remaining));
    }
    index += run.length - 1;
  }
  return !!(code || delimiters.length || brackets || destination);
}

/**
 * End of the stable prefix. Plain lines can enter scrollback immediately; lists, quotes,
 * fences and potential tables remain editable until their closing boundary arrives.
 * Only complete source lines decide boundaries, independent of transport chunk sizes.
 */
export function stableMarkdownEnd(text: string): number {
  const source = text.split('\n');
  let offset = 0;
  let stable = 0;
  let mode: 'list' | 'quote' | 'table' | null = null;
  let fence: Fence | null = null;
  let blank = false;
  let inline = '';
  for (const line of source.slice(0, -1)) {
    const start = offset;
    offset += line.length + 1;
    if (fence) {
      if (closesFence(line, fence)) { fence = null; stable = offset; }
      continue;
    }
    const opener = openingFence(line);
    const list = LIST.test(line);
    const quote = QUOTE.test(line);
    const table = isTableRow(line);
    if (mode === 'list') {
      // Unindented text can be a lazy continuation until a blank line or another block.
      if (!line.trim()) { blank = true; continue; }
      if (list || /^\s+/.test(line) || (!blank && !opener && !quote && !/^#{1,6}\s/.test(line))) continue;
    } else if (mode === 'quote') {
      if (quote || (line.trim() && !blank && !opener && !list && !/^#{1,6}\s/.test(line))) continue;
    } else if (mode === 'table' && table) continue;
    // A new block proves the preceding structural block is complete.
    if (mode) { stable = start; mode = null; blank = false; }
    if (opener || list || quote || table) {
      if (inline) { stable = start; inline = ''; }
      if (opener) fence = opener;
      else mode = list ? 'list' : quote ? 'quote' : 'table';
      continue;
    }
    inline += `${line}\n`;
    if (!line.trim() || !hasUnclosedInline(inline)) { stable = offset; inline = ''; }
  }
  return text.slice(0, stable).trimEnd().length;
}

const PUNCTUATION = /^[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]$/;
function escaped(text: string, index: number): boolean {
  let slashes = 0;
  while (index > 0 && text[--index] === '\\') slashes++;
  return slashes % 2 === 1;
}
function closingDelimiter(text: string, marker: string, from: number, depth = 0): number {
  if (depth > 32) return -1;
  for (let index = from; index < text.length;) {
    if (escaped(text, index)) { index++; continue; }
    if (text[index] === '`') {
      const ticks = /^`+/.exec(text.slice(index))![0];
      const end = text.indexOf(ticks, index + ticks.length);
      index = end >= 0 ? end + ticks.length : index + ticks.length;
      continue;
    }
    if (text[index] !== marker[0]) { index++; continue; }
    let length = 1;
    while (text[index + length] === marker[0]) length++;
    // A smaller run opens nested emphasis; consume it before closing the outer run.
    if (length < marker.length && !/\s/.test(text[index + length] ?? ' ')) {
      const nested = closingDelimiter(text, marker[0]!.repeat(length), index + length, depth + 1);
      if (nested >= 0) { index = nested + length; continue; }
    }
    if (length >= marker.length && !/\s/.test(text[index - 1] ?? ' ')
      && !(marker[0] === '_' && /[\p{L}\p{N}]/u.test(text[index + length] ?? ''))) return index;
    if (length > marker.length && !/\s/.test(text[index + length] ?? ' ')) {
      const nested = closingDelimiter(text, marker[0]!.repeat(length), index + length, depth + 1);
      if (nested >= 0) { index = nested + length; continue; }
    }
    index += length;
  }
  return -1;
}

/** Recursive inline rendering, with literal code/escapes and balanced link destinations. */
export function parseInline(text: string, style: Omit<Span, 'text'> = {}, depth = 0): Span[] {
  if (depth > 32) return [{ ...style, text }];
  const spans: Span[] = [];
  const plain = (value: string) => {
    if (!value) return;
    const previous = spans.at(-1);
    if (previous && Object.keys(previous).every(key => key === 'text' || previous[key as keyof Span] === style[key as keyof typeof style])
      && Object.keys(style).every(key => previous[key as keyof Span] === style[key as keyof typeof style])) previous.text += value;
    else spans.push({ ...style, text: value });
  };
  for (let index = 0; index < text.length;) {
    const char = text[index]!;
    if (char === '\\' && PUNCTUATION.test(text[index + 1] ?? '')) { plain(text[index + 1]!); index += 2; continue; }
    if (char === '`') {
      const marker = /^`+/.exec(text.slice(index))![0];
      let end = text.indexOf(marker, index + marker.length);
      while (end >= 0 && (text[end - 1] === '`' || text[end + marker.length] === '`')) end = text.indexOf(marker, end + marker.length);
      if (end >= 0) {
        let value = text.slice(index + marker.length, end).replace(/\n/g, ' ');
        if (value.startsWith(' ') && value.endsWith(' ') && value.trim()) value = value.slice(1, -1);
        spans.push({ ...style, text: value, code: true }); index = end + marker.length; continue;
      }
      plain(marker); index += marker.length; continue;
    }
    const image = char === '!' && text[index + 1] === '[';
    if (char === '[' || image) {
      const labelStart = index + (image ? 2 : 1);
      let cursor = labelStart;
      let brackets = 1;
      while (cursor < text.length && brackets) {
        if (!escaped(text, cursor)) { if (text[cursor] === '[') brackets++; if (text[cursor] === ']') brackets--; }
        if (brackets) cursor++;
      }
      if (!brackets && text[cursor + 1] === '(') {
        const destination = cursor + 2;
        let end = destination;
        let parens = 1;
        for (; end < text.length && parens; end++) {
          if (!escaped(text, end)) { if (text[end] === '(') parens++; if (text[end] === ')') parens--; }
        }
        if (!parens) {
          const label = text.slice(labelStart, cursor);
          const raw = text.slice(destination, end - 1).trim();
          const match = /^(?:<([^>]+)>|(\S+?))(?:\s+["'].*["'])?$/.exec(raw);
          if (match) {
            const url = (match[1] ?? match[2])!.replace(/\\([()])/g, '$1');
            spans.push(...parseInline(label, { ...style, underline: true, href: url }, depth + 1));
            if (url !== label) spans.push({ ...style, text: ` (${url})`, dim: true, linkFallback: true });
            index = end; continue;
          }
        }
      }
    }
    if (char === '<') {
      const auto = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/.exec(text.slice(index));
      if (auto) { spans.push({ ...style, text: auto[1]!, href: auto[1], underline: true }); index += auto[0].length; continue; }
    }
    const delimiter = /^(\*{1,3}|_{1,3}|~~)/.exec(text.slice(index))?.[0];
    if (delimiter && !/\s/.test(text[index + delimiter.length] ?? ' ')
      && !(delimiter[0] === '_' && /[\p{L}\p{N}]/u.test(text[index - 1] ?? ''))) {
      const end = closingDelimiter(text, delimiter, index + delimiter.length);
      if (end >= 0) {
        const nextStyle = { ...style, ...(delimiter === '~~' ? { strike: true } : {
          ...(delimiter.length >= 2 ? { bold: true } : {}), ...(delimiter.length !== 2 ? { italic: true } : {}),
        }) };
        spans.push(...parseInline(text.slice(index + delimiter.length, end), nextStyle, depth + 1));
        index = end + delimiter.length; continue;
      }
    }
    plain(char); index++;
  }
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

/** Pipe rows support optional outer pipes and literal bars in escapes / code spans. */
export function isTableRow(line: string): boolean {
  return tableCells(line).length > 1 || /^\s*\|.*\|\s*$/.test(line);
}
function isTableRule(line: string): boolean {
  return isTableRow(line) && tableCells(line).every(cell => /^:?-+:?$/.test(cell));
}
function tableCells(line: string): string[] {
  const inner = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  const cells: string[] = [];
  let cell = '';
  let ticks = '';
  for (let index = 0; index < inner.length; index++) {
    const char = inner[index]!;
    if (char === '\\' && inner[index + 1] === '|') { cell += '|'; index++; continue; }
    if (char === '`') {
      const marker = /^`+/.exec(inner.slice(index))![0];
      if (!ticks) ticks = marker; else if (ticks === marker) ticks = '';
      cell += marker; index += marker.length - 1; continue;
    }
    if (char === '|' && !ticks) { cells.push(cell.trim()); cell = ''; }
    else cell += char;
  }
  cells.push(cell.trim());
  return cells;
}
function spansWidth(spans: Span[]): number { return spans.reduce((width, span) => width + displayWidth(span.text), 0); }

/** Wrap whole graphemes across spans; keep all characters and their semantic style. */
function wrapSpans(spans: Span[], width: number): Span[][] {
  const out: Span[][] = [[]];
  let used = 0;
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  for (const span of spans) {
    for (const { segment } of segmenter.segment(span.text)) {
      const size = displayWidth(segment);
      if (segment === '\n' || (used > 0 && used + size > width)) { out.push([]); used = 0; }
      if (segment === '\n') continue;
      const row = out.at(-1)!;
      const previous = row.at(-1);
      // Adjacent graphemes from the same input span share all style fields.
      if (previous && [...Object.keys(span), ...Object.keys(previous)].every(key => key === 'text' || previous[key as keyof Span] === span[key as keyof Span])) previous.text += segment;
      else row.push({ ...span, text: segment });
      used += size;
    }
  }
  return out;
}

/** Bound the live view after parsing, retaining fence/table context and styled wrapped tails. */
export function tailMarkdownRows(lines: MdLine[], maxRows: number, width: number): MdLine[] {
  if (maxRows <= 0) return [];
  const rows: MdLine[] = [];
  for (const line of lines) {
    const prefix = line.prefix && displayWidth(line.prefix) >= width ? truncateWidth(line.prefix, Math.max(1, width - 1)) : line.prefix;
    const available = Math.max(2, width - displayWidth(prefix ?? ''));
    const wrapped = wrapSpans(line.spans, available);
    wrapped.forEach((spans, index) => rows.push({ ...line, spans,
      ...(prefix ? { prefix: index && line.block === 'item' ? ' '.repeat(displayWidth(prefix)) : prefix } : {}),
    }));
    if (rows.length > maxRows) rows.splice(0, rows.length - maxRows);
  }
  return rows;
}

/** Lossless tables: aligned wrapping normally, labeled fields when columns become unreadable. */
function renderTable(rows: string[], align: Array<'left' | 'center' | 'right'>, width: number): MdLine[] {
  const cells = rows.map((row, index) => {
    const values = tableCells(row);
    return Array.from({ length: align.length }, (_, column) => parseInline(values[column] ?? '', index === 0 ? { bold: true } : {}));
  });
  const widths = align.map((_, column) => Math.max(1, ...cells.map(row => spansWidth(row[column]!))));
  const frame = 1 + widths.length * 3;
  const available = Math.max(0, width - frame);
  if (available >= widths.length * 3) {
    while (widths.reduce((sum, value) => sum + value, 0) > available) {
      const widest = widths.indexOf(Math.max(...widths));
      if (widths[widest]! <= 3) break;
      widths[widest]!--;
    }
  }
  const wrapped = cells.map(row => row.map((value, column) => wrapSpans(value, widths[column]!)));
  if (available < widths.length * 3 || wrapped.some(row => row.some(value => value.length > 4))) {
    const out: MdLine[] = [];
    const records = cells.length > 1 ? cells.slice(1) : [cells[0]!];
    records.forEach((record, index) => {
      if (index) out.push({ block: 'table', spans: [] });
      record.forEach((value, column) => {
        const label = cells[0]![column]!.map(span => ({ ...span, bold: true }));
        const fields = cells.length > 1 ? [...label, { text: ': ' }, ...value] : label;
        for (const spans of wrapSpans(fields, Math.max(2, width))) out.push({ block: 'table', spans });
      });
    });
    return out;
  }
  const rule = (left: string, middle: string, right: string): MdLine => ({
    block: 'table', spans: [{ text: `${left}${widths.map(value => '─'.repeat(value + 2)).join(middle)}${right}`, border: true }],
  });
  const renderRow = (values: Span[][][]): MdLine[] => Array.from({ length: Math.max(...values.map(value => value.length)) }, (_, index) => {
    const spans: Span[] = [{ text: '│ ', border: true }];
    values.forEach((value, column) => {
      const content = value[index] ?? [];
      const pad = Math.max(0, widths[column]! - spansWidth(content));
      const before = align[column] === 'right' ? pad : align[column] === 'center' ? Math.floor(pad / 2) : 0;
      if (before) spans.push({ text: ' '.repeat(before) });
      spans.push(...content);
      if (pad - before) spans.push({ text: ' '.repeat(pad - before) });
      spans.push({ text: column === values.length - 1 ? ' │' : ' │ ', border: true });
    });
    return { block: 'table', spans };
  });
  return [rule('┌', '┬', '┐'), ...renderRow(wrapped[0]!), rule('├', '┼', '┤'), ...wrapped.slice(1).flatMap(renderRow), rule('└', '┴', '┘')];
}

/** Source lines of `text` as terminal lines; fence lines themselves are not shown. `width` bounds tables. */
export function parseMarkdown(text: string, inCode = false, width = 120): MdLine[] {
  const out: MdLine[] = [];
  let fence: Fence | null = inCode ? { marker: '`', length: 3 } : null;
  let listIndent = 0;
  const source = text.split('\n');
  for (let index = 0; index < source.length; index++) {
    const line = source[index]!;
    if (fence) {
      if (closesFence(line, fence)) { fence = null; continue; }
      out.push({ block: 'code', spans: highlightCode(line) }); continue;
    }
    const opener = openingFence(line);
    if (opener) { fence = opener; continue; }
    // A header row followed by a |---|:---:| rule starts a table; it runs while rows look like table rows.
    if (isTableRow(line) && isTableRule(source[index + 1] ?? '') && tableCells(line).length === tableCells(source[index + 1]!).length) {
      const align = tableCells(source[index + 1]!).map(cell => (cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : 'left') as 'left' | 'center' | 'right');
      const rows = [line];
      let next = index + 2;
      while (next < source.length && isTableRow(source[next]!) && tableCells(source[next]!).length <= align.length) rows.push(source[next++]!);
      out.push(...renderTable(rows, align, width));
      index = next - 1;
      continue;
    }
    let match: RegExpExecArray | null;
    if ((match = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))) out.push({ block: match[1]!.length === 1 ? 'heading1' : 'heading', spans: parseInline(match[2]!, { bold: true }) });
    else if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) out.push({ block: 'rule', spans: [] });
    else if (QUOTE.test(line)) {
      const quoted = [line.replace(QUOTE, '')];
      while (index + 1 < source.length) {
        const next = source[index + 1]!;
        if (QUOTE.test(next)) quoted.push(source[++index]!.replace(QUOTE, ''));
        else if (next.trim() && !openingFence(next) && !LIST.test(next) && !/^ {0,3}#{1,6}\s/.test(next)) quoted.push(source[++index]!);
        else break;
      }
      const nested = parseMarkdown(quoted.join('\n'), false, Math.max(2, width - 2));
      for (const entry of nested) out.push({ ...entry, block: 'quote', prefix: `▎ ${entry.prefix ?? ''}`, spans: entry.spans.map(span => ({ italic: true, ...span })) });
    }
    else if ((match = LIST.exec(line))) {
      const marker = /\d/.test(match[2]!) ? match[2]! : '-';
      const indent = match[1]!.replace(/\t/g, '  ');
      listIndent = displayWidth(`${indent}${marker} `);
      const task = /^\[([ xX])\]\s+(.*)$/.exec(match[3]!);
      out.push({ block: 'item', prefix: `${indent}${marker} `, spans: parseInline(task ? `${task[1] === ' ' ? '☐' : '☒'} ${task[2]}` : match[3]!) });
    } else if (listIndent && /^\s+\S/.test(line)) {
      out.push({ block: 'item', prefix: ' '.repeat(listIndent), spans: parseInline(line.trimStart()) });
    } else {
      if (!line.trim()) { listIndent = 0; out.push({ block: 'text', spans: [] }); continue; }
      const paragraph = [line];
      while (index + 1 < source.length) {
        const next = source[index + 1]!;
        if (!next.trim() || openingFence(next) || LIST.test(next) || QUOTE.test(next) || isTableRow(next)
          || /^ {0,3}#{1,6}\s/.test(next) || /^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(next)) break;
        paragraph.push(source[++index]!);
      }
      let spans: Span[] = [];
      for (const span of parseInline(paragraph.join('\n'))) {
        span.text.split('\n').forEach((part, partIndex) => {
          if (partIndex) { out.push({ block: 'text', spans }); spans = []; }
          if (part) spans.push({ ...span, text: part });
        });
      }
      out.push({ block: 'text', spans });
    }
  }
  return out;
}
