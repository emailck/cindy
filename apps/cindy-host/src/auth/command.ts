import type { AuthMembership, LoginMethod, VerificationKind } from '@cindy/auth-client';

import type { HostAuthService, HostLoginResult } from './service.js';
import { HostAuthError } from './store.js';

export interface AuthCommandContext {
  service: HostAuthService;
  output(line: string): void;
  /** Interactive trusted terminal input only; never forward answers into logs or an Agent. */
  prompt(question: string): Promise<string>;
  wait?(milliseconds: number): Promise<void>;
  signal?: AbortSignal;
}

function ensureActive(context: AuthCommandContext): void {
  if (context.signal?.aborted) throw new HostAuthError('LOGIN_CANCELLED');
}

async function choose<T>(items: T[], label: (item: T) => string, context: AuthCommandContext): Promise<T> {
  ensureActive(context);
  if (items.length === 0) throw new HostAuthError('LOGIN_METHOD_UNAVAILABLE');
  if (items.length === 1) return items[0]!;
  items.forEach((item, index) => context.output(`${index + 1}. ${label(item)}`));
  const answer = await context.prompt('Select a number: ');
  ensureActive(context);
  const selected = /^\d+$/.test(answer.trim()) ? items[Number(answer.trim()) - 1] : undefined;
  if (!selected) throw new HostAuthError('INVALID_PARAMS');
  return selected;
}

/** All intermediate tickets and verification codes stay in this process, never in argv or config. */
export async function runAuthCommand(args: string[], context: AuthCommandContext): Promise<number> {
  ensureActive(context);
  const { service, output } = context;
  async function prompt(question: string): Promise<string> {
    ensureActive(context);
    const answer = await context.prompt(question);
    ensureActive(context);
    return answer;
  }
  if (args[0] === 'status' && args.length === 1) {
    await service.restore();
    ensureActive(context);
    output(JSON.stringify(service.status()));
    return 0;
  }
  if (args[0] === 'logout' && args.length === 1) {
    // Restore for official remote revocation when possible; local clear must still run on network failure.
    try { await service.restore(); } catch { /* logout below still clears the protected record */ }
    const result = await service.logout();
    output(result.remoteRevoked ? 'Signed out.' : 'Signed out locally; remote revocation was not confirmed.');
    return 0;
  }
  if (args[0] !== 'login') throw new HostAuthError('INVALID_PARAMS');
  if (args.length !== 1 && (args.length !== 3 || !['--email', '--phone', '--org', '--social'].includes(args[1]!))) {
    throw new HostAuthError('INVALID_PARAMS');
  }

  const providers = await service.getProviders();
  ensureActive(context);
  let result: HostLoginResult;
  const wait = (ms: number) => new Promise<void>((resolve, reject) => {
    ensureActive(context);
    const finish = (error?: unknown) => {
      clearTimeout(timer);
      context.signal?.removeEventListener('abort', cancel);
      if (error) reject(error); else resolve();
    };
    const cancel = () => finish(new HostAuthError('LOGIN_CANCELLED'));
    const timer = context.wait ? undefined : setTimeout(() => finish(), ms);
    context.signal?.addEventListener('abort', cancel, { once: true });
    if (context.wait) void Promise.resolve().then(() => context.wait!(ms)).then(() => finish(), finish);
  });
  async function browser(input: { kind: 'social' | 'sso'; providerOrConnectionId: string }): Promise<HostLoginResult> {
    ensureActive(context);
    output('Open this URL in your browser to sign in:');
    const url = await service.startBrowserLogin(input);
    ensureActive(context);
    output(url);
    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline) {
      ensureActive(context);
      const next = await service.pollBrowserLogin();
      ensureActive(context);
      if (next.status !== 'pending') return next;
      await wait(1000);
    }
    throw new HostAuthError('INVALID_AUTH_CODE');
  }
  async function code(kind: VerificationKind, identifier: string): Promise<HostLoginResult> {
    ensureActive(context);
    if (!(kind === 'email' ? providers.email : providers.phone)) throw new HostAuthError('LOGIN_METHOD_UNAVAILABLE');
    if (providers.captcha?.requiredFor.includes(kind === 'email' ? 'email_request_code' : 'phone_request_code')) {
      throw new HostAuthError('CAPTCHA_REQUIRED');
    }
    await service.requestCode(kind, identifier);
    return service.verifyCode(kind, identifier, (await prompt('Verification code: ')).trim());
  }
  if (args[1] === '--social') {
    const provider = args[2]!;
    if (!providers.social.some((available) => available === provider)) throw new HostAuthError('LOGIN_METHOD_UNAVAILABLE');
    result = await browser({ kind: 'social', providerOrConnectionId: provider });
  } else if (args[1] === '--org') {
    const discovery = await service.discoverSsoOrg(args[2]!);
    const connection = await choose(discovery.connections, (item) => `${discovery.orgName}: ${item.connectionName}`, context);
    result = await browser({ kind: 'sso', providerOrConnectionId: connection.connectionId });
  } else if (args[1] === '--phone') {
    result = await code('phone', args[2]!);
  } else {
    const email = args[2] ?? (await prompt('Email: ')).trim();
    const methods = await service.discover(email);
    const method = await choose<LoginMethod>(methods, (item) => item.type === 'email_code' ? 'Email verification code' : `${item.orgName}: ${item.connectionName}`, context);
    result = method.type === 'email_code'
      ? await code('email', email)
      : await browser({ kind: 'sso', providerOrConnectionId: method.connectionId });
  }
  // Official auth can require multiple steps (e.g. binding then account selection).
  while (result.status !== 'ok') {
    ensureActive(context);
    switch (result.status) {
      case 'select_account': {
        const account = await choose<AuthMembership>(result.accounts, (item) => `${item.displayName}${item.orgName ? ` (${item.orgName})` : ''}`, context);
        result = await service.selectAccount(account.id);
        break;
      }
      case 'binding_required': {
        const contact = (await prompt(`${result.bindType === 'email' ? 'Email' : 'Phone'} to bind: `)).trim();
        await service.requestBindingCode(contact);
        result = await service.verifyBinding(contact, (await prompt('Verification code: ')).trim());
        break;
      }
      case 'sso_verification_required': {
        output(`Verify ${result.targetMasked}`);
        await service.requestSsoVerificationCode();
        result = await service.verifySsoVerification((await prompt('Verification code: ')).trim());
        break;
      }
    }
  }
  ensureActive(context);
  output(JSON.stringify(service.status()));
  return 0;
}
