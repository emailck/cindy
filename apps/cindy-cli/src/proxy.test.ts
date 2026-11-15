/**
 * 测试价值
 * - 生产入口与可观察结果：networkFetch（登录与 REST 用）、webSocketAgentFor（中转 WebSocket 用）、assertProxyConfig；
 *   请求是否真的经过环境变量里的代理、NO_PROXY 与本机地址是否直连、不支持的代理是否明确报错。
 * - Bug／规则依据：2026-11-15 WSL 实测：只有代理能出网时，Node fetch 与 ws 不读代理环境变量导致 CLI 无法连接。
 * - 现有覆盖缺口：cindy-host 只为 Claude API 请求走代理；CLI 的登录、REST 与中转连接此前都是直连。
 * - 最小失败输入：设置 HTTP_PROXY 后 fetch 仍直连；HTTPS_PROXY 为 https:// 时静默直连。
 * - tier：unit（本机 loopback 假代理与假上游，无外网）。
 */
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Socks5HttpsAgent, TunnelingHttpsAgent } from '@cindy/anthropic-compat-proxy';
import { afterEach, describe, expect, it } from 'vitest';
import { CliError } from './profile';
import { assertProxyConfig, networkFetch, webSocketAgentFor } from './proxy';

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve)))); });
async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

describe('outbound proxy from the environment', () => {
  it('sends fetch through HTTP_PROXY', async () => {
    const upstream = await listen(createServer((_req, res) => { res.end('upstream-ok'); }));
    const seen: string[] = [];
    // Forwarding proxy: records the absolute-form request, then relays it.
    const proxy = await listen(createServer((req, res) => {
      seen.push(req.url ?? '');
      const target = new URL(req.url!);
      request({ host: target.hostname, port: target.port, path: target.pathname, method: req.method }, upstreamRes => upstreamRes.pipe(res)).end();
    }));
    const fetch = networkFetch({ HTTP_PROXY: `http://127.0.0.1:${proxy}` });
    expect(fetch).not.toBe(globalThis.fetch);
    expect(await (await fetch(`http://127.0.0.1:${upstream}/api/ping`)).text()).toBe('upstream-ok');
    expect(seen).toEqual([`http://127.0.0.1:${upstream}/api/ping`]);
    expect(networkFetch({})).toBe(globalThis.fetch);
  });

  it.each([
    ['HTTP CONNECT proxy', { HTTPS_PROXY: 'http://127.0.0.1:7890' }, TunnelingHttpsAgent],
    ['SOCKS5 via ALL_PROXY', { ALL_PROXY: 'socks5://127.0.0.1:1080' }, Socks5HttpsAgent],
    ['NO_PROXY match', { HTTPS_PROXY: 'http://127.0.0.1:7890', NO_PROXY: '.cindy.app' }, undefined],
    ['no proxy configured', {}, undefined],
  ])('picks the relay WebSocket agent: %s', (_name, env, expected) => {
    const agent = webSocketAgentFor('wss://link.cindy.app/api/device-link/ws', env);
    if (expected) expect(agent).toBeInstanceOf(expected);
    else expect(agent).toBeUndefined();
  });

  it('rejects a proxy it cannot use instead of silently connecting directly', () => {
    const env = { HTTPS_PROXY: 'https://proxy.example:8443' };
    expect(() => assertProxyConfig(env)).toThrow(CliError);
    expect(() => webSocketAgentFor('wss://link.cindy.app/ws', env)).toThrow(CliError);
    expect(() => assertProxyConfig({ HTTPS_PROXY: 'http://user:pass@127.0.0.1:7890' })).not.toThrow();
  });
});
