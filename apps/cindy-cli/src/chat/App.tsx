/**
 * Ink view over ChatController. Colors use only the terminal's named palette (cyan, green,
 * yellow, red, gray/dim) so both light and dark terminal themes keep their own contrast;
 * no fixed foreground/background colors.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Box, Static, Text, useApp, useInput, usePaste } from 'ink';
import { commandDescription, commandSuggestions, type ChatController, type Line, type Prompt } from './controller';
import type { MessageKey, Translate } from '../i18n';

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

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function Spinner() {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setFrame(value => (value + 1) % SPINNER.length), 90);
    return () => clearInterval(timer);
  }, []);
  return <Text color="cyan">{SPINNER[frame]}</Text>;
}

function TranscriptLine({ line, steerTag }: { line: Line; steerTag: string }) {
  switch (line.kind) {
    case 'user':
      return <Box marginTop={1}><Text dimColor>{'> '}</Text><Text>{line.text}</Text>{line.steer ? <Text color="cyan">{`  [${steerTag}]`}</Text> : null}</Box>;
    case 'assistant':
      return <Box marginTop={1}><Text>{line.text}</Text></Box>;
    case 'help': {
      const width = Math.max(...line.sections.flatMap(section => section.rows.map(([keys]) => displayWidth(keys)))) + 2;
      return (
        <Box flexDirection="column" marginTop={1}>
          {line.sections.map(section => (
            <Box key={section.title} flexDirection="column" marginBottom={1}>
              <Text bold>{section.title}</Text>
              {section.rows.map(([keys, description]) => (
                <Box key={keys}>
                  <Box width={width + 2} flexShrink={0}><Text color="cyan">{`  ${keys}`}</Text></Box>
                  <Text>{description}</Text>
                </Box>
              ))}
            </Box>
          ))}
        </Box>
      );
    }
    case 'tool':
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text><Text color={line.error ? 'red' : 'green'}>● </Text><Text bold>{line.name}</Text>{line.summary ? <Text dimColor>({line.summary})</Text> : null}</Text>
          {line.result ? <Text dimColor>{`  ⎿ ${line.result.replace(/\n/g, '\n    ')}`}</Text> : null}
        </Box>
      );
    default:
      return <Box marginTop={1}><Text color={line.tone === 'error' ? 'red' : line.tone === 'warn' ? 'yellow' : undefined} dimColor={line.tone === 'info'}>{line.text}</Text></Box>;
  }
}

/** Long lists (a provider can offer 30+ models) scroll in a fixed window around the selection. */
export const CHOICE_WINDOW = 10;

function Choices({ prompt, t }: { prompt: Prompt; t: Translate }) {
  const total = prompt.choices.length;
  const start = total <= CHOICE_WINDOW ? 0 : Math.min(Math.max(0, prompt.index - Math.floor(CHOICE_WINDOW / 2)), total - CHOICE_WINDOW);
  const end = Math.min(total, start + CHOICE_WINDOW);
  let group = start > 0 ? prompt.choices[start - 1]!.group : undefined;
  return (
    <Box flexDirection="column">
      {start > 0 ? <Text dimColor>{`  ${t('picker.moreAbove', { count: start })}`}</Text> : null}
      {prompt.choices.slice(start, end).map((choice, offset) => {
        const index = start + offset;
        const header = choice.group && choice.group !== group ? (group = choice.group) : undefined;
        const selected = index === prompt.index;
        return (
          <Box key={`${index}-${choice.label}`} flexDirection="column">
            {header ? <Text dimColor>{header}</Text> : null}
            <Text color={selected ? 'cyan' : undefined} dimColor={choice.disabled}>
              {selected ? '❯ ' : '  '}{total <= 9 && prompt.kind !== 'picker' ? `${index + 1}. ` : ''}
              {prompt.kind === 'question' && prompt.question.multiSelect && index < (prompt.question.options?.length ?? 0) ? (prompt.selected.includes(index) ? '[x] ' : '[ ] ') : ''}{choice.label}
              {choice.detail ? <Text dimColor>{`  ${choice.detail}`}</Text> : null}
            </Text>
          </Box>
        );
      })}
      {end < total ? <Text dimColor>{`  ${t('picker.moreBelow', { count: total - end })}`}</Text> : null}
    </Box>
  );
}

