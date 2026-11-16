/**
 * 测试价值
 * - 生产入口与可观察结果：App（ink 交互界面）渲染真实 ChatController；终端里看到的命令提示、模型选择列表、确认框，
 *   以及按键是否到达控制器（Enter 选择、Esc 打断、数字键直接选确认项）。
 * - Bug／规则依据：docs/cindy-cli-client-plan.md「斜杠命令」与快捷键；Esc 打断回合而不是退出。
 * - 现有覆盖缺口：controller.test 只调控制器方法，不经过按键映射。
 * - 最小失败输入：空输入框按 ? 没有打开操作说明；运行中 Enter 未排队、↑ 未取回排队消息、Ctrl+S 未插话、Shift+Tab 未切换权限档、多选数字键未勾选；工具结果晚于工具行到达时不显示（<Static> 只输出一次）；活动区文字超过终端剩余行数（Ink 每帧清屏重写全部历史，终端闪烁）；输入 /mo 后 Enter 没有补全为 /model；Esc 不调用 abort；数字键 2 没有选中「拒绝」（无授权建议时只有「允许这一次」「拒绝」两项）；
 *   回复与工具的终端呈现（Claude Code 习惯）：跨流式片段的代码块里 ** 被当成粗体吃掉或 ``` 围栏原样显示、Read 把文件内容倒进记录、
 *   Edit 不显示改了什么、长输出不折叠、<tool_use_error> 标签原样显示、TodoWrite 显示成 JSON；输入编辑：多行输入里 ↑ 跳到历史而不是上一行、
 *   Ctrl+W 不删词、Delete 当成退格、命令列表 ↓ 后 Enter 仍执行第一项；
 *   配色：终端背景回复（OSC 11）被读成错误的深浅、读到一半就判断、OSC 11 到达后立刻交出终端使紧随的 DA1 回复漏进输入框、
 *   探测期间 Ctrl+C 被吞掉；/theme 选择不生效或不保存。
 * - tier：unit（ink-testing-library 内存终端，假会话句柄）。
 */
import type { AgentEvent, AgentSessionHandle, InteractionDecision, InteractionResolver } from '@cindy/maker-core';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import type { CatalogModel } from '../catalog';
import { EventEmitter } from 'node:events';
import { App, tailRows } from './App';
import { ChatController } from './controller';
import { backgroundTheme, queryBackground } from './theme';

const model = (id: string): CatalogModel => ({ target: 'vps', targetLabel: 'vps', shared: false, providerId: 'anthropic', providerName: 'Anthropic',
  agent: 'claude-code', model: id, modelName: id, efforts: [], defaultEffort: null });
const tick = () => new Promise(resolve => setTimeout(resolve, 20));

/** A session whose events the test pushes one by one. */
function streamingHandle() {
  const queue: AgentEvent[] = [];
  let wake: (() => void) | undefined;
  const push = (event: AgentEvent) => { queue.push(event); wake?.(); };
  const handle = {
    id: 'n', agentKind: 'claude-code', model: 'a', send: vi.fn(async () => {}), steer: vi.fn(), abort: vi.fn(async () => {}), close: vi.fn(async () => {}),
    events: () => ({ async *[Symbol.asyncIterator]() {
      for (;;) { if (queue.length) { yield queue.shift()!; continue; } await new Promise<void>(resolve => { wake = resolve; }); }
    } }),
    setInteractionResolver: () => {},
    getUsageSnapshot: () => ({ tokenUsage: 0, contextTokens: 0, contextWindow: 0, costUsd: 0 }),
  } as unknown as AgentSessionHandle;
  return { handle, push };
}

