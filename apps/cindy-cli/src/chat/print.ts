import type { ChatController } from './controller';

/** Print mode: one message, final answer to stdout, notices to stderr. Prompts cannot be answered, so they are denied. */
export async function runPrint(controller: ChatController, prompt: string, io: { output(text: string): void; error(text: string): void }, options: { continueLatest?: boolean } = {}): Promise<number> {
  let printed = 0;
  let failed = false;
  const flush = () => {
    const { lines } = controller.getSnapshot();
    // A streamed reply is committed line by line (cont pieces); print it as one answer again.
    let reply: string | null = null;
    const output = () => { if (reply !== null) io.output(reply); reply = null; };
    for (const line of lines.slice(printed)) {
      if (line.kind === 'assistant') {
        if (line.cont && reply !== null) reply += `\n${line.text}`;
        else { output(); reply = line.text; }
      } else if (line.kind === 'notice' && line.tone !== 'info') { output(); io.error(line.text); if (line.tone === 'error') failed = true; }
    }
    output();
    printed = lines.length;
  };
  const off = controller.subscribe(() => {
    if (controller.getSnapshot().prompt) controller.cancelPrompt();
  });
  try {
    await controller.init();
    flush();
    if (!controller.getSnapshot().model) return 1;
    // -c -p: a session that cannot be continued is an error, not a silent fresh start.
    if (options.continueLatest && !await controller.continueLatest()) { flush(); return 1; }
    await controller.submit(prompt);
    await controller.waitForTurn();
    flush();
    return failed ? 1 : 0;
  } finally {
    off();
    await controller.exit();
  }
}
