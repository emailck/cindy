/**
 * Ink view over ChatController. Every color comes from the active theme (theme.ts): dark and light use the
 * Desktop token values for the same roles, ansi uses only the terminal's own palette. /theme switches them.
 */
import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Box, Static, Text, useApp, useInput, usePaste, useWindowSize } from 'ink';
import { commandDescription, commandSuggestions, type ChatController, type Line, type Prompt } from './controller';
import type { Translate } from '../i18n';
import { parseMarkdown, type MdLine, type Span } from './markdown';
import { countLines, DETAIL_ROWS, OUTPUT_ROWS, toolDisplayName } from './tools';
import { THEMES, type Theme } from './theme';

const ThemeContext = createContext<Theme>(THEMES.ansi);
const useTheme = () => useContext(ThemeContext);

/** Terminal column width: CJK and full-width characters take two columns (help key column alignment). */
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    width += (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) ? 2 : 1;
  }
  return width;
}

/**
 * The last `rows` terminal rows of `text` wrapped at `columns`. Ink clears the screen and rewrites the whole
 * transcript on every frame while the live area is taller than the terminal, so live text never grows past it;
 * the full text is printed once it is committed.
 */
export function tailRows(text: string, rows: number, columns: number): string {
  const width = Math.max(1, columns);
  const kept: string[] = [];
  let left = Math.max(1, rows);
  const lines = text.split('\n');
  for (let index = lines.length - 1; index >= 0 && left > 0; index--) {
    const line = lines[index]!;
    const height = Math.max(1, Math.ceil(displayWidth(line) / width));
    if (height <= left) { kept.unshift(line); left -= height; continue; }
    // Keep the end of an over-long line: drop characters from its start until it fits.
    let start = 0;
    let over = displayWidth(line) - left * width;
    const chars = [...line];
    while (over > 0 && start < chars.length) { over -= displayWidth(chars[start]!); start++; }
    kept.unshift(chars.slice(start).join(''));
    left = 0;
  }
  return kept.join('\n');
}

/** Rows kept free below the live text for the status, input box, queue preview and footer. */
const RESERVED_ROWS = 12;

const WINDOWS = process.platform === 'win32';
/** Marks the start of a reply or tool call; the Windows console font often lacks ⏺. */
const DOT = WINDOWS ? '●' : '⏺';
/** A glyph that grows and shrinks; Windows consoles get braille dots, which every console font has. */
const SPINNER = WINDOWS ? ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] : ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];

export function elapsedText(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

/** `✻ Working… (12s · Esc interrupt …)`: its own timer, so the transcript does not re-render with it. */
function Status({ text, keys, startedAt }: { text: string; keys?: string; startedAt: number | null }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setFrame(value => value + 1), 120);
    return () => clearInterval(timer);
  }, []);
  const theme = useTheme();
  const extra = [...(startedAt !== null ? [elapsedText(Date.now() - startedAt)] : []), ...(keys ? [keys] : [])];
  return (
    <Box marginTop={1}>
      <Text {...theme.running}>{SPINNER[frame % SPINNER.length]}</Text>
      <Text {...theme.running}>{` ${text}`}</Text>
      {extra.length ? <Text {...theme.faint}>{` (${extra.join(' · ')})`}</Text> : null}
    </Box>
  );
}

/** A running tool call's dot blinks; finished and committed ones stay still. */
function Blink({ children }: { children: string }) {
  const [on, setOn] = useState(true);
  useEffect(() => {
    const timer = setInterval(() => setOn(value => !value), 500);
    return () => clearInterval(timer);
  }, []);
  return <Text {...useTheme().muted}>{on ? children : ' '}</Text>;
}

/** Two-column row: a mark in the gutter, content wrapping in its own column (continuation lines stay aligned). */
function Gutter({ mark, children, width = 2 }: { mark: ReactNode; children: ReactNode; width?: number }) {
  return (
    <Box>
      <Box width={width} flexShrink={0}>{typeof mark === 'string' ? <Text>{mark}</Text> : mark}</Box>
      <Box flexDirection="column" flexGrow={1} flexShrink={1}>{children}</Box>
    </Box>
  );
}

