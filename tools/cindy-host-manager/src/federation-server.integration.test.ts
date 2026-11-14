/** FED-003 test value: production HTTP/WS + real hub/connector/service/SQLite.
 * Existing backend integration covers only one local manager, so cannot detect
 * cross-node routing, remote-owner lock loss, or browser/machine auth confusion.
 * Minimal failures: two equal instance IDs on separate nodes; another browser
 * attaching a remote login; local start while that login is active; central logout.
 * Tier: integration (isolated loopback servers, synthetic runtime, private temp DB).
 * Standalone timing is recorded in federation progress; no real accounts or Docker.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { Store } from './store.js';
import { Auth } from './auth.js';
import { ManagerService } from './service.js';
import { createManagerServer } from './server.js';
import { FederationHub, FederationConnector, enrollManager } from './federation.js';
import type { DockerRuntime, RuntimeInstance, RuntimeInspection, RuntimeLogin } from './runtime-types.js';
class Login implements RuntimeLogin {
    cancelled = false;
    inputData = '';
    outputs = new Set<(data: string) => void>();
    input(data: string) { this.inputData += data; }
    async resize() {}
    async cancel() { this.cancelled = true; }
    onOutput(fn: (data: string) => void) { this.outputs.add(fn); return () => { this.outputs.delete(fn); }; }
    onExit() { return () => {}; }
    output(data: string) { this.outputs.forEach(fn => fn(data)); }
}
class Runtime implements DockerRuntime {
    states = new Map<string, RuntimeInspection['state']>();
    logins: Login[] = [];
    async create(i: RuntimeInstance) { this.states.set(i.id, 'stopped'); }
    async inspect(i: RuntimeInstance): Promise<RuntimeInspection> { return { state: this.states.get(i.id) ?? 'missing' }; }
    async start(i: RuntimeInstance) { this.states.set(i.id, 'running'); }
    async stop(i: RuntimeInstance) { this.states.set(i.id, 'stopped'); }
    async check(i: RuntimeInstance) { return this.inspect(i); }
    async share() { return {}; }
    async testProxy() { return { ip: '203.0.113.5', country: '', region: '', city: '' }; }
    async openLogin() { const login = new Login(); this.logins.push(login); return login; }
}
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(central = false) {
    // Reserve an ephemeral loopback port before freezing the trusted public origin.
    const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>(done => reservation.close(() => done()));
    const origin = `http://127.0.0.1:${port}`;
    const directory = mkdtempSync(join(tmpdir(), 'cindy-federation-server-'));
    let now = Date.now();
    const store = new Store(directory), auth = new Auth(store, 60000, () => now);
    auth.initialize('synthetic-test-password');
    const runtime = new Runtime();
    const service = new ManagerService(store, runtime, 'synthetic:local');
    const hub = central ? new FederationHub(store) : undefined;
    const connector = central ? undefined : new FederationConnector({ service, store });
    const app = createManagerServer({ auth, origin, webDirectory: directory, mode: central ? 'central' : 'standalone', hub, connector, service: central ? undefined : service });
    app.server.listen(port, '127.0.0.1'); await once(app.server, 'listening');
    cleanups.push(async () => { await app.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
    async function call(method: string, path: string, data?: unknown, headers: Record<string, string> = {}) {
        const result = await fetch(origin + path, { method, headers: { ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: data === undefined ? undefined : JSON.stringify(data) });
        return { status: result.status, body: await result.json() as any, cookie: result.headers.get('set-cookie')?.split(';')[0] };
    }
    async function signIn() {
        const result = await call('POST', '/api/session', { password: 'synthetic-test-password' }, { Origin: origin });
        expect(result.status).toBe(200);
        return { Cookie: result.cookie!, Origin: origin, 'X-CSRF-Token': result.body.csrfToken };
    }
    return { store, auth, runtime, service, hub, connector, app, origin, call, signIn, expire: () => { now += 60001; } };
}
async function connected(central: Awaited<ReturnType<typeof fixture>>, node: Awaited<ReturnType<typeof fixture>>, headers: Record<string, string>, name: string) {
    const created = await central.call('POST', '/api/federation/nodes', { name }, headers);
    expect(created.status).toBe(201);
    await enrollManager(node.store, central.origin, created.body.enrollmentToken);
    node.connector!.start();
    // Poll observable reads with event-loop turns, no arbitrary real-time waits.
    for (let i = 0; i < 500; i++) {
        const listed = await central.call('GET', '/api/federation/nodes', undefined, headers);
        if (listed.body.nodes.find((n: any) => n.id === created.body.node.id)?.online) return created.body.node.id as string;
    }
    throw new Error('Node did not connect');
}
describe('federated manager production routing and ownership', () => {
    it('isolates two nodes and shares local/remote locks; logout cancels only its remote login', async () => {
        const central = await fixture(true), a = await fixture(), b = await fixture();
        const owner = await central.signIn(), other = await central.signIn(), local = await a.signIn();
        expect((await central.call('GET', '/api/session', undefined, owner)).body.mode).toBe('central');
        expect((await central.call('GET', '/api/instances', undefined, owner)).status).toBe(404);
        const aId = await connected(central, a, owner, 'Node A'), bId = await connected(central, b, owner, 'Node B');
        const id = '12345678-1234-1234-1234-123456789abc';
        for (const [node, name] of [[a, 'A instance'], [b, 'B instance']] as const) {
            node.store.insert({ id, name, engine: 'codex', proxyMode: 'none', createdAt: new Date().toISOString() });
            node.runtime.states.set(id, 'stopped');
        }
        const scope = (nodeId: string) => `/api/federation/nodes/${nodeId}/api`;
        expect((await central.call('GET', `${scope(aId)}/instances`, undefined, owner)).body.instances[0].name).toBe('A instance');
        expect((await central.call('GET', `${scope(bId)}/instances`, undefined, owner)).body.instances[0].name).toBe('B instance');
        expect((await central.call('POST', `${scope(aId)}/instances/${id}/login`, { target: 'provider' }, { Cookie: owner.Cookie, Origin: central.origin })).status).toBe(403);
        const login = await central.call('POST', `${scope(aId)}/instances/${id}/login`, { target: 'provider' }, owner);
        expect(login.status).toBe(201);
        expect((await a.call('POST', `/api/instances/${id}/actions`, { action: 'start' }, local)).status).toBe(409);
        const wsUrl = central.origin.replace('http:', 'ws:') + `${scope(aId)}/logins/${login.body.loginId}`;
        const bad = new WebSocket(wsUrl, { headers: other }); bad.on('error', () => {});
        const [, rejected] = await once(bad, 'unexpected-response'); expect(rejected.statusCode).toBe(404); rejected.resume(); bad.terminate();
        const ws = new WebSocket(wsUrl, { headers: owner }); await once(ws, 'open');
        const output = once(ws, 'message'); a.runtime.logins[0]!.output('synthetic native output');
        expect(JSON.parse((await output)[0].toString())).toEqual({ type: 'output', data: 'synthetic native output' });
        ws.send(JSON.stringify({ type: 'answer', value: 'synthetic single-line answer' }));
        const pong = once(ws, 'pong'); ws.ping(); await pong;
        await central.call('GET', `${scope(aId)}/instances`, undefined, owner);
        expect(a.runtime.logins[0]!.inputData).toBe('synthetic single-line answer\r');
        const bLogin = await central.call('POST', `${scope(bId)}/instances/${id}/login`, { target: 'provider' }, other);
        expect(bLogin.status).toBe(201);
        const closed = once(ws, 'close');
        expect((await central.call('DELETE', '/api/session', undefined, owner)).status).toBe(200);
        await closed;
        // A read roundtrip orders the node's owner-revocation message before inspection.
        await central.call('GET', `${scope(aId)}/instances`, undefined, other);
        expect(a.runtime.logins[0]!.cancelled).toBe(true);
        expect(b.runtime.logins[0]!.cancelled).toBe(false);
        expect((await a.call('POST', `/api/instances/${id}/actions`, { action: 'start' }, local)).status).toBe(200);
        await central.call('DELETE', `/api/federation/nodes/${bId}`, undefined, other);
        await b.connector!.close();
        expect(b.runtime.logins[0]!.cancelled).toBe(true);
        expect((await a.call('GET', '/api/instances', undefined, local)).body.instances[0].state).toBe('running');
    });
    it('stops remote output at browser expiry while local management remains usable', async () => {
        const c = await fixture(true), a = await fixture();
        const owner = await c.signIn(), local = await a.signIn();
        const nodeId = await connected(c, a, owner, 'Expiry node');
        const created = await a.call('POST', '/api/instances', { name: 'Expiry fixture', engine: 'codex', proxyMode: 'none' }, local);
        const id = created.body.instance.id;
        const base = `/api/federation/nodes/${nodeId}/api`;
        const login = await c.call('POST', `${base}/instances/${id}/login`, { target: 'provider' }, owner);
        const ws = new WebSocket(c.origin.replace('http:', 'ws:') + `${base}/logins/${login.body.loginId}`, { headers: owner });
        await once(ws, 'open');
        const messages: unknown[] = []; ws.on('message', message => messages.push(JSON.parse(message.toString())));
        const closed = once(ws, 'close');
        c.expire(); a.runtime.logins[0]!.output('must not reach expired browser');
        await closed;
        expect(messages).toEqual([]);
        // Local HTTP response follows the connector's asynchronous revoke processing.
        for (let i = 0; i < 100 && !a.runtime.logins[0]!.cancelled; i++) await a.call('GET', '/api/instances', undefined, local);
        expect(a.runtime.logins[0]!.cancelled).toBe(true);
        expect((await a.call('POST', `/api/instances/${id}/actions`, { action: 'start' }, local)).status).toBe(200);
    });
    // Review gap: opening a native process outlives its disconnected owner;
    // a replacement connection must retain the local lock until cancellation.
    it('keeps deferred native login locked across reconnect and cancels its old epoch', async () => {
        const c = await fixture(true), a = await fixture(), h = await c.signIn(), local = await a.signIn();
        const nodeId = await connected(c, a, h, 'Deferred login');
        const created = await a.call('POST', '/api/instances', { name: 'Deferred', engine: 'codex', proxyMode: 'none' }, local);
        const id = created.body.instance.id, base = `/api/federation/nodes/${nodeId}/api`;
        let release!: () => void, entered!: () => void;
        const native = new Login();
        const opening = new Promise<Login>(resolve => { release = () => resolve(native); });
        const started = new Promise<void>(resolve => { entered = resolve; });
        a.runtime.openLogin = async () => { entered(); return opening; };
        const pending = c.call('POST', `${base}/instances/${id}/login`, { target: 'provider' }, h);
        await started; await a.connector!.close();
        expect((await pending).body.error.code).toBe('OPERATION_UNCERTAIN');
        a.connector!.start();
        for (let i = 0; i < 500; i++) {
            const listed = await c.call('GET', '/api/federation/nodes', undefined, h);
            if (listed.body.nodes.find((n: any) => n.id === nodeId)?.online) break;
        }
        expect((await c.call('POST', `${base}/instances/${id}/login`, { target: 'provider' }, h)).body.error.code).toBe('INSTANCE_BUSY');
        const cancelled = new Promise<void>(resolve => { native.cancel = async () => { native.cancelled = true; resolve(); }; });
        release(); await cancelled;
        await c.call('GET', `${base}/instances`, undefined, h);
        expect(native.cancelled).toBe(true);
        expect(a.service.logins.size).toBe(0);
        expect((await a.call('POST', `/api/instances/${id}/actions`, { action: 'start' }, local)).status).toBe(200);
    });
    // A reverse proxy can report 502 after the central consumed the one-time
    // code. Keep the generated key so a successful exchange is recoverable.
    it('retains enrollment credential when an accepted exchange receives a gateway error', async () => {
        const c = await fixture(true), a = await fixture();
        const enrollment = c.hub!.createEnrollment('Gateway fixture');
        const gateway = createHttpServer(async (req, res) => {
            const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
            const body = JSON.parse(Buffer.concat(chunks).toString());
            c.hub!.enroll(body.enrollmentToken, body.credential);
            res.writeHead(502); res.end('{}');
        });
        gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
        const port = (gateway.address() as { port: number }).port;
        try {
            await expect(enrollManager(a.store, `http://127.0.0.1:${port}`, enrollment.enrollmentToken))
                .rejects.toMatchObject({ code: 'ENROLLMENT_UNCERTAIN' });
            const config = a.store.secret<{ nodeId: string; credential: string }>('federation:connection')!;
            expect(c.hub!.authenticate(config.nodeId, config.credential)).toBe(true);
            expect(() => c.hub!.enroll(enrollment.enrollmentToken)).toThrow();
        } finally {
            gateway.closeAllConnections(); await new Promise<void>(done => gateway.close(() => done()));
        }
    });
    it('keeps machine enrollment separate from browser auth and rejects replay', async () => {
        const c = await fixture(true), h = await c.signIn();
        expect((await c.call('POST', '/api/federation/nodes', { name: 'Synthetic' })).status).toBe(401);
        const node = await c.call('POST', '/api/federation/nodes', { name: 'Synthetic' }, h);
        const token = node.body.enrollmentToken;
        expect((await c.call('POST', '/api/federation/enroll', { enrollmentToken: 'invalid' }, h)).status).not.toBe(200);
        expect((await c.call('POST', '/api/federation/enroll', { enrollmentToken: token })).status).toBe(200);
        expect((await c.call('POST', '/api/federation/enroll', { enrollmentToken: token })).status).not.toBe(200);
        const ws = new WebSocket(c.origin.replace('http:', 'ws:') + '/api/federation/connect', { headers: h }); ws.on('error', () => {});
        const [, rejected] = await once(ws, 'unexpected-response'); expect(rejected.statusCode).toBe(401); rejected.resume(); ws.terminate();
    });
});
