import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { openSync, closeSync, writeFileSync, fstatSync, lstatSync, unlinkSync } from 'node:fs';
import { Store } from './store.js';
import { Auth } from './auth.js';
import { ApiError, ManagerService } from './service.js';
import { createManagerServer } from './server.js';
import { DockerRuntimeAdapter } from './docker-runtime.js';
import { FederationHub, FederationConnector, enrollManager, disconnectManager } from './federation.js';
class StartupError extends Error {
}
async function main() {
    process.umask(0o077);
    const directory = process.env.CINDY_MANAGER_DATA_DIR ?? join(homedir(), '.local/share/cindy-host-manager');
    const store = new Store(directory);
    const command = process.argv[2] ?? 'serve';
    if (process.argv.length > 3)
        throw new StartupError('Use init, serve, connect or disconnect; configure deployment with environment variables.');
    const mode = process.env.CINDY_MANAGER_MODE ?? 'standalone';
    if (mode !== 'standalone' && mode !== 'central') throw new StartupError('Invalid CINDY_MANAGER_MODE.');
    const lockPath = join(directory, 'manager.lock');
    let lock: number;
    try {
        lock = openSync(lockPath, 'wx', 0o600);
    }
    catch {
        throw new StartupError('Manager data directory is locked. Verify the previous manager and its managed login containers have stopped before recovering a stale manager.lock.');
    }
    writeFileSync(lock, JSON.stringify({ pid: process.pid }));
    const inode = fstatSync(lock).ino;
    process.once('exit', () => { try {
        if (lstatSync(lockPath).ino === inode)
            unlinkSync(lockPath);
    }
    catch { } closeSync(lock); });
    if (command === 'connect' || command === 'disconnect') {
        if (mode !== 'standalone') throw new StartupError('Only standalone managers connect to a central manager.');
        try {
            if (command === 'disconnect') {
                disconnectManager(store);
                process.stdout.write('Central connection removed. Start the local manager to continue managing instances.\n');
            } else {
                const centralOrigin = process.env.CINDY_MANAGER_CENTRAL_ORIGIN;
                if (!centralOrigin) throw new StartupError('Set CINDY_MANAGER_CENTRAL_ORIGIN.');
                if (process.stdin.isTTY) throw new StartupError('Pipe the one-time enrollment code to connect via stdin.');
                const chunks: Buffer[] = [];
                let size = 0;
                for await (const chunk of process.stdin) {
                    size += chunk.length;
                    if (size > 4096) throw new StartupError('Enrollment input is too long.');
                    chunks.push(Buffer.from(chunk));
                }
                const token = Buffer.concat(chunks).toString().replace(/\r?\n$/, '');
                await enrollManager(store, centralOrigin, token);
                process.stdout.write('Central connection saved. The local manager connects while serving.\n');
            }
        } finally { store.close(); }
        return;
    }
    const auth = new Auth(store);

    if (command === 'init') {
        let password: string;
        if (process.stdin.isTTY && !process.stdout.isTTY)
            throw new StartupError('Generate the administrator password in an interactive terminal, or pipe a password into init.');
        if (process.stdin.isTTY) {
            password = randomBytes(24).toString('base64url');
            auth.initialize(password);
            process.stdout.write(`Administrator password (shown once): ${password}\n`);
        }
        else {
            const chunks: Buffer[] = [];
            let size = 0;
            for await (const chunk of process.stdin) {
                size += chunk.length;
                if (size > 4096)
                    throw new StartupError('Password input is too long.');
                chunks.push(Buffer.from(chunk));
            }
            password = Buffer.concat(chunks).toString().replace(/\r?\n$/, '');
            auth.initialize(password);
            process.stdout.write('Administrator initialized.\n');
        }
        store.close();
        return;
    }
    if (command !== 'serve')
        throw new StartupError('Use init, serve, connect or disconnect.');
    if (!auth.initialized())
        throw new StartupError('Initialize the administrator locally with init before starting.');
    const host = process.env.CINDY_MANAGER_HOST ?? '127.0.0.1';
    const port = Number(process.env.CINDY_MANAGER_PORT ?? 8787);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
        throw new StartupError('Invalid listen port.');
    const loopback = ['127.0.0.1', '::1', 'localhost'].includes(host);
    const origin = process.env.CINDY_MANAGER_ORIGIN ?? `http://${host === '::1' ? '[::1]' : host}:${port}`;
    let publicUrl: URL;
    try {
        publicUrl = new URL(origin);
    }
    catch {
        throw new StartupError('Invalid CINDY_MANAGER_ORIGIN.');
    }
    if (publicUrl.origin !== origin || publicUrl.username || publicUrl.password || !['http:', 'https:'].includes(publicUrl.protocol))
        throw new StartupError('CINDY_MANAGER_ORIGIN must contain only the trusted HTTP(S) origin.');
    if (!loopback && (!process.env.CINDY_MANAGER_ORIGIN || publicUrl.protocol !== 'https:'))
        throw new StartupError('Public binding requires an explicit trusted HTTPS origin behind a TLS reverse proxy.');
    const image = process.env.CINDY_MANAGER_IMAGE ?? 'cindy-host:local';
    // Forced-egress networks; build the image with scripts/build-gateway-image.sh. Empty disables networks.
    const gatewayImage = process.env.CINDY_MANAGER_GATEWAY_IMAGE ?? 'cindy-egress-gateway:local';
    // Central mode never initializes a Docker adapter or exposes local instance routes.
    const service = mode === 'standalone'
        ? new ManagerService(store, new DockerRuntimeAdapter({ image, gatewayImage, socketPath: process.env.CINDY_MANAGER_DOCKER_SOCKET }), image, undefined, gatewayImage || undefined)
        : undefined;
    const hub = mode === 'central' ? new FederationHub(store) : undefined;
    const connector = service ? new FederationConnector({ service, store }) : undefined;
    const app = createManagerServer({ auth, service, mode, hub, connector, origin, webDirectory: join(dirname(fileURLToPath(import.meta.url)), 'web') });
    await new Promise<void>((done, reject) => { app.server.once('error', reject); app.server.listen(port, host, done); });
    connector?.start();
    process.stdout.write(`Cindy host manager (${mode}) listening at ${origin}\n`);
    let closing = false;
    const shutdown = () => { if (closing)
        return; closing = true; void app.close().then(() => store.close()).catch(() => { process.stderr.write('Shutdown failed. Check managed login containers before restarting.\n'); process.exitCode = 1; }); };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
}
void main().catch(error => { process.stderr.write((error instanceof StartupError || error instanceof ApiError ? error.message : 'Manager could not start. Check configuration, private data directory permissions and administrator initialization.') + '\n'); process.exitCode = 1; });
