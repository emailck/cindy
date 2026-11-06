import { runShareControl } from './share-control';
import { parseArgs } from 'node:util';
import { HostCliError, HOST_ENDPOINTS, HOST_REGION, readConfig, resolveDataDirectory, updateConfig, type HostConfig } from './config';
import { serveHost, withProfileLock, type HostLifecycle, type SignalSource } from './lifecycle';
import metadata from '../package.json';

export interface HostCommandContext {
  dataDir: string;
  region: typeof HOST_REGION;
  endpoints: typeof HOST_ENDPOINTS;
  config: HostConfig;
  /** Cancellation also covers protected storage initialization and interactive login. */
  signal?: AbortSignal;
  output(text: string): void;
  error(text: string): void;
}
export interface Diagnostic { name: string; ok: boolean; message: string }
export interface CliDependencies {
  output?: (text: string) => void;
  error?: (text: string) => void;
  env?: NodeJS.ProcessEnv;
  signals?: SignalSource;
  createHost?: (context: HostCommandContext) => HostLifecycle | Promise<HostLifecycle>;
  /** Adapter owns interactive secret input. Never accept passwords/tokens as CLI arguments. */
  authCommand?: (args: string[], context: HostCommandContext) => Promise<number>;
  /** Must return only explicitly safe fields; never return auth service/store objects. */
  status?: (context: HostCommandContext) => Promise<Record<string, unknown>>;
  /** Explicit credential rotation; caller holds profile.lock until this adapter drains auth work. */
  refreshAccount?: (context: HostCommandContext) => Promise<void>;
  doctor?: (context: HostCommandContext) => Promise<Diagnostic[]>;
}

const HELP = `Cindy host — Node remote Agent provider

Usage: cindy-host [--data-dir ABSOLUTE_PATH] <command>

Commands:
  help, --help                       Show this help
  version, --version                 Show version
  status [--refresh-account]         Show status; optionally refresh saved account details
  doctor                             Check host readiness
  config show                        Show effective configuration and overrides
  config set <key> <value>           Save a nonsecret override
  config reset <key>                 Remove an override
  login [options]                    Official Cindy authentication
  logout                            Sign out and revoke stored authentication
  serve                             Run the authenticated provider in foreground
  share usage [on|off]             Inspect or change guest usage-history visibility
  share quota [on|off]             Inspect subscription quota or allow guests to view it
  share link|list                   Manage shares through the running host
  share approve REQUEST_ID CODE     Approve after checking identity and pairing code
  share reject REQUEST_ID           Reject a pending request
  share pause|resume|remove MEMBER  Change an existing share

Configuration keys: remoteAccessEnabled (true|false), permissionMode (full-access), deviceName,
idleMinutes (0–1440; default 30; 0 disables idle reclamation).
Data directory: --data-dir or CINDY_HOST_DATA_DIR; required outside Git workspaces.
The build connects to Cindy services; tokens and passwords are never configuration values.
Full access is the fallback when desktop permissions are omitted; explicit desktop permissions win.
Peer and account authorization always apply.`;