function SpanText({ span }: { span: Span }) {
  const theme = useTheme();
  const tone = span.code ? theme.code : span.tone ? theme.syntax[span.tone] : span.dim ? theme.muted : undefined;
  return (
    <Text bold={span.bold} italic={span.italic || span.tone === 'comment'} strikethrough={span.strike} underline={span.underline} {...tone}>
      {span.text}
    </Text>
  );
}

function MdRow({ line }: { line: MdLine }) {
  const theme = useTheme();
  if (line.block === 'rule') return <Text {...theme.faint}>{'─'.repeat(40)}</Text>;
  // An empty Text has no height: keep blank lines of a reply.
  if (!line.prefix && line.spans.every(span => !span.text)) return <Text> </Text>;
  return (
    <Text underline={line.block === 'heading1'}>
      {line.prefix ? <Text {...(line.block === 'quote' ? theme.faint : line.block === 'item' ? theme.muted : {})}>{line.prefix}</Text> : null}
      {line.spans.map((span, index) => <SpanText key={index} span={span} />)}
    </Text>
  );
}

function Markdown({ text, code }: { text: string; code?: boolean }) {
  return <>{parseMarkdown(text, code).map((line, index) => <MdRow key={index} line={line} />)}</>;
}

/** Output lines under a tool call: the first few, then how many more. */
function outputRows(text: string, t: Translate, theme: Theme, error?: boolean): ReactNode[] {
  if (!text.trim()) return [<Text key="empty" {...theme.faint}>{t('tool.noContent')}</Text>];
  const rows = text.split('\n');
  const shown = rows.length > OUTPUT_ROWS + 1 ? OUTPUT_ROWS : rows.length;
  return [
    ...rows.slice(0, shown).map((row, index) => <Text key={index} {...(error ? theme.error : theme.muted)} wrap="truncate-end">{row || ' '}</Text>),
    ...(rows.length > shown ? [<Text key="more" {...theme.faint}>{t('tool.more', { count: rows.length - shown })}</Text>] : []),
  ];
}

function toolBody(line: Extract<Line, { kind: 'tool' }>, t: Translate, theme: Theme): ReactNode[] {
  const detail = line.detail;
  if (detail?.kind === 'todos') {
    return detail.items.map((item, index) => item.status === 'completed'
      ? <Text key={index} {...theme.faint} strikethrough>{`☒ ${item.text}`}</Text>
      : item.status === 'in_progress' ? <Text key={index} bold {...theme.info}>{`◼ ${item.text}`}</Text>
        : <Text key={index}>{`☐ ${item.text}`}</Text>);
  }
  if (line.result === undefined) return [];
  if (line.error) return outputRows(line.result, t, theme, true);
  if (line.name === 'Read') return [<Text key="read">{t('tool.read', { count: countLines(line.result) })}</Text>];
  if (detail?.kind === 'edit') {
    const rows = detail.rows.slice(0, DETAIL_ROWS);
    return [
      <Text key="summary">{t('tool.updated', { path: detail.path, added: detail.added, removed: detail.removed })}</Text>,
      ...rows.map((row, index) => {
        const tone = row.sign === '+' ? theme.add : row.sign === '-' ? theme.remove : theme.faint;
        // The row's background fills the line, not just its characters.
        return <Box key={index} {...(tone.backgroundColor ? { backgroundColor: tone.backgroundColor } : {})}><Text {...tone} wrap="truncate-end">{`${row.sign} ${row.text}`}</Text></Box>;
      }),
      ...(detail.rows.length > rows.length ? [<Text key="more" {...theme.faint}>{t('tool.more', { count: detail.rows.length - rows.length })}</Text>] : []),
    ];
  }
  if (detail?.kind === 'write') {
    return [
      <Text key="summary">{t('tool.wrote', { count: detail.lines, path: detail.path })}</Text>,
      ...detail.preview.map((row, index) => <Text key={index} {...theme.muted} wrap="truncate-end">{row || ' '}</Text>),
      ...(detail.lines > detail.preview.length ? [<Text key="more" {...theme.faint}>{t('tool.more', { count: detail.lines - detail.preview.length })}</Text>] : []),
    ];
  }
  return outputRows(line.result, t, theme);
}

