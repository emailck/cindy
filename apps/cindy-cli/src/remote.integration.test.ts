/**
 * 测试价值
 * - 生产入口与可观察结果：createCliLink + readCatalog + createRemoteTaskFactory（CLI 控制端）经内存中转连接真实
 *   createCliHost（cindy-host 提供端）；用户看到模型目录、远端 Agent 经隧道读到本机文件后的回答、权限档落到提供端。
 * - Bug／规则依据：docs/cindy-cli-client-plan.md CC-003/CC-004；remote-and-mobile-adaptation.md 故障半径三问
 *   （一台对端不应答时，另一台的链路与在途请求零感知）。
 * - 现有覆盖缺口：Desktop roundtrip 测的是 Desktop 自己的 remoteInvoke；CLI 的出站连接与接线是新代码。
 * - 最小失败输入：建链前读目录、默认 full 权限档、回到本机执行的文件读取与 Bash 命令（输出与工作目录副作用）、静默对端阻塞其它对端。
 * - tier：integration（真实 DeviceLinkClient ×2、真实共享宿主与 loopback 隧道、真实执行器；假中转与假引擎，无账号）。
 */
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, PROVIDER_SHARE_RELAY_CAPABILITY, type Envelope, type WsLike } from '@cindy/device-link';
import type { AgentEvent, AgentSessionHandle, StartSessionOptions } from '@cindy/maker-core';
import { HOST_ENDPOINTS } from '../../cindy-host/src/config';
import { createCliHost } from '../../cindy-host/src/runtime';
import type { createClaudeProvider } from '../../cindy-host/src/runtime/claude';
import { catalogSources, readCatalog } from './catalog';
import { createCliLink } from './link';
import { createRemoteTaskFactory } from './session';

/** Routes envelopes between registered devices like the official relay (same account). */
class Relay {
  readonly sockets = new Map<string, RelaySocket>();
  /** Devices whose frames are swallowed: online but never answering. */
  readonly silent = new Set<string>();
  connect(deviceId: string): RelaySocket {
    const socket = new RelaySocket(this, deviceId);
    this.sockets.set(deviceId, socket);
    return socket;
  }
  deliver(frame: Envelope) {
    if (!frame.dst || this.silent.has(frame.dst)) return;
    this.sockets.get(frame.dst)?.receive(frame);
  }
}

class RelaySocket implements WsLike {
  private handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  constructor(private readonly relay: Relay, readonly deviceId: string) { setTimeout(() => this.emit('open'), 0); }
  send(data: string) {
    const frame = JSON.parse(data) as Envelope;
    if (frame.kind === 'hello') {
      this.receive({ v: PROTOCOL_VERSION, kind: 'hello-ack', payload: { serverProtocolVersion: PROTOCOL_VERSION, deviceId: this.deviceId, userId: 'owner', capabilities: [PROVIDER_SHARE_RELAY_CAPABILITY] } });
      return;
    }
    if (frame.dst) setTimeout(() => this.relay.deliver({ ...frame, src: this.deviceId }), 0);
  }
  receive(frame: Envelope) { this.emit('message', { toString: () => JSON.stringify(frame) }); }
  close() { this.emit('close', 1000); }
  on(event: string, handler: (...args: never[]) => void) { this.handlers.set(event, [...this.handlers.get(event) ?? [], handler as (...args: unknown[]) => void]); }
  private emit(event: string, ...args: unknown[]) { for (const handler of this.handlers.get(event) ?? []) handler(...args); }
}

const auth = { getToken: async () => 'token', captureOwner: () => 'global:owner:1', storageScope: () => 'global:owner', refresh: async () => true };
const cleanup: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

async function startHost(relay: Relay, startSession: (options: StartSessionOptions) => Promise<AgentSessionHandle>) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'cindy-cli-host-'));
  cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
  const config = { remoteAccessEnabled: true, permissionMode: 'full-access' as const, deviceName: 'vps' };
  const provider = {
    kind: 'claude-code', id: 'anthropic', modelIds: new Set(['claude-test-1']), isAuthenticated: async () => true, dispose: async () => {},
    view: (enabled: boolean) => ({ id: 'anthropic', name: 'Anthropic', agents: ['claude-code'], connected: true, remoteInvocationEnabled: enabled,
      models: { 'claude-code': [{ id: 'claude-test-1', name: 'Test model', contextWindow: 128000, efforts: ['low', 'high'], defaultEffort: 'low' }] } }),
    agent: { capabilities: { availableModels: [] }, startSession, forkSdkSession: vi.fn() },
  } as unknown as Awaited<ReturnType<typeof createClaudeProvider>>;
  const host = await createCliHost({ dataDir, region: 'global', endpoints: HOST_ENDPOINTS, config, output() {}, error() {} },
    { auth, createProvider: async () => provider, loadConfig: async () => config, createWebSocket: () => relay.connect('host-device') });
  await host.start(new AbortController().signal);
  cleanup.push(() => host.stop());
}