function PromptView({ prompt, hint, t }: { prompt: Prompt; hint: string; t: Translate }) {
  if (prompt.kind === 'picker') {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
        <Text bold>{prompt.title}</Text>
        <Choices prompt={prompt} t={t} />
        <Text dimColor>{prompt.back ? t('picker.hintBack') : hint}</Text>
      </Box>
    );
  }
  if (prompt.kind === 'permission') {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
        <Text bold color="yellow">{prompt.title}</Text>
        {prompt.summary ? <Text>{prompt.summary}</Text> : null}
        {prompt.description ? <Text dimColor>{prompt.description}</Text> : null}
        <Choices prompt={prompt} t={t} />
      </Box>
    );
  }
  if (prompt.kind === 'question') {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
        <Text bold>{prompt.question.header ? `${prompt.question.header}: ` : ''}{prompt.question.question}{prompt.position ? <Text dimColor>{`  ${prompt.position}`}</Text> : null}</Text>
        <Choices prompt={prompt} t={t} />
      </Box>
    );
  }
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold>{hint}</Text>
      <Text>{prompt.plan}</Text>
      <Choices prompt={prompt} t={t} />
      <Text dimColor>{t('ask.planHint')}</Text>
    </Box>
  );
}

interface Editor { value: string; cursor: number }

function InputBox({ editor, placeholder }: { editor: Editor; placeholder: string }) {
  const before = editor.value.slice(0, editor.cursor);
  const at = editor.value[editor.cursor] ?? ' ';
  const after = editor.value.slice(editor.cursor + 1);
  return (
    <Box borderStyle="round" borderColor="gray" paddingX={1}>
      <Text color="cyan">{'> '}</Text>
      {editor.value ? (
        <Text>{before}<Text inverse>{at === '\n' ? ' ' : at}</Text>{at === '\n' ? '\n' : ''}{after}</Text>
      ) : (
        <Text><Text inverse> </Text><Text dimColor>{placeholder}</Text></Text>
      )}
    </Box>
  );
}

