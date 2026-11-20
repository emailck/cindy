/**
 * Ink view over ChatController. Every color comes from the active theme (theme.ts): dark and light use the
 * Desktop token values for the same roles, ansi uses only the terminal's own palette. /theme switches them.
 */
import { createContext, memo, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Box, Static, Text, useInput, usePaste, useWindowSize, useBoxMetrics, useCursor, measureElement, type DOMElement } from 'ink';
import {
  cacheHitRate, CHILD_ROWS, commandDescription, commandSuggestions, mentionAt, openGroupIndex,
  type ChatController, type GroupItem, type ImageAttachment, type Line, type Prompt, type UsageView,
} from './controller';
import type { Translate } from '../i18n';
import { parseMarkdown, tailMarkdownRows, type MdLine, type Span } from './markdown';
import { countLines, DETAIL_ROWS, OUTPUT_ROWS, toolDisplayName, type DiffRow } from './tools';
import { THEMES, themeFor, type Theme, type Tone } from './theme';
import { viewItems, wrapView, diffRowsText, type ViewItem, type ViewRow } from './viewer';
import { displayWidth, truncateWidth } from './width';
import { resolveCommand } from './commands';
import { edit, inputViewport, moveVertical, type Editor } from './input/editor';
export { edit, type Editor } from './input/editor';

export { displayWidth } from './width';

const ThemeContext = createContext<Theme>(THEMES.ansi);
const useTheme = () => useContext(ThemeContext);
/** Whether the terminal renders OSC 8 hyperlinks (link text clickable, no URL printed after it). */
const LinkContext = createContext(false);

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

const WINDOWS = process.platform === 'win32';
/** Marks the start of a reply or tool call; the Windows console font often lacks ⏺. */
const DOT = WINDOWS ? '●' : '⏺';
/** A glyph that grows and shrinks; Windows consoles get braille dots, which every console font has. */
const SPINNER = WINDOWS ? ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] : ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];
/** Marks a finished thinking block. */
const THOUGHT = WINDOWS ? '*' : '∴';

export function elapsedText(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

/** `✻ Working… (12s · Esc interrupt …)`: its own timer, so the transcript does not re-render with it. */
function Status({ text, keys, startedAt, tone }: { text: string; keys?: string; startedAt: number | null; tone?: Tone }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setFrame(value => value + 1), 120);
    return () => clearInterval(timer);
  }, []);
  const theme = useTheme();
  const color = tone ?? theme.running;
  const extra = [...(startedAt !== null ? [elapsedText(Date.now() - startedAt)] : []), ...(keys ? [keys] : [])];
  return (
    <Box marginTop={1}>
      <Text {...color}>{SPINNER[frame % SPINNER.length]}</Text>
      <Text {...color}>{` ${text}`}</Text>
      {extra.length ? <Text {...theme.faint}>{` (${extra.join(' · ')})`}</Text> : null}
    </Box>
  );
}

export function compactTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(Math.round(tokens));
}

/** Desktop rounding: whole numbers from 100 tok/s, one decimal below. */
function rateText(rate: number): string {
  if (rate > 0 && rate < 0.1) return '<0.1';
  return rate >= 100 ? rate.toFixed(0) : rate.toFixed(1).replace(/\.0$/, '');
}

function costText(cost: number): string {
  return cost < 0.001 ? '<0.001' : cost.toFixed(cost < 1 ? 3 : 2);
}

/**
 * Output speed at a glance: only the number takes a color, from slow (red) through amber and green to fast
 * (blue). Thresholds follow what current models stream: large models around 30–60 tok/s, small ones past 100.
 */
const SPEED_TONES: ReadonlyArray<{ below: number; tone: 'error' | 'warning' | 'success' | 'info' }> = [
  { below: 20, tone: 'error' },
  { below: 50, tone: 'warning' },
  { below: 100, tone: 'success' },
  { below: Infinity, tone: 'info' },
];

export function speedTone(rate: number): 'error' | 'warning' | 'success' | 'info' {
  return SPEED_TONES.find(level => rate < level.below)!.tone;
}

function Speed({ label, rate, bold }: { label: string; rate: number; bold?: boolean }) {
  const theme = useTheme();
  return (
    <Text>
      <Text {...theme.faint}>{`${label} `}</Text>
      <Text {...theme[speedTone(rate)]} bold={bold}>{rateText(rate)}</Text>
      <Text {...theme.faint}>{' tok/s'}</Text>
    </Text>
  );
}

/** Context nearly full: the user may want /compact soon. */
const CONTEXT_WARN_PERCENT = 80;
/** Context past half: worth keeping an eye on. */
const CONTEXT_NOTICE_PERCENT = 60;
const METER_CELLS = 10;

/** Desktop rounding: a whole percent when within 0.05 of it, otherwise one decimal. */
function percentText(rate: number): string {
  const percent = Math.min(100, Math.max(0, rate * 100));
  return Math.abs(percent - Math.round(percent)) < 0.05 ? `${Math.round(percent)}%` : `${percent.toFixed(1)}%`;
}

/**
 * Status bar under the footer, two rows, each part only once the Agent reports it:
 *   Context ███░░░░░░░ 25% 50k/200k │ This turn 42 tok/s · Avg 30 tok/s │ This task ≈ $0.200
 *   ↑ In 2k  ↓ Out 500 │ Cache read 6k · write 2k · hit 60%
 * The meter and percent turn amber past 60% and red from 80% (time for /compact); the hit rate is green when high;
 * a tok/s figure goes red below 20, amber below 50, green below 100 and blue from 100.
 */
