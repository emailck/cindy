import { randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';
import { Store } from './store.js';
import { ApiError, ManagerService } from './service.js';
import { FEDERATION_VERSION, LEASE_MS, centralUrl, hash, identifier, parse, safeError, send, type Frame, type RpcResult } from './federation-protocol.js';
interface ConnectionConfig { origin: string; nodeId: string; credential: string }
const CONFIG = 'federation:connection';
export async function enrollManager(store: Store, centralOrigin: string, enrollmentToken: string): Promise<void> {
    centralUrl(centralOrigin);
    if (store.secret(CONFIG)) throw new ApiError(409, 'ALREADY_CONNECTED', 'Disconnect the existing central connection first.');
    const nodeId = enrollmentToken.split('.')[0];
    if (!/^[a-f0-9-]{36}$/.test(nodeId) || enrollmentToken.length > 200) throw new ApiError(400, 'INVALID_ENROLLMENT', 'Invalid enrollment code.');
    const credential = randomBytes(32).toString('base64url');
    // Persist first: even if the exchange response is lost, the one-time code cannot strand its credential.
    store.setSecret(CONFIG, { origin: centralOrigin, nodeId, credential } satisfies ConnectionConfig);
    let response: Response;
    try {
        response = await fetch(centralOrigin + '/api/federation/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enrollmentToken, credential }), redirect: 'error', signal: AbortSignal.timeout(15_000) });
    } catch { throw new ApiError(503, 'ENROLLMENT_UNCERTAIN', 'Enrollment response was lost. Connection settings are retained; start the Manager to check, or disconnect before enrolling again.'); }
    if (!response.ok) {
        if (response.status >= 500)
            throw new ApiError(503, 'ENROLLMENT_UNCERTAIN', 'Enrollment outcome is uncertain. Connection settings are retained; start the Manager to check, or disconnect before enrolling again.');
        store.delete(CONFIG);
        throw new ApiError(response.status, 'ENROLLMENT_REJECTED', 'Enrollment was rejected. Create a new enrollment code.');
    }
    // Never trust returned credentials; this client generated the key that the central verified.
}
export function disconnectManager(store: Store): void { store.delete(CONFIG); }
export class FederationConnector {
    private ws?: WebSocket;
    private timer?: ReturnType<typeof setInterval>;
    private retry?: ReturnType<typeof setTimeout>;
    private stopped = true;
    private ready = false;
    private seen = 0;
    private failures = 0;
    private owners = new Map<string, number>();
    private revoked = new Set<string>();
    private generation = '';
    constructor(readonly options: { service: ManagerService; store: Store }) { }
    isOwnerActive(owner: string): boolean { return (this.owners.get(owner) ?? 0) > Date.now() && this.ready; }
    private localOwner(owner: string) { return `federation:${this.generation}:${owner}`; }
    private renew(owner: string) { const local = this.localOwner(owner); this.owners.set(local, Date.now() + LEASE_MS); return local; }
    start() {
        if (!this.stopped) return;
        this.stopped = false; this.connect();
        this.timer = setInterval(() => {
            if (this.ws && Date.now() - this.seen > LEASE_MS) this.ws.terminate();
            for (const [owner, until] of this.owners) if (until <= Date.now()) { this.owners.delete(owner); void this.options.service.revoke(owner); }
        }, 5_000);
        this.timer.unref();
    }
    private connect() {
        if (this.stopped) return;
        const config = this.options.store.secret<ConnectionConfig>(CONFIG);
        if (!config) return;
        const url = centralUrl(config.origin); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'; url.pathname = '/api/federation/connect';
        this.generation = randomBytes(12).toString('hex'); this.revoked.clear();
        const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${config.credential}`, 'X-Cindy-Node-Id': config.nodeId }, maxPayload: 1_048_576, perMessageDeflate: false, handshakeTimeout: 10_000, followRedirects: false });
        this.ws = ws; this.ready = false; this.seen = Date.now();
        ws.on('open', () => { if (this.ws === ws) send(ws, { type: 'hello', version: FEDERATION_VERSION, nodeId: config.nodeId }); });
        ws.on('error', () => { /* Connection failures are represented by offline state, never log credentials. */ });
        ws.on('close', () => {
            if (this.ws !== ws) return;
            this.ws = undefined; this.ready = false;
            for (const owner of this.owners.keys()) void this.options.service.revoke(owner);
            this.owners.clear();
            if (!this.stopped) { this.retry = setTimeout(() => this.connect(), Math.min(30_000, 1000 * 2 ** Math.min(this.failures++, 5))); this.retry.unref(); }
        });
        ws.on('message', raw => {
            if (this.ws !== ws) return;
            try {
                const frame = parse(raw); this.seen = Date.now();
                if (!this.ready) {
                    if (frame.type !== 'ready' || frame.version !== FEDERATION_VERSION) throw new Error('Version mismatch');
                    this.ready = true; this.failures = 0; return;
                }
                if (frame.type === 'lease') {
                    if (!Array.isArray(frame.owners) || frame.owners.length > 10_000 || frame.owners.some((owner: unknown) => !identifier(owner))) throw new Error('Invalid lease');
                    const active = new Set(frame.owners.filter((owner: string) => !this.revoked.has(owner)).map((owner: string) => this.renew(owner)));
                    for (const owner of this.owners.keys()) if (!active.has(owner)) { this.owners.delete(owner); void this.options.service.revoke(owner); }
                    send(ws, { type: 'pong' }); return;
                }
                if (!identifier(frame.owner)) throw new Error('Invalid owner');
                const owner = this.localOwner(frame.owner);
                if (frame.type === 'revokeOwner') { this.revoked.add(frame.owner); this.owners.delete(owner); void this.options.service.revoke(owner); return; }
                if (frame.type === 'terminal' || frame.type === 'detach') {
                    if (!this.isOwnerActive(owner)) return;
                    let login;
                    try { login = this.options.service.ownedLogin(frame.loginId, owner); } catch {
                        if (frame.type !== 'detach') send(ws, { type: 'terminalClosed', loginId: frame.loginId, owner: frame.owner });
                        return;
                    }
                    if (frame.type === 'detach') void this.options.service.cancelLogin(login).catch(() => {});
                    else void this.terminal(login.id, owner, frame.data).catch(() => { try { send(ws, { type: 'terminal', loginId: login.id, owner: frame.owner, data: { type: 'error', message: 'Invalid terminal message.' } }); } catch {} void this.options.service.cancelLogin(login).catch(() => {}); });
                    return;
                }
                if (!identifier(frame.id)) throw new Error('Invalid request');
                if (this.revoked.has(frame.owner)) { send(ws, { type: 'result', id: frame.id, ...safeError(new ApiError(401, 'UNAUTHENTICATED', 'Owner session has ended.')) }); return; }
                this.renew(frame.owner);
                void this.handle(frame, owner, ws, config.nodeId).then(result => { if (this.ws === ws && this.ready) { try { send(ws, { type: 'result', id: frame.id, ...result }); } catch { ws.terminate(); } } });
            } catch { ws.close(1008, 'Invalid federation frame'); }
        });
    }
    private async handle(frame: Frame, owner: string, ws: WebSocket, nodeId: string): Promise<RpcResult> {
        try {
            if (frame.type === 'attach') {
                const login = this.options.service.ownedLogin(frame.loginId, owner);
                if (login.attached) throw new ApiError(409, 'ALREADY_ATTACHED', 'Login already connected.');
                login.attached = true;
                login.close = () => { if (this.ws === ws) { try { send(ws, { type: 'terminalClosed', loginId: login.id, owner: frame.owner }); } catch {} } };
                login.send = data => { if (!this.isOwnerActive(owner)) { void this.options.service.cancelLogin(login).catch(() => {}); return; } try { send(ws, { type: 'terminal', loginId: login.id, owner: frame.owner, data }); } catch { ws.terminate(); } };
                login.output.forEach(data => login.send?.({ type: 'output', data })); login.output = []; login.outputBytes = 0;
                if (login.exitCode !== undefined) login.send({ type: 'exit', code: login.exitCode });
                return { status: 200, body: {} };
            }
            if (frame.type !== 'request' || typeof frame.method !== 'string' || typeof frame.path !== 'string') throw new ApiError(400, 'INVALID_REQUEST', 'Invalid federation request.');
            // Determine the whitelist before writing the journal or invoking the runtime.
            const run = this.dispatch(frame.method, frame.path, frame.body, owner);
            const mutation = frame.method !== 'GET';
            let key: string | undefined;
            if (mutation) {
                if (!identifier(frame.operationId)) throw new ApiError(400, 'INVALID_OPERATION_ID', 'A unique operation ID is required.');
                key = `federation:operation:${nodeId}:${frame.operationId}`;
                const digest = hash(JSON.stringify({ owner: frame.owner, method: frame.method, path: frame.path, body: frame.body }));
                const previous = this.options.store.get(key);
                if (previous) {
                    if ((JSON.parse(previous) as { digest: string }).digest !== digest) throw new ApiError(409, 'OPERATION_ID_CONFLICT', 'Operation ID was used with different input.');
                    throw new ApiError(409, 'OPERATION_UNCERTAIN', 'This operation was already accepted. Check its outcome on the machine; it will not be repeated.');
                }
                // FULL synchronous SQLite commit occurs before dispatch. Keep only hashes/status, never responses or input.
                this.options.store.set(key, JSON.stringify({ digest, state: 'accepted' }));
            }
            try {
                const result = await run();
                if (key) { const record = JSON.parse(this.options.store.get(key)!); record.state = 'completed'; record.status = result.status; this.options.store.set(key, JSON.stringify(record)); }
                return result;
            } catch (error) {
                const result = safeError(error);
                if (key) { const record = JSON.parse(this.options.store.get(key)!); record.state = 'failed'; record.status = result.status; this.options.store.set(key, JSON.stringify(record)); }
                return result;
            }
        } catch (error) { return safeError(error); }
    }
    private dispatch(method: string, path: string, body: unknown, owner: string): () => Promise<RpcResult> {
        const service = this.options.service;
        if (path === '/api/settings' && method === 'GET') return async () => ({ status: 200, body: service.settings() });
        if (path === '/api/settings' && method === 'PUT') return async () => ({ status: 200, body: service.updateSettings(body) });
        if (path === '/api/proxy/test' && method === 'POST') return async () => ({ status: 200, body: await service.testProxy(body) });
        if (path === '/api/instances' && method === 'GET') return async () => ({ status: 200, body: { instances: await service.list() } });
        if (path === '/api/instances' && method === 'POST') return async () => ({ status: 201, body: { instance: await service.create(body) } });
        const match = path.match(/^\/api\/instances\/([a-f0-9-]{36})(?:\/(actions|login|share))?$/);
        if (match) {
            const id = match[1];
            if (!match[2] && method === 'GET') return async () => ({ status: 200, body: { instance: await service.view(id) } });
            if (!match[2] && method === 'PATCH') return async () => ({ status: 200, body: { instance: await service.patch(id, body) } });
            if (method === 'POST' && match[2] === 'actions') return async () => ({ status: 200, body: { instance: await service.action(id, body) } });
            if (method === 'POST' && match[2] === 'share') return async () => ({ status: 200, body: { result: await service.share(id, body) } });
            if (method === 'POST' && match[2] === 'login') return async () => ({ status: 201, body: { loginId: await service.login(id, owner, body, () => this.isOwnerActive(owner)) } });
        }
        throw new ApiError(404, 'NOT_FOUND', 'Endpoint not found.');
    }
    private async terminal(id: string, owner: string, data: unknown) {
        const login = this.options.service.ownedLogin(id, owner);
        if (!data || typeof data !== 'object') throw new Error('Invalid terminal');
        const frame = data as Frame;
        if (frame.type === 'cancel') { await this.options.service.cancelLogin(login); return; }
        if (login.exitCode !== undefined && ['answer', 'input', 'resize'].includes(frame.type)) return;
        if (frame.type === 'answer') {
            const value = frame.value; delete frame.value;
            if (typeof value !== 'string' || !value.length || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Invalid answer');
            login.runtime.input(value + '\r'); return;
        }
        if (frame.type === 'resize' && Number.isInteger(frame.cols) && Number.isInteger(frame.rows) && frame.cols >= 20 && frame.cols <= 500 && frame.rows >= 5 && frame.rows <= 200) {
            try { await login.runtime.resize(frame.cols, frame.rows); } catch { if (login.exitCode === undefined) login.send?.({ type: 'warning', code: 'TERMINAL_RESIZE_FAILED', message: 'Terminal resize failed.' }); }
            return;
        }
        throw new Error('Invalid terminal message');
    }
    async close(): Promise<void> {
        this.stopped = true; this.ready = false;
        clearInterval(this.timer); clearTimeout(this.retry);
        this.ws?.terminate(); this.ws = undefined;
        const owners = [...this.owners.keys()]; this.owners.clear();
        await Promise.all(owners.map(owner => this.options.service.revoke(owner)));
    }
}
