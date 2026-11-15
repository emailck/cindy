/**
 * 测试价值
 * - 生产入口与可观察结果：App（ink 交互界面）渲染真实 ChatController；终端里看到的命令提示、模型选择列表、确认框，
 *   以及按键是否到达控制器（Enter 选择、Esc 打断、数字键直接选确认项）。
 * - Bug／规则依据：docs/cindy-cli-client-plan.md「斜杠命令」与快捷键；Esc 打断回合而不是退出。
 * - 现有覆盖缺口：controller.test 只调控制器方法，不经过按键映射。
 * - 最小失败输入：空输入框按 ? 没有打开操作说明；运行中 Enter 未排队、↑ 未取回排队消息、Ctrl+S 未插话、Shift+Tab 未切换权限档、多选数字键未勾选；工具结果晚于工具行到达时不显示（<Static> 只输出一次）；输入 /mo 后 Enter 没有补全为 /model；Esc 不调用 abort；数字键 2 没有选中「拒绝」（无授权建议时只有「允许这一次」「拒绝」两项）。
 * - tier：unit（ink-testing-library 内存终端，假会话句柄）。
 */
import type { AgentEvent, AgentSessionHandle, InteractionDecision, InteractionResolver } from '@cindy/maker-core';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import type { CatalogModel } from '../catalog';
import { App } from './App';
import { ChatController } from './controller';

const model = (id: string): CatalogModel => ({ target: 'vps', targetLabel: 'vps', shared: false, providerId: 'anthropic', providerName: 'Anthropic',
  agent: 'claude-code', model: id, modelName: id, efforts: [], defaultEffort: null });
const tick = () => new Promise(resolve => setTimeout(resolve, 20));

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
    expect(ui.lastFrame()).toContain('⎿ out.txt');

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
});
