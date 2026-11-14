import { spawn } from 'node:child_process';
import { cleanProcessEnv, stripSensitiveAnthropicEnv } from '@cindy/maker-core';
import { claudeQuota, emptyQuota, type QuotaAccount } from '../share-quota';

/** Raw `get_usage` body; `empty` only when the CLI explicitly reports no plan limits. */
export type ClaudeRateLimitsRead = 'empty' | { rateLimits: unknown; subscriptionType: string | null };

/** Share projection of the native read; a body without limits stays "unavailable" as before. */
export async function readClaudeQuota(binary: string, cwd: string): Promise<QuotaAccount> {
  const read = await readClaudeRateLimits(binary, cwd);
  return read === 'empty' ? emptyQuota('unsupported') : claudeQuota(read.rateLimits);
}

/** Same native get_usage control request as Desktop. Never read subscription credentials. */
export async function readClaudeRateLimits(binary: string, cwd: string): Promise<ClaudeRateLimitsRead> {
  const env = cleanProcessEnv(process.env);
  stripSensitiveAnthropicEnv(env);
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST;
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json',
      '--verbose', '--no-session-persistence', '--strict-mcp-config', '--setting-sources', 'user'],
    { cwd, env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    let settled = false; let buffer = ''; let result: ClaudeRateLimitsRead | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value?: ClaudeRateLimitsRead) => {
      if (settled) return;
      settled = true; result = value; clearTimeout(timer); child.kill();
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1000); killTimer.unref();
    };
    const timer = setTimeout(() => finish(), 15000);
    child.on('error', () => finish());
    child.stdin.on('error', () => finish());
    child.stdout.on('error', () => finish());
    child.on('close', () => {
      clearTimeout(timer); if (killTimer) clearTimeout(killTimer);
      if (result) resolve(result); else reject(new Error('Native Claude quota is unavailable.'));
    });
    child.stdout.on('data', chunk => {
      buffer += chunk.toString();
      if (buffer.length > 1024 * 1024) { finish(); return; }
      let newline;
      while (!settled && (newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        try {
          const row = JSON.parse(line);
          if (row.type !== 'control_response' || row.response?.request_id !== 'cindy-quota') continue;
          if (row.response.subtype !== 'success') { finish(); return; }
          const body = row.response.response;
          const plan = typeof body?.subscription_type === 'string' ? body.subscription_type.trim() : '';
          finish(body?.rate_limits_available === false ? 'empty' : { rateLimits: body?.rate_limits, subscriptionType: plan || null });
        } catch { /* Ignore non-protocol diagnostics; never expose raw output. */ }
      }
    });
    child.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'cindy-init', request: { subtype: 'initialize' } }) + '\n');
    child.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'cindy-quota', request: { subtype: 'get_usage', skip_behaviors: true } }) + '\n');
  });
}
