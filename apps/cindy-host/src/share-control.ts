import { createConnection, createServer } from 'node:net';
import { chmod, lstat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { HostCliError } from './config';

export type ShareCommand = { action: 'link' | 'list' | 'approve' | 'reject' | 'pause' | 'resume' | 'remove'; id?: string; code?: string };
export function parseShareCommand(args: string[]): ShareCommand {
  const [action = 'list', id, code] = args;
  if ((action === 'link' || action === 'list') && args.length <= 1) return { action };
  if (action === 'approve' && args.length === 3 && id && /^\d{4}$/.test(code)) return { action, id, code };
  if (['reject', 'pause', 'resume', 'remove'].includes(action) && args.length === 2 && id) return { action: action as ShareCommand['action'], id };
  throw new HostCliError('INVALID_ARGUMENT', 'Use share link|list, share approve REQUEST_ID PAIRING_CODE, or share reject|pause|resume|remove ID.');
}
const socketPath = (dataDir: string) => path.join(dataDir, 'share-control.sock');

/** Local management stays inside the profile owner's container/user boundary. */
export async function startShareControl(dataDir: string, execute: (command: ShareCommand) => Promise<unknown>) {
  if (process.platform === 'win32') throw new HostCliError('UNSUPPORTED_PLATFORM', 'Local share management currently requires a POSIX host.');
  const directory = await lstat(dataDir);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid!() || (directory.mode & 0o077) !== 0) throw new Error('Private profile directory required');
  const file = socketPath(dataDir);
  try {
    const existing = await lstat(file);
    if (!existing.isSocket() || existing.uid !== process.getuid!()) throw new Error('Unexpected management socket');
    // Called only while the host owns the exclusive profile lock.
    await unlink(file);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const connections = new Set<import('node:net').Socket>();
  const server = createServer(socket => {
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
    socket.on('error', () => {});
    socket.setTimeout(20000, () => socket.destroy());
    let input = ''; let handled = false;
    socket.on('data', chunk => {
      if (handled) return;
      input += chunk.toString();
      if (input.length > 4096) { socket.destroy(); return; }
      if (!input.includes('\n')) return;
      handled = true;
      void (async () => {
        const args: unknown = JSON.parse(input.slice(0, input.indexOf('\n')));
        if (!Array.isArray(args) || !args.every(arg => typeof arg === 'string')) throw new Error('Invalid command');
        const result = await execute(parseShareCommand(args));
        socket.end(JSON.stringify({ ok: true, result }) + '\n');
      })().catch(error => socket.end(JSON.stringify({ ok: false, ...(error instanceof HostCliError ? { code: error.code, message: error.message } : {}) }) + '\n'));
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(file, resolve); });
  await chmod(file, 0o600);
  return async () => {
    for (const socket of connections) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  };
}

export async function runShareControl(dataDir: string, args: string[]): Promise<unknown> {
  parseShareCommand(args);
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath(dataDir));
    let input = '';
    const fail = () => { socket.destroy(); reject(new HostCliError('SHARE_CONTROL_FAILED', 'Share command failed. Check that serve is running and the request/member identifiers and pairing code are correct.')); };
    socket.setTimeout(20000, fail);
    socket.on('error', fail);
    socket.on('connect', () => socket.write(JSON.stringify(args) + '\n'));
    socket.on('data', chunk => {
      input += chunk.toString();
      if (input.length > 1024 * 1024) { fail(); return; }
      if (!input.includes('\n')) return;
      try {
        const response = JSON.parse(input.slice(0, input.indexOf('\n')));
        if (response.ok !== true) {
          if (['SHARE_PROVIDER_UNSUPPORTED', 'INVALID_ARGUMENT'].includes(response.code) && typeof response.message === 'string') { socket.destroy(); reject(new HostCliError(response.code, response.message)); return; }
          fail(); return;
        }
        socket.destroy(); resolve(response.result);
      } catch { fail(); }
    });
    socket.on('end', () => { if (!input.includes('\n')) fail(); });
  });
}
