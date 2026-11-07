import { SHARE_INSIGHTS_CHANNEL } from '../share-quota';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { createServer } from 'node:http';
import { createCodexShareBridge } from './codex-share';
import { runShareControl, startShareControl } from '../share-control';
/**
 * Test value: createCliHost uses the production DeviceLinkClient/RemoteAgentHost to return discovery
 * for authorized peers before link admission, gate execution, revoke access, and recover rejected relay credentials.
 * Rule: CLI-005/006; protocol and remote adaptation rules require no unadmitted execution.
 * Gap: Desktop host tests do not exercise this new Node host's wiring or token recovery.
 * Minimal failure: provider:list before link-open; live config disable; WS upgrade rejection.
 * Sharing extends this existing integration tier with real local sockets/native guest
 * processes and fake upstreams; unit parser tests alone cannot verify those boundaries.
 * Tier: integration (real shared host/tunnel and filesystem lifecycle; fake relay/engine, no accounts).
 * Measured time: single-worker standalone 16.72s wall / 320ms tests; the shared Maker module
 * graph takes 15.47s collection on this machine, so this real tunnel case stays integration tier.
 */
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, rm, writeFile, stat, symlink, link } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROVIDER_SHARE_RELAY_CAPABILITY, encodeReliableFrames, DEVICE_LINK_CAPABILITY_RELIABLE_TRANSPORT, PROTOCOL_VERSION, REMOTE_AGENT_CHANNEL, type Envelope, type WsLike, type RemoteAgentStreamItem, type RemoteAgentPollResult } from '@cindy/device-link';
import type { StartSessionOptions, AgentSessionHandle } from '@cindy/maker-core';
import { HOST_ENDPOINTS } from '../config';
import { createCliHost } from './index';
import { mapCodexModels, createNativeCodexAuth, createCodexProvider } from './codex';
import type { CodexModelListItem } from '@cindy/maker-core';
import { quietRuntimeLogger, mapClaudeModels, createNativeClaudeSharing, createClaudeProvider } from './claude';
import { startupDiagnostics } from './startupDiagnostics';

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
    this.push({ v: PROTOCOL_VERSION, kind: 'hello-ack', payload: { serverProtocolVersion: PROTOCOL_VERSION, deviceId: 'host', userId: 'owner', capabilities: [PROVIDER_SHARE_RELAY_CAPABILITY] } });
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

async function harness(startSession?: (options: StartSessionOptions) => Promise<AgentSessionHandle>, kind: 'claude-code' | 'codex' = 'claude-code', sharing = false, idleMinutes?: number) {
  vi.useFakeTimers();
  let owner: string | null = 'account:incarnation-1';
  const config = { remoteAccessEnabled: true, permissionMode: 'full-access' as const, deviceName: 'test-host', idleMinutes };
  const sockets: Socket[] = [];
  const output = vi.fn();
  const diagnostics = vi.fn();
  const auth = { getToken: vi.fn(async () => 'token'), captureOwner: () => owner, storageScope: () => 'global:account', refresh: vi.fn(async () => true) };
  const provider = { kind, sharing: sharing ? { supported: true, prepare: async () => {}, bind: async () => null } : undefined, dispose: vi.fn(async () => {}), id: 'anthropic', modelIds: new Set(['claude-test-1']), isAuthenticated: async () => true,
    view: (enabled: boolean) => ({ id: 'anthropic', connected: true, remoteInvocationEnabled: enabled, models: { [kind]: [{ id: 'claude-test-1', name: 'Test model', contextWindow: 128000, efforts: ['low'], defaultEffort: 'low' }] } }),
    readQuota: vi.fn(async () => ({ state: 'ready', updatedAt: Date.now(), windows: [{ kind: 'week', label: null, remainingPercent: 72, resetsAt: Date.now() + 86400000, windowMinutes: 10080 }], balance: null })),
    agent: { capabilities: { availableModels: [] }, startSession: startSession ?? vi.fn(), forkSdkSession: vi.fn() },
  } as unknown as Awaited<ReturnType<typeof createClaudeProvider>>;
  const dataDir = path.join(os.tmpdir(), `cindy-host-test-${randomUUID()}`);
  if (sharing) await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const host = await createCliHost({ dataDir, region: 'global', endpoints: HOST_ENDPOINTS,
    config, output, error: diagnostics }, { auth, createProvider: async () => provider, loadConfig: async () => config,
    createWebSocket: () => { const socket = new Socket(); sockets.push(socket); return socket; } });
  const start = host.start(new AbortController().signal);
  await vi.advanceTimersByTimeAsync(0);
  expect(output).not.toHaveBeenCalled();
  sockets[0].ack(); await start;
  const open = () => sockets.at(-1)!.request('link-open', 'link', { controllerName: 'desktop', protocolVersion: PROTOCOL_VERSION, appVersion: '1.0.0' });
  return { host, provider, sockets, output, diagnostics, auth, config, open, dataDir, setOwner: (next: string | null) => { owner = next; } };
}