/** Fake engine: reads a file on the controller through the tunnel, answers with its contents. */
function readingEngine(seen: StartSessionOptions[]) {
  return async (options: StartSessionOptions): Promise<AgentSessionHandle> => {
    seen.push(options);
    const hosted = options.deviceHosted!;
    const queue: AgentEvent[] = [];
    let wake: (() => void) | undefined;
    let ended = false;
    const push = (event: AgentEvent) => { queue.push(event); wake?.(); };
    return {
      id: 'native-session-1', agentKind: 'claude-code', model: options.model,
      async send() {
        const response = await fetch(`${hosted.tunnelUrl}/exec/fs.read`, { method: 'POST',
          headers: { authorization: `Bearer ${hosted.tunnelToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ path: 'evidence.txt' }) });
        const body = await response.json() as { data?: string };
        push({ type: 'text', data: { text: `read:${Buffer.from(body.data ?? '', 'base64').toString()}`, isFinal: true }, source: 'claude-code' });
        // Same path as Claude Code's Bash: the cindy_exec MCP tool, executed by the local shell session.
        const call = await fetch(`${hosted.tunnelUrl}/mcp/cindy_exec`, { method: 'POST',
          headers: { authorization: `Bearer ${hosted.tunnelToken}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'Bash', arguments: { command: 'echo shell-ok && echo made > made-by-shell.txt' } } }) });
        // Streamable HTTP may answer as SSE (keep-alive comments, then a data: line) or as plain JSON.
        const raw = await call.text();
        const payload = raw.trimStart().startsWith('{') ? raw : raw.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).at(-1) ?? '{}';
        const rpc = JSON.parse(payload) as { result?: { content?: Array<{ text?: string }> } };
        push({ type: 'text', data: { text: `bash:${rpc.result?.content?.map(part => part.text ?? '').join('') ?? ''}`, isFinal: true }, source: 'claude-code' });
        push({ type: 'done', data: {}, source: 'claude-code' });
      },
      async steer() {}, async abort() {}, async close() { ended = true; wake?.(); },
      events: () => ({ async *[Symbol.asyncIterator]() {
        for (;;) {
          if (queue.length) { yield queue.shift()!; continue; }
          if (ended) return;
          await new Promise<void>(resolve => { wake = resolve; });
        }
      } }),
      setInteractionResolver() {}, getUsageSnapshot: () => ({ tokenUsage: 0, contextTokens: 0, contextWindow: 0, costUsd: 0 }),
    };
  };
}

