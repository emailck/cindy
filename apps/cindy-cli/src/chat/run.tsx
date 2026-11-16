import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { render } from 'ink';
import type { ChatRequest, CommandContext } from '../cli';
import { CliError, writeConfig } from '../profile';
import { startClientRuntime } from '../runtime';
import type { Translate } from '../i18n';
import { App, compactTokens, elapsedText } from './App';
import { cacheHitRate, ChatController, type ChatDeps, type ExitSummary } from './controller';
import { runPrint } from './print';
import { listProjectFiles, readClipboardImage, readText, runLocalCommand, statPath } from './local';
import { colorDepthTheme, colorFgBgTheme, queryBackground, supportsHyperlinks } from './theme';

/** Printed after the interactive UI closes: what this task used, and how to pick it up again. */
export function exitSummaryText(summary: ExitSummary | null, t: Translate, workingDir: string): string | null {
  if (!summary) return null;
  const tokens = summary.tokens;
  const hit = tokens ? cacheHitRate(tokens) : null;
  const facts = [
    t('exit.turns', { count: summary.turns }),
    ...(tokens ? [t('exit.tokens', { input: compactTokens(tokens.input), output: compactTokens(tokens.output) })] : []),
    ...(hit !== null ? [t('exit.cacheHit', { percent: Math.round(hit * 100) })] : []),
    ...(summary.costUsd > 0 ? [t('exit.cost', { cost: summary.costUsd < 0.01 ? summary.costUsd.toFixed(3) : summary.costUsd.toFixed(2) })] : []),
    t('exit.time', { time: elapsedText(summary.workMs) }),
  ];
  return `${t('exit.summary', { facts: facts.join(' · ') })}\n${t('exit.continue', { dir: workingDir })}`;
}

export async function runChat(request: ChatRequest, context: CommandContext, signal: AbortSignal): Promise<number> {
  const interactive = request.prompt === undefined;
  if (interactive && (!process.stdin.isTTY || !process.stdout.isTTY)) throw new CliError('TERMINAL_REQUIRED', 'error.terminalRequired');
  // Ask the terminal for its background while the runtime connects; done before Ink takes stdin.
  const background = interactive && (context.config.theme ?? 'auto') === 'auto'
    ? queryBackground(process.stdin, process.stdout, { onInterrupt: () => process.kill(process.pid, 'SIGINT') }).then(found => found ?? colorFgBgTheme(process.env.COLORFGBG), () => null)
    : Promise.resolve(null);
  const runtime = await startClientRuntime(context, signal).catch(async error => { await background; throw error; });
  // Pasted clipboard images wait here until their message is sent; the directory goes when the CLI exits.
  let pasteDir: string | null = null;
  const workingDir = process.cwd();
  try {
    const deps: ChatDeps = {
      workingDir,
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
      history: runtime.history,
      // The bell reaches the terminal outside Ink's frame; it moves no cursor.
      ...(context.config.notify === 'off' ? {} : { notify: () => { process.stdout.write('\u0007'); } }),
      readText,
      statPath,
      listFiles: () => listProjectFiles(workingDir, runtime.rgPath),
      runLocal: (command, abort) => runLocalCommand(command, workingDir, abort),
      clipboardImage: async () => {
        pasteDir ??= await mkdtemp(path.join(tmpdir(), 'cindy-cli-paste-'));
        return readClipboardImage(pasteDir, randomUUID());
      },
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
      const hyperlinks = supportsHyperlinks(process.env, process.stdout.isTTY === true);
      const colorDepth = process.stdout.getColorDepth?.() ?? 8;
      const instance = render(<App controller={controller} header={header} hyperlinks={hyperlinks} colorDepth={colorDepth} />, { exitOnCtrlC: false, incrementalRendering: true });
      await controller.init();
      if (context.overrides.continue) await controller.continueLatest();
      await controller.whenExited();
      instance.unmount();
      await instance.waitUntilExit().catch(() => undefined);
      const summary = exitSummaryText(controller.exitSummary(), context.t, deps.workingDir);
      if (summary) context.output(summary);
      return 0;
    } finally { signal.removeEventListener('abort', stop); }
  } finally {
    if (pasteDir) await rm(pasteDir, { recursive: true, force: true }).catch(() => undefined);
    await runtime.close();
  }
}