describe('Node provider host', () => {
  // Production logging boundary: only fixed startup diagnostics may leave the quiet runtime.
  // Existing startup tests injected desktop loggers and missed CLI no-op wiring. Minimal input:
  // approved timing with secret extra fields plus an ordinary runtime log; integration fixture.
  it('rebuilds startup diagnostics and suppresses arbitrary runtime messages and fields', () => {
    const output = vi.fn();
    const logger = quietRuntimeLogger(startupDiagnostics(output));
    const secret = 'private-secret-payload';
    logger.info(secret, { stage: 'initialize' });
    logger.info('remote agent startup timing', { side: 'codex', stage: secret, status: 'ok' });
    logger.child(secret).info('remote agent startup timing', {
      side: 'codex', stage: 'initialize', status: 'ok', durationMs: 12, elapsedMs: Infinity,
      runtimeVersion: '0.159.2', sessionRef: secret, token: secret, path: secret,
      stagesMs: { initialize: 12, [secret]: 9 },
      execServer: { answered: 2, forwarded: -1, path: secret, batch: { attempted: 1, token: secret, stopped: { write: 1, [secret]: 1 } } },
    });
    expect(output).toHaveBeenCalledTimes(1);
    const line = output.mock.calls[0][0] as string;
    expect(line).not.toContain(secret);
    const fields = JSON.parse(line.slice('remote agent startup timing '.length));
    expect(fields).toMatchObject({ diagnosticsVersion: 1, hostVersion: expect.any(String), buildRevision: 'dev',
      runtimeVersion: '0.159.2', durationMs: 12, stagesMs: { initialize: 12 },
      execServer: { answered: 2, batch: { attempted: 1, stopped: { write: 1 } } } });
    expect(fields).not.toHaveProperty('elapsedMs');
    expect(fields.execServer).not.toHaveProperty('forwarded');
    expect(() => quietRuntimeLogger(startupDiagnostics(() => { throw new Error(secret); })).info(
      'remote agent startup timing', { side: 'host', stage: 'total', status: 'ok' },
    )).not.toThrow();
  });
  // LogConfig:none loses stderr: the production diagnostic boundary must preserve only safe JSON
  // in the external data root, even when stderr fails. Existing timing tests checked memory only.
  // Minimal input: one approved event at the file limit; integration tier, no runtime/accounts.
  it('persists safe startup JSON with private permissions and bounded rotation when stderr fails', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cindy-startup-log-'));
    const file = path.join(dir, 'startup-timing.jsonl');
    try {
      await writeFile(file, 'x'.repeat(1024 * 1024), { mode: 0o600 });
      const diagnostics = startupDiagnostics(() => { throw new Error('stderr unavailable'); }, dir);
      diagnostics('remote agent startup timing', { side: 'host', stage: 'total', status: 'ok', durationMs: 3, token: 'private-test-secret' });
      await diagnostics.flush();
      const line = await readFile(file, 'utf8');
      expect(JSON.parse(line)).toMatchObject({ side: 'host', stage: 'total', durationMs: 3, recordedAt: expect.any(String) });
      expect(line).not.toContain('private-test-secret');
      expect((await stat(`${file}.1`)).size).toBe(1024 * 1024);
      if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  // A pre-existing diagnostic path must never write through a symbolic or hard link.
  it.each(['symlink', 'hardlink'])('refuses a %s at the diagnostic file path', async (kind) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cindy-startup-link-'));
    const target = path.join(dir, 'unrelated.txt');
    try {
      await writeFile(target, 'untouched');
      try {
        await (kind === 'symlink' ? symlink(target, path.join(dir, 'startup-timing.jsonl')) : link(target, path.join(dir, 'startup-timing.jsonl')));
      } catch (error) {
        if (kind === 'symlink' && ['EPERM', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) return;
        throw error;
      }
      const diagnostics = startupDiagnostics(() => {}, dir);
      diagnostics('remote agent startup timing', { side: 'host', stage: 'total', status: 'ok' });
      await diagnostics.flush();
      expect(await readFile(target, 'utf8')).toBe('untouched');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  // Integration: config parsing alone cannot catch missing readLimits wiring.
  // The real remote caps response must preserve zero and advertise the host policy.
  it.each([[undefined, 30], [0, 0], [120, 120]])('advertises configured idle retention %s', async (minutes, expected) => {
    const h = await harness(undefined, 'claude-code', false, minutes);
    try {
      h.open();
      const socket = h.sockets[0];
      socket.request('invoke', 'retention', { channel: REMOTE_AGENT_CHANNEL, args: [{ op: 'caps' }] });
      await vi.advanceTimersByTimeAsync(0);
      expect(socket.result('retention')).toMatchObject({ ok: true, result: { idleReclaimMinutes: expected } });
    } finally { await h.host.stop(); await rm(h.dataDir, { recursive: true, force: true }); }
  });
  // Actual scoped wire frames, official API parser and local management socket:
  // a link applicant cannot read a catalog until approval and loses access on pause.
  it('authorizes cross-account discovery only after local approval and rejects unrelated channels', async () => {
    const shareId = randomUUID(); const memberId = randomUUID(); const requestId = randomUUID();
    let active = false; let paused = false;
    const person = { displayName: 'Guest', avatarUrl: null, region: 'global' };
    const timestamp = new Date().toISOString();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/approve')) { active = true; return new Response(JSON.stringify({ shareId, memberId })); }
      if (url.endsWith('/pause')) { paused = true; return new Response(JSON.stringify({ memberId, status: 'paused' })); }
      return new Response(JSON.stringify({ shares: [{ shareId, providerId: 'anthropic', providerLabel: 'Test provider', hostDeviceId: 'host', createdAt: timestamp,
        requests: active ? [] : [{ ...person, requestId, pairingCode: '1234', createdAt: timestamp, expiresAt: new Date(Date.now() + 300000).toISOString() }],
        members: active ? [{ ...person, memberId, joinedAt: timestamp, status: paused ? 'paused' : 'active' }] : [] }] }));
    }));
    const h = await harness(undefined, 'codex', true);
    try {
      const socket = h.sockets[0];
      const guestInvoke = (id: string, channel: string, args: unknown[] = []) => socket.push({ v: PROTOCOL_VERSION, kind: 'invoke', id, src: 'guest-device', dst: 'host',
        providerShare: { shareId, source: { role: 'guest', memberId }, target: { role: 'host' } }, payload: { channel, args } });
      guestInvoke('unapproved', 'maker:provider:list'); await vi.advanceTimersByTimeAsync(0);
      expect(socket.result('unapproved')).toMatchObject({ ok: false });
      await runShareControl(h.dataDir, ['approve', requestId, '1234']);
      guestInvoke('approved', 'maker:provider:list'); await vi.advanceTimersByTimeAsync(0);
      expect(socket.result('approved')).toMatchObject({ ok: true });
      guestInvoke('quota', SHARE_INSIGHTS_CHANNEL, [{ version: 1, includeUsage: false }]); await vi.advanceTimersByTimeAsync(0);
      expect(socket.result('quota')).toMatchObject({ ok: true, result: { version: 1, capabilities: { quota: true, usage: true }, quota: { accounts: [{ windows: [{ remainingPercent: 72 }] }] } } });
      guestInvoke('history', SHARE_INSIGHTS_CHANNEL, [{ version: 1, includeUsage: true }]); await vi.advanceTimersByTimeAsync(0);
      expect(socket.result('history')).toMatchObject({ ok: true, result: { status: { usage: 'ready' }, usage: { parties: [{ displayName: 'Guest', isYou: true, days: [] }] } } });
      await runShareControl(h.dataDir, ['usage', 'off']);
      guestInvoke('history-off', SHARE_INSIGHTS_CHANNEL, [{ version: 1, includeUsage: true }]); await vi.advanceTimersByTimeAsync(0);
      expect(socket.result('history-off')).toMatchObject({ ok: true, result: { capabilities: { quota: true, usage: false }, usage: null } });
      await runShareControl(h.dataDir, ['quota', 'off']);
      guestInvoke('quota-off', SHARE_INSIGHTS_CHANNEL, [{ version: 1, includeUsage: false }]); await vi.advanceTimersByTimeAsync(0);
      expect(socket.result('quota-off')).toMatchObject({ ok: true, result: { status: { quota: 'disabled' }, quota: null } });
      guestInvoke('private', 'local-db:sessions:list'); await vi.advanceTimersByTimeAsync(0);
      expect(socket.result('private')).toMatchObject({ ok: false, error: { code: 'CHANNEL_NOT_ALLOWED' } });
      await runShareControl(h.dataDir, ['pause', memberId]);
      guestInvoke('paused', 'maker:provider:list'); await vi.advanceTimersByTimeAsync(0);
      expect(socket.result('paused')).toMatchObject({ ok: false });
    } finally { await h.host.stop(); vi.unstubAllGlobals(); await rm(h.dataDir, { recursive: true, force: true }); }
  });

  // Local Docker exec management uses the running process, not a second auth refresh.
  it('serves private local management commands and rejects malformed requests', async () => {
    const dir = path.join(os.tmpdir(), `cindy-share-control-${randomUUID()}`);
    await mkdir(dir, { mode: 0o700 });
    const stop = await startShareControl(dir, async command => ({ action: command.action }));
    try {
      expect(await runShareControl(dir, ['list'])).toEqual({ action: 'list' });
      await expect(runShareControl(dir, ['approve', 'request', 'bad'])).rejects.toThrow();
    } finally { await stop(); await rm(dir, { recursive: true, force: true }); }
  });

  // Regression: host-side API model discovery used fetch without a proxy, although
  // native Claude inherited HTTP(S)_PROXY. Production entry: createClaudeProvider;
  // observable result: models arrive through the proxy, including pagination.
  // Minimal input: an unresolvable API host and a local proxy returning a catalog.
  // Existing native-sharing tests do not cover API discovery. Tier: integration (real sockets).
  // Standalone focused run: 10.35s wall, 9.87s shared-module collection, 71ms test;
  // keep in the existing integration tier rather than adding another heavy import graph.
  it('discovers Claude API models through the configured proxy and rejects proxy failures', async () => {
    const requests: Array<{ url?: string; auth?: string; key?: string }> = [];
    const tunnels: string[] = [];
    let status = 200;
    const proxy = createServer((req, res) => {
      requests.push({ url: req.url, auth: req.headers['proxy-authorization'], key: req.headers['x-api-key'] as string });
      res.writeHead(status, { 'content-type': 'application/json', ...(status === 302 ? { location: '/redirected' } : {}) });
      const second = req.url?.includes('after_id=');
      res.end(JSON.stringify({ data: [{ id: second ? 'claude-sonnet-4-6' : 'claude-opus-4-7' }],
        has_more: !second, last_id: 'claude-opus-4-7' }));
    });
    proxy.on('connect', (req, socket) => {
      tunnels.push(req.url!);
      socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    });
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
    const port = (proxy.address() as { port: number }).port;
    for (const name of ['HTTP_PROXY', 'HTTPS_PROXY']) vi.stubEnv(name, `http://fake:invalid-secret@127.0.0.1:${port}`);
    for (const name of ['NO_PROXY', 'no_proxy', 'ALL_PROXY', 'all_proxy']) vi.stubEnv(name, '');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cindy-claude-proxy-'));
    const settings = { CINDY_HOST_CLAUDE_BINARY: process.execPath, CINDY_HOST_CLAUDE_AUTH: 'api-key',
      ANTHROPIC_API_KEY: 'invalid-fixture-api-key', ANTHROPIC_BASE_URL: 'http://claude-api.invalid' };
    try {
      const provider = await createClaudeProvider(dir, quietRuntimeLogger(), settings);
      try { expect([...provider.modelIds]).toEqual(['claude-opus-4-7', 'claude-sonnet-4-6']); }
      finally { await provider.dispose(); }
      expect(requests.map(req => req.url)).toEqual(['http://claude-api.invalid/v1/models?limit=100',
        'http://claude-api.invalid/v1/models?limit=100&after_id=claude-opus-4-7']);
      expect(requests.every(req => req.auth === `Basic ${Buffer.from('fake:invalid-secret').toString('base64')}`
        && req.key === 'invalid-fixture-api-key')).toBe(true);
      status = 407;
      await expect(createClaudeProvider(dir, quietRuntimeLogger(), settings)).rejects.toThrow('Anthropic model discovery failed');
      expect(requests).toHaveLength(3);
      await expect(createClaudeProvider(dir, quietRuntimeLogger(), { ...settings,
        ANTHROPIC_BASE_URL: 'https://claude-api.invalid' })).rejects.toThrow('Anthropic model discovery failed');
      expect(tunnels).toEqual(['claude-api.invalid:443']);
      vi.stubEnv('HTTP_PROXY', 'unsupported://fake:invalid-secret@proxy.invalid');
      await expect(createClaudeProvider(dir, quietRuntimeLogger(), settings)).rejects.toThrow('Unsupported Claude outbound proxy');
      expect(requests).toHaveLength(3);
      // Local API gateways must remain reachable even with an unusable external proxy.
      status = 200;
      const localSettings = { ...settings, ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` };
      const local = await createClaudeProvider(dir, quietRuntimeLogger(), localSettings);
      try { expect(local.modelIds.size).toBe(2); } finally { await local.dispose(); }
      expect(requests.slice(3).map(req => ({ url: req.url, auth: req.auth }))).toEqual([
        { url: '/v1/models?limit=100', auth: undefined },
        { url: '/v1/models?limit=100&after_id=claude-opus-4-7', auth: undefined },
      ]);
      status = 302;
      await expect(createClaudeProvider(dir, quietRuntimeLogger(), localSettings)).rejects.toThrow('Anthropic model discovery failed');
      expect(requests).toHaveLength(6); // No request follows the redirect carrying the API key.
    } finally {
      vi.unstubAllEnvs();
      proxy.closeAllConnections();
      await new Promise<void>(resolve => proxy.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  });

  // Native config resolution + the same proxy component Desktop uses. Only fake
  // credentials and a local HTTP endpoint are touched; no model inference or accounts.
  it.skipIf(!process.env.CINDY_CODEX_TEST_BINARY)('confines shared API egress to the approved model and current member', async () => {
    const dir = path.join(os.tmpdir(), `cindy-share-proxy-${randomUUID()}`);
    await mkdir(dir, { mode: 0o700 });
    let upstreamCalls = 0;
    const server = createServer((req, res) => {
      upstreamCalls++;
      expect(req.headers.authorization).toBe('Bearer invalid-fake-share-key');
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    vi.stubEnv('CINDY_FAKE_SHARE_API_KEY', 'invalid-fake-share-key');
    await writeFile(path.join(dir, 'config.toml'), `features.plugins=false\nfeatures.remote_plugin=false\nmodel_provider="fixture"\n[model_providers.fixture]\nname="Fixture"\nbase_url="http://127.0.0.1:${address.port}/v1"\nwire_api="responses"\nenv_key="CINDY_FAKE_SHARE_API_KEY"\nrequires_openai_auth=false\n`);
    vi.stubEnv('CODEX_HOME', dir);
    vi.stubEnv('HOME', dir); vi.stubEnv('USERPROFILE', dir);
    vi.stubEnv('OPENAI_API_KEY', ''); vi.stubEnv('CODEX_API_KEY', '');
    let bridge: Awaited<ReturnType<typeof createCodexShareBridge>> | undefined;
    try {
      expect(await createNativeCodexAuth(process.env.CINDY_CODEX_TEST_BINARY!).getState()).toEqual({ authenticated: true, authSource: 'api-key' });
      bridge = await createCodexShareBridge(process.env.CINDY_CODEX_TEST_BINARY!, new Set(['allowed-model']));
      let current = true;
      const binding = await bridge.bind({ kind: 'codex', providerId: 'cli-codex', hostSessionId: 'host-session', sessionId: 'guest-session', controller: 'fake-guest', isCurrent: () => current });
      expect(binding).not.toBeNull();
      const config = bridge.spawnConfig('host-session');
      expect(JSON.stringify(config)).not.toContain('invalid-fake-share-key');
      const base = JSON.parse(config.extraArgs.find(arg => arg.startsWith('model_providers.cindy_share.base_url='))!.split('=').slice(1).join('=')) as string;
      const send = (model: string, token = binding!.routeToken) => fetch(base + '/responses', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ model, input: 'fake' }) });
      expect((await send('wrong-model')).status).toBe(403);
      expect((await send('allowed-model', 'wrong-token')).status).toBe(403);
      expect((await send('allowed-model')).status).toBe(200);
      current = false;
      expect((await send('allowed-model')).status).toBe(403);
      expect((await fetch(base + '/private')).status).toBe(403);
      expect((await fetch(base + '/responses', { method: 'POST', headers: { authorization: `Bearer ${binding!.routeToken}` }, body: 'not-json' })).status).toBe(403);
      expect(upstreamCalls).toBe(1);
      binding!.release();
    } finally {
      await bridge?.dispose(); vi.unstubAllEnvs();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);

  // Subscription binding must reject other providers and stop authorizing after revocation.
  it('bounds native Claude sharing to the current member and advertised models', async () => {
    let loggedIn = true;
    const sharing = createNativeClaudeSharing('anthropic', new Set(['allowed']), async () => loggedIn);
    await sharing.prepare();
    let current = true;
    const input = { kind: 'claude-code' as const, providerId: 'anthropic', hostSessionId: 'host', sessionId: 'guest', controller: 'member', isCurrent: () => current };
    expect(await sharing.bind({ ...input, providerId: 'other' })).toBeNull();
    const binding = (await sharing.bind(input))!;
    expect(await binding.allowsModel('allowed')).toBe(true);
    expect(await binding.allowsModel('other')).toBe(false);
    current = false;
    expect(await binding.allowsModel('allowed')).toBe(false);
    current = true; binding.release();
    expect(await binding.allowsModel('allowed')).toBe(false);
    loggedIn = false;
    await expect(sharing.prepare()).rejects.toThrow('Native Claude login is unavailable');
  });

  // Official-login sharing must retain native OAuth while denying unbound/model-mismatched
  // requests. Integration gap: API-key coverage cannot detect OAuth routing bypasses.
  it.skipIf(!process.env.CINDY_CODEX_TEST_BINARY)('gates native ChatGPT sharing without persisting credentials', async () => {
    const dir = path.join(os.tmpdir(), `cindy-oauth-share-${randomUUID()}`);
    await mkdir(dir, { mode: 0o700 });
    vi.stubEnv('CODEX_HOME', dir); vi.stubEnv('HOME', dir); vi.stubEnv('USERPROFILE', dir);
    let bridge: Awaited<ReturnType<typeof createCodexShareBridge>> | undefined;
    try {
      bridge = await createCodexShareBridge(process.env.CINDY_CODEX_TEST_BINARY!, new Set(['allowed']), true);
      let current = true;
      const binding = await bridge.bind({ kind: 'codex', providerId: 'openai', hostSessionId: 'oauth-session', sessionId: 'guest', controller: 'guest', isCurrent: () => current });
      const config = bridge.spawnConfig('oauth-session');
      expect(config.extraArgs).toContain('model_providers.cindy_share.requires_openai_auth=true');
      expect(config.extraArgs.some(arg => arg.startsWith('model_providers.cindy_share.env_key='))).toBe(false);
      const base = JSON.parse(config.extraArgs.find(arg => arg.startsWith('model_providers.cindy_share.base_url='))!.split('=').slice(1).join('=')) as string;
      const send = (model: string, token = binding!.routeToken) => fetch(base + '/responses', { method: 'POST', headers: { authorization: 'Bearer invalid-fake-oauth', 'x-cindy-share-route': token, 'content-type': 'application/json' }, body: JSON.stringify({ model }) });
      expect((await send('allowed', 'wrong')).status).toBe(403);
      expect((await send('wrong')).status).toBe(403);
      current = false;
      expect((await send('allowed')).status).toBe(403);
      expect(() => bridge!.spawnConfig('oauth-session')).toThrow('Guest route unavailable');
      await expect(readFile(path.join(dir, 'auth.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      binding!.release();
    } finally { await bridge?.dispose(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); }
  }, 30000);

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
      const timingLines = h.diagnostics.mock.calls.map(([line]) => line as string);
      expect(timingLines.some(line => line.includes('"side":"host"') && line.includes('"stage":"agent-session"'))).toBe(true);
      expect(timingLines.some(line => line.includes('"stage":"total"') && line.includes('"execServer":'))).toBe(true);
      expect(timingLines.some(line => line.includes('"engineSessionRef":'))).toBe(true);
      expect(timingLines.join('\n')).not.toContain('/desktop/project');
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

  // Native guest process uses the shared core isolation and the CLI API bridge.
  // A separate exec-server represents the recipient, with no real credentials/upstream.
  // Regression: a tunneled cindy_memory URL must not merge with a host-injected stdio command.
  // Previously the empty MCP list missed the real desktop thread/start configuration failure.
  it.skipIf(!process.env.CINDY_CODEX_TEST_BINARY).each(['api-key', 'oauth'])('starts an isolated native %s guest without copying credentials', async authMode => {
    const dir = path.join(os.tmpdir(), `cindy-guest-start-${randomUUID()}`);
    const bodies: string[] = [];
    const upstream = createServer((req, res) => {
      let body = ''; req.on('data', chunk => { body += chunk.toString(); });
      req.on('end', () => {
        expect(req.headers.authorization).toBe(authMode === 'oauth' ? `Bearer ${fakeToken}` : 'Bearer invalid-fake-guest-key');
        bodies.push(body);
        const item = { type: 'message', id: 'msg-1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'OK', annotations: [] }] };
        const events = [
          { type: 'response.created', response: { id: 'r1', status: 'in_progress', output: [] } },
          { type: 'response.output_item.done', output_index: 0, item },
          { type: 'response.completed', response: { id: 'r1', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
        ];
        res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
        res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
      });
    });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const endpoint = `http://127.0.0.1:${(upstream.address() as net.AddressInfo).port}/v1`;
    const ownerHome = path.join(dir, 'owner'); const guestHome = path.join(dir, 'guest');
    const workspace = path.join(dir, 'workspace');
    await Promise.all([ownerHome, guestHome, workspace].map(folder => mkdir(folder, { recursive: true, mode: 0o700 })));
    const fakeToken = `test.${Buffer.from(JSON.stringify({ exp: 4102444800, 'https://api.openai.com/auth': { chatgpt_account_id: 'fake-account', chatgpt_plan_type: 'pro' } })).toString('base64url')}.invalid`;
    await writeFile(path.join(ownerHome, 'auth.json'), JSON.stringify(authMode === 'oauth' ? { auth_mode: 'chatgpt', tokens: { access_token: fakeToken, id_token: fakeToken, refresh_token: 'invalid-refresh', account_id: 'fake-account' }, last_refresh: new Date().toISOString() } : { OPENAI_API_KEY: 'invalid-fake-guest-key' }), { mode: 0o600 });
    await writeFile(path.join(ownerHome, 'AGENTS.md'), 'OWNER_PRIVATE_CANARY');
    await writeFile(path.join(ownerHome, 'config.toml'), `features.plugins=false\nfeatures.remote_plugin=false\nmodel_provider="fixture"\n[model_providers.fixture]\nname="Fixture"\nbase_url="${endpoint}"\nwire_api="responses"\nrequires_openai_auth=true\n`);
    const portServer = net.createServer();
    await new Promise<void>(resolve => portServer.listen(0, '127.0.0.1', resolve));
    const port = (portServer.address() as net.AddressInfo).port;
    await new Promise<void>(resolve => portServer.close(() => resolve()));
    const binary = process.env.CINDY_CODEX_TEST_BINARY!;
    const executor = spawn(binary, ['exec-server', '--listen', `ws://127.0.0.1:${port}`], { env: { ...process.env, CODEX_HOME: workspace, HOME: dir, USERPROFILE: dir, OPENAI_API_KEY: '', CODEX_API_KEY: '' }, stdio: 'ignore' });
    vi.stubEnv('CODEX_HOME', ownerHome);
    vi.stubEnv('HOME', dir); vi.stubEnv('USERPROFILE', dir);
    vi.stubEnv('OPENAI_API_KEY', ''); vi.stubEnv('CODEX_API_KEY', '');
    let provider: Awaited<ReturnType<typeof createCodexProvider>> | undefined;
    let handle: AgentSessionHandle | undefined;
    try {
      await vi.waitFor(() => new Promise<void>((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1');
        socket.once('connect', () => { socket.destroy(); resolve(); }); socket.once('error', reject);
      }));
      provider = await createCodexProvider(dir, quietRuntimeLogger(), { CINDY_HOST_CODEX_BINARY: binary });
      await provider.sharing.prepare();
      const model = [...provider.modelIds][0];
      const binding = await provider.sharing.bind({ kind: 'codex', providerId: provider.id, hostSessionId: 'guest-probe', sessionId: 'recipient-task', controller: 'fake-guest', isCurrent: () => true });
      handle = await provider.agent.startSession({ sessionId: 'guest-probe', model, providerId: provider.id, workingDir: workspace,
        permissionMode: 'bypassPermissions', deviceHosted: { workingDir: workspace, extraDirs: [], writableDirs: [], platform: 'linux', shell: 'bash', isGitRepo: false,
          mirrorRoot: workspace, tunnelUrl: `http://127.0.0.1:${port}`, tunnelToken: 'fake', mcpServers: ['cindy_memory'], guest: true, guestHome,
          guestProvider: { providerId: provider.id, modelIds: [model], routeToken: binding!.routeToken } } });
      expect(handle.agentKind).toBe('codex');
      if (authMode === 'api-key') {
      const done = (async () => { for await (const event of handle!.events()) { if (event.type === 'error') throw new Error('Native guest turn failed'); if (event.type === 'done') return; } })();
      await handle.send({ type: 'user', content: 'Only reply OK.' }, { throwOnStartFailure: true });
      await done;
      expect(bodies.length).toBeGreaterThan(0);
      expect(bodies.join('')).not.toContain('OWNER_PRIVATE_CANARY');
      }
      // The native guest home must not receive the owner's credential file.
      await expect(readFile(path.join(guestHome, 'codex', 'auth.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await handle?.close(); await provider?.dispose();
      if (executor.exitCode === null && executor.signalCode === null) {
        const exited = new Promise<void>(resolve => executor.once('close', () => resolve()));
        executor.kill(); await exited;
      }
      vi.unstubAllEnvs();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);

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
    await writeFile(path.join(home, 'config.toml'), 'features.plugins=false\nfeatures.remote_plugin=false\nmodel_provider="fixture"\nmodel="gpt-5.4"\n[model_providers.fixture]\nname="Fixture"\nbase_url="http://127.0.0.1:1/v1"\nwire_api="responses"\nrequires_openai_auth=true\n[mcp_servers.cindy_memory]\ncommand="false"\nenabled=false\n');
    vi.stubEnv('CODEX_HOME', home);
    vi.stubEnv('HOME', dir); vi.stubEnv('USERPROFILE', dir);
    vi.stubEnv('OPENAI_API_KEY', ''); vi.stubEnv('CODEX_API_KEY', '');
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
