/** Terminal column widths: CJK and full-width characters take two columns. */

export function charWidth(char: string): number {
  const code = char.codePointAt(0)!;
  if (code < 0x20 || (code >= 0x7f && code < 0xa0)) return 0;
  return (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6)
    || (code >= 0x1f300 && code <= 0x1faff) || (code >= 0x20000 && code <= 0x3fffd) ? 2 : 1;
}

export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) width += charWidth(char);
  return width;
}

/** `text` cut to at most `width` columns, ending with … when something was cut. */
export function truncateWidth(text: string, width: number): string {
  if (displayWidth(text) <= width) return text;
  let out = '';
  let used = 0;
  for (const char of text) {
    const next = charWidth(char);
    if (used + next > width - 1) break;
    out += char;
    used += next;
  }
  return `${out}…`;
}

/** Splits one line into terminal rows of at most `width` columns (tabs count as two spaces). */
export function wrapLine(line: string, width: number): string[] {
  const max = Math.max(1, width);
  const rows: string[] = [];
  let row = '';
  let used = 0;
  for (const char of line.replace(/\t/g, '  ')) {
    const next = charWidth(char);
    if (used + next > max) { rows.push(row); row = ''; used = 0; }
    row += char;
    used += next;
  }
  rows.push(row);
  return rows;
}
