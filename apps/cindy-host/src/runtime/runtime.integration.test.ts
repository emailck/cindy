/**
 * Test value: createCliHost uses the production DeviceLinkClient/RemoteAgentHost to return discovery
 * for authorized peers before link admission, gate execution, revoke access, and recover rejected relay credentials.
 * Rule: CLI-005/006; protocol and remote adaptation rules require no unadmitted execution.
 * Gap: Desktop host tests do not exercise this new Node host's wiring or token recovery.
 * Minimal failure: provider:list before link-open; live config disable; WS upgrade rejection.
 * Tier: integration (real shared host/tunnel and filesystem lifecycle; fake relay/engine, no accounts).
 * Measured time: single-worker standalone 16.72s wall / 320ms tests; the shared Maker module
 * graph takes 15.47s collection on this machine, so this real tunnel case stays integration tier.
 */
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeReliableFrames, DEVICE_LINK_CAPABILITY_RELIABLE_TRANSPORT, PROTOCOL_VERSION, REMOTE_AGENT_CHANNEL, type Envelope, type WsLike, type RemoteAgentStreamItem, type RemoteAgentPollResult } from '@cindy/device-link';
import type { StartSessionOptions, AgentSessionHandle } from '@cindy/maker-core';
import { HOST_ENDPOINTS } from '../config';
import { createCliHost } from './index';
import { mapCodexModels, createNativeCodexAuth, createCodexProvider } from './codex';
import type { CodexModelListItem } from '@cindy/maker-core';
import { quietRuntimeLogger, mapClaudeModels, type createClaudeProvider } from './claude';

class Socket implements WsLike {
  sent: Envelope[] = [];
  private handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  private waiting = new Map<string, (value: unknown) => void>();
  send(data: string) {
    const frame = JSON.parse(data) as Envelope; this.sent.push(frame);
    if (frame.kind === 'invoke-result' && frame.id) { this.waiting.get(frame.id)?.(frame.payload); this.waiting.delete(frame.id); }
  }
  close() { this.emit('close', 1000); }
  on(event: string, handler: (...args: never[]) => void) {
    this.handlers.set(event, [...this.handlers.get(event) ?? [], handler as (...args: unknown[]) => void]);
  }
  emit(event: string, ...args: unknown[]) { for (const handler of this.handlers.get(event) ?? []) handler(...args); }
  push(frame: Envelope) { this.emit('message', { toString: () => JSON.stringify(frame) }); }
  ack() {
    this.emit('open');
    this.push({ v: PROTOCOL_VERSION, kind: 'hello-ack', payload: { serverProtocolVersion: PROTOCOL_VERSION, deviceId: 'host', userId: 'owner' } });
  }
  request(kind: Envelope['kind'], id: string, payload: unknown, src = 'desktop') { this.push({ v: PROTOCOL_VERSION, kind, id, src, payload }); }
  result(id: string) { return this.sent.findLast(frame => frame.kind === 'invoke-result' && frame.id === id)?.payload; }
  async remote(request: unknown): Promise<unknown> {
    const id = randomUUID();
    const result = new Promise<unknown>(resolve => { this.waiting.set(id, resolve); });
    this.request('invoke', id, { channel: REMOTE_AGENT_CHANNEL, args: [request] });
    const response = await result as { ok: boolean; result?: unknown; error?: unknown };
    if (!response.ok) throw new Error(JSON.stringify(response.error));
    return response.result;
  }
}

afterEach(() => { vi.useRealTimers(); });