/** Terminal rows a transcript line takes, roughly (keeps the live area within the window). */
function lineRows(line: Line, t: Translate): number {
  if (line.kind === 'tool') return 2 + toolBody(line, t, THEMES.ansi).length;
  if (line.kind === 'help') return 1 + line.sections.reduce((rows, section) => rows + 2 + section.rows.length, 0);
  return 1 + line.text.split('\n').length;
}

function TranscriptLine({ line, t, live }: { line: Line; t: Translate; /** In the live area (not yet printed for good). */ live?: boolean }) {
  const theme = useTheme();
  switch (line.kind) {
    case 'user':
      return <Box marginTop={1}><Gutter mark={<Text {...theme.faint}>{'>'}</Text>}><Text {...theme.muted}>{line.text}{line.steer ? <Text {...theme.info}>{`  [${t('chat.steerTag')}]`}</Text> : null}</Text></Gutter></Box>;
    case 'assistant':
      return <Box marginTop={line.cont ? 0 : 1}><Gutter mark={line.cont ? '' : DOT}><Markdown text={line.text} code={line.code} /></Gutter></Box>;
    case 'help': {
      const width = Math.max(...line.sections.flatMap(section => section.rows.map(([keys]) => displayWidth(keys)))) + 2;
      return (
        <Box flexDirection="column" marginTop={1}>
          {line.sections.map(section => (
            <Box key={section.title} flexDirection="column" marginBottom={1}>
              <Text bold>{section.title}</Text>
              {section.rows.map(([keys, description]) => (
                <Box key={keys}>
                  <Box width={width + 2} flexShrink={0}><Text {...theme.info}>{`  ${keys}`}</Text></Box>
                  <Text>{description}</Text>
                </Box>
              ))}
            </Box>
          ))}
        </Box>
      );
    }
    case 'tool': {
      const done = line.result !== undefined;
      const mark = line.error ? <Text {...theme.error}>{DOT}</Text> : done ? <Text {...theme.success}>{DOT}</Text> : live ? <Blink>{DOT}</Blink> : <Text {...theme.faint}>{DOT}</Text>;
      const body = toolBody(line, t, theme);
      return (
        <Box flexDirection="column" marginTop={1}>
          <Gutter mark={mark}><Text><Text bold>{toolDisplayName(line.name)}</Text>{line.summary ? <Text {...theme.muted}>{`(${line.summary})`}</Text> : null}</Text></Gutter>
          {body.length ? <Gutter width={5} mark={<Text {...theme.faint}>{'  ⎿  '}</Text>}>{body}</Gutter> : null}
        </Box>
      );
    }
    default:
      return <Box marginTop={1}><Text {...(line.tone === 'error' ? theme.error : line.tone === 'warn' ? theme.warning : theme.muted)}>{line.text}</Text></Box>;
  }
}

/** Long lists (a provider can offer 30+ models) scroll in a fixed window around the selection. */
export const CHOICE_WINDOW = 10;

function Choices({ prompt, t }: { prompt: Prompt; t: Translate }) {
  const theme = useTheme();
  const total = prompt.choices.length;
  const start = total <= CHOICE_WINDOW ? 0 : Math.min(Math.max(0, prompt.index - Math.floor(CHOICE_WINDOW / 2)), total - CHOICE_WINDOW);
  const end = Math.min(total, start + CHOICE_WINDOW);
  let group = start > 0 ? prompt.choices[start - 1]!.group : undefined;
  return (
    <Box flexDirection="column">
      {start > 0 ? <Text {...theme.faint}>{`  ${t('picker.moreAbove', { count: start })}`}</Text> : null}
      {prompt.choices.slice(start, end).map((choice, offset) => {
        const index = start + offset;
        const header = choice.group && choice.group !== group ? (group = choice.group) : undefined;
        const selected = index === prompt.index;
        return (
          <Box key={`${index}-${choice.label}`} flexDirection="column">
            {header ? <Text {...theme.faint}>{header}</Text> : null}
            <Text {...(selected ? theme.info : choice.disabled ? theme.faint : {})}>
              {selected ? '❯ ' : '  '}{total <= 9 && prompt.kind !== 'picker' ? `${index + 1}. ` : ''}
              {prompt.kind === 'question' && prompt.question.multiSelect && index < (prompt.question.options?.length ?? 0) ? (prompt.selected.includes(index) ? '[x] ' : '[ ] ') : ''}{choice.label}
              {choice.detail ? <Text {...theme.faint}>{`  ${choice.detail}`}</Text> : null}
            </Text>
          </Box>
        );
      })}
      {end < total ? <Text {...theme.faint}>{`  ${t('picker.moreBelow', { count: total - end })}`}</Text> : null}
    </Box>
  );
}

