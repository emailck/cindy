/**
 * How tool calls read in the transcript, independent of the renderer: display names, what the call
 * changes (edit diff, written lines, todo list) and how its output is summarized under it.
 */

export interface DiffRow { sign: '+' | '-' | ' '; text: string }
export interface TodoItem { text: string; status: 'pending' | 'in_progress' | 'completed' }

/** Derived from the tool input when the call starts; keeps only what the transcript shows. */
export type ToolDetail =
  | { kind: 'edit'; path: string; added: number; removed: number; rows: DiffRow[] }
  | { kind: 'write'; path: string; lines: number; preview: string[] }
  | { kind: 'todos'; items: TodoItem[] };

/** Rows of a diff or preview shown under a tool call; the rest is counted. */
export const DETAIL_ROWS = 12;
/** Output rows shown under a tool call before "… +N lines". */
export const OUTPUT_ROWS = 4;
/** Output kept per tool call: enough to count lines and show the head, bounded for long sessions. */
const OUTPUT_KEEP = 20_000;

const NAMES: Record<string, string> = { Edit: 'Update', MultiEdit: 'Update', TodoWrite: 'Update Todos' };

/** `mcp__server__tool` reads as `server - tool (MCP)`; built-in tools keep their name (Edit reads as Update). */
export function toolDisplayName(name: string): string {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) return `${mcp[1]} - ${mcp[2]} (MCP)`;
  return NAMES[name] ?? name;
}

function str(value: unknown): string { return typeof value === 'string' ? value : ''; }
function lines(text: string): string[] { return text === '' ? [] : text.replace(/\n$/, '').split('\n'); }

/**
 * Line diff of two short texts (longest common subsequence). Large edits are not diffed row by row:
 * counts stay exact, rows show removals then additions.
 */
export function diffLines(before: string, after: string): DiffRow[] {
  const a = lines(before);
  const b = lines(after);
  if (a.length * b.length > 250_000) return [...a.map(text => ({ sign: '-' as const, text })), ...b.map(text => ({ sign: '+' as const, text }))];
  const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
  }
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { rows.push({ sign: ' ', text: a[i]! }); i++; j++; }
    // Removals before additions where either order is a longest match, as unified diffs read.
    else if (i < a.length && (j >= b.length || table[i + 1]![j]! >= table[i]![j + 1]!)) rows.push({ sign: '-', text: a[i++]! });
    else rows.push({ sign: '+', text: b[j++]! });
  }
  return rows;
}

/** Keeps changed rows with one row of context around each change, like a compact unified diff. */
function compact(rows: DiffRow[]): DiffRow[] {
  const changed = (index: number) => rows[index] !== undefined && rows[index]!.sign !== ' ';
  return rows.filter((_, index) => changed(index) || changed(index - 1) || changed(index + 1));
}

const TODO_STATUS = new Set(['pending', 'in_progress', 'completed']);

export function toolDetail(name: string, input: unknown): ToolDetail | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const record = input as Record<string, unknown>;
  const path = str(record.file_path) || str(record.path) || str(record.notebook_path);
  if (name === 'Edit' || name === 'MultiEdit') {
    const edits = name === 'MultiEdit' && Array.isArray(record.edits) ? record.edits as Array<Record<string, unknown>> : [record];
    const rows = edits.flatMap(edit => diffLines(str(edit.old_string), str(edit.new_string)));
    if (!rows.length) return undefined;
    return { kind: 'edit', path, added: rows.filter(row => row.sign === '+').length, removed: rows.filter(row => row.sign === '-').length, rows: compact(rows) };
  }
  if (name === 'Write' && typeof record.content === 'string') {
    const content = lines(record.content);
    return { kind: 'write', path, lines: content.length, preview: content.slice(0, DETAIL_ROWS) };
  }
  if (name === 'TodoWrite' && Array.isArray(record.todos)) {
    const items = (record.todos as Array<Record<string, unknown>>).flatMap(todo => {
      const status = str(todo.status);
      const text = str(todo.content);
      return text && TODO_STATUS.has(status) ? [{ text, status: status as TodoItem['status'] }] : [];
    });
    return items.length ? { kind: 'todos', items } : undefined;
  }
  return undefined;
}

/** Tool output as kept on the line: tool errors lose their wrapper tag and are flagged. */
export function toolOutput(fullText: string): { output: string; error: boolean } {
  const match = /^\s*<tool_use_error>([^]*?)<\/tool_use_error>\s*$/.exec(fullText);
  const text = match ? match[1]!.trim() : fullText.replace(/\s+$/, '');
  return { output: text.length > OUTPUT_KEEP ? text.slice(0, OUTPUT_KEEP) : text, error: !!match };
}

export function countLines(text: string): number { return text ? text.split('\n').length : 0; }