async function harness(startSession?: (options: StartSessionOptions) => Promise<AgentSessionHandle>, kind: 'claude-code' | 'codex' = 'claude-code') {
  vi.useFakeTimers();
  let owner: string | null = 'account:incarnation-1';
  const config = { remoteAccessEnabled: true, permissionMode: 'full-access' as const, deviceName: 'test-host' };
  const sockets: Socket[] = [];
  const output = vi.fn();
  const auth = { getToken: vi.fn(async () => 'token'), captureOwner: () => owner, storageScope: () => 'global:account', refresh: vi.fn(async () => true) };
  const provider = { kind, dispose: vi.fn(async () => {}), id: 'anthropic', modelIds: new Set(['claude-test-1']), isAuthenticated: async () => true,
    view: (enabled: boolean) => ({ id: 'anthropic', connected: true, remoteInvocationEnabled: enabled, models: { [kind]: [{ id: 'claude-test-1', name: 'Test model', contextWindow: 128000, efforts: ['low'], defaultEffort: 'low' }] } }),
    agent: { capabilities: { availableModels: [] }, startSession: startSession ?? vi.fn(), forkSdkSession: vi.fn() },
  } as unknown as Awaited<ReturnType<typeof createClaudeProvider>>;
  const dataDir = path.join(os.tmpdir(), `cindy-host-test-${randomUUID()}`);
  const host = await createCliHost({ dataDir, region: 'global', endpoints: HOST_ENDPOINTS,
    config, output, error: vi.fn() }, { auth, createProvider: async () => provider, loadConfig: async () => config,
    createWebSocket: () => { const socket = new Socket(); sockets.push(socket); return socket; } });
  const start = host.start(new AbortController().signal);
  await vi.advanceTimersByTimeAsync(0);
  expect(output).not.toHaveBeenCalled();
  sockets[0].ack(); await start;
  const open = () => sockets.at(-1)!.request('link-open', 'link', { controllerName: 'desktop', protocolVersion: PROTOCOL_VERSION, appVersion: '1.0.0' });
  return { host, provider, sockets, output, auth, config, open, dataDir, setOwner: (next: string | null) => { owner = next; } };
}