function UsageBar({ usage, t }: { usage: UsageView; t: Translate }) {
  const theme = useTheme();
  const percent = usage.contextWindow ? Math.min(100, Math.round((usage.contextTokens / usage.contextWindow) * 100)) : null;
  const level = percent === null ? theme.muted : percent >= CONTEXT_WARN_PERCENT ? theme.error : percent >= CONTEXT_NOTICE_PERCENT ? theme.warning : theme.success;
  const sep = <Text {...theme.faint}>{'  │  '}</Text>;
  const dot = <Text {...theme.faint}>{' · '}</Text>;
  const groups: ReactNode[] = [];
  if (usage.contextTokens) {
    const filled = percent === null ? 0 : Math.min(METER_CELLS, Math.round(percent / (100 / METER_CELLS)));
    groups.push(
      <Text key="context">
        <Text {...theme.faint}>{`${t('usage.context')} `}</Text>
        {percent !== null ? (
          <Text>
            <Text {...level}>{'█'.repeat(filled)}</Text><Text {...theme.faint}>{'░'.repeat(METER_CELLS - filled)}</Text>
            <Text {...level} bold>{` ${percent}%`}</Text>
            <Text {...theme.muted}>{` ${compactTokens(usage.contextTokens)}/${compactTokens(usage.contextWindow)}`}</Text>
          </Text>
        ) : <Text {...theme.muted}>{compactTokens(usage.contextTokens)}</Text>}
      </Text>,
    );
  }
  const speed: ReactNode[] = [];
  if (usage.turnRate !== null) speed.push(<Speed key="turn" label={t('usage.turn')} rate={usage.turnRate} bold />);
  if (usage.averageRate !== null) speed.push(<Speed key="avg" label={t('usage.average')} rate={usage.averageRate} />);
  if (speed.length) groups.push(<Text key="speed">{speed.map((part, index) => <Text key={index}>{index ? dot : null}{part}</Text>)}</Text>);
  if (usage.costUsd > 0) groups.push(<Text key="cost" {...theme.success}>{t('usage.cost', { cost: costText(usage.costUsd) })}</Text>);

  const tokens = usage.tokens;
  const hit = tokens ? cacheHitRate(tokens) : null;
  const hitTone = hit === null ? theme.muted : hit >= 0.7 ? theme.success : hit >= 0.3 ? theme.warning : theme.muted;
  const figure = (value: number) => <Text>{compactTokens(value)}</Text>;
  const tokenRow = tokens ? (
    <Text wrap="truncate-end">
      <Text {...theme.info}>{'↑ '}</Text><Text {...theme.faint}>{`${t('usage.input')} `}</Text>{figure(tokens.input)}
      <Text>{'   '}</Text>
      <Text {...theme.running}>{'↓ '}</Text><Text {...theme.faint}>{`${t('usage.output')} `}</Text>{figure(tokens.output)}
      {sep}
      <Text {...theme.faint}>{`${t('usage.cache')} ${t('usage.cacheRead')} `}</Text>{figure(tokens.cacheRead)}
      {dot}<Text {...theme.faint}>{`${t('usage.cacheWrite')} `}</Text>{figure(tokens.cacheWrite)}
      {hit !== null ? <Text>{dot}<Text {...theme.faint}>{`${t('usage.cacheHit')} `}</Text><Text {...hitTone} bold>{percentText(hit)}</Text></Text> : null}
    </Text>
  ) : null;
  if (!groups.length && !tokenRow) return null;
  return (
    <Box paddingX={2} flexDirection="column">
      {groups.length ? <Text wrap="truncate-end">{groups.map((group, index) => <Text key={index}>{index ? sep : null}{group}</Text>)}</Text> : null}
      {/* This task's tokens: input excludes cache; hit rate uses Desktop's formula. */}
      {tokenRow}
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

const OSC8 = '\u001B]8;;';
const BEL = '\u0007';

function SpanText({ span }: { span: Span }) {
  const theme = useTheme();
  const links = useContext(LinkContext);
  if (span.linkFallback && links) return null;
  const tone = span.border ? theme.faint : span.code ? theme.code : span.tone ? theme.syntax[span.tone] : span.dim ? theme.muted : span.href ? theme.info : undefined;
  const text = span.href && links ? `${OSC8}${span.href}${BEL}${span.text}${OSC8}${BEL}` : span.text;
  return (
    <Text bold={span.bold} italic={span.italic || span.tone === 'comment'} strikethrough={span.strike} underline={span.underline} {...tone}>
      {text}
    </Text>
  );
}

function MdRow({ line }: { line: MdLine }) {
  const theme = useTheme();
  if (line.block === 'rule') return <Text {...theme.faint}>{'─'.repeat(40)}</Text>;
  // An empty Text has no height: keep blank lines of a reply.
  if (!line.prefix && line.spans.every(span => !span.text)) return <Text> </Text>;
  return (
    <Text underline={line.block === 'heading1'} wrap={line.block === 'table' ? 'truncate-end' : 'wrap'}>
      {line.prefix ? <Text {...(line.block === 'quote' ? theme.faint : line.block === 'item' ? theme.muted : {})}>{line.prefix}</Text> : null}
      {line.spans.map((span, index) => <SpanText key={index} span={span} />)}
    </Text>
  );
}

const Markdown = memo(function Markdown({ text, code, width, maxRows }: { text: string; code?: boolean; width: number; maxRows?: number }) {
  const parsed = parseMarkdown(text, code, width);
  const lines = maxRows === undefined ? parsed : tailMarkdownRows(parsed, maxRows, width);
  return <>{lines.map((line, index) => <MdRow key={index} line={line} />)}</>;
});

/** Output lines under a tool call: the first few, then how many more (Ctrl+O shows them all). */
function outputRows(text: string, t: Translate, theme: Theme, error?: boolean): ReactNode[] {
  if (!text.trim()) return [<Text key="empty" {...theme.faint}>{t('tool.noContent')}</Text>];
  const rows = text.split('\n');
  const shown = rows.length > OUTPUT_ROWS + 1 ? OUTPUT_ROWS : rows.length;
  return [
    ...rows.slice(0, shown).map((row, index) => <Text key={index} {...(error ? theme.error : theme.muted)} wrap="truncate-end">{row || ' '}</Text>),
    ...(rows.length > shown ? [<Text key="more" {...theme.faint}>{t('tool.more', { count: rows.length - shown })}</Text>] : []),
  ];
}

/** One diff row: line number, sign, text; the changed words get a stronger background. */
function DiffLine({ row, numberWidth }: { row: DiffRow; numberWidth: number }) {
  const theme = useTheme();
  const tone = row.sign === '+' ? theme.add : row.sign === '-' ? theme.remove : theme.faint;
  const word = row.sign === '+' ? theme.addWord : theme.removeWord;
  const number = numberWidth ? `${String(row.line ?? '').padStart(numberWidth)} ` : '';
  const [from, to] = row.mark ?? [0, 0];
  return (
    // The row's background fills the line, not just its characters.
    <Box {...(tone.backgroundColor ? { backgroundColor: tone.backgroundColor } : {})}>
      <Text wrap="truncate-end">
        <Text {...tone} {...(row.sign === ' ' ? {} : { dimColor: false })}>{`${number}${row.sign} `}</Text>
        {row.mark ? (
          <Text {...tone}>{row.text.slice(0, from)}<Text {...word}>{row.text.slice(from, to)}</Text>{row.text.slice(to)}</Text>
        ) : <Text {...tone}>{row.text || ' '}</Text>}
      </Text>
    </Box>
  );
}

function diffRows(rows: readonly DiffRow[], more: number, t: Translate, theme: Theme): ReactNode[] {
  const numberWidth = Math.max(0, ...rows.map(row => String(row.line ?? '').length));
  return [
    ...rows.map((row, index) => <DiffLine key={index} row={row} numberWidth={numberWidth} />),
    ...(more > 0 ? [<Text key="more" {...theme.faint}>{t('tool.more', { count: more })}</Text>] : []),
  ];
}

function numberedRows(rows: readonly string[], more: number, t: Translate, theme: Theme): ReactNode[] {
  const width = String(rows.length).length;
  return [
    ...rows.map((row, index) => <Text key={index} wrap="truncate-end"><Text {...theme.faint}>{`${String(index + 1).padStart(width)} `}</Text><Text {...theme.muted}>{row || ' '}</Text></Text>),
    ...(more > 0 ? [<Text key="more" {...theme.faint}>{t('tool.more', { count: more })}</Text>] : []),
  ];
}

type ToolLine = Extract<Line, { kind: 'tool' }>;

function toolBody(line: ToolLine, t: Translate, theme: Theme): ReactNode[] {
  const detail = line.detail;
  if (detail?.kind === 'todos') {
    return detail.items.map((item, index) => item.status === 'completed'
      ? <Text key={index} {...theme.faint} strikethrough>{`☒ ${item.text}`}</Text>
      : item.status === 'in_progress' ? <Text key={index} bold {...theme.info}>{`◼ ${item.text}`}</Text>
        : <Text key={index}>{`☐ ${item.text}`}</Text>);
  }
  // A sub-Agent: its last few tool calls while it works, then how it went.
  if (line.children?.length || line.task) {
    if (line.result === undefined && !line.interrupted) {
      const count = line.childCount ?? 0;
      return [
        ...(line.children ?? []).map(child => (
          <Text key={child.id} wrap="truncate-end" {...(child.error ? theme.error : theme.faint)}>
            {toolDisplayName(child.name)}{child.summary ? `(${child.summary})` : ''}
          </Text>
        )),
        ...(count > CHILD_ROWS ? [<Text key="more" {...theme.faint}>{t('subagent.more', { count: count - CHILD_ROWS })}</Text>] : []),
      ];
    }
  }
  if (line.interrupted && line.result === undefined) return [<Text key="interrupted" {...theme.warning}>{t('tool.interrupted')}</Text>];
  if (line.result === undefined) return [];
  if (line.children?.length || line.task) {
    const uses = line.task?.toolUses ?? line.childCount ?? 0;
    const facts = [
      ...(uses ? [t('subagent.toolUses', { count: uses })] : []),
      ...(line.task?.totalTokens ? [t('subagent.tokens', { tokens: compactTokens(line.task.totalTokens) })] : []),
      ...(line.task?.durationMs ? [elapsedText(line.task.durationMs)] : []),
    ];
    return [
      <Text key="done" {...(line.error ? theme.error : {})}>
        {t('subagent.done')}{facts.length ? <Text {...theme.muted}>{` (${facts.join(' · ')})`}</Text> : null}
        {line.result ? <Text {...theme.faint}>{` ${t('group.expand')}`}</Text> : null}
      </Text>,
    ];
  }
  if (line.error) return outputRows(line.result, t, theme, true);
  if (line.name === 'Read') return [<Text key="read">{t('tool.read', { count: countLines(line.result) })}</Text>];
  if (detail?.kind === 'edit') {
    const rows = detail.rows.slice(0, DETAIL_ROWS);
    return [
      <Text key="summary">
        {t('tool.updated', { path: detail.path, added: detail.added, removed: detail.removed }).split(/(\+\d+|−\d+)/).map((part, index) => (
          <Text key={index} {...(/^\+\d+$/.test(part) ? theme.success : /^−\d+$/.test(part) ? theme.error : {})}>{part}</Text>
        ))}
      </Text>,
      ...diffRows(rows, detail.rows.length - rows.length, t, theme),
    ];
  }
  if (detail?.kind === 'write') {
    return [
      <Text key="summary">{t('tool.wrote', { count: detail.lines, path: detail.path })}</Text>,
      ...numberedRows(detail.preview, detail.lines - detail.preview.length, t, theme),
    ];
  }
  return outputRows(line.result, t, theme);
}

/** "Read 3 files, searched 2 patterns": what a read / search group did. */
function groupTitle(items: readonly GroupItem[], t: Translate): string {
  const count = (names: string[]) => items.filter(item => names.includes(item.name)).length;
  const reads = count(['Read', 'NotebookRead']);
  const searches = count(['Grep', 'Glob']);
  const lists = count(['LS']);
  const parts = [
    ...(reads ? [reads === 1 ? t('group.read1') : t('group.readN', { count: reads })] : []),
    ...(searches ? [searches === 1 ? t('group.search1') : t('group.searchN', { count: searches })] : []),
    ...(lists ? [lists === 1 ? t('group.list1') : t('group.listN', { count: lists })] : []),
  ];
  const text = parts.join(t('group.read1').startsWith('Read') ? ', ' : '，');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Terminal rows a transcript line takes, roughly (keeps the live area within the window). */
function lineRows(line: Line, t: Translate): number {
  switch (line.kind) {
    case 'tool': return 2 + toolBody(line, t, THEMES.ansi).length;
    case 'group': return 3;
    case 'thinking': case 'interrupted': return 2;
    case 'local': return 3 + (line.output ? Math.min(OUTPUT_ROWS + 1, line.output.split('\n').length) : 0);
    case 'help': return 1 + line.sections.reduce((rows, section) => rows + 2 + section.rows.length, 0);
    default: return 1 + line.text.split('\n').length;
  }
}

function ToolRow({ line, t, live }: { line: ToolLine; t: Translate; live?: boolean }) {
  const theme = useTheme();
  const done = line.result !== undefined;
  const mark = line.error ? <Text {...theme.error}>{DOT}</Text>
    : done ? <Text {...theme.success}>{DOT}</Text>
      : line.interrupted ? <Text {...theme.warning}>{DOT}</Text>
        : live ? <Blink>{DOT}</Blink> : <Text {...theme.faint}>{DOT}</Text>;
  const body = toolBody(line, t, theme);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Gutter mark={mark}><Text><Text bold>{toolDisplayName(line.name)}</Text>{line.summary ? <Text {...theme.muted}>{`(${line.summary})`}</Text> : null}</Text></Gutter>
      {body.length ? <Gutter width={5} mark={<Text {...theme.faint}>{'  ⎿  '}</Text>}>{body}</Gutter> : null}
    </Box>
  );
}

function TranscriptLine({ line, t, live, width }: { line: Line; t: Translate; /** In the live area (not yet printed for good). */ live?: boolean; width: number }) {
  const theme = useTheme();
  switch (line.kind) {
    case 'user':
      return <Box marginTop={1}><Gutter mark={<Text {...theme.faint}>{'>'}</Text>}><Text {...theme.muted}>{line.text}{line.steer ? <Text {...theme.info}>{`  [${t('chat.steerTag')}]`}</Text> : null}</Text></Gutter></Box>;
    case 'assistant':
      return <Box marginTop={line.cont ? 0 : 1}><Gutter mark={line.cont ? '' : DOT}><Markdown text={line.text} code={line.code} width={width - 2} /></Gutter></Box>;
    case 'thinking':
      return (
        <Box marginTop={1}>
          <Gutter mark={<Text {...theme.faint}>{THOUGHT}</Text>}>
            <Text {...theme.faint} italic>
              {line.durationMs !== undefined ? t('thinking.done', { duration: elapsedText(Math.max(1000, line.durationMs)) }) : t('thinking.doneNoTime')}
              {` ${t('thinking.hint')}`}
            </Text>
          </Gutter>
        </Box>
      );
    case 'interrupted':
      return <Gutter width={5} mark={<Text {...theme.faint}>{'  ⎿  '}</Text>}><Text {...theme.warning}>{t('chat.interruptedHint')}</Text></Gutter>;
    case 'tool':
      return <ToolRow line={line} t={t} {...(live ? { live } : {})} />;
    case 'group': {
      // One call reads like any other tool call; several collapse into what they did.
      if (line.items.length === 1) {
        const item = line.items[0]!;
        return <ToolRow line={{ id: line.id, kind: 'tool', name: item.name, summary: item.summary, ...(item.result !== undefined ? { result: item.result } : {}),
          ...(item.error ? { error: true } : {}), ...(item.interrupted ? { interrupted: true } : {}) }} t={t} {...(live ? { live } : {})} />;
      }
      const failed = line.items.filter(item => item.error).length;
      const waiting = line.items.some(item => item.result === undefined && !item.interrupted);
      const mark = failed ? <Text {...theme.error}>{DOT}</Text> : waiting && live ? <Blink>{DOT}</Blink>
        : line.items.some(item => item.interrupted) ? <Text {...theme.warning}>{DOT}</Text> : <Text {...theme.success}>{DOT}</Text>;
      const last = line.items.at(-1)!;
      return (
        <Box flexDirection="column" marginTop={1}>
          <Gutter mark={mark}>
            <Text>
              <Text bold>{groupTitle(line.items, t)}</Text>
              {failed ? <Text {...theme.error}>{` · ${t('group.failed', { count: failed })}`}</Text> : null}
              {waiting ? null : <Text {...theme.faint}>{` ${t('group.expand')}`}</Text>}
            </Text>
          </Gutter>
          {waiting ? <Gutter width={5} mark={<Text {...theme.faint}>{'  ⎿  '}</Text>}><Text {...theme.faint} wrap="truncate-end">{`${toolDisplayName(last.name)}(${last.summary})`}</Text></Gutter> : null}
        </Box>
      );
    }
    case 'local': {
      const body: ReactNode[] = line.running ? [] : [
        ...outputRows(line.output ?? '', t, theme, line.exitCode !== 0 && line.exitCode !== undefined),
        <Text key="meta" {...theme.faint}>
          {line.exitCode === null ? `${t('local.stopped')} · ` : line.exitCode ? `${t('local.exit', { code: line.exitCode })} · ` : ''}{t('local.pending')}
        </Text>,
      ];
      return (
        <Box flexDirection="column" marginTop={1}>
          <Gutter mark={<Text {...theme.local} bold>{'!'}</Text>}><Text {...theme.local}>{line.command}</Text></Gutter>
          {body.length ? <Gutter width={5} mark={<Text {...theme.faint}>{'  ⎿  '}</Text>}>{body}</Gutter> : null}
        </Box>
      );
    }
    case 'help': {
      const keyWidth = Math.max(...line.sections.flatMap(section => section.rows.map(([keys]) => displayWidth(keys)))) + 2;
      return (
        <Box flexDirection="column" marginTop={1}>
          {line.sections.map(section => (
            <Box key={section.title} flexDirection="column" marginBottom={1}>
              <Text bold>{section.title}</Text>
              {section.rows.map(([keys, description]) => (
                <Box key={keys}>
                  <Box width={keyWidth + 2} flexShrink={0}><Text {...theme.info}>{`  ${keys}`}</Text></Box>
                  <Text>{description}</Text>
                </Box>
              ))}
            </Box>
          ))}
        </Box>
      );
    }
    default:
      return <Box marginTop={1}><Text {...(line.tone === 'error' ? theme.error : line.tone === 'warn' ? theme.warning : theme.muted)}>{line.text}</Text></Box>;
  }
}

function MatchText({ text, query }: { text: string; query: string }) {
  const index = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1;
  return index < 0 ? <Text>{text}</Text> : <Text>{text.slice(0, index)}<Text bold underline>{text.slice(index, index + query.length)}</Text>{text.slice(index + query.length)}</Text>;
}

/** Long lists (a provider can offer 30+ models) scroll in a fixed window around the selection. */
export const CHOICE_WINDOW = 10;

function Choices({ prompt, t, limit = CHOICE_WINDOW, query = '' }: { prompt: Prompt; t: Translate; limit?: number; query?: string }) {
  const theme = useTheme();
  const total = prompt.choices.length;
  const start = total <= limit ? 0 : Math.min(Math.max(0, prompt.index - Math.floor(limit / 2)), total - limit);
  const end = Math.min(total, start + limit);
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
            <Text wrap="truncate-end" {...(selected ? theme.info : choice.disabled ? theme.faint : {})}>
              {selected ? '❯ ' : '  '}{total <= 9 && prompt.kind !== 'picker' ? `${index + 1}. ` : ''}
              {prompt.kind === 'question' && prompt.question.multiSelect && index < (prompt.question.options?.length ?? 0) ? (prompt.selected.includes(index) ? '[x] ' : '[ ] ') : ''}<MatchText text={choice.label} query={query} />
              {choice.detail ? <Text {...theme.faint}>{'  '}<MatchText text={choice.detail} query={query} /></Text> : null}
            </Text>
          </Box>
        );
      })}
      {end < total ? <Text {...theme.faint}>{`  ${t('picker.moreBelow', { count: total - end })}`}</Text> : null}
    </Box>
  );
}

