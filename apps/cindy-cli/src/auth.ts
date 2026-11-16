import { Writable } from 'node:stream';
import { createInterface } from 'node:readline/promises';
import { CindyAuthClient } from '@cindy/auth-client';
// Login, refresh and protected storage are the provider host's audited implementation (fork-owned).
import { createHostAuthService, getOrCreateDeviceIdentity, HostAuthError, readStoredAuthStatus, runAuthCommand, type HostAuthService } from '../../cindy-host/src/auth';
import { createHostAuthFetch } from '../../cindy-host/src/auth-fetch';
import { createHostCredentialStore, CredentialStoreUnavailableError } from '../../cindy-host/src/storage';
import type { ProtectedCredentialStore } from '../../cindy-host/src/auth/store';
import { CLI_ENDPOINTS, CLI_REGION, CliError } from './profile';
import { networkFetch } from './proxy';

export type CliAuth = HostAuthService;
export type { ProtectedCredentialStore };

/** Hidden terminal answer (verification codes). Answers never enter argv, logs or the Agent. */
export async function promptHidden(question: string, signal?: AbortSignal, write: (text: string) => void = text => { process.stdout.write(text); }): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new CliError('TERMINAL_REQUIRED', 'error.terminalRequired');
  const muted = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const terminal = createInterface({ input: process.stdin, output: muted, terminal: true });
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  terminal.on('SIGINT', cancel);
  write(question);
  try { return await terminal.question('', { signal: controller.signal }); }
  catch { throw new CliError('COMMAND_CANCELLED', 'error.cancelled'); }
  finally {
    terminal.close(); muted.end();
    signal?.removeEventListener('abort', cancel);
    write('\n');
  }
}

/** Visible single-line answer (confirmations). */
export async function promptVisible(question: string, signal?: AbortSignal): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new CliError('TERMINAL_REQUIRED', 'error.terminalRequired');
  const terminal = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  try { return await terminal.question(question, signal ? { signal } : {}); }
  catch { throw new CliError('COMMAND_CANCELLED', 'error.cancelled'); }
  finally { terminal.close(); }
}

export function credentialStore(dataDir: string): ProtectedCredentialStore {
  // Linux terminals commonly have no Secret Service. Keep credentials in the user's
  // private data directory by default; an explicit backend selection still wins.
  return createHostCredentialStore(dataDir, process.env.CINDY_CLI_CREDENTIAL_STORE ?? (process.platform === 'linux' ? 'file' : 'keyring'));
}

/** Caller holds the profile lock until drain() completes. */
export async function createAuth(dataDir: string, signal?: AbortSignal): Promise<CliAuth> {
  signal?.throwIfAborted();
  const store = credentialStore(dataDir);
  try {
    await store.assertAvailable();
    signal?.throwIfAborted();
    const deviceId = await getOrCreateDeviceIdentity(store);
    const client = new CindyAuthClient({ baseUrl: CLI_ENDPOINTS.authApiBaseUrl, region: CLI_REGION, deviceId, clientType: 'desktop', fetch: createHostAuthFetch(signal, networkFetch()) });
    return createHostAuthService({ store, client, region: CLI_REGION, authApiBaseUrl: CLI_ENDPOINTS.authApiBaseUrl });
  } catch (error) {
    if (error instanceof CredentialStoreUnavailableError || error instanceof HostAuthError || (error as { code?: string })?.code === 'CREDENTIAL_STORE_UNAVAILABLE') throw new CliError('CREDENTIAL_STORE_UNAVAILABLE', 'error.credentialStore');
    throw error;
  }
}

export function authFailure(error: unknown): CliError {
  if (error instanceof CliError) return error;
  if (error instanceof HostAuthError) {
    if (error.code === 'CAPTCHA_REQUIRED') return new CliError('AUTH_FAILED', 'error.captcha');
    if (error.code === 'INVALID_PARAMS') return new CliError('INVALID_ARGUMENT', 'error.loginParams');
    if (error.code === 'CREDENTIAL_STORE_UNAVAILABLE') return new CliError(error.code, 'error.credentialStore');
    if (error.code === 'LOGIN_CANCELLED') return new CliError('COMMAND_CANCELLED', 'error.cancelled');
    // Only fixed protocol codes are shown, never server text (it could carry details).
    if (/^[A-Z][A-Z0-9_]{2,63}$/.test(error.code)) return new CliError(`AUTH_FAILED/${error.code}`, 'error.authFailed');
  }
  // Network/transport failures: the error class name only (e.g. TypeError from fetch), no message.
  if (error instanceof Error && /^[A-Za-z]{1,40}Error$/.test(error.name)) return new CliError(`AUTH_FAILED/${error.name}`, 'error.authFailed');
  return new CliError('AUTH_FAILED', 'error.authFailed');
}

export async function runLogin(args: string[], dataDir: string, signal: AbortSignal, output: (line: string) => void): Promise<number> {
  let auth: CliAuth | undefined;
  try {
    auth = await createAuth(dataDir, signal);
    return await runAuthCommand(args, { service: auth, output, prompt: question => promptHidden(question, signal), signal });
  } catch (error) {
    // Ctrl+C / SIGTERM aborts the request in flight; report a cancellation, not a sign-in or network failure.
    if (signal.aborted) throw new CliError('COMMAND_CANCELLED', 'error.cancelled');
    throw authFailure(error);
  }
  finally { await auth?.drain(); }
}

/** Read-only: never rotates a refresh token or creates a device identity. */
export async function readSavedLogin(dataDir: string): Promise<Record<string, unknown>> {
  try { return { ...(await readStoredAuthStatus(credentialStore(dataDir), CLI_REGION)) }; }
  catch { return { credentials: 'unavailable', account: null }; }
}
