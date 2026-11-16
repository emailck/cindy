import metadata from '../package.json';
import { createTranslator, detectLanguage, isLanguage, type Language, type Translate } from './i18n';
import {
  CliError, CONFIG_KEYS, defaultDataDirectory, isPermissionChoice, parseConfigValue, readConfig, resolveDataDirectory,
  withProfileLock, writeConfig, type CliConfig, type PermissionChoice, type SignalSource,
} from './profile';

export interface CommandContext {
  dataDir: string;
  config: CliConfig;
  language: Language;
  t: Translate;
  output(text: string): void;
  error(text: string): void;
  /** Per-run overrides from flags; never persisted implicitly. */
  overrides: { model?: string; permissionMode?: PermissionChoice; language?: Language; /** -c: continue the latest session in this directory. */ continue?: boolean };
}

export interface ChatRequest { /** Present for -p; absent for the interactive UI. */ prompt?: string }

export interface CliDependencies {
  output?: (text: string) => void;
  error?: (text: string) => void;
  env?: NodeJS.ProcessEnv;
  signals?: SignalSource;
  /** Interactive / print mode. Runs while holding the profile lock. */
  chat?: (request: ChatRequest, context: CommandContext, signal: AbortSignal) => Promise<number>;
  login?: (args: string[], context: CommandContext, signal: AbortSignal) => Promise<number>;
  status?: (context: CommandContext) => Promise<Record<string, unknown>>;
  received?: (args: string[], context: CommandContext, signal: AbortSignal) => Promise<number>;
  /** Lists remote models visible to this account (same-account computers and shares). */
  models?: (context: CommandContext, signal: AbortSignal) => Promise<number>;
  /** Runs before networked commands (proxy validation); throw CliError to stop. */
  beforeCommand?: () => void;
}

const VALUE_OPTIONS = new Set(['--data-dir', '--lang', '--model', '--permission-mode', '-p', '--print']);
const FLAG_OPTIONS = new Set(['-c', '--continue']);

interface ParsedArgs { options: Map<string, string>; flags: Set<string>; positionals: string[] }

/** Global options may appear anywhere; login keeps its own nonsecret options as positionals. */
function parseArgs(argv: readonly string[]): ParsedArgs {
  const options = new Map<string, string>();
  const positionals: string[] = [];
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index++) {
    const raw = argv[index]!;
    const eq = raw.startsWith('--') ? raw.indexOf('=') : -1;
    const name = eq > 0 ? raw.slice(0, eq) : raw;
    if (FLAG_OPTIONS.has(raw)) {
      const key = raw === '-c' ? '--continue' : raw;
      if (flags.has(key)) throw new CliError('INVALID_ARGUMENT', 'error.duplicateOption', { option: raw });
      flags.add(key); continue;
    }
    if (!VALUE_OPTIONS.has(name)) { positionals.push(raw); continue; }
    const value = eq > 0 ? raw.slice(eq + 1) : argv[++index];
    if (value === undefined || (value.startsWith('-') && name !== '-p' && name !== '--print')) throw new CliError('INVALID_ARGUMENT', 'error.missingValue', { option: name });
    const key = name === '-p' ? '--print' : name;
    if (options.has(key)) throw new CliError('INVALID_ARGUMENT', 'error.duplicateOption', { option: name });
    options.set(key, value);
  }
  return { options, flags, positionals };
}