function PromptView({ prompt, hint, t }: { prompt: Prompt; hint: string; t: Translate }) {
  const theme = useTheme();
  if (prompt.kind === 'picker') {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1}>
        <Text bold>{prompt.title}</Text>
        <Choices prompt={prompt} t={t} />
        <Text {...theme.faint}>{prompt.back ? t('picker.hintBack') : hint}</Text>
      </Box>
    );
  }
  if (prompt.kind === 'permission') {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.attention} paddingX={1}>
        <Text bold color={theme.attention}>{prompt.title}</Text>
        {prompt.summary ? <Text>{prompt.summary}</Text> : null}
        {prompt.description ? <Text {...theme.muted}>{prompt.description}</Text> : null}
        <Choices prompt={prompt} t={t} />
      </Box>
    );
  }
  if (prompt.kind === 'question') {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.info.color ?? theme.border} paddingX={1}>
        <Text bold>{prompt.question.header ? `${prompt.question.header}: ` : ''}{prompt.question.question}{prompt.position ? <Text {...theme.faint}>{`  ${prompt.position}`}</Text> : null}</Text>
        <Choices prompt={prompt} t={t} />
      </Box>
    );
  }
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.info.color ?? theme.border} paddingX={1}>
      <Text bold>{hint}</Text>
      <Text>{prompt.plan}</Text>
      <Choices prompt={prompt} t={t} />
      <Text {...theme.faint}>{t('ask.planHint')}</Text>
    </Box>
  );
}

export interface Editor { value: string; cursor: number }

const WORD = /[\p{L}\p{N}_]/u;

/**
 * Editing moves on the input (cursor is a UTF-16 index). Lines are the input's own lines; a word is a run of
 * letters, digits or underscores, as in shells.
 */
export const edit = {
  lineStart: ({ value, cursor }: Editor) => value.lastIndexOf('\n', cursor - 1) + 1,
  lineEnd: ({ value, cursor }: Editor) => { const end = value.indexOf('\n', cursor); return end < 0 ? value.length : end; },
  wordLeft({ value, cursor }: Editor): number {
    let index = cursor;
    while (index > 0 && !WORD.test(value[index - 1]!)) index--;
    while (index > 0 && WORD.test(value[index - 1]!)) index--;
    return index;
  },
  wordRight({ value, cursor }: Editor): number {
    let index = cursor;
    while (index < value.length && !WORD.test(value[index]!)) index++;
    while (index < value.length && WORD.test(value[index]!)) index++;
    return index;
  },
  /** Cursor one line up (-1) or down (1) at the same column, or null on the first / last line. */
  vertical(editor: Editor, delta: -1 | 1): number | null {
    const start = edit.lineStart(editor);
    const column = editor.cursor - start;
    if (delta < 0) {
      if (start === 0) return null;
      const previousStart = editor.value.lastIndexOf('\n', start - 2) + 1;
      return Math.min(previousStart + column, start - 1);
    }
    const end = edit.lineEnd(editor);
    if (end >= editor.value.length) return null;
    return Math.min(end + 1 + column, edit.lineEnd({ value: editor.value, cursor: end + 1 }));
  },
  remove: ({ value }: Editor, from: number, to: number): Editor => ({ value: value.slice(0, from) + value.slice(to), cursor: from }),
};

