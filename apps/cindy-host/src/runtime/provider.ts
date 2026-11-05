import type { Logger } from '@cindy/maker-core';
import { createClaudeProvider } from './claude';
import { createCodexProvider } from './codex';

export function createProvider(dataDir: string, logger: Logger, env: NodeJS.ProcessEnv = process.env) {
  const kind = env.CINDY_HOST_AGENT ?? 'claude-code';
  if (kind === 'claude-code') return createClaudeProvider(dataDir, logger, env);
  if (kind === 'codex') return createCodexProvider(dataDir, logger, env);
  throw new Error('CINDY_HOST_AGENT must be claude-code or codex.');
}