describe('terminal client against the Node provider host', () => {
  // Integration: exercise the factory's live trust lookup through the real tunnel + local executor.
  // Relay membership itself is covered by share tests; map the share identity to this in-process host.
  // Default/off must deny credential contents; trust must permit next read without weakening normal writes.
  it('rechecks per-share trust for each credential operation while preserving normal task gates', async () => {
    const relay = new Relay();
    let operation = { endpoint: 'fs.read', body: { path: '.env' } as Record<string, unknown> };
    await startHost(relay, async options => {
      const hosted = options.deviceHosted!;
      const queue: AgentEvent[] = [];
      let wake: (() => void) | undefined;
      let ended = false;
      const push = (event: AgentEvent) => { queue.push(event); wake?.(); };
      return {
        id: randomUUID(), agentKind: 'claude-code', model: options.model,
        async send() {
          const response = await fetch(`${hosted.tunnelUrl}/exec/${operation.endpoint}`, { method: 'POST',
            headers: { authorization: `Bearer ${hosted.tunnelToken}`, 'content-type': 'application/json' }, body: JSON.stringify(operation.body) });
          push({ type: 'text', data: { text: await response.text(), isFinal: true } });
          push({ type: 'done', data: {} });
        },
        async setPermissionMode() {},
        async steer() {}, async abort() {}, async close() { ended = true; wake?.(); },
        events: () => ({ async *[Symbol.asyncIterator]() {
          for (;;) {
            if (queue.length) { yield queue.shift()!; continue; }
            if (ended) return;
            await new Promise<void>(resolve => { wake = resolve; });
          }
        } }),
        setInteractionResolver() {}, getUsageSnapshot: () => ({ tokenUsage: 0, contextTokens: 0, contextWindow: 0, costUsd: 0 }),
      };
    });
    const link = createCliLink({ auth, deviceName: 'laptop', appVersion: '0.1.0', deviceLinkApiBaseUrl: HOST_ENDPOINTS.deviceLinkApiBaseUrl,
      createWebSocket: () => relay.connect('cli-device') });
    await link.start(new AbortController().signal); cleanup.push(() => link.stop());
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'cindy-cli-trust-'));
    cleanup.push(() => rm(workspace, { recursive: true, force: true }));
    await mkdir(path.join(workspace, 'project'));
    await writeFile(path.join(workspace, 'project', '.env'), 'INVALID_TEST_CREDENTIAL=not-a-secret');
    let trusted = false;
    const factory = createRemoteTaskFactory((_target, channel, args) => link.invoke('host-device', channel, args), {
      isShareTrusted: shareId => shareId === 'test-share' && trusted,
    });
    cleanup.push(() => factory.dispose());
    const handle = await factory.open({ target: 'share:test-share', agent: 'claude-code', providerId: 'anthropic', model: 'claude-test-1',
      permission: 'full', workingDir: path.join(workspace, 'project'), sessionId: randomUUID(), credentialNotice: 'test credential consent' });
    cleanup.push(() => handle.close());
    let prompts = 0;
    handle.setInteractionResolver(async () => { prompts++; return { kind: 'permission', behavior: 'deny' }; });
    const events = handle.events()[Symbol.asyncIterator]();
    const turn = async () => {
      await handle.send({ type: 'user', content: 'test local operation' });
      let result = '';
      for (;;) {
        const event = await events.next();
        if (event.done) throw new Error('Session ended before done');
        if (event.value.type === 'text') result += String((event.value.data as { text?: string }).text ?? '');
        if (event.value.type === 'done') return result;
      }
    };
    expect(await turn()).not.toContain(Buffer.from('INVALID_TEST_CREDENTIAL=not-a-secret').toString('base64'));
    expect(prompts).toBe(1);
    trusted = true;
    expect(await turn()).toContain(Buffer.from('INVALID_TEST_CREDENTIAL=not-a-secret').toString('base64'));
    expect(prompts).toBe(1);
    trusted = false;
    expect(await turn()).not.toContain(Buffer.from('INVALID_TEST_CREDENTIAL=not-a-secret').toString('base64'));
    expect(prompts).toBe(2);
    trusted = true;
    await handle.setPermissionMode?.('default');
    operation = { endpoint: 'fs.write', body: { path: path.join(workspace, 'outside.txt'), data: Buffer.from('must-not-write').toString('base64') } };
    expect(await turn()).toContain('not confirmed');
    // Low-level noncredential requests stay denied by the ordinary gate (the Agent must ask separately).
    expect(prompts).toBe(2);
    await expect(readFile(path.join(workspace, 'outside.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  }, 60_000);

  it('lists models, runs a task whose tool executes locally, and is not blocked by a silent computer', async () => {
    const relay = new Relay();
    const seen: StartSessionOptions[] = [];
    await startHost(relay, readingEngine(seen));
    relay.connect('silent-device');
    relay.silent.add('silent-device');

    const link = createCliLink({ auth, deviceName: 'laptop', appVersion: '0.1.0', deviceLinkApiBaseUrl: HOST_ENDPOINTS.deviceLinkApiBaseUrl,
      createWebSocket: () => relay.connect('cli-device') });
    await link.start(new AbortController().signal);
    cleanup.push(() => link.stop());

    // The silent computer's catalog read stays pending; the live one must still answer.
    const silentRead = readCatalog(link.invoke, [{ target: 'silent-device', label: 'Silent', shared: false }]);
    const sources = catalogSources([
      { deviceId: 'host-device', name: 'vps', platform: 'linux', appVersion: '0.1.0', lastSeenAt: null, online: true, busy: false, remoteControlEnabled: true, isSelf: false },
      { deviceId: 'cli-device', name: 'laptop', platform: 'win32', appVersion: '0.1.0', lastSeenAt: null, online: true, busy: false, remoteControlEnabled: false, isSelf: true },
    ], [], name => name);
    const catalog = await readCatalog(link.invoke, sources);
    expect(catalog.unavailable).toEqual([]);
    expect(catalog.models).toEqual([expect.objectContaining({ target: 'host-device', providerId: 'anthropic', model: 'claude-test-1', efforts: ['low', 'high'] })]);

    const workspace = await mkdtemp(path.join(os.tmpdir(), 'cindy-cli-workspace-'));
    cleanup.push(() => rm(workspace, { recursive: true, force: true }));
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, 'evidence.txt'), 'local-only contents');
    const factory = createRemoteTaskFactory(link.invoke);
    const handle = await factory.open({ target: 'host-device', agent: 'claude-code', providerId: 'anthropic', model: 'claude-test-1',
      permission: 'full', workingDir: workspace, sessionId: randomUUID(), credentialNotice: 'n/a' });
    cleanup.push(() => handle.close());
    expect(seen[0]?.permissionMode).toBe('bypassPermissions');

    const texts: string[] = [];
    const finished = (async () => {
      for await (const event of handle.events()) {
        if (event.type === 'text') texts.push(String((event.data as { text?: unknown }).text));
        if (event.type === 'done' || event.type === 'error') return event.type;
      }
      return 'ended';
    })();
    await handle.send({ type: 'user', content: 'read the evidence' });
    expect(await finished).toBe('done');
    expect(texts.join('')).toContain('read:local-only contents');
    // The command ran here, in the task's working directory, with this platform's shell (Git Bash on Windows).
    expect(texts.join('')).toContain('shell-ok');
    expect((await readFile(path.join(workspace, 'made-by-shell.txt'), 'utf8')).trim()).toBe('made');

    let silentSettled = false;
    void silentRead.then(() => { silentSettled = true; });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(silentSettled).toBe(false);
  }, 60_000);
});
