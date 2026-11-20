import type { MessageKey, Translate } from '../i18n';

/** Canonical slash commands. Aliases, help, completion and dispatch all use these descriptors. */
export const COMMAND_REGISTRY = [
  { name: 'trust', aliases: [], descriptionKey: 'cmd.trust', parameterHint: '[on|off]', availability: 'any', action: 'trust' },
  { name: 'help', aliases: [], descriptionKey: 'cmd.help', parameterHint: '', availability: 'any', action: 'help' },
  { name: 'model', aliases: [], descriptionKey: 'cmd.model', parameterHint: '[model]', availability: 'idle', action: 'model' },
  { name: 'effort', aliases: [], descriptionKey: 'cmd.effort', parameterHint: '[effort]', availability: 'idle', action: 'effort' },
  { name: 'permissions', aliases: [], descriptionKey: 'cmd.permissions', parameterHint: '[full|normal|plan]', availability: 'idle', action: 'permissions' },
  { name: 'plan', aliases: [], descriptionKey: 'cmd.plan', parameterHint: '', availability: 'idle', action: 'plan' },
  { name: 'compact', aliases: [], descriptionKey: 'cmd.compact', parameterHint: '[instructions]', availability: 'idle', action: 'compact' },
  { name: 'clear', aliases: [], descriptionKey: 'cmd.clear', parameterHint: '', availability: 'idle', action: 'clear' },
  { name: 'resume', aliases: [], descriptionKey: 'cmd.resume', parameterHint: '', availability: 'idle', action: 'resume' },
  { name: 'status', aliases: [], descriptionKey: 'cmd.status', parameterHint: '', availability: 'any', action: 'status' },
  { name: 'cost', aliases: [], descriptionKey: 'cmd.cost', parameterHint: '', availability: 'any', action: 'cost' },
  { name: 'context', aliases: [], descriptionKey: 'cmd.context', parameterHint: '', availability: 'any', action: 'context' },
  { name: 'lang', aliases: [], descriptionKey: 'cmd.lang', parameterHint: '[en|zh]', availability: 'any', action: 'lang' },
  { name: 'theme', aliases: [], descriptionKey: 'cmd.theme', parameterHint: '[auto|dark|light|ansi]', availability: 'any', action: 'theme' },
  { name: 'exit', aliases: ['quit'], descriptionKey: 'cmd.exit', parameterHint: '', availability: 'any', action: 'exit' },
] as const satisfies ReadonlyArray<{ name: string; aliases: readonly string[]; descriptionKey: MessageKey; parameterHint: string; availability: 'idle' | 'any'; action: string }>;

export type CommandDefinition = (typeof COMMAND_REGISTRY)[number];
export type Command = CommandDefinition['name'] | CommandDefinition['aliases'][number];
export const COMMANDS: readonly Command[] = [...COMMAND_REGISTRY.map(command => command.name), ...COMMAND_REGISTRY.flatMap(command => command.aliases)];

export function resolveCommand(name: string): CommandDefinition | undefined {
  const normalized = name.toLowerCase();
  return COMMAND_REGISTRY.find(command => command.name === normalized || (command.aliases as readonly string[]).includes(normalized));
}

export function commandAvailable(command: CommandDefinition, phase: 'idle' | 'connecting' | 'running'): boolean {
  return phase === 'idle' || command.availability === 'any';
}

export function commandDescription(t: Translate, name: Command): string {
  return t(resolveCommand(name)!.descriptionKey);
}

/** Prefixes first, then names, aliases and localized descriptions containing the search text. */
export function commandSuggestions(input: string, t?: Translate): Command[] {
  if (!input.startsWith('/') || /\s/.test(input)) return [];
  const query = input.slice(1).toLowerCase();
  const matched = COMMAND_REGISTRY.filter(command => [command.name, ...command.aliases, ...(t ? [t(command.descriptionKey)] : [])]
    .some(value => value.toLowerCase().includes(query)));
  return matched.sort((a, b) => Number(b.name.startsWith(query)) - Number(a.name.startsWith(query))).map(command => command.name);
}

export function commandHelpRows(t: Translate): Array<[string, string]> {
  return COMMAND_REGISTRY.map(command => [`/${command.name}${command.parameterHint ? ` ${command.parameterHint}` : ''}`, t(command.descriptionKey)]);
}
