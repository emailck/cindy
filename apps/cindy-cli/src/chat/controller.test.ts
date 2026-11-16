/**
 * 测试价值
 * - 生产入口与可观察结果：ChatController（交互界面与 -p 共用的状态）与 runPrint；用户看到的对话行、回到 Agent 的确认决定、
 *   换模型/接回任务时实际打开的远端任务参数。
 * - Bug／规则依据：docs/cindy-cli-client-plan.md「斜杠命令」「交互确认」（不伪造用户选择，中断按拒绝）；
 *   provider-sharing.md §9 第 7 条（「本任务总是允许」只能来自用户选择，经同一确认通道回传授权建议）。
 * - 现有覆盖缺口：新代码；Desktop 的确认卡与模型选择器在 renderer，不经过这里。
 * - 最小失败输入：运行中输入被丢弃或立即发送、打断后队列继续自动发送、插话失败丢消息、多选只取一项、计划修改意见丢失；/model 未先选供应商、同名分享无法区分、连不上的来源可被选中；流式增量与最终全文重复显示；流式回复逐行提交后最终全文再次输出或 -p 输出被拆成多段；Ctrl+C 关闭确认被当成允许；换到另一台电脑的模型仍发到旧任务；
 *   /resume 不带原生会话 id；记录里的模型已不可用时仍把旧的原生会话 id 交给当前另一条路由。
 * - tier：unit（假会话句柄、内存任务记录；无网络）。
 */
import type { AgentEvent, AgentSessionHandle, InteractionDecision, InteractionRequest, InteractionResolver } from '@cindy/maker-core';
import { describe, expect, it, vi } from 'vitest';
import type { CatalogModel } from '../catalog';
import type { RemoteTaskRequest } from '../session';
import type { TaskRecord, TaskStore } from '../store';
import { ChatController, type ChatDeps } from './controller';
import { runPrint } from './print';

const model = (target: string, id: string): CatalogModel => ({ target, targetLabel: target, shared: false, providerId: 'anthropic', providerName: 'Anthropic',
  agent: 'claude-code', model: id, modelName: id, efforts: ['low', 'high'], defaultEffort: 'low' });