/** What the call would do, shown on its confirmation: the diff, the file's first lines, or the whole command. */
function PermissionPreviewView({ preview: fullPreview, t }: { preview: NonNullable<Extract<Prompt, { kind: 'permission' }>['preview']>; t: Translate }) {
  const theme = useTheme();
  const limit = fullPreview.kind === 'diff' ? 20 : DETAIL_ROWS;
  const preview = { ...fullPreview, rows: fullPreview.rows.slice(0, limit), more: fullPreview.more + Math.max(0, fullPreview.rows.length - limit) } as typeof fullPreview;
  const rows = preview.kind === 'diff' ? diffRows(preview.rows, preview.more, t, theme)
    : preview.kind === 'write' ? numberedRows(preview.rows, preview.more, t, theme)
      : [
        ...preview.rows.map((row, index) => <Text key={index} wrap="truncate-end">{row || ' '}</Text>),
        ...(preview.more > 0 ? [<Text key="more" {...theme.faint}>{t('tool.more', { count: preview.more })}</Text>] : []),
      ];
  return <Box flexDirection="column" marginY={1} paddingLeft={preview.kind === 'command' ? 2 : 0}>{rows}</Box>;
}

/** Prompt text stays readable even when its inline card is condensed for a small terminal. */
function promptDetails(prompt: Prompt, t: Translate): ViewItem {
  const rows: ViewRow[] = [];
  const text = (value: string) => rows.push(...value.split('\n').map(text => ({ text })));
  if (prompt.kind === 'plan') {
    text(prompt.plan);
    return { id: 'prompt-plan', title: t('viewer.plan'), rows };
  }
  const title = prompt.kind === 'question' ? prompt.question.header ?? prompt.question.question : prompt.title;
  if (prompt.kind === 'question') {
    if (prompt.question.header) text(prompt.question.header);
    text(prompt.question.question);
    if (prompt.position) text(prompt.position);
  } else {
    text(prompt.title);
    if (prompt.kind === 'permission') {
      if (prompt.summary) text(prompt.summary);
      if (prompt.description) text(prompt.description);
      const preview = prompt.preview;
      if (preview) {
        rows.push({ text: '' });
        if (preview.kind === 'diff') rows.push(...diffRowsText(preview.rows));
        else preview.rows.forEach((row, index) => text(preview.kind === 'write' ? `${index + 1} ${row}` : row));
        if (preview.more) text(t('tool.more', { count: preview.more }));
      }
    }
  }
  rows.push({ text: '' });
  prompt.choices.forEach((choice, index) => {
    if (choice.group) text(choice.group);
    text(`${index + 1}. ${choice.label}`);
    if (choice.detail) text(choice.detail);
  });
  return { id: `prompt-${prompt.kind}`, title, rows };
}

