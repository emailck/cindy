/**
 * What the input box needs from this computer: project paths for `@` completion, `!command` execution, a file's
 * text and kind, and an image from the clipboard. Nothing here leaves the computer by itself; `!command` output
 * and `@` mentions go to the Agent only with a message the user sends.
 */
import { spawn } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { findWindowsGitBash } from '../../../desktop/src/main/remote-agent/executor/shell';
import type { ImageAttachment, LocalResult, PathKind } from './controller';

/** Paths offered for `@` completion; large trees are cut here. */
const MAX_FILES = 30_000;
/** Files read for diff line numbers. */
const MAX_TEXT_BYTES = 2_000_000;
/** Output kept from a `!command` (the controller keeps less for the message). */
const MAX_OUTPUT = 200_000;

export function readText(file: string): string | null {
  try {
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > MAX_TEXT_BYTES) return null;
    return readFileSync(file, 'utf8');
  } catch { return null; }
}

export function statPath(absolute: string): PathKind {
  try {
    const stat = statSync(absolute);
    return stat.isDirectory() ? 'dir' : stat.isFile() ? 'file' : null;
  } catch { return null; }
}

/** stdout lines of a command, or null when it cannot run or fails. */
function lines(command: string, args: string[], cwd: string, timeoutMs = 10_000): Promise<string[] | null> {
  return new Promise(resolve => {
    let child;
    try { child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }); }
    catch { resolve(null); return; }
    const out: string[] = [];
    let rest = '';
    let count = 0;
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      const parts = (rest + chunk).split('\n');
      rest = parts.pop() ?? '';
      for (const part of parts) if (part && count++ < MAX_FILES) out.push(part.replace(/\r$/, ''));
      if (count >= MAX_FILES) child.kill();
    });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', code => {
      clearTimeout(timer);
      if (rest && count < MAX_FILES) out.push(rest);
      resolve(code === 0 || count >= MAX_FILES ? out : null);
    });
  });
}

