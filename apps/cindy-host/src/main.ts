import { Writable } from 'node:stream';
import { createInterface } from 'node:readline/promises';
import { CindyAuthClient } from '@cindy/auth-client';
import { createHostAuthService, getOrCreateDeviceIdentity, HostAuthError, runAuthCommand } from './auth';
import { runCli, type HostCommandContext, type Diagnostic } from './cli';
import { HostCliError } from './config';
import { createCliHost } from './runtime';
import { quietRuntimeLogger } from './runtime/claude';
import { createProvider } from './runtime/provider';
import { createHostCredentialStore, CredentialStoreUnavailableError } from './storage';
import { createHostAuthFetch } from './auth-fetch';

/** Terminal answers are hidden, including verification codes. No answer enters argv or logs. */
async function prompt(question: string, signal?: AbortSignal): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new HostCliError('TERMINAL_REQUIRED', 'Interactive login requires a trusted terminal.');
  const muted = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const terminal = createInterface({ input: process.stdin, output: muted, terminal: true });
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  terminal.on('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  process.stdout.write(question);
  try { return await terminal.question('', { signal: controller.signal }); }
  finally {
    terminal.close(); muted.end(); process.removeListener('SIGTERM', cancel);
    signal?.removeEventListener('abort', cancel);
    process.stdout.write('\n');
  }
}

async function authService(context: HostCommandContext) {
  context.signal?.throwIfAborted();
  const store = createHostCredentialStore(context.dataDir);
  try {
    await store.assertAvailable();
    context.signal?.throwIfAborted();
    const deviceId = await getOrCreateDeviceIdentity(store);
    context.signal?.throwIfAborted();
    const client = new CindyAuthClient({ baseUrl: context.endpoints.authApiBaseUrl, region: context.region,
      deviceId, clientType: 'desktop',
      fetch: createHostAuthFetch(context.signal),
    });
    return createHostAuthService({ store, client, region: context.region, authApiBaseUrl: context.endpoints.authApiBaseUrl });
  } catch (error) {
    if (error instanceof CredentialStoreUnavailableError) throw new HostCliError(error.code, error.message);
    if (error instanceof HostAuthError) throw new HostCliError('CREDENTIAL_STORE_UNAVAILABLE', 'Protected authentication storage could not be initialized. Run doctor to check its setup.');
    throw error;
  }
}

function authFailure(error: unknown): never {
  const message = error instanceof HostAuthError && error.code === 'CAPTCHA_REQUIRED'
    ? 'This login method requires CAPTCHA. Use an available browser sign-in method; CAPTCHA is not bypassed.'
    : error instanceof HostAuthError && error.code === 'INVALID_PARAMS'
      ? 'Use login [--email EMAIL | --phone PHONE | --org ORGANIZATION | --social PROVIDER], or logout. Verification codes are entered interactively.'
      : error instanceof HostAuthError && error.code === 'CREDENTIAL_STORE_UNAVAILABLE'
        ? 'Protected authentication storage is unavailable. Run doctor to check its setup.'
        : 'Authentication could not be completed. Check the selected sign-in method, verification code, account availability and service connectivity.';
  if (error instanceof HostCliError) throw error;
  throw new HostCliError('AUTH_FAILED', message);
}

void runCli(process.argv.slice(2), {
  async authCommand(args, context) {
    let auth: Awaited<ReturnType<typeof authService>> | undefined;
    try {
      auth = await authService(context);
      return await runAuthCommand(args, { service: auth, output: context.output, prompt: question => prompt(question, context.signal), signal: context.signal });
    }
    catch (error) { return authFailure(error); }
    finally { await auth?.drain(); }
  },
  async createHost(context) {
    const auth = await authService(context);
    try {
      if (!await auth.restore()) throw new HostCliError('AUTH_REQUIRED', 'Sign in with cindy-host login before starting serve.');
      context.signal?.throwIfAborted();
      const host = await createCliHost(context, { auth });
      return {
        ...host,
        async stop() {
          // Stop consumers first, then persist any authoritative rotation result.
          // The caller holds profile.lock throughout this drain.
          try { await host.stop(); }
          finally { await auth.drain(); }
        },
      };
    } catch (error) {
      await auth.drain();
      if (error instanceof HostCliError) throw error;
      if (error instanceof HostAuthError) return authFailure(error);
      throw new HostCliError('RUNTIME_START_FAILED', 'Provider startup failed. Run doctor; configure the selected Agent executable and authenticate it before starting serve.');
    }
  },
  async status(context) {
    // A status read must never rotate a refresh token or initialize a device identity
    // while another process owns this profile. Stored authentication is not a live login check.
    const store = createHostCredentialStore(context.dataDir);
    try {
      const savedAuthentication = await store.get(`auth-session.v1.${context.region}`) !== null;
      return { state: 'not-probed', savedAuthentication, message: 'Stored authentication presence only; relay connectivity and login validity are verified by serve.' };
    } catch { return { state: 'not-probed', credentials: 'unavailable', message: 'Run doctor to check protected storage.' }; }
  },
  async doctor(context) {
    const checks: Diagnostic[] = [];
    try {
      const store = createHostCredentialStore(context.dataDir);
      await store.assertAvailable();
      checks.push({ name: 'credentials', ok: true, message: 'Selected credential store is available.' });
      const savedAuthentication = await store.get(`auth-session.v1.${context.region}`) !== null;
      checks.push({ name: 'cindy-login', ok: savedAuthentication, message: savedAuthentication ? 'Stored Cindy login exists; validity is checked at startup.' : 'Sign in using cindy-host login before starting serve.' });
    } catch (error) {
      checks.push({ name: 'credentials', ok: false, message: error instanceof CredentialStoreUnavailableError ? error.message : 'Selected credential store is unavailable.' });
    }
    try {
      const provider = await createProvider(context.dataDir, quietRuntimeLogger());
      await provider.dispose();
      checks.push({ name: 'agent', ok: true, message: 'Selected Agent executable and authentication checked. Model execution and relay connectivity require serve.' });
    } catch {
      checks.push({ name: 'agent', ok: false, message: 'For Codex set CINDY_HOST_AGENT=codex and CINDY_HOST_CODEX_BINARY, then sign in with that binary. For Claude set CINDY_HOST_CLAUDE_BINARY and CINDY_HOST_CLAUDE_AUTH=native or api-key.' });
    }
    return checks;
  },
}).then(code => { process.exitCode = code; });