function PromptTitle({ children, t, tone }: { children: ReactNode; t: Translate; tone?: Tone }) {
  const theme = useTheme();
  return <Box>
    <Box flexGrow={1} flexShrink={1}><Text bold wrap="truncate-end" {...tone}>{children}</Text></Box>
    <Box flexShrink={0}><Text {...theme.faint}>{` ${t('viewer.promptHint')}`}</Text></Box>
  </Box>;
}

function PromptView({ prompt, hint, t, width, planRows, filterQuery, choiceRows, maxRows }: { prompt: Prompt; hint: string; t: Translate; width: number; filterQuery: string; choiceRows: number; maxRows: number; /** Rows the plan may take. */ planRows: number }) {
  const theme = useTheme();
  if (prompt.kind === 'picker') {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1}>
        <PromptTitle t={t}>{prompt.title}</PromptTitle>
        {prompt.searchable ? <Text {...theme.faint} wrap="truncate-end">{filterQuery ? `> ${filterQuery}` : t('picker.search')}</Text> : null}
        {prompt.choices.length ? <Choices prompt={prompt} t={t} limit={choiceRows} query={filterQuery} /> : <Text {...theme.faint}>{t('picker.noMatches')}</Text>}
        <Text {...theme.faint} wrap="truncate-end">{prompt.searchable ? t('picker.filterHint') : prompt.back ? t('picker.hintBack') : hint}</Text>
      </Box>
    );
  }
  if (prompt.kind === 'permission') {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.attention} paddingX={1}>
        <PromptTitle t={t} tone={{ color: theme.attention }}>{prompt.title}</PromptTitle>
        {prompt.summary ? <Text wrap="truncate-end">{prompt.summary}</Text> : null}
        {prompt.preview && maxRows > prompt.choices.length + 5 ? <Box flexDirection="column" maxHeight={maxRows - prompt.choices.length - 5} overflowY="hidden"><PermissionPreviewView preview={prompt.preview} t={t} /></Box> : null}
        {prompt.description ? <Text wrap="truncate-end" {...theme.muted}>{prompt.description}</Text> : null}
        <Choices prompt={prompt} t={t} limit={choiceRows} />
      </Box>
    );
  }
  if (prompt.kind === 'question') {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.info.color ?? theme.border} paddingX={1}>
        <PromptTitle t={t}>{prompt.question.header ? `${prompt.question.header}: ` : ''}{prompt.question.question}{prompt.position ? <Text {...theme.faint}>{`  ${prompt.position}`}</Text> : null}</PromptTitle>
        <Choices prompt={prompt} t={t} limit={choiceRows} />
      </Box>
    );
  }
  // The plan reads like a reply (Markdown). A long one shows its start here; Ctrl+O shows all of it.
  const source = prompt.plan.split('\n');
  const rows = Math.max(1, Math.min(planRows, maxRows - prompt.choices.length - 6));
  const shown = source.length > rows ? source.slice(0, rows - 1) : source;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.info.color ?? theme.border} paddingX={1}>
      <PromptTitle t={t}>{hint}</PromptTitle>
      <Box flexDirection="column" marginY={1}><Markdown text={shown.join('\n')} width={width - 4} /></Box>
      {shown.length < source.length ? <Text {...theme.faint}>{t('plan.more', { count: source.length - shown.length })}</Text> : null}
      <Choices prompt={prompt} t={t} limit={choiceRows} />
      <Text {...theme.faint} wrap="truncate-end">{t('ask.planHint')}</Text>
    </Box>
  );
}