/** Composable entry; importing this module touches no disk and starts nothing. */
export async function runCli(argv: readonly string[], dependencies: CliDependencies = {}): Promise<number> {
  const env = dependencies.env ?? process.env;
  const output = dependencies.output ?? (text => { process.stdout.write(`${text}\n`); });
  const error = dependencies.error ?? (text => { process.stderr.write(`${text}\n`); });
  let t = createTranslator(detectLanguage(env));
  try {
    const { options, flags, positionals } = parseArgs(argv);
    const langFlag = options.get('--lang');
    if (langFlag !== undefined && !isLanguage(langFlag)) throw new CliError('INVALID_ARGUMENT', 'error.unexpectedArgument');
    if (langFlag) t = createTranslator(langFlag);
    const permissionFlag = options.get('--permission-mode');
    if (permissionFlag !== undefined && !isPermissionChoice(permissionFlag)) throw new CliError('INVALID_ARGUMENT', 'error.unexpectedArgument');
    const prompt = options.get('--print');
    const command = prompt !== undefined ? 'print' : positionals.shift() ?? 'chat';

    if (command === 'help' || command === '--help' || command === '-h') { output(t('help.text')); return 0; }
    if (command === 'version' || command === '--version' || command === '-v') { output(metadata.version); return 0; }
    if (!['chat', 'print', 'login', 'logout', 'status', 'received', 'config', 'models'].includes(command)) throw new CliError('INVALID_ARGUMENT', 'error.unknownCommand');
    if (command === 'print' && positionals.length > 0) throw new CliError('INVALID_ARGUMENT', 'error.unexpectedArgument');
    if (command !== 'chat' && command !== 'print' && (options.has('--model') || permissionFlag || flags.size)) throw new CliError('INVALID_ARGUMENT', 'error.unexpectedArgument');

    const dataDir = await resolveDataDirectory(options.get('--data-dir') ?? defaultDataDirectory(env));
    const config = (await readConfig(dataDir)).effective;
    const language: Language = (langFlag as Language | undefined) ?? config.language ?? detectLanguage(env);
    t = createTranslator(language);
    const context: CommandContext = {
      dataDir, config, language, t, output, error,
      overrides: { model: options.get('--model'), permissionMode: permissionFlag as PermissionChoice | undefined, language: langFlag as Language | undefined, ...(flags.has('--continue') ? { continue: true } : {}) },
    };
    if (['chat', 'print', 'login', 'logout', 'received', 'models'].includes(command)) dependencies.beforeCommand?.();
    const locked = <T>(action: (signal: AbortSignal) => Promise<T>) =>
      withProfileLock(dataDir, action, { ...(dependencies.signals ? { signals: dependencies.signals } : {}) });

    switch (command) {
      case 'config': {
        const action = positionals.shift() ?? 'show';
        if (action === 'show' && positionals.length === 0) {
          output(JSON.stringify({ dataDir, ...config }, null, 2)); return 0;
        }
        if (action === 'set' && positionals.length === 2) {
          const patch = parseConfigValue(positionals[0]!, positionals[1]!);
          await writeConfig(dataDir, current => ({ ...current, ...patch }));
          output(t('config.saved')); return 0;
        }
        if (action === 'reset' && positionals.length === 1) {
          const key = positionals[0]!;
          if (!(CONFIG_KEYS as readonly string[]).includes(key)) throw new CliError('INVALID_CONFIG', 'error.configKey');
          await writeConfig(dataDir, current => { const next = { ...current }; delete next[key as keyof typeof next]; return next; });
          output(t('config.saved')); return 0;
        }
        throw new CliError('INVALID_ARGUMENT', 'error.unexpectedArgument');
      }
      case 'status': {
        if (positionals.length) throw new CliError('INVALID_ARGUMENT', 'error.unexpectedArgument');
        const runtime = dependencies.status ? await dependencies.status(context) : {};
        output(JSON.stringify({ title: t('status.title'), version: metadata.version, dataDir, language, permissionMode: config.permissionMode, ...runtime }, null, 2));
        return 0;
      }
      case 'login':
      case 'logout': {
        if (command === 'logout' && positionals.length) throw new CliError('INVALID_ARGUMENT', 'error.unexpectedArgument');
        if (!dependencies.login) throw new CliError('NOT_IMPLEMENTED', 'error.notImplemented');
        return await locked(signal => dependencies.login!([command, ...positionals], context, signal));
      }
      case 'models': {
        if (positionals.length) throw new CliError('INVALID_ARGUMENT', 'error.unexpectedArgument');
        if (!dependencies.models) throw new CliError('NOT_IMPLEMENTED', 'error.notImplemented');
        return await locked(signal => dependencies.models!(context, signal));
      }
      case 'received': {
        if (!dependencies.received) throw new CliError('NOT_IMPLEMENTED', 'error.notImplemented');
        return await locked(signal => dependencies.received!(positionals, context, signal));
      }
      default: {
        if (positionals.length) throw new CliError('INVALID_ARGUMENT', 'error.unknownCommand');
        if (!dependencies.chat) throw new CliError('NOT_IMPLEMENTED', 'error.notImplemented');
        // Once the interactive UI owns the terminal, Ctrl+C is a key there (interrupt turn, then exit), not SIGINT.
        return await locked(signal => dependencies.chat!({ prompt }, context, signal));
      }
    }
  } catch (cause) {
    // Never echo upstream responses or arbitrary exception text (may carry secrets).
    if (cause instanceof CliError) { error(`${cause.code}: ${t(cause.messageKey, cause.vars)}`); return 1; }
    error(`CLI_FAILED: ${t('error.failed')}`);
    return 1;
  }
}
