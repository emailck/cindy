/**
 * Line-oriented Markdown for terminal replies. Replies are committed piece by piece while streaming,
 * so parsing works per source line; the only state carried between pieces is whether a code fence is open.
 */

export type SyntaxTone = 'keyword' | 'string' | 'number' | 'comment';

export interface Span { text: string; bold?: boolean; italic?: boolean; code?: boolean; strike?: boolean; underline?: boolean; dim?: boolean; tone?: SyntaxTone }

export interface MdLine {
  block: 'text' | 'heading1' | 'heading' | 'quote' | 'item' | 'code' | 'rule';
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
      spans.push(...parseInline(linkText, { ...style, underline: true }));
      if (url !== linkText) spans.push({ ...style, text: ` (${url})`, dim: true });
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

/** Source lines of `text` as terminal lines; fence lines themselves are not shown. */
export function parseMarkdown(text: string, inCode = false): MdLine[] {
  const out: MdLine[] = [];
  let code = inCode;
  for (const line of text.split('\n')) {
    if (FENCE.test(line)) { code = !code; continue; }
    if (code) { out.push({ block: 'code', spans: highlightCode(line) }); continue; }
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