/** A bounded editor with the terminal's native cursor for IME composition. */
function InputBox({ editor, placeholder, local, width, maxRows }: { editor: Editor; placeholder: string; local: boolean; width: number; maxRows: number }) {
  const theme = useTheme();
  const ref = useRef<DOMElement>(null);
  const previousTop = useRef(0);
  const shownEditor = local ? { value: editor.value.slice(1), cursor: Math.max(0, editor.cursor - 1) } : editor;
  const viewport = inputViewport(shownEditor, Math.max(1, width - 4), maxRows, previousTop.current);
  previousTop.current = viewport.top;
  const [position, setPosition] = useState<{ x: number; y: number }>();
  const { setCursorPosition } = useCursor();
  useLayoutEffect(() => {
    if (!ref.current) return;
    const measured = measureElement(ref.current);
    const next = { x: measured.x + 3 + viewport.cursorColumn, y: measured.y + 1 + viewport.cursorRow };
    setPosition(previous => previous?.x === next.x && previous.y === next.y ? previous : next);
  });
  setCursorPosition(position);
  return (
    <Box ref={ref} flexDirection="column" borderStyle="single" borderLeft={false} borderRight={false}
      borderColor={local ? theme.local.color ?? theme.border : theme.border} paddingX={1}>
      {viewport.rows.map((row, index) => (
        <Box key={viewport.top + index}>
          <Text {...(local ? theme.local : theme.muted)}>{index === 0 ? local ? '! ' : '> ' : '  '}</Text>
          <Text wrap="truncate-end">{editor.value ? row.text || ' ' : <Text {...theme.faint}>{truncateWidth(placeholder, Math.max(1, width - 4))}</Text>}</Text>
        </Box>
      ))}
    </Box>
  );
}

/** Ctrl+R: the search text, and the newest earlier input containing it with the match marked. */
function HistorySearch({ query, match, t }: { query: string; match: string | null; t: Translate }) {
  const theme = useTheme();
  // The line of the input that contains the search text, the match marked; … where lines are left out.
  const rows = match ? match.split('\n') : [];
  const row = rows.findIndex(line => line.toLowerCase().includes(query.toLowerCase()));
  const line = row >= 0 ? rows[row]! : '';
  const at = line.toLowerCase().indexOf(query.toLowerCase());
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.info.color ?? theme.border} paddingX={1}>
      <Text><Text {...theme.info} bold>{`${t('history.search')}: `}</Text>{query}<Text inverse> </Text></Text>
      {match && row >= 0 ? (
        <Text wrap="truncate-end">
          {row > 0 ? <Text {...theme.faint}>{'… '}</Text> : null}
          {line.slice(0, at)}<Text {...theme.info} bold underline>{line.slice(at, at + query.length)}</Text>{line.slice(at + query.length)}
          {row < rows.length - 1 ? <Text {...theme.faint}>{' …'}</Text> : null}
        </Text>
      ) : <Text {...theme.faint}>{query ? t('history.noMatch') : ' '}</Text>}
      <Text {...theme.faint}>{t('history.searchHint')}</Text>
    </Box>
  );
}

/** The Ctrl+O viewer: one folded item at a time, scrolled in the live area; nothing is added to the history. */
function Viewer({ title, position, rows, offset, height, t }: { title: string; position: string; rows: ViewRow[]; offset: number; height: number; t: Translate }) {
  const theme = useTheme();
  const shown = rows.slice(offset, offset + height);
  const tone = (row: ViewRow): Tone => (row.tone === 'add' ? theme.add : row.tone === 'remove' ? theme.remove : row.tone === 'error' ? theme.error
    : row.tone === 'muted' ? theme.muted : row.tone === 'faint' ? theme.faint : {});
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end"><Text bold {...theme.info}>{title}</Text><Text {...theme.faint}>{`  ${position}`}</Text></Text>
      {/* Short content takes only the rows it needs; long content scrolls in a fixed window. */}
      <Box flexDirection="column" height={Math.max(1, Math.min(height, rows.length))}>
        {shown.map((row, index) => <Text key={offset + index} {...tone(row)} wrap="truncate-end">{row.text || ' '}</Text>)}
      </Box>
      <Text {...theme.faint} wrap="truncate-end">
        {t('viewer.lines', { from: rows.length ? offset + 1 : 0, to: Math.min(rows.length, offset + height), total: rows.length })}{`  ·  ${t('viewer.hint')}`}
      </Text>
    </Box>
  );
}

