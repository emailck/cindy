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
 *   探测期间 Ctrl+C 被吞掉；/theme 选择不生效或不保存；
 *   状态栏：占位 status 帧把上下文清零、新请求仍显示上一轮速度、上一轮测速晚到被重复计入平均、远端进程重启后费用从零算起、
 *   宿主标记测速不可靠时仍显示本轮速度、/clear 后仍显示旧任务的用量；token 行只取一个模型、远端进程重启（新 epoch）后
 *   token 从零算起、缓存命中率与 Desktop 口径不一致（分母漏掉缓存写入）；
 *   折叠与展开（2026-11-16，参考 Claude Code）：思考内容直接倒进记录、连续 Read/Grep 各占一行、Subagent 的工具调用混成顶层行、
 *   打断后等结果的调用仍显示在运行、Ctrl+O 看不到被折叠的完整输出或 ← 不切到上一项；表格逐行流式到达时各行单独提交（列不对齐）；
 *   确认框只有一行摘要（看不到 Edit 的 diff 与行号、多行 Bash 命令只剩首行）；
 *   输入：`!命令` 被当成消息发给 Agent 或其输出没随下一条消息发送、`@` 补全不出现或发送时没有引用块、长粘贴把全文塞进记录、
 *   粘贴的图片路径当成文字发送而不是图片块；
 *   高优先级优化（2026-11-16）：确认框里输入的文字没有作为拒绝理由交回（本机凭证确认却接受了输入）、计划按原文显示 Markdown 标记
 *   或超长计划看不到结尾、Ctrl+R 搜不到上次运行的输入或发送后没有记住。
 * - 状态栏依据：用户需求（上下文占用、本轮与本任务平均 tok/s、预计费用、本任务输入／输出／缓存读写与命中率）；
 *   UsageSnapshot 字段语义见 maker-core types/events.ts，命中率公式见 Desktop shared/turnUsageDetails.ts。
 * - tier：unit（ink-testing-library 内存终端，假会话句柄）。
 * - 实测耗时：App.test.tsx 单独运行 vitest Duration 4.5 秒（2026-11-16，15 项；等待由 20 ms 降为 5 ms，只有 Esc 等 Ink 的 20 ms 判定）。
 */
import type { AgentEvent, AgentSessionHandle, InteractionDecision, InteractionResolver } from '@cindy/maker-core';
import { render } from 'ink-testing-library';
import { render as renderTerminal } from 'ink';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { CatalogModel } from '../catalog';
import { EventEmitter } from 'node:events';
import { App, tailRows } from './App';
import { ChatController } from './controller';
import { backgroundTheme, queryBackground } from './theme';