describe('Node provider host', () => {
  // Regression: returning the long-poll promise from onFrame stalled ordered
  // delivery/ACK for 10 seconds, delaying even provider discovery behind it.
  // Real reliable transport + shared host, virtual time; a second peer is unaffected.
  it('admits later reliable requests before an idle poll completes without blocking another peer', async () => {
    let releaseEvents!: () => void;
    const ended = new Promise<void>(resolve => { releaseEvents = resolve; });
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const h = await harness(async options => {
      started();
      return { id: 'poll-session', agentKind: 'claude-code', model: options.model,
        async send() {}, async abort() {}, async steer() {}, close: async () => { releaseEvents(); },
        events: () => ({ async *[Symbol.asyncIterator]() { await ended; } }),
        setInteractionResolver() {}, getUsageSnapshot: () => ({ tokenUsage: 0, contextTokens: 0, contextWindow: 0, costUsd: 0 }),
      };
    });
    try {
      const socket = h.sockets[0];
      h.open();
      const runId = randomUUID();
      await socket.remote({ op: 'open', runId, agentKind: 'claude-code', payload: { json: {
        sessionId: 'idle-task', options: { model: 'claude-test-1', providerId: 'anthropic' },
        workspace: { workingDir: '/desktop/project', platform: 'linux', shell: 'bash' },
        projectFiles: [], ancestorFiles: [], personal: { files: [] }, mcpServers: [],
      } } });
      await ready;
      await vi.advanceTimersByTimeAsync(0);
      const initial = await socket.remote({ op: 'poll', runs: [{ runId, cursor: 0 }], waitMs: 0 }) as RemoteAgentPollResult;
      const cursor = initial.runs[0].cursor;
      for (const peer of ['desktop', 'other-desktop']) {
        socket.request('link-open', `link-${peer}`, { controllerName: peer, protocolVersion: PROTOCOL_VERSION,
          appVersion: '1', capabilities: [DEVICE_LINK_CAPABILITY_RELIABLE_TRANSPORT],
          transportStreamId: `stream-${peer}`, transportBaseSeq: 1 }, peer);
      }
      const send = (peer: string, seq: number, id: string, channel: string, args: unknown[]) => {
        for (const frame of encodeReliableFrames({ v: PROTOCOL_VERSION, kind: 'invoke', src: peer, id,
          payload: { channel, args } }, `stream-${peer}`, seq)) socket.push(frame);
      };
      send('desktop', 1, 'idle-poll', REMOTE_AGENT_CHANNEL, [{ op: 'poll', runs: [{ runId, cursor }], waitMs: 10000 }]);
      await vi.advanceTimersByTimeAsync(0);
      expect(socket.result('idle-poll')).toBeUndefined();
      send('desktop', 2, 'same-peer-discovery', 'maker:provider:list', []);
      send('other-desktop', 1, 'other-peer-discovery', 'maker:provider:list', []);
      await vi.advanceTimersByTimeAsync(0);
      expect(socket.result('other-peer-discovery')).toBeDefined();
      expect(socket.result('same-peer-discovery')).toBeDefined();
      expect(socket.result('idle-poll')).toBeUndefined();
      await vi.advanceTimersByTimeAsync(10000);
      expect(socket.result('idle-poll')).toBeDefined();
    } finally { releaseEvents(); await h.host.stop(); await rm(h.dataDir, { recursive: true, force: true }); }
  });

  // Native regression: two live API sessions previously requested provider-oauth
  // despite using the native API configuration, so session two tried to replace
  // an occupied app-server. No inference is sent; credentials and endpoint are fake.
  it.skipIf(!process.env.CINDY_CODEX_TEST_BINARY)('keeps two native API sessions attached across model changes', async () => {
    const dir = path.join(os.tmpdir(), `cindy-native-concurrency-${randomUUID()}`);
    const home = path.join(dir, 'codex');
    const workspace = path.join(dir, 'work');
    await mkdir(home, { recursive: true, mode: 0o700 });
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'invalid-fake-concurrency-key' }), { mode: 0o600 });
    await writeFile(path.join(home, 'config.toml'), 'model_provider="fixture"\nmodel="gpt-5.4"\n[model_providers.fixture]\nname="Fixture"\nbase_url="http://127.0.0.1:1/v1"\nwire_api="responses"\nrequires_openai_auth=true\n[mcp_servers.cindy_memory]\ncommand="false"\nenabled=false\n');
    vi.stubEnv('CODEX_HOME', home);
    let provider: Awaited<ReturnType<typeof createCodexProvider>> | undefined;
    const handles: AgentSessionHandle[] = [];
    try {
      provider = await createCodexProvider(dir, quietRuntimeLogger(), { CINDY_HOST_CODEX_BINARY: process.env.CINDY_CODEX_TEST_BINARY });
      for (let i = 0; i < 2; i++) {
        handles.push(await provider.agent.startSession({ sessionId: randomUUID(), workingDir: workspace,
          model: 'gpt-5.4', providerId: provider.id, permissionMode: 'bypassPermissions' }));
      }
      expect(handles).toHaveLength(2);
      await handles[0].setModel?.('gpt-5.4', { providerId: provider.id });
      expect(await readFile(path.join(home, 'config.toml'), 'utf8')).toContain('model_provider="fixture"');
    } finally {
      for (const handle of handles) await handle.close();
      await provider?.dispose();
      vi.unstubAllEnvs();
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it.each(['claude-code', 'codex'] as const)('allows pre-link %s discovery while requiring admission for execution', async kind => {
    const h = await harness(undefined, kind);
    try {
      const socket = h.sockets[0];
      socket.request('invoke', 'before', { channel: 'maker:provider:list', args: [] });
      await vi.advanceTimersByTimeAsync(0);
      expect(socket.result('before')).toMatchObject({ ok: true, result: { providers: [{ id: 'anthropic' }] } });
      socket.request('invoke', 'execution-before', { channel: REMOTE_AGENT_CHANNEL, args: [{ op: 'poll', runs: [] }] });
      await vi.advanceTimersByTimeAsync(0);
      expect(socket.result('execution-before')).toMatchObject({ ok: false, error: { code: 'ACCESS_REVOKED' } });
      h.open();
      expect(socket.sent.some(frame => frame.kind === 'link-accept')).toBe(true);
      socket.request('invoke', 'after', { channel: 'maker:provider:list', args: [] });
      await vi.advanceTimersByTimeAsync(0);
      expect(socket.result('after')).toMatchObject({ ok: true, result: { providers: [{ id: 'anthropic', connected: true }] } });
      socket.request('invoke', 'agents', { channel: 'maker:list-available-agents', args: [] });
      socket.request('invoke', 'other', { channel: 'maker:agent:status', args: [kind === 'codex' ? 'claude-code' : 'codex'] });
      await vi.advanceTimersByTimeAsync(0);
      expect(socket.result('agents')).toMatchObject({ ok: true, result: [kind] });
      expect(socket.result('other')).toMatchObject({ ok: true, result: { binaryReady: false, authReady: false } });
      // The desktop selector probes all three engines even when only one is enabled.
      for (const engine of ['claude-code', 'codex', 'pi']) {
        socket.request('invoke', `caps-${engine}`, { channel: 'maker:get-capabilities', args: [engine] });
      }
      await vi.advanceTimersByTimeAsync(0);
      for (const engine of ['claude-code', 'codex', 'pi']) {
        expect(socket.result(`caps-${engine}`)).toMatchObject({ ok: true, result: {
          availableModels: engine === kind ? [{ id: 'claude-test-1', displayName: 'Test model', contextWindow: 128000, defaultEffort: 'low' }] : [],
          ...(engine !== kind ? { hasFastMode: false, effortLevels: [], permissionModes: [] } : {}),
        } });
      }
      socket.request('invoke', 'denied', { channel: 'file-browser:remote-op', args: [] });
      await vi.advanceTimersByTimeAsync(0);
      expect(socket.result('denied')).toMatchObject({ ok: false, error: { code: 'CHANNEL_NOT_ALLOWED' } });
    } finally { await h.host.stop(); }
  });

  it('blocks calls after configuration revocation and stops when the authenticated owner changes', async () => {
    const h = await harness();
    try {
      h.open(); h.config.remoteAccessEnabled = false;
      await vi.advanceTimersByTimeAsync(1_000);
      h.sockets[0].request('invoke', 'revoked', { channel: 'maker:provider:list', args: [] });
      await vi.advanceTimersByTimeAsync(0);
      expect(h.sockets[0].result('revoked')).toMatchObject({ ok: false, error: { code: 'ACCESS_REVOKED' } });
      h.setOwner('other-account:incarnation-2');
      await vi.advanceTimersByTimeAsync(1_000);
      await h.host.waitUntilStopped?.();
    } finally { await h.host.stop(); }
  });

  it('forces refresh when relay rejects a locally unexpired token', async () => {
    const h = await harness();
    try {
      h.sockets[0].emit('error', new Error('Unexpected server response: 401'));
      h.sockets[0].emit('close', 1006);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.auth.refresh).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(35_000);
      expect(h.sockets.length).toBeGreaterThan(1);
    } finally { await h.host.stop(); }
  });

  // Regression: API-key Codex login was rejected solely because status was not
  // ChatGPT. Exercise the production adapter without reading real credentials.
  it.each(['oauth', 'api-key'] as const)('accepts native %s login without replacing Codex configuration', async source => {
    const status = vi.fn(async () => ({ stdout: '', stderr: source === 'oauth' ? 'Logged in using ChatGPT' : 'Logged in using an API key - fake-secret' }));
    const auth = createNativeCodexAuth('/unused/codex', status);
    expect(await auth.getState()).toEqual({ authenticated: true, authSource: source });
    expect(await auth.getAuthEnv({ credentialMode: 'provider-oauth' })).toEqual({});
    status.mockRejectedValueOnce(new Error('fake-secret'));
    expect(await auth.getState()).toEqual({ authenticated: false });
  });

  // Codex model/list uses model slug rather than row id. Hidden models must not
  // become remotely callable; the previous CLI only covered Claude alias mapping.
  it('projects only visible native Codex model slugs and advertised reasoning levels', () => {
    const base: CodexModelListItem = { id: 'row', model: 'test', displayName: 'Test', description: '', hidden: false, supportedReasoningEfforts: [], defaultReasoningEffort: 'low', additionalSpeedTiers: [], serviceTiers: [], isDefault: false };
    const models = mapCodexModels([
      { ...base, id: 'row-id', model: 'test-codex-model', displayName: 'Test Codex', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: '' }], defaultReasoningEffort: 'low' },
      { ...base, id: 'hidden', model: 'hidden-model', hidden: true },
    ]);
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ id: 'test-codex-model', efforts: ['low'], defaultEffort: 'low' });
  });

  it('resolves reported SDK aliases and never adds registry models outside discovered membership', () => {
    const mapped = mapClaudeModels([{ value: 'opus', description: 'Opus 4.7 with 1M context' }, { value: 'sonnet' }, { value: 'opus', description: 'Sonnet 4.6' },
      { value: 'claude-fable-5-20260401[1m]' }, { value: 'claude-3-7-sonnet-20250219' }, { value: 'claude-fable-5' }]);
    expect(mapped.map(model => model.id)).toEqual(['claude-opus-4-7', 'claude-fable-5', 'claude-3-7-sonnet']);
  });

  it.each(['claude-code', 'codex'] as const)('routes %s sessions through desktop tunnel with permission preservation and cleanup', async kind => {
    let finishStream!: () => void;
    const streamEnded = new Promise<void>(resolve => { finishStream = resolve; });
    let toolResult!: Promise<string>;
    let desktopFile!: string;
    const permissions: unknown[] = [];
    const close = vi.fn(async () => { finishStream(); });
    const h = await harness(async options => {
      expect(options.deviceHosted).toBeDefined();
      permissions.push(options.permissionMode);
      const hosted = options.deviceHosted!;
      return {
        id: 'native-session', agentKind: kind, model: options.model,
        async send() {
          toolResult = fetch(`${hosted.tunnelUrl}/exec/read-file`, { method: 'POST',
            headers: { authorization: `Bearer ${hosted.tunnelToken}`, 'content-type': 'application/json' },
            body: JSON.stringify({ path: desktopFile }) }).then(response => response.text());
        },
        async abort() {}, async steer() {}, close,
        events: () => ({ async *[Symbol.asyncIterator]() { await streamEnded; } }),
        setInteractionResolver() {}, getUsageSnapshot: () => ({ tokenUsage: 0, contextTokens: 0, contextWindow: 0, costUsd: 0 }),
      };
    }, kind);
    vi.useRealTimers();
    try {
      // Controller workspace is outside the provider's accounts/remote-agent shadow tree.
      const desktopWorkspace = path.join(h.dataDir, 'desktop-workspace');
      await mkdir(desktopWorkspace, { recursive: true });
      desktopFile = path.join(desktopWorkspace, 'evidence.txt');
      await writeFile(desktopFile, 'desktop-owned contents');
      h.open(); const socket = h.sockets[0]; let runId = randomUUID(); let cursor = 0;
      const poll = async () => {
        const result = await socket.remote({ op: 'poll', runs: [{ runId, cursor }], waitMs: 50 }) as RemoteAgentPollResult;
        const rows: RemoteAgentStreamItem[] = [];
        for (const run of result.runs) {
          cursor = run.cursor;
          if (run.data) rows.push(...Buffer.from(run.data, 'base64').toString().trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
        }
        return rows;
      };
      await socket.remote({ op: 'open', runId, agentKind: kind, payload: { json: {
        sessionId: 'desktop-task', options: { model: 'claude-test-1', providerId: 'anthropic' },
        workspace: { workingDir: '/desktop/project', platform: 'linux', shell: 'bash' }, projectFiles: [], ancestorFiles: [], personal: { files: [] }, mcpServers: [],
      } } });
      let started = false;
      for (let attempt = 0; attempt < 40 && !started; attempt++) started = (await poll()).some(item => item.t === 'started');
      expect(started).toBe(true);
      expect(permissions).toEqual(['bypassPermissions']);
      await socket.remote({ op: 'call', runId, callId: randomUUID(), method: 'send', payload: { json: [{ content: 'Read evidence' }] } });
      let request: Extract<RemoteAgentStreamItem, { t: 'request' }> | undefined;
      for (let attempt = 0; attempt < 40 && !request; attempt++) request = (await poll()).find((item): item is Extract<RemoteAgentStreamItem, { t: 'request' }> => item.t === 'request');
      expect(request?.request).toMatchObject({ type: 'http', path: '/exec/read-file' });
      if (request?.request.type !== 'http') throw new Error('Expected desktop HTTP execution request');
      const requestedPath = JSON.parse(Buffer.from(request.request.body!, 'base64').toString()).path as string;
      expect(requestedPath).toBe(desktopFile);
      const desktopContents = await readFile(requestedPath);
      await socket.remote({ op: 'reply', runId, requestId: request!.requestId,
        payload: { json: { type: 'http', status: 200, headers: [['content-type', 'text/plain']], body: desktopContents.toString('base64') } } });
      expect(await toolResult).toBe('desktop-owned contents');
      await socket.remote({ op: 'close', runId, mode: 'close', reason: 'navigation' });
      expect(close).toHaveBeenCalledOnce();
      runId = randomUUID(); cursor = 0;
      await socket.remote({ op: 'open', runId, agentKind: kind, payload: { json: {
        sessionId: 'desktop-ask-task', options: { model: 'claude-test-1', providerId: 'anthropic', permissionMode: 'ask' },
        workspace: { workingDir: '/desktop/project', platform: 'linux', shell: 'bash' }, projectFiles: [], ancestorFiles: [], personal: { files: [] }, mcpServers: [],
      } } });
      for (let attempt = 0; attempt < 40 && permissions.length < 2; attempt++) await poll();
      expect(permissions).toEqual(['bypassPermissions', 'ask']);
    } finally {
      await h.host.stop();
      expect(h.provider.dispose).toHaveBeenCalledOnce();
      const relative = path.relative(os.tmpdir(), h.dataDir);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Invalid test cleanup path');
      await rm(h.dataDir, { recursive: true, force: true });
    }
  });
});