/** Pasted text this long goes in as a placeholder; the message carries the full text. */
const PASTE_LINES = 10;
const PASTE_CHARS = 2000;
/** Placeholders in either interface language (the language can change while they sit in the input or history). */
const PASTE_RE = /\[(?:Pasted text|粘贴的文本) #(\d+)[^\]]*\]/g;
const IMAGE_RE = /\[(?:Image|图片) #(\d+)\]/g;
/** Inputs ↑ and Ctrl+R reach in a run (earlier runs' included). */
const HISTORY_KEEP = 500;

export function App({ controller, header, hyperlinks = false, colorDepth = 24, closing = false }: {
  controller: ChatController; header: string; hyperlinks?: boolean; /** The terminal's color depth (getColorDepth). */ colorDepth?: number;
  /** Clear disposable UI while keeping the already-mounted scrollback tree for shutdown. */ closing?: boolean;
}) {
  const windowSize = useWindowSize();
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const t = controller.translate();
  const theme = themeFor(snapshot.theme, colorDepth);
  const [editor, setEditor] = useState<Editor>({ value: '', cursor: 0 });
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [suggestion, setSuggestion] = useState(0);
  /** Ctrl+O viewer: which folded item and how far it is scrolled; null when closed. */
  const [viewer, setViewer] = useState<{ index: number; offset: number } | null>(null);
  /** Pasted texts and images behind the input's placeholders, kept for the run (history and queue reuse them). */
  const pastes = useRef(new Map<number, string>());
  const images = useRef(new Map<number, ImageAttachment>());
  const pasteCount = useRef(0);
  /** Ctrl+R: the search text and how many older matches were skipped; null when not searching. */
  const [search, setSearch] = useState<{ query: string; skip: number } | null>(null);
  const prompt = snapshot.prompt;
  const chromeRef = useRef<DOMElement>(null);
  const chrome = useBoxMetrics(chromeRef);
  const draft = useRef<Editor | null>(null);
  const previousPrompt = useRef<Prompt | null>(null);
  useLayoutEffect(() => {
    if (prompt && !previousPrompt.current) { draft.current = editor; setEditor({ value: '', cursor: 0 }); }
    else if (!prompt && previousPrompt.current && draft.current) { setEditor(draft.current); draft.current = null; }
    previousPrompt.current = prompt;
  }, [prompt]);
  const [filter, setFilter] = useState<{ choices: Prompt['choices']; query: string; index: number } | null>(null);
  const filterQuery = prompt?.kind === 'picker' && prompt.searchable && filter?.choices === prompt.choices ? filter.query : '';
  const filteredIndices = prompt?.kind === 'picker' && prompt.searchable ? prompt.choices.flatMap((choice, index) =>
    `${choice.label} ${choice.detail ?? ''} ${choice.group ?? ''}`.toLowerCase().includes(filterQuery.toLowerCase()) ? [index] : []) : [];
  const filterIndex = Math.min(filter?.index ?? 0, Math.max(0, filteredIndices.length - 1));
  const shownPrompt = prompt?.kind === 'picker' && filterQuery ? { ...prompt, choices: filteredIndices.map(index => prompt.choices[index]!), index: filterIndex } : prompt;
  const suggestionRows = Math.max(1, Math.min(5, Math.floor(windowSize.rows / 4)));

  // Typing answers a question, revises a plan, or (on an Agent's confirmation) denies the step with a reason.
  const typing = !prompt || prompt.kind === 'question' || prompt.kind === 'plan' || (prompt.kind === 'permission' && prompt.feedback);
  const local = typing && !prompt && editor.value.startsWith('!');
  // Commands and @ completion belong to messages, not to answers.
  const commands = typing && !prompt ? commandSuggestions(editor.value, t) : [];
  const mention = typing && !prompt && !commands.length && !local ? mentionAt(editor.value, editor.cursor) : null;
  const files = mention ? controller.fileSuggestions(mention.query) : [];
  const suggestions: Array<{ kind: 'command' | 'file'; value: string }> = commands.length
    ? commands.map(value => ({ kind: 'command', value })) : files.map(value => ({ kind: 'file', value }));
  const selected = suggestions[Math.min(suggestion, suggestions.length - 1)];
  useEffect(() => { setSuggestion(0); }, [editor.value]);
  const suggestionStart = Math.max(0, Math.min(suggestion - Math.floor(suggestionRows / 2), suggestions.length - suggestionRows));
  const shownSuggestions = suggestions.slice(suggestionStart, suggestionStart + suggestionRows);

  // A confirmation or question needs the screen: close the viewer and any history search.
  useEffect(() => { if (prompt) { setViewer(null); setSearch(null); } }, [prompt]);
  // Earlier runs' inputs in this project directory come before this run's (↑, Ctrl+R).
  useEffect(() => {
    let live = true;
    void controller.loadHistory().then(saved => { if (live && saved.length) setHistory(current => [...saved.filter(item => !current.includes(item)), ...current]); });
    return () => { live = false; };
  }, [controller]);

  /** Folded items for Ctrl+O; the current prompt is always the last item, with all of its text. */
  const viewable = () => [...viewItems(snapshot.lines, t), ...(prompt ? [promptDetails(prompt, t)] : [])];
  const items = viewer ? viewable() : [];
  /** Ctrl+R: newest matching inputs first; the shown one skips `skip` newer matches. */
  const matches = search ? [...history].reverse().filter(item => item.toLowerCase().includes(search.query.toLowerCase())) : [];
  const match = search && search.query ? matches[Math.min(search.skip, Math.max(0, matches.length - 1))] : undefined;
  const viewHeight = Math.max(3, windowSize.rows - 4);
  const viewItem = viewer ? items[Math.min(viewer.index, items.length - 1)] : undefined;
  const viewRows = viewItem ? wrapView(viewItem.rows, Math.max(10, windowSize.columns - 1)) : [];

  const insert = (text: string) => setEditor(current => edit.insert(current, text));
  const attachImage = (image: ImageAttachment) => {
    const id = ++pasteCount.current;
    images.current.set(id, image);
    setEditor(current => {
      const before = current.value.slice(0, current.cursor);
      const text = `${before && !/\s$/.test(before) ? ' ' : ''}${t('paste.image', { id })} `;
      return { value: before + text + current.value.slice(current.cursor), cursor: current.cursor + text.length };
    });
  };
  /** The input as sent: placeholders replaced by the pasted text, images collected from their placeholders. */
  const resolve = (value: string) => {
    const text = value.replace(PASTE_RE, (whole, id: string) => pastes.current.get(Number(id)) ?? whole);
    const attached = [...new Set([...value.matchAll(IMAGE_RE)].map(match => Number(match[1])))].flatMap(id => images.current.get(id) ?? []);
    return { text, extra: { ...(text !== value ? { display: value } : {}), ...(attached.length ? { images: attached } : {}) } };
  };

  usePaste(text => {
    if (viewer || search) return;
    if (prompt?.kind === 'picker' && prompt.searchable) { setFilter({ choices: prompt.choices, query: filterQuery + text.replace(/[\r\n]+/g, ' '), index: 0 }); return; }
    if (!typing || viewer || search) return;
    const normalized = text.replace(/\r\n?/g, '\n');
    // A dropped or pasted image file goes with the message as an image.
    const image = controller.imageFromPath(normalized);
    if (image) { attachImage(image); return; }
    const count = normalized.split('\n').length;
    if (count > PASTE_LINES || normalized.length > PASTE_CHARS) {
      const id = ++pasteCount.current;
      pastes.current.set(id, normalized);
      insert(t('paste.text', { id, lines: count }));
      return;
    }
    insert(normalized);
  });

  useInput((input, key) => {
    if (viewer) {
      const last = Math.max(0, viewRows.length - viewHeight);
      const scroll = (offset: number) => setViewer({ index: viewer.index, offset: Math.max(0, Math.min(last, offset)) });
      if (key.escape || (key.ctrl && input === 'o') || input === 'q' || (key.ctrl && input === 'c')) setViewer(null);
      else if (key.upArrow || input === 'k') scroll(viewer.offset - 1);
      else if (key.downArrow || input === 'j') scroll(viewer.offset + 1);
      else if (key.pageUp || input === 'b') scroll(viewer.offset - viewHeight);
      else if (key.pageDown || input === ' ') scroll(viewer.offset + viewHeight);
      else if (key.home || input === 'g') scroll(0);
      else if (key.end || input === 'G') scroll(last);
      else if (key.leftArrow) setViewer({ index: Math.max(0, viewer.index - 1), offset: 0 });
      else if (key.rightArrow) setViewer({ index: Math.min(items.length - 1, viewer.index + 1), offset: 0 });
      return;
    }
    if (search) {
      if (key.escape || (key.ctrl && (input === 'c' || input === 'g'))) setSearch(null);
      else if (key.ctrl && input === 'r') setSearch({ ...search, skip: Math.min(search.skip + 1, Math.max(0, matches.length - 1)) });
      else if (key.return || key.tab) {
        if (match) { setEditor({ value: match, cursor: match.length }); setHistoryIndex(null); }
        setSearch(null);
      } else if (key.backspace || key.delete) setSearch({ query: edit.backspace({ value: search.query, cursor: search.query.length }).value, skip: 0 });
      else if (input && !key.ctrl && !key.meta) setSearch({ query: search.query + input, skip: 0 });
      return;
    }
    if (key.ctrl && input === 'c') { controller.ctrlC(); return; }
    if (key.ctrl && input === 'o') {
      const count = viewable().length;
      if (count) setViewer({ index: count - 1, offset: 0 });
      return;
    }
    if (key.ctrl && input === 'r' && !prompt) { setSearch({ query: '', skip: 0 }); return; }
    if (key.escape) {
      if (prompt?.kind === 'picker' && filterQuery) { setFilter(null); return; }
      if (prompt) controller.cancelPrompt();
      else if (controller.stopLocal()) { /* stopped the local command */ }
      else if (snapshot.phase === 'running') controller.interrupt();
      else setEditor({ value: '', cursor: 0 });
      return;
    }
    if (!prompt && key.tab && key.shift) { void controller.cyclePermission(); return; }
    if (!prompt && key.ctrl && input === 's') {
      const { text, extra } = resolve(editor.value);
      setEditor({ value: '', cursor: 0 });
      void controller.steer(text, extra);
      return;
    }
    // Ctrl+V (Alt+V where the terminal keeps Ctrl+V for its own paste): an image from the clipboard.
    if (typing && ((key.ctrl && input === 'v') || (key.meta && input === 'v'))) {
      void controller.pasteImage().then(image => { if (image) attachImage(image); });
      return;
    }
    if (prompt?.kind === 'picker' && prompt.searchable) {
      const updateFilter = (query: string) => setFilter({ choices: prompt.choices, query, index: 0 });
      if (key.upArrow || key.downArrow) {
        if (!filterQuery) controller.move(key.upArrow ? -1 : 1);
        else if (filteredIndices.length) {
          const direction = key.upArrow ? -1 : 1;
          let next = filterIndex;
          for (let step = 0; step < filteredIndices.length; step++) {
            next = (next + direction + filteredIndices.length) % filteredIndices.length;
            if (!prompt.choices[filteredIndices[next]!]!.disabled) break;
          }
          setFilter({ choices: prompt.choices, query: filterQuery, index: next });
        }
      } else if (key.return) {
        const index = filterQuery ? filteredIndices[filterIndex] : prompt.index;
        if (index !== undefined && !prompt.choices[index]?.disabled) controller.choose(index);
      } else if (key.backspace || key.delete) updateFilter(edit.backspace({ value: filterQuery, cursor: filterQuery.length }).value);
      else if (input && !key.ctrl && !key.meta) updateFilter(filterQuery + input);
      return;
    }
    if (prompt && !typing) {
      if (key.upArrow) controller.move(-1);
      else if (key.downArrow) controller.move(1);
      else if (key.return) controller.choose();
      else if (/^[1-9]$/.test(input) && Number(input) <= prompt.choices.length) controller.choose(Number(input) - 1);
      return;
    }
    if (prompt && !editor.value) {
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
    // ↑/↓ choose among the listed commands or files; Tab completes and Enter runs / completes the highlighted one.
    if ((key.upArrow || key.downArrow) && suggestions.length > 1) {
      setSuggestion(index => (index + (key.upArrow ? -1 : 1) + suggestions.length) % suggestions.length);
      return;
    }
    if (selected?.kind === 'file' && mention && (key.tab || key.return)) {
      const value = selected.value;
      const directory = value.endsWith('/');
      const token = `@${/\s/.test(value) ? `"${value}${directory ? '' : '"'}` : value}${directory ? '' : ' '}`;
      setEditor(current => ({ value: current.value.slice(0, mention.start) + token + current.value.slice(current.cursor), cursor: mention.start + token.length }));
      return;
    }
    // ? on an empty input opens the operations guide (Claude Code parity).
    if (input === '?' && !prompt && !editor.value) { void controller.submit('/help'); return; }
    // ↑ on an empty line with queued messages: take the last one back for editing (Claude Code parity).
    if (key.upArrow && !prompt && !editor.value && snapshot.queue.length) {
      const queued = controller.popQueued();
      if (queued) { const text = queued.display ?? queued.text; setEditor({ value: text, cursor: text.length }); }
      return;
    }
    if (key.return) {
      if (editor.value.endsWith('\\')) { setEditor(current => ({ value: `${current.value.slice(0, -1)}\n`, cursor: current.value.length })); return; }
      const value = selected?.kind === 'command' ? `/${selected.value}` : editor.value;
      const { text, extra } = resolve(value);
      // Messages and commands are remembered (answers to the Agent are not). Later runs get the pasted text in
      // full; pasted images are temporary files, so their placeholders are left out.
      if (!prompt && value.trim()) {
        setHistory(entries => [...entries.filter(item => item !== value), value].slice(-HISTORY_KEEP));
        controller.remember(text.replace(IMAGE_RE, '').replace(/[ \t]{2,}/g, ' ').trim());
      }
      setHistoryIndex(null);
      setEditor({ value: '', cursor: 0 });
      void controller.submit(text, extra);
      return;
    }
    if (key.tab && selected?.kind === 'command') { const value = `/${selected.value} `; setEditor({ value, cursor: value.length }); return; }
    // In a multi-line input ↑/↓ move between its lines; history only from the first / last line.
    if (key.upArrow || key.downArrow) {
      const projected = local ? { ...editor, value: editor.value.slice(1), cursor: Math.max(0, editor.cursor - 1) } : editor;
      const moved = moveVertical(projected, key.upArrow ? -1 : 1, Math.max(1, windowSize.columns - 4));
      if (moved !== null) { setEditor(local ? { ...moved, value: editor.value, cursor: moved.cursor + 1 } : moved); return; }
      if (prompt || !history.length) return;
      const next = historyIndex === null ? (key.upArrow ? history.length - 1 : null) : historyIndex + (key.upArrow ? -1 : 1);
      if (next === null || next >= history.length) { setHistoryIndex(null); setEditor({ value: '', cursor: 0 }); return; }
      const index = Math.max(0, next);
      setHistoryIndex(index);
      setEditor({ value: history[index]!, cursor: history[index]!.length });
      return;
    }
    const move = (cursor: (current: Editor) => number) => setEditor(current => ({ value: current.value, cursor: cursor(current) }));
    // Word moves: Alt+←/→ (macOS Option), Ctrl+←/→ and Alt+B / Alt+F as in shells.
    if ((key.leftArrow && (key.meta || key.ctrl)) || (key.meta && input === 'b')) { move(edit.wordLeft); return; }
    if ((key.rightArrow && (key.meta || key.ctrl)) || (key.meta && input === 'f')) { move(edit.wordRight); return; }
    if (key.leftArrow) { move(edit.left); return; }
    if (key.rightArrow) { move(edit.right); return; }
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
    if (key.backspace) { setEditor(edit.backspace); return; }
    if (key.delete) { setEditor(edit.delete); return; }
    if (input && !key.ctrl && !key.meta) insert(input);
  });

  // <Static> prints each line once. While the turn runs, keep live: lines from the first call still awaiting its
  // result (a running `!command` too, at any time), and a read / search group that may still grow. The boundary
  // only moves forward (lines are append-only), so nothing is printed twice.
  const committedCount = useRef(0);
  const running = snapshot.phase !== 'idle';
  const waiting = (line: Line) => (line.kind === 'local' && !!line.running)
    || (running && line.kind === 'tool' && line.result === undefined && !line.interrupted)
    || (running && line.kind === 'group' && line.items.some(item => item.result === undefined && !item.interrupted));
  const firstPending = snapshot.lines.findIndex((line, index) => index >= committedCount.current && waiting(line));
  let boundary = firstPending < 0 ? snapshot.lines.length : firstPending;
  const open = running ? openGroupIndex(snapshot.lines) : -1;
  if (open >= committedCount.current && open < boundary) boundary = open;
  committedCount.current = Math.max(committedCount.current, boundary);
  const committed = snapshot.lines.slice(0, committedCount.current);
  const pending = snapshot.lines.slice(committedCount.current);
  const pendingRows = pending.reduce((rows, line) => rows + lineRows(line, t), 0);
  const model = snapshot.model;
  const status = prompt ? '' : snapshot.localRunning ? t('chat.localRunning')
    : snapshot.phase === 'connecting' ? t('chat.connecting', { where: model?.targetLabel ?? '' })
      : snapshot.phase === 'running' ? (prompt ? t('chat.waitingAnswer') : t(snapshot.thinking ? 'chat.thinking' : 'chat.working')) : '';
  const statusKeys = snapshot.localRunning ? t('chat.localKeys') : snapshot.phase === 'running' && !prompt ? t('chat.workingKeys') : undefined;
  const queue = snapshot.queue;
  // Footer left: the exit hint, local command mode, a non-default permission mode, or where to find all keys.
  const mode = snapshot.exitArmed ? <Text>{t('chat.exitHint')}</Text>
    : local ? <Text {...theme.local}>{t('footer.local')}</Text>
      : snapshot.permission === 'full' ? <Text {...theme.full}>{t('footer.full')}</Text>
        : snapshot.permission === 'plan' ? <Text {...theme.info}>{t('footer.plan')}</Text>
          : !editor.value && !prompt ? <Text {...theme.faint}>{t('footer.shortcuts')}</Text> : <Text> </Text>;
  const width = windowSize.columns;
  return (
    <ThemeContext.Provider value={theme}>
    <LinkContext.Provider value={hyperlinks}>
    <Box flexDirection="column">
      <Static items={[{ id: 'header', kind: 'notice', tone: 'info', text: header } as Line, ...committed]}>
        {/* <Static> lays lines out shrink-to-fit; the terminal width lets diff backgrounds span the row. */}
        {line => <Box key={line.id} flexDirection="column" width={width}><TranscriptLine line={line} t={t} width={width} /></Box>}
      </Static>
      {/* Bound the entire live area, including pending tools, wrapped text and the composer. Bounding
          only snapshot.live lets a pending tool hold arbitrarily many later lines here; Ink then clears
          the terminal and replays all static history on every spinner tick. Keep the bottom (input)
          visible and leave one spare terminal row, including on Windows. Clipped history is still
          committed in full above when the pending tools finish. */}
      {closing ? null : <Box flexDirection="column" maxHeight={Math.max(1, windowSize.rows - 1)} overflowY="hidden" justifyContent="flex-end">
        {viewer && viewItem ? (
          <Viewer title={viewItem.title} position={t('viewer.position', { index: Math.min(viewer.index, items.length - 1) + 1, total: items.length })}
            rows={viewRows} offset={viewer.offset} height={viewHeight} t={t} />
        ) : (
        <Box flexDirection="column" flexShrink={0}>
          <Box flexDirection="column" maxHeight={Math.max(0, windowSize.rows - chrome.height - 2)} overflowY="hidden" justifyContent="flex-end">
          {pending.map(line => <TranscriptLine key={line.id} line={line} t={t} width={width} live />)}
          {snapshot.live ? (
            <Box marginTop={snapshot.liveCont ? 0 : 1}>
              <Gutter mark={snapshot.liveCont ? '' : DOT}>
                <Markdown text={snapshot.live} maxRows={Math.max(1, windowSize.rows - chrome.height - 3 - pendingRows)} code={snapshot.liveCode} width={width - 2} />
              </Gutter>
            </Box>
          ) : null}
          </Box>
          <Box ref={chromeRef} flexDirection="column">
          {status ? <Status text={status} {...(statusKeys ? { keys: statusKeys } : {})} startedAt={!snapshot.localRunning && snapshot.phase === 'running' ? snapshot.turnStartedAt : null}
            {...(snapshot.localRunning ? { tone: theme.local } : {})} /> : null}
          <Box marginTop={1} flexDirection="column">
            {shownPrompt ? <PromptView prompt={shownPrompt} t={t} hint={shownPrompt.kind === 'plan' ? t('ask.planTitle') : t('picker.hint')} width={width}
              planRows={Math.max(3, Math.floor(windowSize.rows / 3))} filterQuery={filterQuery} maxRows={Math.max(4, windowSize.rows - (typing ? 6 : 3))} choiceRows={Math.max(1, Math.min(CHOICE_WINDOW, windowSize.rows - 10))} /> : null}
            {!prompt && queue.length ? (
              <Box flexDirection="column" paddingX={2}>
                <Text {...(snapshot.queuePaused ? theme.warning : theme.muted)}>
                  {snapshot.queuePaused ? t('chat.queuePaused', { count: queue.length }) : t('chat.queued', { count: queue.length })}
                </Text>
                {queue.slice(0, 3).map((item, index) => <Text key={item.id} {...theme.faint} wrap="truncate-end">{`  ${index + 1}. ${(item.display ?? item.text).split('\n')[0]!.slice(0, 100)}`}</Text>)}
                {queue.length > 3 ? <Text {...theme.faint}>{`  ${t('chat.queueMore', { count: queue.length - 3 })}`}</Text> : null}
                <Text {...theme.faint}>{`  ${t('chat.queueHint')}`}</Text>
              </Box>
            ) : null}
            {snapshot.localPending && !local ? <Box paddingX={2}><Text {...theme.local}>{t('local.pendingCount', { count: snapshot.localPending })}</Text></Box> : null}
            {search ? <HistorySearch query={search.query} match={match ?? null} t={t} />
              : typing ? <InputBox editor={editor} local={local} width={windowSize.columns} maxRows={prompt || suggestions.length ? 1 : Math.max(1, Math.min(8, Math.floor(windowSize.rows / 3)))} placeholder={prompt?.kind === 'question' ? t(prompt.question.multiSelect ? 'ask.multiHint' : 'ask.questionHint')
                : prompt?.kind === 'plan' ? t('ask.planHint') : prompt?.kind === 'permission' ? t('permission.feedbackHint') : t('chat.hint')} /> : null}
            {suggestions.length ? (
              <Box flexDirection="column" paddingX={2}>
                {suggestionStart > 0 ? <Text {...theme.faint}>{t('picker.moreAbove', { count: suggestionStart })}</Text> : null}
                {shownSuggestions.map(item => {
                  const isSelected = item === selected;
                  return item.kind === 'command' ? (
                    <Text key={item.value} wrap="truncate-end">
                      <Text {...(isSelected ? theme.info : theme.muted)} bold={isSelected}><MatchText text={`/${item.value}`} query={editor.value.slice(1)} />{' '}<MatchText text={resolveCommand(item.value)?.parameterHint ?? ''} query="" />{'  '}</Text>
                      <Text {...(isSelected ? theme.info : theme.faint)}><MatchText text={commandDescription(t, item.value as Parameters<typeof commandDescription>[1])} query={editor.value.slice(1)} /></Text>
                    </Text>
                  ) : (
                    <Text key={item.value} wrap="truncate-end" {...(isSelected ? theme.info : theme.muted)} bold={isSelected}>{`${isSelected ? '❯ ' : '  '}@${item.value}`}</Text>
                  );
                })}
                {suggestionStart + shownSuggestions.length < suggestions.length ? <Text {...theme.faint}>{t('picker.moreBelow', { count: suggestions.length - suggestionStart - shownSuggestions.length })}</Text> : null}
              </Box>
            ) : null}
            <Box paddingX={2} justifyContent="space-between" height={1} overflow="hidden">
              {mode}
              <Text {...theme.faint} wrap="truncate-end">{model ? `${model.modelName}${snapshot.effort ? ` (${snapshot.effort})` : ''} · ${model.targetLabel}` : t('chat.noModel')}</Text>
            </Box>
            {!prompt && snapshot.usage ? <UsageBar usage={snapshot.usage} t={t} /> : null}
          </Box>
          </Box>
        </Box>
        )}
      </Box>}
    </Box>
    </LinkContext.Provider>
    </ThemeContext.Provider>
  );
}