/** Composable command entry. Importing this module does not start a host or touch disk. */
export async function runCli(argv: string[], dependencies: CliDependencies = {}): Promise<number> {
  const output = dependencies.output ?? (text => { process.stdout.write(`${text}\n`); });
  const error = dependencies.error ?? (text => { process.stderr.write(`${text}\n`); });
  try {
    // Extract only global options. Authentication adapter validates its own nonsecret arguments.
    let dataDirectory: string | undefined;
    const args: string[] = [];
    for (let index = 0; index < argv.length; index++) {
      const value = argv[index];
      if (value === '--data-dir' || value.startsWith('--data-dir=')) {
        if (dataDirectory !== undefined) throw new HostCliError('INVALID_ARGUMENT', 'Specify --data-dir only once.');
        dataDirectory = value === '--data-dir' ? argv[++index] : value.slice('--data-dir='.length);
        if (!dataDirectory || dataDirectory.startsWith('--')) throw new HostCliError('INVALID_ARGUMENT', '--data-dir requires a path.');
      } else args.push(value);
    }
    const command = args.shift() ?? 'help';
    if (command === 'help' || command === '--help' || command === '-h') {
      if (args.length) throw new HostCliError('INVALID_ARGUMENT', 'help accepts no arguments.');
      output(HELP); return 0;
    }
    if (command === 'version' || command === '--version' || command === '-v') {
      if (args.length) throw new HostCliError('INVALID_ARGUMENT', 'version accepts no arguments.');
      output(metadata.version); return 0;
    }
    if (!['status', 'doctor', 'config', 'login', 'logout', 'serve', 'share'].includes(command)) throw new HostCliError('INVALID_ARGUMENT', 'Unknown command. Run cindy-host help.');
    const dataDir = await resolveDataDirectory(dataDirectory ?? (dependencies.env ?? process.env).CINDY_HOST_DATA_DIR);
    const context: HostCommandContext = { dataDir, region: HOST_REGION, endpoints: HOST_ENDPOINTS, config: (await readConfig(dataDir)).effective, output, error };
    if (command === 'share') { output(JSON.stringify(await runShareControl(dataDir, args), null, 2)); return 0; }
    if (command === 'login' || command === 'logout') {
      if (!dependencies.authCommand) throw new HostCliError('AUTH_UNAVAILABLE', 'No protected authentication adapter is installed in this build.');
      return await withProfileLock(dataDir, signal => { context.signal = signal; return dependencies.authCommand!([command, ...args], context); }, { signals: dependencies.signals });
    }
    // Strictly reject stray flags/arguments for commands without their own schema.
    const parsed = command !== 'config' ? parseArgs({ args, options: command === 'status' ? { 'refresh-account': { type: 'boolean' } } : {}, allowPositionals: false, strict: true }) : undefined;
    if (command === 'config') {
      const action = args.shift() ?? 'show';
      if (action === 'show' && args.length === 0) {
        output(JSON.stringify(await readConfig(dataDir), null, 2)); return 0;
      }
      if ((action === 'set' && args.length === 2) || (action === 'reset' && args.length === 1)) {
        await withProfileLock(dataDir, () => updateConfig(dataDir, args[0], action === 'set' ? args[1] : undefined), { signals: dependencies.signals });
        output('Configuration saved. Restart serve to apply the change.'); return 0;
      }
      throw new HostCliError('INVALID_ARGUMENT', 'Use config show, config set <key> <value>, or config reset <key>.');
    }
    if (command === 'status') {
      if (parsed?.values['refresh-account']) {
        if (!dependencies.refreshAccount) throw new HostCliError('AUTH_UNAVAILABLE', 'No account refresh adapter is installed in this build.');
        await withProfileLock(dataDir, signal => { context.signal = signal; return dependencies.refreshAccount!(context); }, { signals: dependencies.signals });
      }
      const runtime = dependencies.status ? await dependencies.status(context) : { state: 'unavailable', message: 'No runtime status adapter installed.' };
      output(JSON.stringify({ region: context.region, dataDir, remoteAccessEnabled: context.config.remoteAccessEnabled, permissionMode: context.config.permissionMode, runtime }, null, 2));
      return 0;
    }
    if (command === 'doctor') {
      const checks: Diagnostic[] = [
        { name: 'node', ok: Number(process.versions.node.split('.')[0]) > 22 || (Number(process.versions.node.split('.')[0]) === 22 && Number(process.versions.node.split('.')[1]) >= 19), message: `Node ${process.versions.node}; Node 22.19 or newer is required.` },
        { name: 'data-directory', ok: true, message: 'Explicit data directory is outside Git workspaces.' },
        { name: 'remote-access', ok: context.config.remoteAccessEnabled, message: context.config.remoteAccessEnabled ? 'Remote access enabled.' : 'Enable with config set remoteAccessEnabled true.' },
        { name: 'runtime', ok: Boolean(dependencies.createHost), message: dependencies.createHost ? 'Runtime adapter installed; service connectivity is checked at startup.' : 'No runtime adapter installed.' },
        ...(dependencies.doctor ? await dependencies.doctor(context) : [{ name: 'credentials', ok: false, message: 'No protected credential diagnostics adapter installed.' }]),
      ];
      output(JSON.stringify({ checks }, null, 2)); return checks.every(check => check.ok) ? 0 : 1;
    }
    if (!dependencies.createHost) throw new HostCliError('RUNTIME_UNAVAILABLE', 'Remote provider runtime is not installed in this build; serve cannot start.');
    if (!context.config.remoteAccessEnabled) throw new HostCliError('REMOTE_ACCESS_DISABLED', 'Remote access is disabled. Enable it with config set remoteAccessEnabled true.');
    return await withProfileLock(dataDir, async signal => {
      context.signal = signal;
      context.config = (await readConfig(dataDir)).effective;
      if (!context.config.remoteAccessEnabled) throw new HostCliError('REMOTE_ACCESS_DISABLED', 'Remote access is disabled. Enable it with config set remoteAccessEnabled true.');
      await serveHost(async () => dependencies.createHost!(context), { signals: dependencies.signals, ready: () => output('Cindy host is ready. Press Ctrl+C to stop.') });
      return 0;
    }, { signals: dependencies.signals });
  } catch (cause) {
    // Never echo upstream responses, arbitrary exception messages, or command arguments containing secrets.
    if (cause instanceof HostCliError) { error(`${cause.code}: ${cause.message}`); return 1; }
    if (cause && typeof cause === 'object' && typeof (cause as { code?: unknown }).code === 'string'
      && (cause as { code: string }).code.startsWith('ERR_PARSE_ARGS')) { error('INVALID_ARGUMENT: Unexpected argument. Run cindy-host help.'); return 1; }
    error('HOST_FAILED: Command failed. Check protected authentication, local data access, and runtime configuration.');
    return 1;
  }
}

