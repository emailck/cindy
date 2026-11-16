import { render } from 'ink';
import type { ChatRequest, CommandContext } from '../cli';
import { CliError, writeConfig } from '../profile';
import { startClientRuntime } from '../runtime';
import { App } from './App';
import { ChatController, type ChatDeps } from './controller';
import { runPrint } from './print';
import { colorDepthTheme, colorFgBgTheme, queryBackground } from './theme';

export async function runChat(request: ChatRequest, context: CommandContext, signal: AbortSignal): Promise<number> {
  const interactive = request.prompt === undefined;
  if (interactive && (!process.stdin.isTTY || !process.stdout.isTTY)) throw new CliError('TERMINAL_REQUIRED', 'error.terminalRequired');
  // Ask the terminal for its background while the runtime connects; done before Ink takes stdin.
  const background = interactive && (context.config.theme ?? 'auto') === 'auto'
    ? queryBackground(process.stdin, process.stdout, { onInterrupt: () => process.kill(process.pid, 'SIGINT') }).then(found => found ?? colorFgBgTheme(process.env.COLORFGBG), () => null)
    : Promise.resolve(null);
  const runtime = await startClientRuntime(context, signal).catch(async error => { await background; throw error; });
  try {
    const deps: ChatDeps = {
      workingDir: process.cwd(),
      language: context.language,
      permission: context.overrides.permissionMode ?? context.config.permissionMode,
      ...(context.overrides.model ? { initialModel: context.overrides.model } : context.config.model ? { initialModel: context.config.model } : {}),
      account: runtime.account,
      searchAvailable: runtime.searchAvailable,
      shellAvailable: runtime.shellAvailable,
      catalog: () => runtime.catalog(),
      openTask: task => runtime.factory.open(task),
      tasks: runtime.tasks,
      // Per-run --lang never persists; /lang and /model remember the choice.
      saveLanguage: language => writeConfig(context.dataDir, current => ({ ...current, language })),
      saveModel: choice => writeConfig(context.dataDir, current => ({ ...current, model: choice })),
      theme: { setting: context.config.theme ?? 'auto', background: await background, depth: colorDepthTheme(process.env, process.stdout.getColorDepth?.() ?? 8) },
      saveTheme: setting => writeConfig(context.dataDir, current => ({ ...current, theme: setting })),
    };
    const controller = new ChatController(deps);
    const stop = () => { void controller.exit(); };
    signal.addEventListener('abort', stop, { once: true });
    void runtime.accountLost.then(() => {
      context.error(`ACCOUNT_LOST: ${context.t('error.accountLost')}`);
      stop();
    });
    try {
      if (!interactive) return await runPrint(controller, request.prompt!, context, { continueLatest: context.overrides.continue === true });
      const header = `${context.t('chat.welcome', { cwd: deps.workingDir })}\n${context.t('chat.hint')}`;
      const instance = render(<App controller={controller} header={header} />, { exitOnCtrlC: false, incrementalRendering: true });
      await controller.init();
      if (context.overrides.continue) await controller.continueLatest();
      await controller.whenExited();
      instance.unmount();
      await instance.waitUntilExit().catch(() => undefined);
      return 0;
    } finally { signal.removeEventListener('abort', stop); }
  } finally {
    await runtime.close();
  }
}
