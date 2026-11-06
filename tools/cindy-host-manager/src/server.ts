import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { Auth, type Session } from './auth.js';
import { ApiError, ManagerService, object } from './service.js';
export interface ServerOptions {
    service: ManagerService;
    auth: Auth;
    origin: string;
    webDirectory: string;
}
const runtimeErrors: Record<string, [
    number,
    string
]> = {
    STOP_TIMEOUT: [409, 'The process has not stopped. Data is retained; retry after it finishes.'],
    INSTANCE_RUNNING: [409, 'Stop the instance and finish any previous login before continuing.'],
    INSTANCE_STOPPED: [409, 'Start the instance before managing sharing.'],
    INSTANCE_MISSING: [409, 'Instance container is missing. Start it to recreate the container.'],
    RESOURCE_NOT_OWNED: [409, 'Docker resource ownership does not match this instance.'],
    INVALID_PROXY: [400, 'Only HTTP CONNECT proxy URLs are supported.'],
    INVALID_SHARE: [400, 'Invalid share member, pairing code or setting.'],
    INVALID_LOGIN: [400, 'Invalid native login options.'],
    NATIVE_DIRECTORY_UNAVAILABLE: [409, 'The native configuration directory is unavailable. Check its ownership and permissions. Saved files are retained.'],
    COMMAND_TIMEOUT: [504, 'The native command timed out.'],
    COMMAND_FAILED: [502, 'The native command failed. Check login and service availability.'],
    DOCKER_FAILED: [503, 'Docker is unavailable or the managed image could not run.'],
};
const securityHeaders = {
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    'Cache-Control': 'no-store',
};
async function body(req: IncomingMessage): Promise<unknown> {
    if (req.headers['content-type']?.split(';')[0] !== 'application/json')
        throw new ApiError(415, 'JSON_REQUIRED', 'Use application/json.');
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 16384)
            throw new ApiError(413, 'BODY_TOO_LARGE', 'Request body is too large.');
        chunks.push(Buffer.from(chunk));
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString());
    }
    catch {
        throw new ApiError(400, 'INVALID_JSON', 'Invalid JSON.');
    }
}
export function createManagerServer({ service, auth, origin, webDirectory }: ServerOptions) {
    const expected = new URL(origin);
    if (expected.origin !== origin || expected.username || expected.password || !['http:', 'https:'].includes(expected.protocol))
        throw new Error('Origin must be an HTTP(S) origin without credentials or a path.');
    const secure = expected.protocol === 'https:';
    const cookie = (id: string, maxAge: number) => `cindy_manager=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
    function verifyHost(req: IncomingMessage) { if (req.headers.host !== expected.host)
        throw new ApiError(403, 'HOST_REJECTED', 'Untrusted request host.'); }
    function verifyOrigin(req: IncomingMessage) { if (req.headers.origin !== origin)
        throw new ApiError(403, 'ORIGIN_REJECTED', 'Request origin rejected.'); }
    function session(req: IncomingMessage): Session { const session = auth.session(req.headers.cookie); if (!session)
        throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in to continue.'); return session; }
    function writeGuard(req: IncomingMessage, session: Session) { verifyOrigin(req); if (req.headers['x-csrf-token'] !== session.csrfToken)
        throw new ApiError(403, 'CSRF_REJECTED', 'Refresh the page and try again.'); }
    function json(res: ServerResponse, status: number, value: unknown) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); }
    async function handle(req: IncomingMessage, res: ServerResponse) {
        Object.entries(securityHeaders).forEach(([name, value]) => res.setHeader(name, value));
        verifyHost(req);
        const url = new URL(req.url ?? '/', origin), path = url.pathname, method = req.method;
        if (path === '/api/session') {
            if (method === 'GET') {
                const current = auth.session(req.headers.cookie);
                json(res, 200, current ? { authenticated: true, csrfToken: current.csrfToken } : { authenticated: false });
                return;
            }
            if (method === 'POST') {
                verifyOrigin(req);
                const data = object(await body(req), ['password']);
                if (typeof data.password !== 'string' || data.password.length > 1024)
                    throw new ApiError(400, 'INVALID_BODY', 'Invalid password.');
                const current = await auth.login(data.password);
                if (!current)
                    throw new ApiError(401, 'LOGIN_FAILED', 'Sign in failed or temporarily rate limited.');
                const previous = auth.session(req.headers.cookie);
                if (previous) {
                    auth.revoke(previous.id);
                    await service.revoke(previous.id);
                }
                res.setHeader('Set-Cookie', cookie(current.id, Math.floor(auth.lifetimeMs / 1000)));
                json(res, 200, { authenticated: true, csrfToken: current.csrfToken });
                return;
            }
            if (method === 'DELETE') {
                const current = session(req);
                writeGuard(req, current);
                auth.revoke(current.id);
                await service.revoke(current.id);
                res.setHeader('Set-Cookie', cookie('', 0));
                json(res, 200, { authenticated: false });
                return;
            }
        }
        if (path.startsWith('/api/')) {
            const current = session(req);
            if (method !== 'GET')
                writeGuard(req, current);
            if (path === '/api/settings' && method === 'GET') {
                json(res, 200, service.settings());
                return;
            }
            if (path === '/api/settings' && method === 'PUT') {
                json(res, 200, service.updateSettings(await body(req)));
                return;
            }
            if (path === '/api/instances' && method === 'GET') {
                json(res, 200, { instances: await service.list() });
                return;
            }
            if (path === '/api/instances' && method === 'POST') {
                json(res, 201, { instance: await service.create(await body(req)) });
                return;
            }
            const match = path.match(/^\/api\/instances\/([a-f0-9-]{36})(?:\/(actions|login|share))?$/);
            if (match) {
                const id = match[1]!;
                if (!match[2] && method === 'GET') {
                    json(res, 200, { instance: await service.view(id) });
                    return;
                }
                if (!match[2] && method === 'PATCH') {
                    json(res, 200, { instance: await service.patch(id, await body(req)) });
                    return;
                }
                if (method === 'POST' && match[2] === 'actions') {
                    json(res, 200, { instance: await service.action(id, await body(req)) });
                    return;
                }
                if (method === 'POST' && match[2] === 'login') {
                    json(res, 201, { loginId: await service.login(id, current.id, await body(req), () => auth.active(current.id)) });
                    return;
                }
                if (method === 'POST' && match[2] === 'share') {
                    json(res, 200, { result: await service.share(id, await body(req)) });
                    return;
                }
            }
            throw new ApiError(404, 'NOT_FOUND', 'Endpoint not found.');
        }
        if (method !== 'GET' && method !== 'HEAD')
            throw new ApiError(404, 'NOT_FOUND', 'Page not found.');
        let requested: string;
        try {
            requested = decodeURIComponent(path);
        }
        catch {
            throw new ApiError(400, 'INVALID_PATH', 'Invalid path.');
        }
        const root = await realpath(webDirectory);
        const candidate = resolve(root, `.${requested === '/' ? '/index.html' : requested}`);
        if (candidate !== root && !candidate.startsWith(root + sep))
            throw new ApiError(404, 'NOT_FOUND', 'Page not found.');
        let file: string;
        try {
            file = await realpath(candidate);
            if (!file.startsWith(root + sep) || !(await stat(file)).isFile())
                throw new Error();
        }
        catch {
            throw new ApiError(404, 'NOT_FOUND', 'Page not found.');
        }
        const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
        const bytes = await readFile(file);
        res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Content-Length': bytes.length });
        res.end(method === 'HEAD' ? undefined : bytes);
    }
    const server = createServer((req, res) => { void handle(req, res).catch(error => { if (res.headersSent) {
        res.destroy();
        return;
    } const mapped = runtimeErrors[String(error?.code)]; const safe = error instanceof ApiError ? error : mapped ? new ApiError(mapped[0], error.code, mapped[1]) : new ApiError(500, 'OPERATION_FAILED', 'Operation failed. Check the host configuration and try again.'); json(res, safe.status, { error: { code: safe.code, message: safe.message } }); }); });
    server.requestTimeout = 30000;
    server.headersTimeout = 10000;
    const wss = new WebSocketServer({ noServer: true, maxPayload: 16384, perMessageDeflate: false });
    server.on('upgrade', (req, socket, head) => {
        try {
            verifyHost(req);
            verifyOrigin(req);
            const current = session(req);
            const match = new URL(req.url ?? '/', origin).pathname.match(/^\/api\/logins\/([a-f0-9-]{36})$/);
            if (!match)
                throw new ApiError(404, 'NOT_FOUND', 'Login not found.');
            const login = service.ownedLogin(match[1]!, current.id);
            if (login.attached)
                throw new ApiError(409, 'ALREADY_ATTACHED', 'Login already connected.');
            wss.handleUpgrade(req, socket, head, ws => {
                login.attached = true;
                const cleanup = () => { login.send = undefined; void service.cancelLogin(login).catch(() => { }); };
                login.close = () => ws.close(1000);
                login.send = message => { if (!auth.active(current.id) || login.expiresAt <= Date.now()) {
                    ws.close(1008);
                    cleanup();
                    return;
                } if (ws.readyState !== WebSocket.OPEN)
                    return; if (ws.bufferedAmount > 262144) {
                    ws.close(1009);
                    return;
                } ws.send(JSON.stringify(message)); };
                login.output.forEach(data => login.send?.({ type: 'output', data }));
                login.output = [];
                login.outputBytes = 0;
                if (login.exitCode !== undefined)
                    login.send({ type: 'exit', code: login.exitCode });
                ws.on('message', raw => {
                    if (!auth.active(current.id) || login.expiresAt <= Date.now()) {
                        ws.close(1008);
                        cleanup();
                        return;
                    }
                    try {
                        const data = JSON.parse(raw.toString()) as Record<string, unknown>;
                        if (data.type === 'cancel') {
                            ws.close(1000);
                            cleanup();
                            return;
                        }
                        if (login.exitCode !== undefined && (data.type === 'input' || data.type === 'answer' || data.type === 'resize'))
                            return;
                        if (data.type === 'answer') {
                            const value = data.value;
                            delete data.value;
                            if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value))
                                throw new Error();
                            login.runtime.input(value + '\r');
                            return;
                        }
                        if (data.type === 'resize' && Number.isInteger(data.cols) && Number.isInteger(data.rows) && Number(data.cols) >= 20 && Number(data.cols) <= 500 && Number(data.rows) >= 5 && Number(data.rows) <= 200) {
                            void (async () => {
                                try {
                                    await login.runtime.resize(Number(data.cols), Number(data.rows));
                                }
                                catch {
                                    if (login.exitCode === undefined)
                                        login.send?.({ type: 'warning', code: 'TERMINAL_RESIZE_FAILED', message: 'Terminal resize failed.' });
                                }
                            })();
                            return;
                        }
                        throw new Error();
                    }
                    catch {
                        login.send?.({ type: 'error', message: 'Invalid terminal message.' });
                        ws.close(1008);
                    }
                });
                ws.on('close', cleanup);
                ws.on('error', cleanup);
            });
        }
        catch (error) {
            const status = error instanceof ApiError ? error.status : 403;
            socket.write(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\n\r\n`);
            socket.destroy();
        }
    });
    const sweep = setInterval(() => { auth.prune(); void service.sweep(id => auth.active(id)); }, 1000);
    sweep.unref();
    return {
        server,
        async close() {
            clearInterval(sweep);
            let cleanupError:unknown;
            try {await service.close();} catch(error) {cleanupError=error;}
            for(const client of wss.clients) client.terminate();
            wss.close();
            await new Promise<void>((done,reject)=>{
                server.close(error=>error?reject(error):done());
                server.closeAllConnections();
            });
            if(cleanupError)throw cleanupError;
        }
    };
}
