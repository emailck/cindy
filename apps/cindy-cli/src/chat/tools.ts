/**
 * How tool calls read in the transcript, independent of the renderer: display names, what the call
 * changes (edit diff, written lines, todo list) and how its output is summarized under it.
 */

/**
 * One diff row. `line` is the file line number when known (old numbering for removals, new for the rest);
 * `mark` is the changed character range of a removal / addition paired with its counterpart.
 */
export interface DiffRow { sign: '+' | '-' | ' '; text: string; line?: number; mark?: [number, number] }
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
/** Output kept per tool call: enough for the Ctrl+O viewer, bounded for long sessions. */
export const OUTPUT_KEEP = 60_000;
/** Lines of a Bash command shown on a confirmation. */
export const COMMAND_ROWS = 12;

const NAMES: Record<string, string> = { Edit: 'Update', MultiEdit: 'Update', TodoWrite: 'Update Todos' };

const EXEC_PREFIX = 'mcp__cindy_exec__';

/** The remote Agent's file and command tools are Cindy tools on its side; they read as the built-in ones here. */
export function builtinName(name: string): string {
  return name.startsWith(EXEC_PREFIX) ? name.slice(EXEC_PREFIX.length) : name;
}

/** `mcp__server__tool` reads as `server - tool (MCP)`; built-in tools keep their name (Edit reads as Update). */
export function toolDisplayName(name: string): string {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) return `${mcp[1]} - ${mcp[2]} (MCP)`;
  return NAMES[name] ?? name;
}

/** Read and search calls that collapse into one transcript row when they follow each other. */
export const GROUPED_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead']);
/** Calls that run a sub-Agent; its own tool calls are shown under them. */
export const SUBAGENT_TOOLS = new Set(['Task', 'Agent']);

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

/** Numbers the rows from `start`: removals and context count on the old file, additions and context on the new one. */
function numberRows(rows: DiffRow[], start: number): DiffRow[] {
  let oldLine = start;
  let newLine = start;
  return rows.map(row => {
    if (row.sign === '-') return { ...row, line: oldLine++ };
    if (row.sign === '+') return { ...row, line: newLine++ };
    oldLine++;
    return { ...row, line: newLine++ };
  });
}

/**
 * Word-level change marks: a run of removals followed by as many additions pairs them row by row; each pair
 * marks the part between their common start and common end, so the changed words stand out.
 */
export function markChanges(rows: DiffRow[]): DiffRow[] {
  const out = rows.map(row => ({ ...row }));
  for (let index = 0; index < out.length;) {
    if (out[index]!.sign !== '-') { index++; continue; }
    let removed = index;
    while (removed < out.length && out[removed]!.sign === '-') removed++;
    let added = removed;
    while (added < out.length && out[added]!.sign === '+') added++;
    if (removed - index === added - removed) {
      for (let k = 0; k < removed - index; k++) {
        const a = out[index + k]!;
        const b = out[removed + k]!;
        let prefix = 0;
        while (prefix < a.text.length && prefix < b.text.length && a.text[prefix] === b.text[prefix]) prefix++;
        let suffix = 0;
        while (suffix < a.text.length - prefix && suffix < b.text.length - prefix && a.text[a.text.length - 1 - suffix] === b.text[b.text.length - 1 - suffix]) suffix++;
        // Only worth marking when the rows share something; a rewritten row is changed as a whole.
        if (prefix + suffix === 0) continue;
        if (a.text.length - suffix > prefix) a.mark = [prefix, a.text.length - suffix];
        if (b.text.length - suffix > prefix) b.mark = [prefix, b.text.length - suffix];
      }
    }
    index = Math.max(added, index + 1);
  }
  return out;
}

/** Keeps changed rows with `context` rows around each change, like a compact unified diff. */
function compact(rows: DiffRow[], context: number): DiffRow[] {
  const changed = rows.map(row => row.sign !== ' ');
  return rows.filter((_, index) => {
    for (let offset = -context; offset <= context; offset++) if (changed[index + offset]) return true;
    return false;
  });
}

const TODO_STATUS = new Set(['pending', 'in_progress', 'completed']);

/** Rows of the file around an edit, for line numbers and surrounding context. Null when the file cannot be read. */
export type ReadText = (path: string) => string | null;

const FILE_CONTEXT = 2;

/** An edit's diff placed in its file: numbered from the line where `before` starts, with file lines around it. */
function placeEdit(before: string, after: string, file: string | null): DiffRow[] {
  const rows = diffLines(before, after);
  if (!file) return rows;
  // Normally the call is shown before it runs; if it already ran, the file holds the new text instead.
  const found = before ? file.indexOf(before) : -1;
  const ran = found < 0 && after ? file.indexOf(after) : -1;
  const at = found >= 0 ? found : ran;
  if (at < 0) return rows;
  const placed = found >= 0 ? before : after;
  const start = file.slice(0, at).split('\n').length;
  const fileLines = file.split('\n');
  const end = start + lines(placed).length - 1;
  const head = fileLines.slice(Math.max(0, start - 1 - FILE_CONTEXT), start - 1).map(text => ({ sign: ' ' as const, text }));
  const tail = fileLines.slice(end, end + FILE_CONTEXT).map(text => ({ sign: ' ' as const, text }));
  // Only whole-line edits get file context: a partial-line edit's first row is not the file's full line.
  const next = file[at + placed.length];
  const whole = (at === 0 || file[at - 1] === '\n') && (next === undefined || next === '\n' || placed.endsWith('\n'));
  return numberRows(whole ? [...head, ...rows, ...tail] : rows, whole ? start - head.length : start);
}

export function toolDetail(name: string, input: unknown, readText?: ReadText): ToolDetail | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const record = input as Record<string, unknown>;
  const path = str(record.file_path) || str(record.path) || str(record.notebook_path);
  if (name === 'Edit' || name === 'MultiEdit') {
    const edits = name === 'MultiEdit' && Array.isArray(record.edits) ? record.edits as Array<Record<string, unknown>> : [record];
    const file = readText && path ? readText(path) : null;
    let rows: DiffRow[] = [];
    let current = file;
    for (const edit of edits) {
      const before = str(edit.old_string);
      const after = str(edit.new_string);
      rows = [...rows, ...placeEdit(before, after, current)];
      // MultiEdit applies its edits in order: later ones are found in the text the earlier ones produced.
      if (current !== null && before) current = current.replace(before, after);
    }
    const changed = rows.filter(row => row.sign !== ' ');
    if (!changed.length) return undefined;
    return { kind: 'edit', path, added: changed.filter(row => row.sign === '+').length, removed: changed.filter(row => row.sign === '-').length, rows: markChanges(compact(rows, FILE_CONTEXT)) };
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

/** The full command of a Bash call, for its confirmation; null for other tools. */
export function commandText(name: string, input: unknown): string | null {
  if (name !== 'Bash' || !input || typeof input !== 'object') return null;
  const command = str((input as Record<string, unknown>).command).trim();
  return command || null;
}

/** Tool output as kept on the line: tool errors lose their wrapper tag and are flagged. */
export function toolOutput(fullText: string): { output: string; error: boolean; truncated: boolean } {
  const match = /^\s*<tool_use_error>([^]*?)<\/tool_use_error>\s*$/.exec(fullText);
  const text = match ? match[1]!.trim() : fullText.replace(/\s+$/, '');
  const truncated = text.length > OUTPUT_KEEP;
  return { output: truncated ? text.slice(0, OUTPUT_KEEP) : text, error: !!match, truncated };
}

export function countLines(text: string): number { return text ? text.split('\n').length : 0; }
