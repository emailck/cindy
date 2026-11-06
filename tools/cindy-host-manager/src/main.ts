import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { openSync, closeSync, writeFileSync, fstatSync, lstatSync, unlinkSync } from 'node:fs';
import { Store } from './store.js';
import { Auth } from './auth.js';
import { ManagerService } from './service.js';
import { createManagerServer } from './server.js';
import { DockerRuntimeAdapter } from './docker-runtime.js';
class StartupError extends Error {
}
async function main() {
    process.umask(0o077);
    const directory = process.env.CINDY_MANAGER_DATA_DIR ?? join(homedir(), '.local/share/cindy-host-manager');
    const store = new Store(directory);
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
    const auth = new Auth(store);
    const command = process.argv[2] ?? 'serve';
    if (process.argv.length > 3)
        throw new StartupError('Use init or serve; configure deployment with environment variables.');
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
        throw new StartupError('Use init or serve.');
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
    const runtime = new DockerRuntimeAdapter({ image, socketPath: process.env.CINDY_MANAGER_DOCKER_SOCKET });
    const service = new ManagerService(store, runtime, image);
    const app = createManagerServer({ auth, service, origin, webDirectory: join(dirname(fileURLToPath(import.meta.url)), 'web') });
    await new Promise<void>((done, reject) => { app.server.once('error', reject); app.server.listen(port, host, done); });
    process.stdout.write(`Cindy host manager listening at ${origin}\n`);
    let closing = false;
    const shutdown = () => { if (closing)
        return; closing = true; void app.close().then(() => store.close()).catch(() => { process.stderr.write('Shutdown failed. Check managed login containers before restarting.\n'); process.exitCode = 1; }); };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
}
void main().catch(error => { process.stderr.write((error instanceof StartupError ? error.message : 'Manager could not start. Check configuration, private data directory permissions and administrator initialization.') + '\n'); process.exitCode = 1; });