export function App({ controller, header }: { controller: ChatController; header: string }) {
  const app = useApp();
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const t = controller.translate();
  const [editor, setEditor] = useState<Editor>({ value: '', cursor: 0 });
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const prompt = snapshot.prompt;
  const typing = !prompt || prompt.kind === 'question' || prompt.kind === 'plan';
  const suggestions = typing ? commandSuggestions(editor.value) : [];

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
      const value = suggestions.length === 1 && editor.value !== `/${suggestions[0]}` && !editor.value.includes(' ') ? `/${suggestions[0]}` : editor.value;
      if (value.trim()) setHistory(items => [...items.filter(item => item !== value), value].slice(-100));
      setHistoryIndex(null);
      setEditor({ value: '', cursor: 0 });
      void controller.submit(value);
      return;
    }
    if (key.tab && suggestions.length) { const value = `/${suggestions[0]} `; setEditor({ value, cursor: value.length }); return; }
    if (key.upArrow || key.downArrow) {
      if (!history.length) return;
      const next = historyIndex === null ? (key.upArrow ? history.length - 1 : null) : historyIndex + (key.upArrow ? -1 : 1);
      if (next === null || next >= history.length) { setHistoryIndex(null); setEditor({ value: '', cursor: 0 }); return; }
      const index = Math.max(0, next);
      setHistoryIndex(index);
      setEditor({ value: history[index]!, cursor: history[index]!.length });
      return;
    }
    if (key.leftArrow) { setEditor(current => ({ ...current, cursor: Math.max(0, current.cursor - 1) })); return; }
    if (key.rightArrow) { setEditor(current => ({ ...current, cursor: Math.min(current.value.length, current.cursor + 1) })); return; }
    if (key.home || (key.ctrl && input === 'a')) { setEditor(current => ({ ...current, cursor: 0 })); return; }
    if (key.end || (key.ctrl && input === 'e')) { setEditor(current => ({ ...current, cursor: current.value.length })); return; }
    if (key.ctrl && input === 'u') { setEditor({ value: '', cursor: 0 }); return; }
    if (key.ctrl && input === 'j') { insert('\n'); return; }
    if (key.backspace || key.delete) {
      setEditor(current => (current.cursor === 0 ? current : { value: current.value.slice(0, current.cursor - 1) + current.value.slice(current.cursor), cursor: current.cursor - 1 }));
      return;
    }
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
  const model = snapshot.model;
  const status = snapshot.phase === 'connecting'
    ? t('chat.connecting', { where: model?.targetLabel ?? '' })
    : snapshot.phase === 'running' ? (prompt ? t('chat.waitingAnswer') : `${t(snapshot.thinking ? 'chat.thinking' : 'chat.working')}  ${t('chat.workingKeys')}`) : '';
  const queue = snapshot.queue;
  return (
    <Box flexDirection="column">
      <Static items={[{ id: 'header', kind: 'notice', tone: 'info', text: header } as Line, ...committed]}>
        {line => <TranscriptLine key={line.id} line={line} steerTag={t('chat.steerTag')} />}
      </Static>
      {pending.map(line => <TranscriptLine key={line.id} line={line} steerTag={t('chat.steerTag')} />)}
      {snapshot.live ? <Box marginTop={1}><Text>{snapshot.live}</Text></Box> : null}
      {status ? <Box marginTop={1}><Spinner /><Text dimColor>{` ${status}`}</Text></Box> : null}
      <Box marginTop={1} flexDirection="column">
        {prompt ? <PromptView prompt={prompt} t={t} hint={prompt.kind === 'plan' ? t('ask.planTitle') : t('picker.hint')} /> : null}
        {queue.length ? (
          <Box flexDirection="column" paddingX={2}>
            <Text color={snapshot.queuePaused ? 'yellow' : undefined} dimColor={!snapshot.queuePaused}>
              {snapshot.queuePaused ? t('chat.queuePaused', { count: queue.length }) : t('chat.queued', { count: queue.length })}
            </Text>
            {queue.slice(0, 3).map((item, index) => <Text key={item.id} dimColor>{`  ${index + 1}. ${item.text.split('\n')[0]!.slice(0, 100)}`}</Text>)}
            {queue.length > 3 ? <Text dimColor>{`  ${t('chat.queueMore', { count: queue.length - 3 })}`}</Text> : null}
            <Text dimColor>{`  ${t('chat.queueHint')}`}</Text>
          </Box>
        ) : null}
        {typing ? <InputBox editor={editor} placeholder={prompt?.kind === 'question' ? t(prompt.question.multiSelect ? 'ask.multiHint' : 'ask.questionHint') : prompt?.kind === 'plan' ? t('ask.planHint') : t('chat.hint')} /> : null}
        {suggestions.length ? (
          <Box flexDirection="column" paddingX={2}>
            {suggestions.map(name => <Text key={name}><Text color="cyan">{`/${name.padEnd(12)}`}</Text><Text dimColor>{commandDescription(t, name)}</Text></Text>)}
          </Box>
        ) : null}
        <Box paddingX={2}>
          <Text dimColor>
            {model ? `${model.modelName}${snapshot.effort ? ` (${snapshot.effort})` : ''} · ${model.targetLabel}` : t('chat.noModel')}
            {` · ${t(`perm.${snapshot.permission}` as MessageKey).split(/[ ：:]/)[0]}`}
            {snapshot.exitArmed ? `  ${t('chat.exitHint')}` : ''}
          </Text>
        </Box>
      </Box>
    </Box>
  );
}
