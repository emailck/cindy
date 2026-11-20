/** 测试价值：FED-002 新增反向连接权限边界，现有单机测试未覆盖。
 * 生产入口：Hub/Connector/同一个 ManagerService，经真实 loopback WS。
 * 最小失败输入：双节点同 ID、重复 operationId、跨 owner attach、一次性码重放、丢失 attach ACK。
 * 可观察结果：节点与登录隔离、共享锁、跨连接持久去重、秘密不落明文。
 * tier: integration；无真实账号/Docker/真实等待；耗时见进度。 */
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { once } from 'node:events';
import { Store } from './store.js';
import { FederationHub, FederationConnector, disconnectManager, enrollManager } from './federation.js';
import { ManagerService } from './service.js';
import type { DockerRuntime, RuntimeLogin } from './runtime-types.js';
class Login implements RuntimeLogin {
    inputText = ''; cancelled = false; resized = '';
    outputs = new Set<(data: string) => void>();
    input(value: string) { this.inputText += value; }
    async resize(cols: number, rows: number) { this.resized = `${cols}:${rows}`; }
    async cancel() { this.cancelled = true; }
    onOutput(fn: (data: string) => void) { this.outputs.add(fn); return () => { this.outputs.delete(fn); }; }
    onExit(_fn: (code: number) => void) { return () => {}; }
}
class Runtime implements DockerRuntime {
    starts = 0; login = new Login(); fail = false;
    async create() {} async stop() {} async check() { return { state: 'stopped' as const }; }
    async inspect() { return { state: 'stopped' as const }; }
    async start() { this.starts++; if (this.fail) throw Object.assign(new Error('synthetic-secret-runtime-output'), { code: 'STOP_TIMEOUT' }); }
    async share() { return {}; }
    async probe() { return { ok: true, durationMs: 1, checkedAt: '2026-01-01T00:00:00.000Z' }; }
    async allocateSubnet() { return '172.30.0.0/24'; }
    async applyNetwork() {}
    async inspectNetwork() { return 'running' as const; }
    async removeNetwork() {}
    async testNetwork() { return { ip: '192.0.2.9', country: '', region: '', city: '' }; }
    async testProxy() { return { ip: '192.0.2.1', country: 'Synthetic', region: '', city: '' }; }
    async openLogin() { return this.login; }
}
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function fixture() {
    const directory = mkdtempSync(join(tmpdir(), 'cindy-federation-synthetic-'));
    const centralStore = new Store(directory), hub = new FederationHub(centralStore);
    const server = createServer(async (req, res) => {
        try {
            const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
            const body = JSON.parse(Buffer.concat(chunks).toString());
            const result = hub.enroll(body.enrollmentToken, body.credential);
            res.writeHead(200); res.end(JSON.stringify(result));
        } catch { res.writeHead(401); res.end('{}'); }
    });
    const wss = new WebSocketServer({ noServer: true, maxPayload: 1_048_576 });
    const handshakes: (() => void)[] = [], frames: any[] = [];
    let dropNextResult = false;
    server.on('upgrade', (req, socket, head) => {
        const id = String(req.headers['x-cindy-node-id']), key = String(req.headers.authorization).replace(/^Bearer /, '');
        if (!hub.authenticate(id, key)) { socket.destroy(); return; }
        wss.handleUpgrade(req, socket, head, ws => {
            // Transport fault injection: lose one node acknowledgement, keep the socket healthy.
            const emit = ws.emit;
            ws.emit = function(event: string | symbol, ...args: any[]) {
                if (event === 'message' && dropNextResult && JSON.parse(args[0].toString()).type === 'result') { dropNextResult = false; return true; }
                return Reflect.apply(emit, this, [event, ...args]);
            };
            hub.accept(ws, id, key);
            ws.on('message', raw => { const frame = JSON.parse(raw.toString()); frames.push(frame); if (frame.type === 'hello') handshakes.shift()?.(); });
        });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing port');
    const origin = `http://127.0.0.1:${address.port}`;
    cleanup.push(async () => { hub.close(); for (const ws of wss.clients) ws.terminate(); await new Promise<void>(resolve => wss.close(() => resolve())); await new Promise<void>(resolve => server.close(() => resolve())); centralStore.close(); rmSync(directory, { force: true, recursive: true }); });
    const connected = () => new Promise<void>(resolve => handshakes.push(resolve));
    async function node(name: string) {
        const dir = mkdtempSync(join(tmpdir(), 'cindy-federation-node-synthetic-')); let store = new Store(dir);
        const enrollment = hub.createEnrollment(name); await enrollManager(store, origin, enrollment.enrollmentToken);
        expect(() => hub.enroll(enrollment.enrollmentToken)).toThrow();
        const config = store.secret<{ credential: string; nodeId: string }>('federation:connection')!;
        expect(hub.authenticate(config.nodeId, config.credential)).toBe(true);
        const runtime = new Runtime(); let service = new ManagerService(store, runtime, 'synthetic:local');
        let connector = new FederationConnector({ service, store });
        cleanup.push(async () => { await connector.close(); await service.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
        const ready = connected(); connector.start(); await ready;
        return { id: enrollment.node.id, get store() { return store; }, config, runtime, get service() { return service; }, get connector() { return connector; }, dir, async restart() {
            await connector.close(); await service.close(); store.close();
            store = new Store(dir); service = new ManagerService(store, runtime, 'synthetic:local'); connector = new FederationConnector({ service, store });
            const ready = connected(); connector.start(); await ready;
        } };
    }
    return { hub, centralStore, directory, origin, connected, node, frames, dropNextResult: () => { dropNextResult = true; } };
}
it('isolates nodes/owners, streams single-line answers, shares local locks and revokes only remote logins', async () => {
    const f = await fixture(), a = await f.node('Synthetic A'), b = await f.node('Synthetic B');
    const instanceId = '11111111-1111-4111-8111-111111111111';
    for (const node of [a, b]) node.store.insert({ id: instanceId, name: node.id, engine: 'codex', proxyMode: 'none', createdAt: new Date().toISOString() });
    const owner = 'synthetic-browser-session', other = 'synthetic-other-browser';
    for (const node of [a, b]) expect((await f.hub.request(node.id, owner, 'GET', '/api/instances')).body).toMatchObject({ instances: [{ name: node.id }] });
    const remote = await f.hub.request(a.id, owner, 'POST', `/api/instances/${instanceId}/login`, { target: 'provider' });
    const loginId = (remote.body as any).loginId;
    expect(remote.status).toBe(201); expect(a.service.logins.get(loginId)!.owner).not.toContain(owner);
    await expect(f.hub.attachLogin(a.id, other, loginId, () => {}, () => {})).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(a.service.action(instanceId, { action: 'start' })).rejects.toMatchObject({ code: 'INSTANCE_BUSY' });
    let outputResolve!: (value: unknown) => void;
    const output = new Promise(resolve => { outputResolve = resolve; });
    const terminal = await f.hub.attachLogin(a.id, owner, loginId, outputResolve, () => {});
    a.runtime.login.outputs.forEach(fn => fn('synthetic output'));
    expect(await output).toMatchObject({ type: 'output', data: 'synthetic output' });
    terminal.message({ type: 'answer', value: 'synthetic-answer' }); terminal.message({ type: 'resize', cols: 80, rows: 24 });
    await f.hub.request(a.id, owner, 'GET', '/api/settings'); // Ordered socket barrier, no sleeps.
    expect(a.runtime.login.inputText).toBe('synthetic-answer\r'); expect(a.runtime.login.resized).toBe('80:24');
    await b.service.login(instanceId, 'synthetic-local-owner', { target: 'provider' });
    // A stale terminal after cancel must not disconnect the machine or other browser owners.
    terminal.message({ type: 'cancel' }); await f.hub.request(a.id, other, 'GET', '/api/settings');
    terminal.message({ type: 'resize', cols: 80, rows: 24 });
    expect((await f.hub.request(a.id, other, 'GET', '/api/settings')).status).toBe(200);
    f.hub.revokeOwner(owner); await f.hub.request(a.id, other, 'GET', '/api/settings');
    expect(a.runtime.login.cancelled).toBe(true); expect(b.runtime.login.cancelled).toBe(false);
    expect(JSON.stringify(f.frames)).not.toContain(owner);
    expect(f.hub.listNodes().every(node => node.online)).toBe(true);
    f.hub.revoke(a.id); expect(f.hub.authenticate(a.id, a.config.credential)).toBe(false);
    await expect(f.hub.request(a.id, other, 'GET', '/api/settings')).rejects.toMatchObject({ code: 'NODE_OFFLINE' });
    expect((await f.hub.request(b.id, other, 'GET', '/api/settings')).status).toBe(200);
});
it('persists deduplication across store/service/connector restart, rejects changed input, sanitizes runtime errors and encrypts credentials', async () => {
    const f = await fixture(), a = await f.node('Synthetic journal');
    const instance = await a.service.create({ name: 'Synthetic', engine: 'codex', proxyMode: 'none' });
    const path = `/api/instances/${instance.id}/actions`;
    expect((await f.hub.request(a.id, 'synthetic-owner', 'POST', path, { action: 'start' }, 'synthetic-operation')).status).toBe(200);
    await a.restart();
    expect((await f.hub.request(a.id, 'synthetic-owner', 'POST', path, { action: 'start' }, 'synthetic-operation')).body).toMatchObject({ error: { code: 'OPERATION_UNCERTAIN' } });
    expect(a.runtime.starts).toBe(1);
    expect((await f.hub.request(a.id, 'synthetic-owner', 'POST', path, { action: 'stop' }, 'synthetic-operation')).body).toMatchObject({ error: { code: 'OPERATION_ID_CONFLICT' } });
    expect((await f.hub.request(a.id, 'synthetic-owner', 'POST', '/api/arbitrary-shell', { command: 'synthetic' })).status).toBe(404);
    a.runtime.fail = true;
    const failed = await f.hub.request(a.id, 'synthetic-owner', 'POST', path, { action: 'start' });
    expect(failed).toMatchObject({ status: 409, body: { error: { code: 'STOP_TIMEOUT' } } }); expect(JSON.stringify(failed)).not.toContain('synthetic-secret-runtime-output');
    await f.hub.request(a.id, 'synthetic-owner', 'PUT', '/api/settings', { proxyUrl: 'http://127.0.0.1:8123', proxyPassword: 'synthetic-proxy-secret' });
    const raw = readFileSync(join(a.dir, 'manager.sqlite')).toString();
    expect(raw).not.toContain(a.config.credential); expect(raw).not.toContain('synthetic-proxy-secret');
    expect(f.centralStore.get('federation:nodes')).not.toContain(a.config.credential);
    const expired = f.hub.createEnrollment('Expired synthetic');
    const now = Date.now(), clock = vi.spyOn(Date, 'now').mockReturnValue(now + 11 * 60_000);
    expect(() => f.hub.enroll(expired.enrollmentToken)).toThrow(); clock.mockRestore();
    await a.connector.close(); disconnectManager(a.store); expect(a.store.secret('federation:connection')).toBeUndefined(); expect(a.store.list()).toHaveLength(1);
});

it('reports lost mutation outcome without replay, retains instance data and rejects incompatible handshake', async () => {
    const f = await fixture(), a = await f.node('Synthetic uncertainty');
    const instance = await a.service.create({ name: 'Synthetic deferred', engine: 'codex', proxyMode: 'none' });
    let release!: () => void, entered!: () => void;
    const pendingRuntime = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    a.runtime.start = async () => { a.runtime.starts++; entered(); await pendingRuntime; };
    const path = `/api/instances/${instance.id}/actions`;
    const operation = f.hub.request(a.id, 'synthetic-owner', 'POST', path, { action: 'start' }, 'lost-operation');
    const rejected = expect(operation).rejects.toMatchObject({ code: 'OPERATION_UNCERTAIN' });
    await started; await a.connector.close(); await rejected; release();
    // New service/connection must consult the persisted accepted record even if no response arrived.
    await a.restart();
    expect((await f.hub.request(a.id, 'synthetic-owner', 'POST', path, { action: 'start' }, 'lost-operation')).body).toMatchObject({ error: { code: 'OPERATION_UNCERTAIN' } });
    expect(a.runtime.starts).toBe(1); expect(a.store.list()).toHaveLength(1);
    await a.connector.close();
    const raw = new WebSocket(f.origin.replace('http:', 'ws:') + '/api/federation/connect', { headers: { Authorization: `Bearer ${a.config.credential}`, 'X-Cindy-Node-Id': a.id } });
    await once(raw, 'open');
    const closed = once(raw, 'close'); raw.send(JSON.stringify({ type: 'hello', nodeId: a.id, version: 999 }));
    expect((await closed)[0]).toBe(1008);
    expect(f.hub.listNodes().find(node => node.id === a.id)?.online).toBe(false);
});

it('cancels an attached login when only its acknowledgement is lost, without blocking other owners', async () => {
    const f = await fixture(), a = await f.node('Synthetic lost attachment');
    const instance = await a.service.create({ name: 'Synthetic attachment', engine: 'codex', proxyMode: 'none' });
    const result = await f.hub.request(a.id, 'synthetic-owner', 'POST', `/api/instances/${instance.id}/login`, { target: 'provider' });
    const loginId = (result.body as any).loginId;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    f.dropNextResult();
    const attachment = f.hub.attachLogin(a.id, 'synthetic-owner', loginId, () => {}, () => {});
    const rejected = expect(attachment).rejects.toMatchObject({ code: 'OPERATION_UNCERTAIN' });
    await f.hub.request(a.id, 'synthetic-other-owner', 'GET', '/api/settings');
    expect(a.service.logins.get(loginId)?.attached).toBe(true);
    vi.advanceTimersByTime(30_001); await rejected;
    await f.hub.request(a.id, 'synthetic-other-owner', 'GET', '/api/settings');
    expect(a.runtime.login.cancelled).toBe(true);
    await a.service.action(instance.id, { action: 'start' }); expect(a.runtime.starts).toBe(1);
    vi.useRealTimers();
});
