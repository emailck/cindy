/** 测试价值：MGR-002 全新后端无已有覆盖。生产 HTTP/WS + service + SQLite，fake Docker。
 * 最小失败输入：匿名写入、跨源 WS、旧登录取消与新登录交错、一次 create 失败。
 * 可观察结果：认证/CSRF/所有权拒绝，秘密不回显，持久化与锁一致。tier: integration。
 * 单文件耗时见交付记录；不使用真实账号、外部网络或 Docker。 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { Store } from './store.js';
import { Auth } from './auth.js';
import { ManagerService } from './service.js';
import { createManagerServer } from './server.js';
import type { DockerRuntime, RuntimeInstance, RuntimeInspection, RuntimeLogin, RuntimeProxy } from './runtime-types.js';
class FakeLogin implements RuntimeLogin {
    cancelled = false;
    inputData = '';
    outputs = new Set<(data: string) => void>();
    exits = new Set<(code: number) => void>();
    input(data: string) { this.inputData += data; }
    async resize() { }
    async cancel() { this.cancelled = true; }
    onOutput(fn: (data: string) => void) { this.outputs.add(fn); return () => { this.outputs.delete(fn); }; }
    onExit(fn: (code: number) => void) { this.exits.add(fn); return () => { this.exits.delete(fn); }; }
    output(data: string) { this.outputs.forEach(fn => fn(data)); }
    exit() { this.exits.forEach(fn => fn(0)); }
}
class FakeRuntime implements DockerRuntime {
    async testProxy(proxy: RuntimeProxy) { this.proxies.push(proxy); return { ip: '203.0.113.7', country: 'Fixture', region: 'Region', city: 'City' }; }
    states = new Map<string, RuntimeInspection['state']>();
    logins: FakeLogin[] = [];
    failCreate = false;
    failStop = false;
    proxies: (RuntimeProxy | null | undefined)[] = [];
    async create(instance: RuntimeInstance, proxy?: RuntimeProxy | null) { if (this.failCreate) {
        this.failCreate = false;
        throw new Error('RAW_DOCKER_SECRET');
    } this.states.set(instance.id, 'stopped'); this.proxies.push(proxy); }
    async inspect(instance: RuntimeInstance): Promise<RuntimeInspection> { return { state: this.states.get(instance.id) ?? 'missing' }; }
    async start(instance: RuntimeInstance, proxy?: RuntimeProxy | null) { this.states.set(instance.id, 'running'); this.proxies.push(proxy); }
    async stop(instance: RuntimeInstance) {if(this.failStop){this.failStop=false;throw Object.assign(new Error('raw error'),{code:'STOP_TIMEOUT'});} this.states.set(instance.id, 'stopped'); }
    async check(instance: RuntimeInstance) { return { ...await this.inspect(instance), authentication: { cindy: 'stored' as const, provider: 'authenticated' as const } }; }
    async share() { return { shares: { requests: [], members: [] }, usage: {} }; }
    async openLogin() { const login = new FakeLogin(); this.logins.push(login); return login; }
}
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse())
    await cleanup(); });
async function fixture() {
    const directory = mkdtempSync(join(tmpdir(), 'cindy-manager-test-'));
    let now = Date.now();
    const store = new Store(directory), auth = new Auth(store, 60000, () => now), runtime = new FakeRuntime(), service = new ManagerService(store, runtime, 'test:local');
    auth.initialize('invalid-test-password');
    writeFileSync(join(directory, 'index.html'), '<html>fixture</html>');
    const app = createManagerServer({ service, auth, origin: 'http://manager.test', webDirectory: directory });
    await new Promise<void>(done => app.server.listen(0, '127.0.0.1', done));
    const address = app.server.address();
    if (!address || typeof address === 'string')
        throw new Error('Address missing');
    const port = address.port;
    cleanups.push(async () => { await app.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
    function call(method: string, path: string, data?: unknown, headers: Record<string, string> = {}) {
        return new Promise<{
            status: number;
            body: any;
            headers: Record<string, any>;
        }>((done, reject) => {
            const req = request({ host: '127.0.0.1', port, path, method, headers: { Host: 'manager.test', ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers } }, res => {
                const chunks: Buffer[] = [];
                res.on('data', chunk => chunks.push(Buffer.from(chunk)));
                res.on('end', () => { const raw = Buffer.concat(chunks).toString(); let body: unknown; try {
                    body = JSON.parse(raw);
                }
                catch {
                    body = raw;
                } done({ status: res.statusCode!, body, headers: res.headers }); });
            });
            req.on('error', reject);
            req.end(data === undefined ? undefined : JSON.stringify(data));
        });
    }
    async function signIn() { const result = await call('POST', '/api/session', { password: 'invalid-test-password' }, { Origin: 'http://manager.test' }); expect(result.status).toBe(200); return { Cookie: result.headers['set-cookie'][0].split(';')[0], Origin: 'http://manager.test', 'X-CSRF-Token': result.body.csrfToken } as Record<string, string>; }
    async function create(headers: Record<string, string>) { const result = await call('POST', '/api/instances', { name: 'Test host', engine: 'codex', proxyMode: 'none' }, headers); expect(result.status).toBe(201); return result.body.instance.id as string; }
    function socket(loginId: string, headers: Record<string, string>) { return new WebSocket(`ws://127.0.0.1:${port}/api/logins/${loginId}`, { headers: { Host: 'manager.test', ...headers } }); }
    return { directory, store, auth, runtime, service, call, signIn, create, socket, expire: () => { now += 60001; } };
}
describe('host manager production HTTP and login security', () => {
    it('requires session, trusted origin and CSRF; logout revokes cookie', async () => {
        const f = await fixture();
        expect((await f.call('GET', '/api/instances')).status).toBe(401);
        expect((await f.call('POST', '/api/session', { password: 'invalid-test-password' }, { Origin: 'http://evil.test' })).status).toBe(403);
        const h = await f.signIn();
        expect((await f.call('POST', '/api/instances', { name: 'x', engine: 'codex', proxyMode: 'none' }, { Cookie: h.Cookie!, Origin: h.Origin! })).status).toBe(403);
        expect((await f.call('GET', '/api/instances', undefined, { ...h, Host: 'evil.test' })).status).toBe(403);
        const id = await f.create(h);
        expect((await f.call('GET', `/api/instances/${id}`, undefined, h)).body.instance.state).toBe('stopped');
        expect((await f.call('DELETE', '/api/session', undefined, h)).status).toBe(200);
        expect((await f.call('GET', '/api/instances', undefined, h)).status).toBe(401);
    });
    it('encrypts proxy credentials, persists records and applies proxy overrides on next start', async () => {
        const f = await fixture(), h = await f.signIn(), id = await f.create(h);
        const proxy = { proxyUrl: 'http://proxy.test:8080', proxyUsername: 'invalid-user', proxyPassword: 'invalid-proxy-secret' };
        expect((await f.call('PUT', '/api/settings', proxy, h)).body).toEqual({ image: 'test:local', proxyConfigured: true, proxyUrl: 'http://proxy.test:8080' });
        expect(readFileSync(join(f.directory, 'manager.sqlite')).includes(Buffer.from(proxy.proxyPassword))).toBe(false);
        for (const proxyUrl of ['http://user:secret@proxy.test:8080', 'https://proxy.test:8080'])
            expect((await f.call('PUT', '/api/settings', { proxyUrl }, h)).status).toBe(400);
        const reopened = new Store(f.directory);
        expect(reopened.instance(id)?.name).toBe('Test host');
        expect(reopened.proxy()?.password).toBe(proxy.proxyPassword);
        reopened.close();
        await f.call('POST', `/api/instances/${id}/actions`, { action: 'start' }, h);
        expect(f.runtime.proxies.at(-1)).toBeNull();
        expect((await f.call('PATCH', `/api/instances/${id}`, { proxyMode: 'default' }, h)).status).toBe(409);
        await f.call('POST', `/api/instances/${id}/actions`, { action: 'stop' }, h);
        await f.call('PATCH', `/api/instances/${id}`, { proxyMode: 'default' }, h);
        await f.call('POST', `/api/instances/${id}/actions`, { action: 'start' }, h);
        expect(f.runtime.proxies.at(-1)?.password).toBe(proxy.proxyPassword);
        await f.call('PUT', '/api/settings', { proxyUrl: null }, h);
        expect(f.service.settings().proxyConfigured).toBe(false);
    });
    // Integration: production HTTP routes + encrypted SQLite. A custom proxy must
    // survive reopen, stay isolated from defaults/other instances, and reach runtime
    // operations without returning credentials. Existing tests cover only the global proxy.
    it('isolates custom proxies, preserves blank credentials and tests drafts without saving', async () => {
        const f = await fixture(), h = await f.signIn();
        const missing = await f.call('POST', '/api/proxy/test', { proxyMode: 'default' }, h);
        expect(missing.status).toBe(400);
        expect(missing.body.error.code).toBe('PROXY_NOT_CONFIGURED');
        const first = await f.call('POST', '/api/instances', { name: 'Custom', engine: 'claude-code', proxyMode: 'custom',
            proxyUrl: 'http://first.invalid:8080', proxyUsername: 'fixture-user', proxyPassword: 'invalid-custom-secret' }, h);
        expect(first.status).toBe(201);
        const id = first.body.instance.id;
        expect(first.body.instance).toMatchObject({ proxyMode: 'custom', proxyUrl: 'http://first.invalid:8080', proxyAuthConfigured: true });
        expect(JSON.stringify(first.body)).not.toContain('invalid-custom-secret');
        expect(readFileSync(join(f.directory, 'manager.sqlite')).includes(Buffer.from('invalid-custom-secret'))).toBe(false);
        const reopened = new Store(f.directory);
        try { expect(reopened.proxy(id)?.password).toBe('invalid-custom-secret'); expect(reopened.proxy()).toBeNull(); }
        finally { reopened.close(); }
        await f.call('PUT', '/api/settings', { proxyUrl: 'http://default.invalid:8080' }, h);
        const other = await f.create(h);
        await f.call('POST', `/api/instances/${id}/actions`, { action: 'start' }, h);
        expect(f.runtime.proxies.at(-1)?.password).toBe('invalid-custom-secret');
        expect((await f.call('PATCH', `/api/instances/${id}`, { proxyUrl: 'http://changed.invalid' }, h)).status).toBe(409);
        const draft = { proxyMode: 'custom', instanceId: id, proxyUrl: 'http://first.invalid:8080', proxyPassword: '' };
        expect((await f.call('POST', '/api/proxy/test', draft, h)).body.ip).toBe('203.0.113.7');
        expect(f.runtime.proxies.at(-1)?.password).toBe('invalid-custom-secret');
        expect((await f.call('POST', '/api/proxy/test', draft, { Cookie: h.Cookie!, Origin: h.Origin! })).status).toBe(403);
        await f.call('POST', '/api/proxy/test', { ...draft, proxyUrl: 'http://draft.invalid:8080' }, h);
        expect(f.runtime.proxies.at(-1)?.password).toBeUndefined();
        expect(f.service.store.proxy(id)?.url).toBe('http://first.invalid:8080');
        await f.call('POST', `/api/instances/${id}/actions`, { action: 'stop' }, h);
        await f.call('PATCH', `/api/instances/${id}`, { proxyPassword: '' }, h);
        expect(f.service.store.proxy(id)?.password).toBe('invalid-custom-secret');
        await f.call('PATCH', `/api/instances/${id}`, { proxyClearAuth: true }, h);
        expect(f.service.store.proxy(id)).toEqual({ url: 'http://first.invalid:8080' });
        await f.call('POST', `/api/instances/${other}/actions`, { action: 'start' }, h);
        expect(f.runtime.proxies.at(-1)).toBeNull();
    });
    it('keeps the new login lock after cancelling an old completed login', async () => {
        const f = await fixture(), h = await f.signIn(), id = await f.create(h);
        const first = await f.call('POST', `/api/instances/${id}/login`, { target: 'provider' }, h);
        expect(first.status).toBe(201);
        expect((await f.call('POST', `/api/instances/${id}/actions`, { action: 'start' }, h)).status).toBe(409);
        f.runtime.logins[0]!.exit();
        expect((await f.call('POST', `/api/instances/${id}/login`, { target: 'provider' }, h)).status).toBe(201);
        await f.service.cancelLogin(f.service.logins.get(first.body.loginId)!);
        expect((await f.call('POST', `/api/instances/${id}/actions`, { action: 'start' }, h)).status).toBe(409);
        await f.call('DELETE', '/api/session', undefined, h);
        expect(f.runtime.logins[1]!.cancelled).toBe(true);
    });
    it('binds terminal to creator and origin, streams native output, cancels on disconnect', async () => {
        const f = await fixture(), owner = await f.signIn(), other = await f.signIn(), id = await f.create(owner);
        const login = await f.call('POST', `/api/instances/${id}/login`, { target: 'provider' }, owner), loginId = login.body.loginId;
        for (const h of [other, { ...owner, Origin: 'http://evil.test' }]) {
            const ws = f.socket(loginId, h);
            ws.on('error', () => { });
            const [, res] = await once(ws, 'unexpected-response');
            expect([403, 404]).toContain(res.statusCode);
            res.resume();
            ws.terminate();
        }
        const ws = f.socket(loginId, owner);
        await once(ws, 'open');
        const output = once(ws, 'message');
        f.runtime.logins[0]!.output('native login output');
        expect(JSON.parse((await output)[0].toString())).toEqual({ type: 'output', data: 'native login output' });
        ws.send(JSON.stringify({ type: 'answer', value: 'invalid-test-answer' }));
        ws.close();
        await once(ws, 'close');
        expect(f.runtime.logins[0]!.cancelled).toBe(true);
        expect(f.runtime.logins[0]!.inputData).toBe('invalid-test-answer\r');
    });
    // MGR-010: the terminal is output-only. Only an explicit single-line answer
    // may reach native stdin; rejected values must never be reflected to the browser.
    it('rejects control characters and legacy raw input without forwarding or echoing the answer', async () => {
        const f = await fixture(), h = await f.signIn(), id = await f.create(h);
        for (const message of [
            { type: 'answer', value: '' },
            { type: 'answer', value: 'x'.repeat(4097) },
            { type: 'answer', value: 'invalid-secret\nsecond-line' },
            { type: 'answer', value: 'invalid-secret\x1b' },
            { type: 'answer', value: 'invalid-secret\x7f' },
            { type: 'input', data: '\x03invalid-secret' },
        ]) {
            const result = await f.call('POST', `/api/instances/${id}/login`, { target: 'provider' }, h);
            const runtime = f.runtime.logins.at(-1)!;
            const ws = f.socket(result.body.loginId, h);
            await once(ws, 'open');
            const replies: unknown[] = [];
            ws.on('message', data => { replies.push(JSON.parse(data.toString())); });
            const closed = once(ws, 'close');
            const barrier = Promise.race([once(ws, 'pong'), closed]);
            ws.send(JSON.stringify(message));
            ws.ping();
            await barrier;
            expect(runtime.inputData).toBe('');
            expect(replies).toEqual([{ type: 'error', message: 'Invalid terminal message.' }]);
            expect(JSON.stringify(replies)).not.toContain('invalid-secret');
            ws.close();
            await closed;
        }
    });
    // Regression: Docker removed an exit-0 login container while a terminal resize
    // was in flight; the late rejection must not replace the native login result.
    it('keeps exit zero final when an in-flight resize rejects and ignores later terminal input', async () => {
        const f = await fixture(), h = await f.signIn(), id = await f.create(h);
        const result = await f.call('POST', `/api/instances/${id}/login`, { target: 'provider' }, h);
        const runtime = f.runtime.logins[0]!;
        let resizeCalls = 0;
        let resizeStarted!: () => void;
        let rejectResize!: (error: Error) => void;
        const started = new Promise<void>(resolve => { resizeStarted = resolve; });
        const pendingResize = new Promise<void>((_resolve, reject) => { rejectResize = reject; });
        runtime.resize = () => { resizeCalls++; resizeStarted(); return pendingResize; };
        const ws = f.socket(result.body.loginId, h);
        await once(ws, 'open');
        const messages: unknown[] = [];
        ws.on('message', data => { messages.push(JSON.parse(data.toString())); });
        ws.send(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }));
        await started;
        const exit = once(ws, 'message');
        runtime.exit();
        expect(JSON.parse((await exit)[0].toString())).toEqual({ type: 'exit', code: 0 });
        rejectResize(new Error('fake container already removed'));
        ws.send(JSON.stringify({ type: 'answer', value: 'must not reach completed login' }));
        ws.send(JSON.stringify({ type: 'input', data: 'legacy input must also be ignored after exit' }));
        ws.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
        // Ping is a socket ordering barrier; no timers or arbitrary wait are needed.
        const pong = once(ws, 'pong');
        ws.ping();
        await pong;
        expect(messages).toEqual([{ type: 'exit', code: 0 }]);
        expect(runtime.inputData).toBe('');
        expect(resizeCalls).toBe(1);
        ws.close();
        await once(ws, 'close');
    });
    it('reports active terminal resize failure as an advisory warning', async () => {
        const f = await fixture(), h = await f.signIn(), id = await f.create(h);
        const result = await f.call('POST', `/api/instances/${id}/login`, { target: 'provider' }, h);
        const runtime = f.runtime.logins[0]!;
        runtime.resize = async () => { throw new Error('fake resize failure'); };
        const ws = f.socket(result.body.loginId, h);
        await once(ws, 'open');
        const warning = once(ws, 'message');
        ws.send(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }));
        expect(JSON.parse((await warning)[0].toString())).toEqual({
            type: 'warning', code: 'TERMINAL_RESIZE_FAILED', message: 'Terminal resize failed.'
        });
        const exit = once(ws, 'message');
        runtime.exit();
        expect(JSON.parse((await exit)[0].toString())).toEqual({ type: 'exit', code: 0 });
        ws.close();
        await once(ws, 'close');
    });
    it('revokes terminal output immediately at session expiry and logout', async () => {
        for (const reason of ['expiry', 'logout']) {
            const f = await fixture(), h = await f.signIn(), id = await f.create(h);
            const result = await f.call('POST', `/api/instances/${id}/login`, { target: 'provider' }, h);
            const ws = f.socket(result.body.loginId, h);
            await once(ws, 'open');
            const messages: unknown[] = [];
            ws.on('message', data => messages.push(JSON.parse(data.toString())));
            const closed = once(ws, 'close');
            if (reason === 'expiry') {
                f.expire();
                f.runtime.logins[0]!.output('must not reach expired session');
            }
            else
                await f.call('DELETE', '/api/session', undefined, h);
            await closed;
            expect(messages).toEqual([]);
            expect(f.runtime.logins[0]!.cancelled).toBe(true);
        }
    });
    it('keeps login locked after cancellation failure and releases it after timeout retry',async()=>{
        const f=await fixture(),h=await f.signIn(),id=await f.create(h);
        const result=await f.call('POST',`/api/instances/${id}/login`,{target:'provider'},h);
        const login=f.service.logins.get(result.body.loginId)!;
        f.runtime.logins[0]!.cancel=async()=>{throw new Error('fake stop failure');};
        await expect(f.service.cancelLogin(login)).rejects.toThrow('fake stop failure');
        expect((await f.call('POST',`/api/instances/${id}/actions`,{action:'start'},h)).status).toBe(409);
        login.expiresAt=0;
        f.runtime.logins[0]!.cancel=async()=>{f.runtime.logins[0]!.cancelled=true;};
        await f.service.sweep(()=>true);
        expect(f.runtime.logins[0]!.cancelled).toBe(true);
        expect((await f.call('POST',`/api/instances/${id}/actions`,{action:'start'},h)).body.instance.state).toBe('running');
    });
    it('returns safe errors and retries failed provisioning under the persisted identity', async () => {
        const f = await fixture(), h = await f.signIn();
        f.runtime.failCreate = true;
        const failed = await f.call('POST', '/api/instances', { name: 'Retry', engine: 'claude-code', proxyMode: 'none' }, h);
        expect(failed.status).toBe(500);
        expect(JSON.stringify(failed.body)).not.toContain('RAW_DOCKER_SECRET');
        const id = f.store.list()[0]!.id;
        expect((await f.call('POST', `/api/instances/${id}/actions`, { action: 'start' }, h)).body.instance.state).toBe('running');
        expect(f.store.list()).toHaveLength(1);
        expect((await f.call('POST', `/api/instances/${id}/login`, { target: 'provider' }, h)).body.error.code).toBe('STOP_REQUIRED');
        expect((await f.call('POST', `/api/instances/${id}/actions`, { action: 'shell', command: 'whoami' }, h)).status).toBe(400);
    });
    it('preserves running state after a failed stop so the operator can retry',async()=>{
        const f=await fixture(),h=await f.signIn(),id=await f.create(h);
        await f.call('POST',`/api/instances/${id}/actions`,{action:'start'},h);
        f.runtime.failStop=true;
        const failed=await f.call('POST',`/api/instances/${id}/actions`,{action:'stop'},h);
        expect(failed.status).toBe(409);expect(failed.body.error.code).toBe('STOP_TIMEOUT');
        const view=(await f.call('GET',`/api/instances/${id}`,undefined,h)).body.instance;
        expect(view.state).toBe('running');expect(view.error).toBeDefined();
        expect((await f.call('POST',`/api/instances/${id}/actions`,{action:'stop'},h)).body.instance.state).toBe('stopped');
    });
    it('contains static paths and sets security headers', async () => {
        const f = await fixture(), html = await f.call('GET', '/');
        expect(html.status).toBe(200);
        expect(html.headers['content-security-policy']).toContain("frame-ancestors 'none'");
        symlinkSync('/etc/hostname', join(f.directory, 'escape'));
        expect((await f.call('GET', '/escape')).status).toBe(404);
        expect((await f.call('GET', '/..%2f..%2fetc%2fhostname')).status).toBe(404);
    });
});
