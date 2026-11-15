import { promptVisible, readSavedLogin, runLogin } from './auth';
import { runChat } from './chat/run';
import { runCli } from './cli';
import { assertProxyConfig } from './proxy';
import { runReceived } from './received';
import { startClientRuntime } from './runtime';

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, ms);
    const stop = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener('abort', stop, { once: true });
  });
}

void runCli(process.argv.slice(2), {
  // Unsupported proxy settings are reported before any network use.
  beforeCommand: assertProxyConfig,
  login: (args, context, signal) => runLogin(args, context.dataDir, signal, context.output),
  chat: runChat,
  status: async context => ({ login: await readSavedLogin(context.dataDir) }),
  async models(context, signal) {
    const runtime = await startClientRuntime(context, signal);
    try {
      const { models, unavailable } = await runtime.catalog();
      let group = '';
      for (const model of models) {
        const label = `${model.providerName} · ${model.targetLabel}`;
        if (label !== group) { context.output(label); group = label; }
        context.output(`  ${model.model}${model.modelName !== model.model ? ` (${model.modelName})` : ''}${model.efforts.length ? `  [${model.efforts.join(', ')}]` : ''}`);
      }
      if (!models.length) context.output(context.t('chat.noModels'));
      if (unavailable.length) context.error(context.t('chat.unavailableSources', { names: unavailable.map(source => source.label).join(', ') }));
      return 0;
    } finally { await runtime.close(); }
  },
  async received(args, context, signal) {
    // Share management uses only the authenticated REST API; no relay connection needed.
    const runtime = await startClientRuntime(context, signal, { relay: false });
    try {
      return await runReceived(args, { shares: runtime.shares, t: context.t, output: context.output,
        ask: question => promptVisible(question, signal), wait: ms => delay(ms, signal) });
    } finally { await runtime.close(); }
  },
}).then(code => { process.exitCode = code; });