const model = (id: string): CatalogModel => ({ target: 'vps', targetLabel: 'vps', shared: false, providerId: 'anthropic', providerName: 'Anthropic',
  agent: 'claude-code', model: id, modelName: id, efforts: [], defaultEffort: null });
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
/** Ink holds a lone Esc for 20 ms (it may start an escape sequence) before delivering it. */
const pressEscape = async (stdin: { write(data: string): unknown }) => { stdin.write('\u001B'); await new Promise(resolve => setTimeout(resolve, 30)); };

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
  // Regression: the debug renderer above does not exercise Ink's TTY overflow fallback. A pending tool
  // followed by a long reply used to reprint committed history on every frame (user-reported flooding).
  // Unit: real App + Ink renderer, in-memory TTY, no process/network or persisted session.
  it.each(['light', 'dark'] as const)('does not replay history behind a pending tool or after resize (%s)', async setting => {
    const { handle } = streamingHandle();
    const controller = new ChatController({ workingDir: '/project', language: 'en', permission: 'full',
      theme: { setting, background: setting, depth: null },
      catalog: async () => ({ models: [model('claude-a')], unavailable: [] }), openTask: async () => handle,
      tasks: { list: async () => [], save: async () => {} } });
    const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 163, rows: 37 });
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
    let output = '';
    stdout.on('data', chunk => { output += chunk.toString(); });
    const ui = renderTerminal(<App controller={controller} header="HISTORY_SENTINEL" />, {
      stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream,
      stderr: new PassThrough() as unknown as NodeJS.WriteStream,
      interactive: true, incrementalRendering: true, patchConsole: false, exitOnCtrlC: false, maxFps: 1000,
    });
    try {
      await controller.init();
      await controller.submit('go');
      await tick();
      controller.apply({ type: 'tool_use', data: { toolUseId: 'slow', toolName: 'Bash', input: { command: 'slow-command' } } });
      controller.apply({ type: 'text', data: { text: Array.from({ length: 45 }, (_, i) => `pending-row-${i}`).join('\n'), isFinal: true } });
      await tick();
      expect(output.match(/HISTORY_SENTINEL/g)).toHaveLength(1);
      controller.apply({ type: 'thinking', data: { stage: 'start' } });
      await tick();
      expect(output.match(/HISTORY_SENTINEL/g)).toHaveLength(1);
      expect(output).not.toContain('\x1b[2J');
      stdout.columns = 40;
      stdout.rows = 12;
      stdout.emit('resize');
      await tick();
      // Ink itself redraws history on a width change. Subsequent frames must settle, not keep replaying it.
      output = '';
      stdin.write('DRAFT_SENTINEL');
      controller.apply({ type: 'thinking', data: { stage: 'final' } });
      await tick();
      controller.apply({ type: 'thinking', data: { stage: 'start' } });
      await tick();
      expect(output).not.toContain('HISTORY_SENTINEL');
      expect(output).toContain('DRAFT_SENTINEL');
      expect(output).not.toContain('\x1b[2J');
      // Finishing the pending tool must still print the full reply and late result into scrollback.
      output = '';
      controller.apply({ type: 'tool_result_full', data: { toolUseId: 'slow', fullText: 'LATE_RESULT' } });
      controller.apply({ type: 'done', data: {} });
      await tick();
      expect(output).toContain('pending-row-0');
      expect(output).toContain('pending-row-44');
      expect(output.match(/LATE_RESULT/g)).toHaveLength(1);
      expect(output).not.toContain('HISTORY_SENTINEL');
    } finally {
      ui.unmount();
      ui.cleanup();
      await controller.exit();
      stdin.destroy();
      stdout.destroy();
    }
  });

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
    const file = 'one\ntwo\nconst a = 1;\nconst b = 2;\nfive';
    const controller = new ChatController({ workingDir: '/project', language: 'en', permission: 'full',
      catalog: async () => ({ models: [model('claude-a'), model('claude-b')], unavailable: [] }), openTask: async () => handle,
      tasks: { list: async () => [], save: async () => {} }, readText: path => (path === '/project/a.ts' ? file : null) });
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

    // The confirmation shows what the call would do: a command in full, an edit's diff numbered from the local file.
    const decision: Promise<InteractionDecision> = resolver!({ kind: 'permission', requestId: 'r', toolName: 'Bash', input: { command: 'cd build &&\n  rm -rf out' } });
    await tick();
    expect(ui.lastFrame()).toContain('Allow Bash?');
    expect(ui.lastFrame()).toMatch(/cd build &&[ │]*\n[ │]*rm -rf out/);
    ui.stdin.write('2');
    expect(await decision).toEqual({ kind: 'permission', behavior: 'deny' });
    const edit = resolver!({ kind: 'permission', requestId: 'e', toolName: 'mcp__cindy_exec__Edit', input: { file_path: '/project/a.ts', old_string: 'const a = 1;', new_string: 'const a = 2;' } });
    await tick();
    for (const text of ['Allow Edit?', '2   two', '3 - const a = 1;', '3 + const a = 2;', '4   const b = 2;']) expect(ui.lastFrame()).toContain(text);
    // Typing on an Agent's confirmation denies the step and tells the Agent what to do instead.
    ui.stdin.write('use git mv instead'); await tick();
    ui.stdin.write('\r');
    expect(await edit).toEqual({ kind: 'permission', behavior: 'deny', reason: 'use git mv instead' });
    // A confirmation this computer raises (shared-provider credentials) answers yes or no only: typing does nothing.
    const credential = resolver!({ kind: 'permission', requestId: 'c', toolName: 'Read', input: { file_path: '/project/.env' }, metadata: { hostOwnedConfirmation: 'shared_provider_credential' } });
    await tick();
    expect(ui.lastFrame()).not.toContain('what the Agent should do instead');
    ui.stdin.write('x'); await tick();
    ui.stdin.write('2');
    expect(await credential).toEqual({ kind: 'permission', behavior: 'deny' });
    // A plan reads as Markdown; a long one shows its start, Ctrl+O the whole plan.
    const plan = resolver!({ kind: 'plan_review', requestId: 'pl', plan: ['# Steps', '1. **Rename** files', ...Array.from({ length: 30 }, (_, index) => `- step ${index + 3}`), 'LAST_STEP'].join('\n') });
    await tick();
    let frame = ui.lastFrame()!;
    expect(frame).toContain('Rename files');
    for (const text of ['# Steps', '**Rename**', 'LAST_STEP']) expect(frame).not.toContain(text);
    expect(frame).toMatch(/… \+\d+ lines · Ctrl\+O shows the whole plan/);
    ui.stdin.write('\u000F'); await tick();
    ui.stdin.write('G'); await tick();
    expect(ui.lastFrame()).toContain('LAST_STEP');
    await pressEscape(ui.stdin); // closes the viewer, not the plan
    ui.stdin.write('2');
    expect(await plan).toEqual({ kind: 'plan_review', behavior: 'deny' });
    frame = ui.lastFrame()!;

    await pressEscape(ui.stdin);
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
    const reply = 'Intro **bold** and `code`\n```js\nconst a = 2**3;\n**not bold**\n```\n# Done\n| Name | Count |\n|---|--:|\n| alpha | 1 |\n| **beta** | 22 |\nSee [docs](https://x.y).';
    // One source line per streamed piece: each finished line is committed as it arrives, except table rows,
    // which wait for the whole table.
    for (const piece of reply.split(/(?<=\n)/)) push({ type: 'text', data: { text: piece, isFinal: false } });
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
    // The table streamed row by row is printed once complete, columns aligned (right-aligned Count).
    for (const text of ['│ Name  │ Count │', '│ alpha │     1 │', '│ beta  │    22 │', 'See docs (https://x.y)']) expect(frame).toContain(text);
    expect(frame).not.toContain('|---|');
    for (const text of ['```', '# Done', 'three', 'n5', '<tool_use_error>', 'content']) expect(frame).not.toContain(text);
    ui.unmount();
  });

  it('shows context, this turn and average tok/s, and the reported cost in the status bar', async () => {
    const { handle, push } = streamingHandle();
    const controller = new ChatController({ workingDir: '/project', language: 'en', permission: 'full',
      catalog: async () => ({ models: [model('claude-a')], unavailable: [] }), openTask: async () => handle,
      tasks: { list: async () => [], save: async () => {} } });
    const ui = render(<App controller={controller} header="Cindy" />);
    const speed = (tokens: number, elapsedMs: number, rate: number, streaming: boolean) => ({ tokens, elapsedMs, rate, average: (tokens * 1000) / elapsedMs, streaming });
    const status = (data: Record<string, unknown>) => push({ type: 'status', data: { isRunning: true, ...data } } as AgentEvent);
    await controller.init();
    await controller.submit('one');
    await tick();
    // Request receipts: cumulative per Agent process (epoch), one row per model; the task row sums the models.
    const receipt = (epoch: string, ...models: Array<[string, number, number, number, number]>) => ({ epoch,
      models: models.map(([name, inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens]) => ({ model: name, inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens })) });
    status({ contextTokens: 50_000, contextWindow: 200_000, costUsd: 0.2, tokenSpeed: speed(300, 10_000, 42, true),
      requestUsage: receipt('p1', ['a', 1000, 300, 6000, 1000], ['b', 1000, 200, 0, 1000]) });
    await tick();
    expect(ui.lastFrame()).toContain('Context ███░░░░░░░ 25% 50k/200k  │  This turn 42 tok/s · Avg 30 tok/s  │  This task ≈ $0.200');
    // Hit rate = cache read / (input + cache read + cache write), Desktop's formula: 6k / 10k.
    expect(ui.lastFrame()).toContain('↑ In 2k   ↓ Out 500  │  Cache read 6k · write 2k · hit 60%');
    // Turn end: this turn shows its own average. A placeholder frame with zeros keeps the last known figures.
    status({ contextTokens: 170_000, contextWindow: 200_000, costUsd: 0.2, tokenSpeed: speed(300, 10_000, 42, false) });
    status({ isRunning: false, contextTokens: 0, contextWindow: 0, costUsd: 0 });
    push({ type: 'done', data: {} });
    await tick();
    expect(ui.lastFrame()).toContain('Context █████████░ 85% 170k/200k  │  This turn 30 tok/s · Avg 30 tok/s');
    expect(ui.lastFrame()).toContain('↑ In 2k   ↓ Out 500  │  Cache read 6k');
    // Next request: no stale "this turn"; a late repeat of the last turn's meter is not counted twice.
    await controller.submit('two');
    await tick();
    status({ tokenSpeed: speed(300, 10_000, 42, false) });
    await tick();
    expect(ui.lastFrame()).not.toContain('This turn');
    expect(ui.lastFrame()).toContain('Avg 30 tok/s');
    // The remote Agent process restarted: its cost starts over, the task total keeps what was spent before.
    // Its receipts start over too (new epoch): tokens keep counting on top of the earlier process's.
    status({ costUsd: 0.05, tokenSpeed: speed(100, 10_000, 10, true), requestUsage: receipt('p2', ['a', 1000, 500, 1000, 0]) });
    await tick();
    expect(ui.lastFrame()).toContain('This turn 10 tok/s · Avg 20 tok/s  │  This task ≈ $0.250');
    expect(ui.lastFrame()).toContain('↑ In 3k   ↓ Out 1k  │  Cache read 7k · write 2k · hit 58.3%');
    status({ generationReliable: false });
    await tick();
    expect(ui.lastFrame()).not.toContain('This turn');
    push({ type: 'done', data: {} });
    await tick();
    await controller.submit('/clear');
    await tick();
    expect(ui.lastFrame()).not.toContain('Context');
    expect(ui.lastFrame()).not.toContain('↑ In');
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
    expect(submit).toHaveBeenLastCalledWith(' one bX\ncd', {});
    await type('/c'); await type('\u001B[B'); await type('\r'); // ↓ highlights the second command, Enter runs it
    expect(submit).toHaveBeenLastCalledWith('/clear', {});
    ui.unmount();
  });

  it('reaches earlier runs\' inputs with Ctrl+R and remembers what is sent', async () => {
    const add = vi.fn(async () => {});
    const controller = new ChatController({ workingDir: '/project', language: 'en', permission: 'full',
      catalog: async () => ({ models: [model('claude-a')], unavailable: [] }), openTask: async () => { throw new Error('unused'); },
      tasks: { list: async () => [], save: async () => {} }, history: { load: async () => ['deploy staging', 'run tests', 'deploy prod'], add } });
    const submit = vi.spyOn(controller, 'submit');
    const ui = render(<App controller={controller} header="Cindy" />);
    await controller.init();
    const type = async (text: string) => { ui.stdin.write(text); await tick(); };
    await type('\u0012'); await type('depl'); // Ctrl+R: the newest match first
    expect(ui.lastFrame()).toContain('deploy prod');
    await type('\u0012'); // older match
    expect(ui.lastFrame()).toContain('deploy staging');
    await type('\r');
    expect(ui.lastFrame()).toContain('> deploy staging');
    await type('\r');
    expect(submit).toHaveBeenLastCalledWith('deploy staging', {});
    expect(add).toHaveBeenLastCalledWith('/project', 'deploy staging');
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

  it('folds thinking, read / search runs and sub-Agent calls, marks an interrupt, and expands output with Ctrl+O', async () => {
    const { handle, push } = streamingHandle();
    const controller = new ChatController({ workingDir: '/project', language: 'en', permission: 'full',
      catalog: async () => ({ models: [model('claude-a')], unavailable: [] }), openTask: async () => handle,
      tasks: { list: async () => [], save: async () => {} } });
    const ui = render(<App controller={controller} header="Cindy" />);
    await controller.init();
    await controller.submit('go');
    await tick();
    push({ type: 'thinking', data: { stage: 'start' } });
    push({ type: 'thinking', data: { stage: 'final', text: 'SECRET_PLAN', durationMs: 2_000 } });
    for (const [id, toolName, input] of [['r1', 'Read', { file_path: '/project/a.ts' }], ['g1', 'Grep', { pattern: 'foo' }], ['r2', 'Read', { file_path: '/project/b.ts' }]] as const) {
      push({ type: 'tool_use', data: { toolUseId: id, toolName, input } });
      push({ type: 'tool_result_full', data: { toolUseId: id, fullText: `${id}-content` } });
    }
    push({ type: 'tool_use', data: { toolUseId: 'b', toolName: 'Bash', input: { command: 'seq 10' } } });
    push({ type: 'tool_result_full', data: { toolUseId: 'b', fullText: Array.from({ length: 10 }, (_, index) => `n${index + 1}`).join('\n') } });
    // A sub-Agent's own calls arrive tagged with the call that started it.
    push({ type: 'tool_use', data: { toolUseId: 'task', toolName: 'Task', input: { description: 'Explore' } } });
    for (const id of ['c1', 'c2', 'c3', 'c4']) push({ type: 'tool_use', data: { toolUseId: id, toolName: 'Bash', input: { command: `ls ${id}` } }, agentMeta: { parentUuid: 'task' } } as AgentEvent);
    await tick(); await tick();
    let frame = ui.lastFrame()!;
    for (const text of ['Thought for 2s (Ctrl+O to show)', 'Read 2 files, searched 1 pattern', 'n4', '… +6 lines (Ctrl+O to expand)', 'Task(Explore)', 'Bash(ls c4)', '+1 more tool uses']) expect(frame).toContain(text);
    for (const text of ['SECRET_PLAN', 'Read(a.ts)', '⏺ Bash(ls c1)', 'n10']) expect(frame).not.toContain(text);

    ui.stdin.write('\u000F'); // Ctrl+O: the latest folded item, in full
    await tick();
    frame = ui.lastFrame()!;
    expect(frame).toContain('Bash(seq 10)');
    expect(frame).toContain('n10');
    ui.stdin.write('\u001B[D'); // ←: the item before it
    await tick();
    expect(ui.lastFrame()).toContain('r2-content');
    await pressEscape(ui.stdin);
    expect(ui.lastFrame()).not.toContain('r2-content');

    await pressEscape(ui.stdin); // Esc interrupts: the sub-Agent call never got its result
    frame = ui.lastFrame()!;
    expect(frame).toContain('Interrupted · Tell the Agent what to do instead');
    expect(frame).toMatch(/Task\(Explore\)\n\s+⎿\s+Interrupted/);
    ui.unmount();
  });

  it('sends a local command result, an @ mention, a long paste and a pasted image path with the next message', async () => {
    const send = vi.fn(async () => {});
    const handle = {
      id: 'n', agentKind: 'claude-code', model: 'a', send, steer: vi.fn(), abort: vi.fn(async () => {}), close: vi.fn(async () => {}),
      events: () => ({ async *[Symbol.asyncIterator]() { await new Promise(() => {}); } }),
      setInteractionResolver: () => {}, getUsageSnapshot: () => ({ tokenUsage: 0, contextTokens: 0, contextWindow: 0, costUsd: 0 }),
    } as unknown as AgentSessionHandle;
    const runLocal = vi.fn(async () => ({ output: 'v1.2', exitCode: 0 }));
    const controller = new ChatController({ workingDir: '/project', language: 'en', permission: 'full',
      catalog: async () => ({ models: [model('claude-a')], unavailable: [] }), openTask: async () => handle,
      tasks: { list: async () => [], save: async () => {} }, runLocal,
      statPath: path => (path === '/project/src/app.ts' || path === '/project/shot.png' ? 'file' : null),
      listFiles: async () => ['src/', 'src/app.ts', 'README.md'] });
    const ui = render(<App controller={controller} header="Cindy" />);
    await controller.init();
    const type = async (text: string) => { ui.stdin.write(text); await tick(); };
    await type('!git describe'); await type('\r'); await tick();
    expect(runLocal).toHaveBeenCalledWith('git describe', expect.any(AbortSignal));
    expect(ui.lastFrame()).toContain('v1.2');
    expect(ui.lastFrame()).toContain('Goes with your next message');
    expect(send).not.toHaveBeenCalled();

    await type('see @app'); await tick();
    expect(ui.lastFrame()).toContain('❯ @src/app.ts');
    await type('\t');
    const pasted = Array.from({ length: 12 }, (_, index) => `row${index + 1}`).join('\n');
    await type(`\u001B[200~${pasted}\u001B[201~`);
    await type('\u001B[200~/project/shot.png\u001B[201~');
    expect(ui.lastFrame()).toContain('see @src/app.ts [Pasted text #1 +12 lines] [Image #2]');
    await type('\r'); await tick();

    const message = (send.mock.calls[0] as unknown as [{ content: Array<Record<string, unknown>> }])[0];
    const [text, ...blocks] = message.content;
    expect(text!.text).toMatch(/^The user ran this command[^]*\$ git describe\nv1\.2\n\(exit code 0\)\n\nsee @src\/app\.ts row1\n[^]*row12 \[Image #2\]$/);
    expect(blocks).toEqual([
      { type: 'mention', name: 'app.ts', path: '/project/src/app.ts', kind: 'file' },
      { type: 'image', path: '/project/shot.png', mimeType: 'image/png' },
    ]);
    // The transcript keeps the placeholder rather than all twelve pasted rows.
    expect(ui.lastFrame()).toContain('> see @src/app.ts [Pasted text #1 +12 lines] [Image #2]');
    expect(ui.lastFrame()).not.toContain('row12');
    ui.unmount();
  });
});