function fakeHandle(onSend?: (push: (event: AgentEvent) => void) => void) {
  const queue: AgentEvent[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  let resolver: InteractionResolver | undefined;
  const push = (event: AgentEvent) => { queue.push(event); wake?.(); };
  const handle = {
    id: 'native-1', agentKind: 'claude-code', model: 'm',
    send: vi.fn(async () => { onSend?.(push); }),
    steer: vi.fn(async (_message: unknown) => {}), abort: vi.fn(async () => {}), close: vi.fn(async () => { ended = true; wake?.(); }),
    events: () => ({ async *[Symbol.asyncIterator]() {
      for (;;) {
        if (queue.length) { yield queue.shift()!; continue; }
        if (ended) return;
        await new Promise<void>(resolve => { wake = resolve; });
      }
    } }),
    setInteractionResolver: (next: InteractionResolver) => { resolver = next; },
    getUsageSnapshot: () => ({ tokenUsage: 1200, contextTokens: 10, contextWindow: 100, costUsd: 0.0123 }),
    setModel: vi.fn(async () => {}), setPermissionMode: vi.fn(async () => {}), setPlanMode: vi.fn(async () => {}),
  };
  return { handle: handle as unknown as AgentSessionHandle & typeof handle, push, ask: (request: InteractionRequest, signal?: AbortSignal) => resolver!(request, signal) };
}

function setup(models: CatalogModel[], handles: ReturnType<typeof fakeHandle>[], records: TaskRecord[] = []) {
  const opened: RemoteTaskRequest[] = [];
  const saved: TaskRecord[] = [];
  const tasks: TaskStore = { list: async () => records, save: async record => { saved.push(record); } };
  const deps: ChatDeps = { workingDir: '/project', language: 'en', permission: 'full', catalog: async () => ({ models, unavailable: [] }),
    openTask: async request => { opened.push(request); return handles.shift()!.handle; }, tasks, now: () => 1 };
  return { controller: new ChatController(deps), opened, saved };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('ChatController', () => {
  it('shows streamed text once, attaches tool results, and records the task for /resume', async () => {
    const session = fakeHandle(push => {
      push({ type: 'text', data: { text: 'Hel', isFinal: false } });
      push({ type: 'text', data: { text: 'lo\nwor', isFinal: false } });
      push({ type: 'text', data: { text: 'ld\n\nbye', isFinal: false } });
      push({ type: 'text', data: { text: 'Hello\nworld\n\nbye', isFinal: true } });
      push({ type: 'tool_use', data: { toolUseId: 't1', toolName: 'Bash', input: { command: 'ls -la' } } });
      push({ type: 'tool_result_full', data: { toolUseId: 't1', fullText: 'a.txt\nb.txt' } });
      push({ type: 'done', data: {} });
    });
    const { controller, opened, saved } = setup([model('vps', 'claude-a')], [session]);
    await controller.init();
    await controller.submit('list files');
    await controller.waitForTurn();
    const lines = controller.getSnapshot().lines.filter(line => line.kind !== 'notice');
    expect(lines.map(line => line.kind === 'tool' ? `tool:${line.name}:${line.summary}:${line.result}` : `${line.kind}:${'text' in line ? line.text : ''}`))
      .toEqual(['user:list files', 'assistant:Hello', 'assistant:world', 'assistant:\nbye', 'tool:Bash:ls -la:a.txt\nb.txt']);
    // Finished lines are committed while streaming (the live area stays one line); later pieces continue the same reply.
    expect(lines.filter(line => line.kind === 'assistant').map(line => line.kind === 'assistant' && line.cont)).toEqual([false, true, true]);
    expect(opened[0]).toMatchObject({ target: 'vps', model: 'claude-a', permission: 'full', effort: 'low', workingDir: '/project' });
    await flush();
    expect(saved.at(-1)).toMatchObject({ title: 'list files', resumeSessionId: 'native-1', target: 'vps' });
  });

  it('keeps only the unfinished line of a streamed reply live (taller live text makes Ink redraw the whole screen)', async () => {
    let stream: ((event: AgentEvent) => void) | undefined;
    const session = fakeHandle(push => { stream = push; });
    const { controller } = setup([model('vps', 'claude-a')], [session]);
    await controller.init();
    await controller.submit('write a lot');
    stream!({ type: 'text', data: { text: `${Array.from({ length: 60 }, (_, index) => `row ${index + 1}`).join('\n')}\nstill typ`, isFinal: false } });
    await flush();
    expect(controller.getSnapshot().live).toBe('still typ');
    expect(controller.getSnapshot().lines.at(-1)).toMatchObject({ kind: 'assistant', text: expect.stringMatching(/^row 1\n[^]*\nrow 60$/) });
  });

  it('returns only what the user chose: session approval carries the suggestion, Ctrl+C and aborts deny', async () => {
    const session = fakeHandle();
    const { controller } = setup([model('vps', 'claude-a')], [session]);
    await controller.init();
    await controller.submit('go');
    const suggestion = { type: 'providerShareCredentialSessionApproval', destination: 'session' };
    const request: InteractionRequest = { kind: 'permission', requestId: 'r1', toolName: 'Read', input: { file_path: '/project/.env' }, suggestions: [suggestion] };

    const approved = session.ask(request);
    expect(controller.getSnapshot().prompt).toMatchObject({ kind: 'permission', summary: '/project/.env', choices: [{ label: 'Allow once' }, { label: 'Always allow for this session' }, { label: 'Deny' }] });
    controller.move(1); controller.choose();
    expect(await approved).toEqual({ kind: 'permission', behavior: 'allow', permissionUpdates: [suggestion] });

    const cancelled = session.ask({ ...request, requestId: 'r2' });
    controller.ctrlC();
    expect(await cancelled).toEqual<InteractionDecision>({ kind: 'permission', behavior: 'deny' });

    const aborter = new AbortController();
    const aborted = session.ask({ ...request, requestId: 'r3' }, aborter.signal);
    aborter.abort();
    expect(await aborted).toMatchObject({ kind: 'permission', behavior: 'deny', reason: 'dismissed' });
    expect(controller.getSnapshot().prompt).toBeNull();
  });

  it('switches models in place on the same computer and starts a new session on another computer', async () => {
    const first = fakeHandle(push => push({ type: 'done', data: {} }));
    const second = fakeHandle(push => push({ type: 'done', data: {} }));
    const { controller, opened } = setup([model('vps', 'claude-a'), model('vps', 'claude-b'), model('share:s1', 'claude-c')], [first, second]);
    await controller.init();
    await controller.submit('one'); await controller.waitForTurn();

    await controller.submit('/model claude-b');
    expect(first.handle.setModel).toHaveBeenCalledWith('claude-b', { providerId: 'anthropic', effort: 'low' });

    await controller.submit('/model');
    expect(controller.getSnapshot().prompt).toMatchObject({ kind: 'picker', title: 'Select a provider', index: 0,
      choices: [{ label: 'Anthropic · vps', detail: '2 models · current' }, { label: 'Anthropic · share:s1', detail: '1 models' }] });
    controller.move(1); controller.choose();
    expect(controller.getSnapshot().prompt).toMatchObject({ title: 'Select a model · Anthropic · share:s1', back: true, choices: [{ label: 'claude-c' }] });
    controller.cancelPrompt();
    expect(controller.getSnapshot().prompt).toMatchObject({ title: 'Select a provider' });
    controller.move(1); controller.choose(); controller.choose(); await flush();
    expect(first.handle.close).toHaveBeenCalled();
    await controller.submit('two'); await controller.waitForTurn();
    expect(opened.map(request => request.target)).toEqual(['vps', 'share:s1']);
    expect(opened[1]!.sessionId).not.toBe(opened[0]!.sessionId);
  });

  it('numbers duplicate provider labels and never selects an unreachable source', async () => {
    const shared = (target: string, id: string) => ({ ...model(target, id), targetLabel: 'Shared by Magi', shared: true });
    const deps: ChatDeps = { workingDir: '/project', language: 'en', permission: 'full', tasks: { list: async () => [], save: async () => {} },
      catalog: async () => ({ models: [shared('share:a', 'claude-a'), shared('share:b', 'claude-b')], unavailable: [{ target: 'share:c', label: 'Shared by Ann', shared: true }] }),
      openTask: async () => { throw new Error('not opened'); } };
    const controller = new ChatController(deps);
    await controller.init();
    await controller.submit('/model');
    expect(controller.getSnapshot().prompt?.choices).toEqual([
      { label: 'Anthropic · Shared by Magi', detail: '1 models · current' },
      { label: 'Anthropic · Shared by Magi (2)', detail: '1 models' },
      { label: 'Shared by Ann', detail: 'not reachable right now', disabled: true },
    ]);
    controller.move(1); controller.move(1);
    expect(controller.getSnapshot().prompt?.index).toBe(0);
    controller.choose(2);
    expect(controller.getSnapshot().prompt).toMatchObject({ title: 'Select a provider' });
  });

  it('applies plan mode to the open session and resumes a recorded session with its native id', async () => {
    const first = fakeHandle(push => push({ type: 'done', data: {} }));
    const second = fakeHandle(push => push({ type: 'done', data: {} }));
    const record: TaskRecord = { sessionId: 'old-session', workingDir: '/project', target: 'vps', targetLabel: 'vps', agent: 'claude-code',
      providerId: 'anthropic', model: 'claude-a', resumeSessionId: 'native-old', title: 'earlier work', updatedAt: 0 };
    const { controller, opened } = setup([model('vps', 'claude-a')], [first, second], [record]);
    await controller.init();
    await controller.submit('one'); await controller.waitForTurn();
    await controller.submit('/permissions plan');
    expect(first.handle.setPermissionMode).toHaveBeenCalledWith('default');
    expect(first.handle.setPlanMode).toHaveBeenCalledWith(true);

    await controller.submit('/resume');
    controller.choose(); await flush();
    await controller.submit('continue'); await controller.waitForTurn();
    expect(opened[1]).toMatchObject({ sessionId: 'old-session', resumeSessionId: 'native-old', permission: 'plan' });
  });

  it('-c continues the latest session here, and never reuses a resume id on another route', async () => {
    const record = (sessionId: string, target: string, updatedAt: number): TaskRecord => ({ sessionId, workingDir: '/project', target, targetLabel: target,
      agent: 'claude-code', providerId: 'anthropic', model: 'claude-a', resumeSessionId: `native-${sessionId}`, title: sessionId, updatedAt });
    const latest = fakeHandle(push => push({ type: 'done', data: {} }));
    const { controller, opened } = setup([model('vps', 'claude-a')], [latest], [record('latest', 'vps', 2), record('older', 'vps', 1)]);
    await controller.init();
    expect(await controller.continueLatest()).toBe(true);
    await controller.submit('go on'); await controller.waitForTurn();
    expect(opened[0]).toMatchObject({ sessionId: 'latest', resumeSessionId: 'native-latest', target: 'vps' });

    const fresh = fakeHandle(push => push({ type: 'done', data: {} }));
    const gone = setup([model('vps', 'claude-a')], [fresh], [record('elsewhere', 'old-laptop', 3)]);
    await gone.controller.init();
    expect(await gone.controller.continueLatest()).toBe(false);
    expect(gone.controller.getSnapshot().lines.at(-1)).toMatchObject({ tone: 'warn', text: expect.stringContaining('Cannot resume "elsewhere"') });
    await gone.controller.submit('hello'); await gone.controller.waitForTurn();
    expect(gone.opened[0]!.sessionId).not.toBe('elsewhere');
    expect(gone.opened[0]!.resumeSessionId).toBeUndefined();
  });

  it('queues input during a turn, pauses the queue on interrupt, and steers without losing a message', async () => {
    const session = fakeHandle();
    const { controller } = setup([model('vps', 'claude-a')], [session]);
    await controller.init();
    await controller.submit('first');
    await controller.submit('second');
    await controller.submit('third');
    expect(session.handle.send).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().queue.map(item => item.text)).toEqual(['second', 'third']);

    session.push({ type: 'done', data: {} }); await flush(); await flush();
    expect(session.handle.send).toHaveBeenLastCalledWith({ type: 'user', content: 'second' });
    expect(controller.getSnapshot().queue.map(item => item.text)).toEqual(['third']);

    controller.interrupt();
    expect(controller.getSnapshot()).toMatchObject({ phase: 'idle', queuePaused: true });
    await flush();
    expect(session.handle.send).toHaveBeenCalledTimes(2);
    await controller.submit('');
    expect(session.handle.send).toHaveBeenLastCalledWith({ type: 'user', content: 'third' });

    expect(await controller.steer('look at README first')).toBe('steered');
    expect(session.handle.steer).toHaveBeenCalledWith({ type: 'user', content: 'look at README first' });
    expect(controller.getSnapshot().lines.at(-1)).toMatchObject({ kind: 'user', text: 'look at README first', steer: true });

    await controller.submit('later');
    session.handle.steer.mockRejectedValueOnce(new Error('busy'));
    expect(await controller.steer('')).toBe('queued');
    expect(controller.getSnapshot().queue.map(item => item.text)).toEqual(['later']);
    expect(controller.popQueued()).toMatchObject({ text: 'later' });
    expect(controller.getSnapshot().queue).toEqual([]);
  });

  it('answers multi-select questions, sends plan feedback, and cycles permission modes', async () => {
    const session = fakeHandle();
    const { controller } = setup([model('vps', 'claude-a')], [session]);
    await controller.init();
    await controller.submit('start');
    const question = session.ask({ kind: 'ask_user_question', requestId: 'q', questions: [
      { question: 'Which checks?', multiSelect: true, options: [{ label: 'lint' }, { label: 'unit' }, { label: 'e2e' }] }] });
    controller.toggle(0); controller.toggle(2); controller.choose();
    expect(await question).toEqual({ kind: 'ask_user_question', answers: { 'Which checks?': 'lint, e2e' } });

    const plan = session.ask({ kind: 'plan_review', requestId: 'p', plan: '1. refactor' });
    await controller.submit('use pnpm, not npm');
    expect(await plan).toEqual({ kind: 'plan_review', behavior: 'deny', reason: 'use pnpm, not npm' });

    await controller.cyclePermission();
    expect(controller.getSnapshot().permission).toBe('normal');
    expect(session.handle.setPermissionMode).toHaveBeenLastCalledWith('default');
    await controller.cyclePermission();
    expect(session.handle.setPlanMode).toHaveBeenLastCalledWith(true);
  });

  it('warns at startup when ripgrep is missing (Linux hosts without rg)', async () => {
    const controller = new ChatController({ workingDir: '/project', language: 'en', permission: 'full', searchAvailable: false,
      catalog: async () => ({ models: [model('vps', 'claude-a')], unavailable: [] }), openTask: async () => { throw new Error('unused'); },
      tasks: { list: async () => [], save: async () => {} } });
    await controller.init();
    expect(controller.getSnapshot().lines[0]).toMatchObject({ kind: 'notice', tone: 'warn', text: expect.stringContaining('ripgrep (rg) was not found. The Agent searches with rg') });
  });

  it('print mode writes the final answer and denies prompts it cannot show', async () => {
    let decision: Promise<InteractionDecision> | undefined;
    const session = fakeHandle(push => {
      decision = session.ask({ kind: 'permission', requestId: 'p', toolName: 'Bash', input: { command: 'rm -rf x' } });
      void decision.then(() => {
        push({ type: 'text', data: { text: 'ans', isFinal: false } });
        push({ type: 'text', data: { text: 'wer\n\nmore', isFinal: false } });
        push({ type: 'text', data: { text: 'answer\n\nmore', isFinal: true } });
        push({ type: 'done', data: {} });
      });
    });
    const { controller } = setup([model('vps', 'claude-a')], [session]);
    const out: string[] = [];
    const err: string[] = [];
    expect(await runPrint(controller, 'do it', { output: text => out.push(text), error: text => err.push(text) })).toBe(0);
    expect(await decision).toEqual({ kind: 'permission', behavior: 'deny' });
    expect(out).toEqual(['answer\n\nmore']);
    expect(session.handle.close).toHaveBeenCalled();
  });
});