async function walk(root: string): Promise<string[]> {
  const out: string[] = [];
  const visit = async (dir: string, depth: number) => {
    if (depth > 8 || out.length >= MAX_FILES) return;
    let entries;
    try { entries = await readdir(path.join(root, dir), { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (out.length >= MAX_FILES) return;
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(rel, depth + 1);
      else out.push(rel);
    }
  };
  await visit('', 0);
  return out;
}

/**
 * Project files for `@` completion, honoring .gitignore: ripgrep, then git, then a bounded walk without
 * node_modules. Folders are derived from the files and end with /.
 */
export async function listProjectFiles(cwd: string, rgPath = 'rg'): Promise<string[]> {
  const files = await lines(rgPath, ['--files', '--hidden', '--glob', '!.git/'], cwd)
    ?? await lines('git', ['ls-files', '-co', '--exclude-standard'], cwd)
    ?? await walk(cwd);
  const normalized = files.map(file => file.replace(/\\/g, '/').replace(/^\.\//, ''));
  const dirs = new Set<string>();
  for (const file of normalized) {
    let at = file.lastIndexOf('/');
    while (at > 0) { const dir = file.slice(0, at + 1); if (dirs.has(dir)) break; dirs.add(dir); at = file.lastIndexOf('/', at - 1); }
  }
  return [...[...dirs].sort(), ...normalized.sort()];
}

const ANSI = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001B]*(?:\u0007|\u001B\\)|[@-Z\\-_])/g;

/**
 * Runs a `!command` with the user's shell in `cwd` (Git Bash on Windows when present, as the Agent's commands do;
 * otherwise cmd). stdout and stderr are kept together, without color codes. Abort stops the command and what it
 * started.
 */
export function runLocalCommand(command: string, cwd: string, signal: AbortSignal, env: NodeJS.ProcessEnv = process.env): Promise<LocalResult> {
  return new Promise(resolve => {
    const windows = process.platform === 'win32';
    const bash = windows ? findWindowsGitBash(env) : null;
    const [file, args, extra] = windows
      ? bash ? [bash, ['-c', command], {}] : ['cmd.exe', ['/d', '/s', '/c', command], { windowsVerbatimArguments: true }]
      : [env.SHELL || '/bin/sh', ['-c', command], { detached: true }];
    let output = '';
    let child;
    try {
      child = spawn(file, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...extra });
    } catch (error) {
      resolve({ output: error instanceof Error ? error.message : String(error), exitCode: null });
      return;
    }
    const keep = (chunk: Buffer) => { if (output.length < MAX_OUTPUT) output += chunk.toString('utf8'); };
    child.stdout!.on('data', keep);
    child.stderr!.on('data', keep);
    let stopped = false;
    const stop = () => {
      stopped = true;
      try {
        // POSIX: the shell leads its own process group, so the whole pipeline stops.
        if (!windows && child.pid) process.kill(-child.pid, 'SIGTERM');
        else child.kill();
      } catch { child.kill(); }
    };
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
    child.on('error', error => { output += error.message; });
    child.on('close', code => {
      signal.removeEventListener('abort', stop);
      resolve({ output: output.replace(ANSI, '').replace(/\r\n?/g, '\n'), exitCode: stopped ? null : code });
    });
  });
}

/** Runs a helper and returns its stdout bytes; rejects with a readable reason when it is not installed. */
function run(file: string, args: string[], input?: string): Promise<{ code: number | null; stdout: Buffer }> {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(file, args, { stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'], windowsHide: true }); }
    catch (error) { reject(error); return; }
    const chunks: Buffer[] = [];
    child.stdout!.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', (error: NodeJS.ErrnoException) => reject(error.code === 'ENOENT' ? new Error(`${file} not found`) : error));
    child.on('close', code => resolve({ code, stdout: Buffer.concat(chunks) }));
    if (input !== undefined) child.stdin!.end(input);
  });
}

/**
 * Saves the clipboard's image as a PNG in `dir`. macOS uses osascript, Windows PowerShell, Linux wl-paste
 * (Wayland) or xclip (X11). Null when the clipboard holds no image.
 */
export async function readClipboardImage(dir: string, name: string): Promise<ImageAttachment | null> {
  const file = path.join(dir, `${name}.png`);
  if (process.platform === 'darwin') {
    const script = [
      'try', '  set png to (the clipboard as «class PNGf»)', 'on error', '  return "none"', 'end try',
      `set fh to open for access (POSIX file ${JSON.stringify(file)}) with write permission`,
      'set eof fh to 0', 'write png to fh', 'close access fh', 'return "ok"',
    ].join('\n');
    const { stdout } = await run('osascript', ['-'], script);
    return stdout.toString().trim() === 'ok' ? { path: file, mimeType: 'image/png' } : null;
  }
  if (process.platform === 'win32') {
    const quoted = file.replace(/'/g, "''");
    const command = 'Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; '
      + '$i = [System.Windows.Forms.Clipboard]::GetImage(); '
      + `if ($i) { $i.Save('${quoted}', [System.Drawing.Imaging.ImageFormat]::Png); 'ok' } else { 'none' }`;
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', command]);
    return stdout.toString().trim() === 'ok' ? { path: file, mimeType: 'image/png' } : null;
  }
  const wayland = !!process.env.WAYLAND_DISPLAY;
  if (!wayland && !process.env.DISPLAY) return null;
  const types = wayland ? await run('wl-paste', ['--list-types']) : await run('xclip', ['-selection', 'clipboard', '-t', 'TARGETS', '-o']);
  if (!types.stdout.toString().split('\n').some(type => type.trim() === 'image/png')) return null;
  const image = wayland ? await run('wl-paste', ['--type', 'image/png']) : await run('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o']);
  if (image.code !== 0 || !image.stdout.length) return null;
  await writeFile(file, image.stdout, { mode: 0o600 });
  return { path: file, mimeType: 'image/png' };
}