describe('terminal UI', () => {
  it('completes slash commands, picks a model, answers a confirmation by number and interrupts with Esc', async () => {
    let resolver: InteractionResolver | undefined;
    const queue: AgentEvent[] = [];
    let wake: (() => void) | undefined;
    const push = (event: AgentEvent) => { queue.push(event); wake?.(); };
    const abort = vi.fn(async () => {});
    const handle = {
      id: 'n', agentKind: 'claude-code', model: 'a', send: vi.fn(async () => {}), steer: vi.fn(), abort, close: vi.fn(async () => {}),
      events: () => ({ async *[Symbol.asyncIterator]() {
        for (;;) { if (queue.length) { yield queue.shift()!; continue; } await new Promise<void>(resolve => { wake = resolve; }); }
      } }),
      setInteractionResolver: (next: InteractionResolver) => { resolver = next; },
      getUsageSnapshot: () => ({ tokenUsage: 0, contextTokens: 0, contextWindow: 0, costUsd: 0 }),
    } as unknown as AgentSessionHandle;
    const controller = new ChatController({ workingDir: '/project', language: 'en', permission: 'full',
      catalog: async () => ({ models: [model('claude-a'), model('claude-b')], unavailable: [] }), openTask: async () => handle,
      tasks: { list: async () => [], save: async () => {} } });
    const ui = render(<App controller={controller} header="Cindy" />);
    await controller.init();
    await tick();

    ui.stdin.write('/mo');
    await tick();
    expect(ui.lastFrame()).toContain('Choose the provider and model');
    ui.stdin.write('\r');
    await tick(); await tick();
    expect(ui.lastFrame()).toContain('Select a model');
    ui.stdin.write('\u001B[B');
    await tick();
    ui.stdin.write('\r');
    await tick();
    expect(controller.getSnapshot().model?.model).toBe('claude-b');

    ui.stdin.write('hello');
    await tick();
    ui.stdin.write('\r');
    await tick();
    push({ type: 'tool_use', data: { toolUseId: 't1', toolName: 'Bash', input: { command: 'ls' } } });
    await tick();
    push({ type: 'tool_result_full', data: { toolUseId: 't1', fullText: 'out.txt' } });
    await tick();
    expect(ui.lastFrame()).toContain('⎿  out.txt');

    const decision: Promise<InteractionDecision> = resolver!({ kind: 'permission', requestId: 'r', toolName: 'Bash', input: { command: 'rm -rf build' } });
    await tick();
    expect(ui.lastFrame()).toContain('Allow Bash?');
    ui.stdin.write('2');
    expect(await decision).toEqual({ kind: 'permission', behavior: 'deny' });

    ui.stdin.write('\u001B');
    await tick();
    expect(abort).toHaveBeenCalledOnce();
    ui.unmount();
  });

  it('caps live text to the rows left in the terminal, keeping the end of an over-long line', () => {
    // Taller live text makes Ink clear the screen and rewrite the whole transcript on every frame (flicker).
    expect(tailRows('a\nb\nc\nd', 2, 80)).toBe('c\nd');
    expect(tailRows(`${'x'.repeat(250)}END`, 2, 100)).toBe(`${'x'.repeat(197)}END`);
    expect(tailRows('中文'.repeat(60), 1, 10)).toBe('文中文中文');
  });

  it('scrolls a long model list in a fixed window', async () => {
    const models = Array.from({ length: 12 }, (_, index) => model(`claude-${index + 1}`));
    const controller = new ChatController({ workingDir: '/project', language: 'en', permission: 'full',
      catalog: async () => ({ models, unavailable: [] }), openTask: async () => { throw new Error('unused'); },
      tasks: { list: async () => [], save: async () => {} } });
    const ui = render(<App controller={controller} header="Cindy" />);
    await controller.init();
    await controller.submit('/model');
    await tick();
    expect(ui.lastFrame()).toContain('↓ 2 more');
    expect(ui.lastFrame()).not.toContain('claude-11');
    for (let step = 0; step < 8; step++) controller.move(1);
    await tick();
    expect(ui.lastFrame()).toContain('❯ claude-9');
    expect(ui.lastFrame()).toContain('↑ 2 more');
    expect(ui.lastFrame()).toContain('claude-12');
    ui.unmount();
  });

  it('queues with Enter while running, takes it back with ↑, steers with Ctrl+S and cycles permissions with Shift+Tab', async () => {
    let resolver: InteractionResolver | undefined;
    const steer = vi.fn(async () => {});
    const handle = {
      id: 'n', agentKind: 'claude-code', model: 'a', send: vi.fn(async () => {}), steer, abort: vi.fn(async () => {}), close: vi.fn(async () => {}),
      events: () => ({ async *[Symbol.asyncIterator]() { await new Promise(() => {}); } }),
      setInteractionResolver: (next: InteractionResolver) => { resolver = next; },
      getUsageSnapshot: () => ({ tokenUsage: 0, contextTokens: 0, contextWindow: 0, costUsd: 0 }),
      setPermissionMode: vi.fn(async () => {}), setPlanMode: vi.fn(async () => {}),
    } as unknown as AgentSessionHandle;
    const controller = new ChatController({ workingDir: '/project', language: 'en', permission: 'full',
      catalog: async () => ({ models: [model('claude-a')], unavailable: [] }), openTask: async () => handle,
      tasks: { list: async () => [], save: async () => {} } });
    const ui = render(<App controller={controller} header="Cindy" />);
    await controller.init();
    const type = async (text: string) => { ui.stdin.write(text); await tick(); };
    await type('start'); await type('\r');
    await type('later'); await type('\r');
    expect(ui.lastFrame()).toContain('Queued (1)');
    expect(ui.lastFrame()).toContain('Ctrl+S steer');
    await type('\u001B[A');
    expect(controller.getSnapshot().queue).toEqual([]);
    expect(ui.lastFrame()).toContain('> later');
    await type('\u0013');
    expect(steer).toHaveBeenCalledWith({ type: 'user', content: 'later' });
    expect(ui.lastFrame()).toContain('[steer]');
    await type('\u001B[Z');
    expect(controller.getSnapshot().permission).toBe('normal');

    const answer = resolver!({ kind: 'ask_user_question', requestId: 'q', questions: [
      { question: 'Which checks?', multiSelect: true, options: [{ label: 'lint' }, { label: 'unit' }, { label: 'e2e' }] }] });
    await tick();
    await type('1'); await type('3');
    expect(ui.lastFrame()).toContain('[x] lint');
    await type('\r');
    expect(await answer).toEqual({ kind: 'ask_user_question', answers: { 'Which checks?': 'lint, e2e' } });
    ui.unmount();
  });

  it('opens the operations guide with ? on an empty input', async () => {
    const controller = new ChatController({ workingDir: '/project', language: 'zh', permission: 'full',
      catalog: async () => ({ models: [model('claude-a')], unavailable: [] }), openTask: async () => { throw new Error('unused'); },
      tasks: { list: async () => [], save: async () => {} } });
    const ui = render(<App controller={controller} header="Cindy" />);
    await controller.init();
    ui.stdin.write('?');
    await tick();
    const frame = ui.lastFrame()!;
    for (const text of ['任务运行中', '插话：不打断', '回答 Agent', '切换权限档', '/model']) expect(frame).toContain(text);
    expect(frame).not.toContain('> ?');
    ui.unmount();
  });

  it('renders replies as Markdown and summarizes tool calls the way Claude Code does', async () => {
    const { handle, push } = streamingHandle();
    const controller = new ChatController({ workingDir: '/project', language: 'en', permission: 'full',
      catalog: async () => ({ models: [model('claude-a')], unavailable: [] }), openTask: async () => handle,
      tasks: { list: async () => [], save: async () => {} } });
    const ui = render(<App controller={controller} header="Cindy" />);
    await controller.init();
    await controller.submit('go');
    await tick();
    // The code fence opens in one streamed piece and closes in a later one.
    const reply = 'Intro **bold** and `code`\n```js\nconst a = 2**3;\n**not bold**\n```\n# Done';
    push({ type: 'text', data: { text: reply.slice(0, 40), isFinal: false } });
    push({ type: 'text', data: { text: reply.slice(40), isFinal: false } });
    push({ type: 'text', data: { text: reply, isFinal: true } });
    const tool = (id: string, toolName: string, input: unknown, fullText: string) => {
      push({ type: 'tool_use', data: { toolUseId: id, toolName, input } });
      push({ type: 'tool_result_full', data: { toolUseId: id, fullText } });
    };
    tool('r', 'Read', { file_path: '/project/src/a.ts' }, '     1\tone\n     2\ttwo\n     3\tthree');
    tool('e', 'Edit', { file_path: '/project/src/a.ts', old_string: 'keep\nold\nkeep2', new_string: 'keep\nnew\nkeep2' }, 'ok');
    tool('b', 'Bash', { command: 'seq 10' }, Array.from({ length: 10 }, (_, index) => `n${index + 1}`).join('\n'));
    tool('x', 'Bash', { command: 'false' }, '<tool_use_error>boom</tool_use_error>');
    tool('t', 'TodoWrite', { todos: [{ content: 'first step', status: 'completed' }, { content: 'second step', status: 'in_progress' }, { content: 'third step', status: 'pending' }] }, 'ok');
    push({ type: 'done', data: {} });
    await tick(); await tick();
    const frame = ui.lastFrame()!;
    for (const text of ['⏺ Intro bold and code', 'const a = 2**3;', '**not bold**', 'Done', 'Read(src/a.ts)', 'Read 3 lines', 'Update(src/a.ts)',
      'Updated src/a.ts (+1 −1)', '- old', '+ new', 'n4', '… +6 lines', 'boom', '☒ first step', '◼ second step', '☐ third step']) expect(frame).toContain(text);
    expect(frame.indexOf('- old')).toBeLessThan(frame.indexOf('+ new'));
    for (const text of ['```', '# Done', 'three', 'n5', '<tool_use_error>', 'content']) expect(frame).not.toContain(text);
    ui.unmount();
  });

  it('edits the input like a shell line: lines, words, forward delete, and choosing a listed command', async () => {
    const controller = new ChatController({ workingDir: '/project', language: 'en', permission: 'full',
      catalog: async () => ({ models: [model('claude-a')], unavailable: [] }), openTask: async () => { throw new Error('unused'); },
      tasks: { list: async () => [], save: async () => {} } });
    const submit = vi.spyOn(controller, 'submit');
    const ui = render(<App controller={controller} header="Cindy" />);
    await controller.init();
    const type = async (text: string) => { ui.stdin.write(text); await tick(); };
    await type('/status'); await type('\r'); // history now has an entry for ↑ to wrongly jump to
    await type('ab'); await type('\n'); await type('cd');
    await type('\u001B[A'); await type('X'); // ↑ in a two-line input: previous line, same column
    await type('\u0001'); await type('\u001B[3~'); // Ctrl+A, Delete: removes the character after the cursor
    await type(' one two'); await type('\u0017'); // typed at the line start; Ctrl+W deletes "two" before the cursor
    await type('\r');
    expect(submit).toHaveBeenLastCalledWith(' one bX\ncd');
    await type('/c'); await type('\u001B[B'); await type('\r'); // ↓ highlights the second command, Enter runs it
    expect(submit).toHaveBeenLastCalledWith('/clear');
    ui.unmount();
  });

  it('reads the terminal background and hands stdin back only after the terminal has finished replying', async () => {
    for (const [reply, theme] of [
      ['\x1b]11;rgb:ffff/ffff/ffff\x1b\\', 'light'], ['\x1b]11;rgb:1e1e/1e1e/1e1e\x07', 'dark'], ['\x1b]11;rgb:fd/f6/e3\x07', 'light'],
      ['\x1b]11;rgba:0000/0000/0000/ffff\x07', 'dark'], ['\x1b]11;rgb:ffff/ffff/ff', null],
    ] as const) expect(backgroundTheme(reply)).toBe(theme);

    const tty = () => Object.assign(new EventEmitter(), { isTTY: true, raw: false, setRawMode(mode: boolean) { this.raw = mode; }, resume() {}, pause() {} });
    const stdin = tty();
    const written: string[] = [];
    let settled = false;
    const result = queryBackground(stdin, { write: text => written.push(text) }, { timeoutMs: 5_000 }).then(theme => { settled = true; return theme; });
    expect(written.join('')).toBe('\x1b]11;?\x1b\\\x1b[c');
    stdin.emit('data', Buffer.from('\x1b]11;rgb:ffff/ffff/ffff\x07'));
    await tick();
    expect(settled).toBe(false); // the DA1 reply is still on its way; Ink must not read it as typing
    stdin.emit('data', Buffer.from('\x1b[?62;22c'));
    expect(await result).toBe('light');
    expect(stdin.raw).toBe(false);
    expect(stdin.listenerCount('data')).toBe(0);

    const interrupted = tty();
    const onInterrupt = vi.fn();
    const pending = queryBackground(interrupted, { write: () => {} }, { timeoutMs: 5_000, onInterrupt });
    interrupted.emit('data', Buffer.from('\x03'));
    expect(await pending).toBeNull();
    expect(onInterrupt).toHaveBeenCalledOnce();
  });

  it('switches and saves the colors with /theme', async () => {
    const saveTheme = vi.fn(async () => {});
    const controller = new ChatController({ workingDir: '/project', language: 'en', permission: 'full',
      catalog: async () => ({ models: [model('claude-a')], unavailable: [] }), openTask: async () => { throw new Error('unused'); },
      tasks: { list: async () => [], save: async () => {} }, theme: { setting: 'auto', background: 'light', depth: null }, saveTheme });
    expect(controller.getSnapshot().theme).toBe('light');
    const ui = render(<App controller={controller} header="Cindy" />);
    await controller.init();
    ui.stdin.write('/theme');
    await tick();
    ui.stdin.write('\r');
    await tick();
    expect(ui.lastFrame()).toContain('Auto — follow the terminal (Light)');
    ui.stdin.write('\u001B[B'); // Dark
    await tick();
    ui.stdin.write('\r');
    await tick();
    expect(controller.getSnapshot()).toMatchObject({ theme: 'dark', themeSetting: 'dark' });
    expect(saveTheme).toHaveBeenCalledWith('dark');
    ui.unmount();
  });
});