function InputBox({ editor, placeholder }: { editor: Editor; placeholder: string }) {
  const theme = useTheme();
  const before = editor.value.slice(0, editor.cursor);
  const at = editor.value[editor.cursor] ?? ' ';
  const after = editor.value.slice(editor.cursor + 1);
  return (
    <Box borderStyle="round" borderColor={theme.border} paddingX={1}>
      <Text {...theme.muted}>{'> '}</Text>
      {editor.value ? (
        <Text>{before}<Text inverse>{at === '\n' ? ' ' : at}</Text>{at === '\n' ? '\n' : ''}{after}</Text>
      ) : (
        <Text><Text inverse> </Text><Text {...theme.faint}>{placeholder}</Text></Text>
      )}
    </Box>
  );
}

export function App({ controller, header }: { controller: ChatController; header: string }) {
  const app = useApp();
  const windowSize = useWindowSize();
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const t = controller.translate();
  const theme = THEMES[snapshot.theme];
  const [editor, setEditor] = useState<Editor>({ value: '', cursor: 0 });
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [suggestion, setSuggestion] = useState(0);
  const prompt = snapshot.prompt;
  const typing = !prompt || prompt.kind === 'question' || prompt.kind === 'plan';
  const suggestions = typing ? commandSuggestions(editor.value) : [];
  const selected = suggestions[Math.min(suggestion, suggestions.length - 1)];
  useEffect(() => { setSuggestion(0); }, [editor.value]);

  useEffect(() => { if (snapshot.exited) app.exit(); }, [snapshot.exited, app]);

  const insert = (text: string) => setEditor(current => ({ value: current.value.slice(0, current.cursor) + text + current.value.slice(current.cursor), cursor: current.cursor + text.length }));
  usePaste(text => { if (typing) insert(text.replace(/\r\n?/g, '\n')); });

  useInput((input, key) => {
    if (key.ctrl && input === 'c') { controller.ctrlC(); return; }
    if (key.escape) {
      if (prompt) controller.cancelPrompt();
      else if (snapshot.phase === 'running') controller.interrupt();
      else setEditor({ value: '', cursor: 0 });
      return;
    }
    if (key.tab && key.shift) { void controller.cyclePermission(); return; }
    if (key.ctrl && input === 's') {
      const value = editor.value;
      setEditor({ value: '', cursor: 0 });
      void controller.steer(value);
      return;
    }
    if (prompt && prompt.kind !== 'question' && prompt.kind !== 'plan') {
      if (key.upArrow) controller.move(-1);
      else if (key.downArrow) controller.move(1);
      else if (key.return) controller.choose();
      else if (/^[1-9]$/.test(input) && Number(input) <= prompt.choices.length) controller.choose(Number(input) - 1);
      return;
    }
    if ((prompt?.kind === 'question' || prompt?.kind === 'plan') && !editor.value) {
      if (key.upArrow) { controller.move(-1); return; }
      if (key.downArrow) { controller.move(1); return; }
      if (key.return) { controller.choose(); return; }
      const multi = prompt.kind === 'question' && prompt.question.multiSelect;
      if (input === ' ' && multi) { controller.toggle(); return; }
      if (/^[1-9]$/.test(input) && Number(input) <= prompt.choices.length) {
        if (multi && Number(input) <= (prompt.question.options?.length ?? 0)) controller.toggle(Number(input) - 1);
        else controller.choose(Number(input) - 1);
        return;
      }
    }
    // ↑/↓ choose among the listed commands; Tab completes and Enter runs the highlighted one.
    if ((key.upArrow || key.downArrow) && suggestions.length > 1) {
      setSuggestion(index => (index + (key.upArrow ? -1 : 1) + suggestions.length) % suggestions.length);
      return;
    }
    // ? on an empty input opens the operations guide (Claude Code parity).
    if (input === '?' && !prompt && !editor.value) { void controller.submit('/help'); return; }
    // ↑ on an empty line with queued messages: take the last one back for editing (Claude Code parity).
    if (key.upArrow && !prompt && !editor.value && snapshot.queue.length) {
      const text = controller.popQueued();
      if (text !== null) setEditor({ value: text, cursor: text.length });
      return;
    }
    if (key.return) {
      if (editor.value.endsWith('\\')) { setEditor(current => ({ value: `${current.value.slice(0, -1)}\n`, cursor: current.value.length })); return; }
      const value = selected ? `/${selected}` : editor.value;
      if (value.trim()) setHistory(items => [...items.filter(item => item !== value), value].slice(-100));
      setHistoryIndex(null);
      setEditor({ value: '', cursor: 0 });
      void controller.submit(value);
      return;
    }
    if (key.tab && selected) { const value = `/${selected} `; setEditor({ value, cursor: value.length }); return; }
    // In a multi-line input ↑/↓ move between its lines; history only from the first / last line.
    if (key.upArrow || key.downArrow) {
      const cursor = edit.vertical(editor, key.upArrow ? -1 : 1);
      if (cursor !== null) { setEditor({ ...editor, cursor }); return; }
      if (!history.length) return;
      const next = historyIndex === null ? (key.upArrow ? history.length - 1 : null) : historyIndex + (key.upArrow ? -1 : 1);
      if (next === null || next >= history.length) { setHistoryIndex(null); setEditor({ value: '', cursor: 0 }); return; }
      const index = Math.max(0, next);
      setHistoryIndex(index);
      setEditor({ value: history[index]!, cursor: history[index]!.length });
      return;
    }
    const move = (cursor: (current: Editor) => number) => setEditor(current => ({ ...current, cursor: cursor(current) }));
    // Word moves: Alt+←/→ (macOS Option), Ctrl+←/→ and Alt+B / Alt+F as in shells.
    if ((key.leftArrow && (key.meta || key.ctrl)) || (key.meta && input === 'b')) { move(edit.wordLeft); return; }
    if ((key.rightArrow && (key.meta || key.ctrl)) || (key.meta && input === 'f')) { move(edit.wordRight); return; }
    if (key.leftArrow) { move(current => Math.max(0, current.cursor - 1)); return; }
    if (key.rightArrow) { move(current => Math.min(current.value.length, current.cursor + 1)); return; }
    if (key.home || (key.ctrl && input === 'a')) { move(edit.lineStart); return; }
    if (key.end || (key.ctrl && input === 'e')) { move(edit.lineEnd); return; }
    if (key.ctrl && input === 'u') { setEditor({ value: '', cursor: 0 }); return; }
    if (key.ctrl && input === 'j') { insert('\n'); return; }
    if ((key.ctrl && input === 'w') || (key.backspace && key.meta)) { setEditor(current => edit.remove(current, edit.wordLeft(current), current.cursor)); return; }
    if (key.ctrl && input === 'k') {
      // At the end of a line, Ctrl+K joins the next line (removes the line break).
      setEditor(current => { const end = edit.lineEnd(current); return edit.remove(current, current.cursor, end === current.cursor ? Math.min(end + 1, current.value.length) : end); });
      return;
    }
    if (key.backspace) { setEditor(current => (current.cursor === 0 ? current : edit.remove(current, current.cursor - 1, current.cursor))); return; }
    if (key.delete) { setEditor(current => edit.remove(current, current.cursor, Math.min(current.value.length, current.cursor + 1))); return; }
    if (input && !key.ctrl && !key.meta) insert(input);
  });

  // <Static> prints each line once: keep lines from the first tool still awaiting its result live until the turn ends.
  // The boundary only moves forward (lines are append-only), so nothing is printed twice.
  const committedCount = useRef(0);
  const firstPending = snapshot.phase === 'idle' ? -1
    : snapshot.lines.findIndex((line, index) => index >= committedCount.current && line.kind === 'tool' && line.result === undefined);
  committedCount.current = Math.max(committedCount.current, firstPending < 0 ? snapshot.lines.length : firstPending);
  const committed = snapshot.lines.slice(0, committedCount.current);
  const pending = snapshot.lines.slice(committedCount.current);
  const pendingRows = pending.reduce((rows, line) => rows + lineRows(line, t), 0);
  const model = snapshot.model;
  const status = snapshot.phase === 'connecting'
    ? t('chat.connecting', { where: model?.targetLabel ?? '' })
    : snapshot.phase === 'running' ? (prompt ? t('chat.waitingAnswer') : t(snapshot.thinking ? 'chat.thinking' : 'chat.working')) : '';
  const statusKeys = snapshot.phase === 'running' && !prompt ? t('chat.workingKeys') : undefined;
  const queue = snapshot.queue;
  // Footer left: the exit hint, a non-default permission mode, or where to find all keys (Claude Code parity).
  const mode = snapshot.exitArmed ? <Text>{t('chat.exitHint')}</Text>
    : snapshot.permission === 'full' ? <Text {...theme.full}>{t('footer.full')}</Text>
      : snapshot.permission === 'plan' ? <Text {...theme.info}>{t('footer.plan')}</Text>
        : !editor.value && !prompt ? <Text {...theme.faint}>{t('footer.shortcuts')}</Text> : <Text> </Text>;
  return (
    <ThemeContext.Provider value={theme}>
    <Box flexDirection="column">
      <Static items={[{ id: 'header', kind: 'notice', tone: 'info', text: header } as Line, ...committed]}>
        {/* <Static> lays lines out shrink-to-fit; the terminal width lets diff backgrounds span the row. */}
        {line => <Box key={line.id} flexDirection="column" width={windowSize.columns}><TranscriptLine line={line} t={t} /></Box>}
      </Static>
      {pending.map(line => <TranscriptLine key={line.id} line={line} t={t} live />)}
      {snapshot.live ? (
        <Box marginTop={snapshot.liveCont ? 0 : 1}>
          <Gutter mark={snapshot.liveCont ? '' : DOT}>
            <Markdown text={tailRows(snapshot.live, windowSize.rows - RESERVED_ROWS - pendingRows, windowSize.columns - 2)} code={snapshot.liveCode} />
          </Gutter>
        </Box>
      ) : null}
      {status ? <Status text={status} {...(statusKeys ? { keys: statusKeys } : {})} startedAt={snapshot.phase === 'running' ? snapshot.turnStartedAt : null} /> : null}
      <Box marginTop={1} flexDirection="column">
        {prompt ? <PromptView prompt={prompt} t={t} hint={prompt.kind === 'plan' ? t('ask.planTitle') : t('picker.hint')} /> : null}
        {queue.length ? (
          <Box flexDirection="column" paddingX={2}>
            <Text {...(snapshot.queuePaused ? theme.warning : theme.muted)}>
              {snapshot.queuePaused ? t('chat.queuePaused', { count: queue.length }) : t('chat.queued', { count: queue.length })}
            </Text>
            {queue.slice(0, 3).map((item, index) => <Text key={item.id} {...theme.faint}>{`  ${index + 1}. ${item.text.split('\n')[0]!.slice(0, 100)}`}</Text>)}
            {queue.length > 3 ? <Text {...theme.faint}>{`  ${t('chat.queueMore', { count: queue.length - 3 })}`}</Text> : null}
            <Text {...theme.faint}>{`  ${t('chat.queueHint')}`}</Text>
          </Box>
        ) : null}
        {typing ? <InputBox editor={editor} placeholder={prompt?.kind === 'question' ? t(prompt.question.multiSelect ? 'ask.multiHint' : 'ask.questionHint') : prompt?.kind === 'plan' ? t('ask.planHint') : t('chat.hint')} /> : null}
        {suggestions.length ? (
          <Box flexDirection="column" paddingX={2}>
            {suggestions.map(name => (
              <Text key={name}>
                <Text {...(name === selected ? theme.info : theme.muted)} bold={name === selected}>{`/${name.padEnd(12)}`}</Text>
                <Text {...(name === selected ? theme.info : theme.faint)}>{commandDescription(t, name)}</Text>
              </Text>
            ))}
          </Box>
        ) : null}
        <Box paddingX={2} justifyContent="space-between">
          {mode}
          <Text {...theme.faint}>{model ? `${model.modelName}${snapshot.effort ? ` (${snapshot.effort})` : ''} · ${model.targetLabel}` : t('chat.noModel')}</Text>
        </Box>
      </Box>
    </Box>
    </ThemeContext.Provider>
  );
}
