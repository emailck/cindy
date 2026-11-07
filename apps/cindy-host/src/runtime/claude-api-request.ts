import { request as httpRequest, type Agent, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import {
  createEnvOutboundProxyResolver, parseOutboundProxyUrl, stripIpv6Brackets,
  TunnelingHttpsAgent, Socks5HttpAgent, Socks5HttpsAgent,
} from '@cindy/anthropic-compat-proxy';

/** Host-owned API-key requests must use the same proxy environment as native Claude.
 * Subscription requests remain inside the unmodified CLI. Never install a global
 * dispatcher: Cindy authentication and Device Link have their own network paths.
 */
export async function requestClaudeApiModels(url: URL, apiKey: string): Promise<unknown> {
  const rawProxy = createEnvOutboundProxyResolver()(url.href);
  const proxy = parseOutboundProxyUrl(rawProxy);
  // Unlike the generic compatibility proxy, an explicit but unusable proxy must
  // fail closed here. Neither parsing nor connection failures may retry directly.
  if (rawProxy && !proxy) throw new Error('Unsupported Claude outbound proxy. Configure an HTTP or SOCKS5 proxy.');

  let agent: Agent | undefined;
  const options: RequestOptions = {
    method: 'GET', agent: false, signal: AbortSignal.timeout(15_000),
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', host: url.host },
  };
  if (proxy?.kind === 'socks5') {
    agent = url.protocol === 'https:' ? new Socks5HttpsAgent(proxy) : new Socks5HttpAgent(proxy);
    options.agent = agent;
  } else if (proxy && url.protocol === 'https:') {
    agent = new TunnelingHttpsAgent(proxy);
    options.agent = agent;
  } else if (proxy) {
    options.hostname = stripIpv6Brackets(proxy.hostname);
    options.port = proxy.port;
    options.path = url.href;
    options.headers = { ...options.headers, ...(proxy.authHeader ? { 'proxy-authorization': proxy.authHeader } : {}) };
  }
  try {
    return await new Promise<unknown>((resolve, reject) => {
      const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, options, response => {
        void (async () => {
          // Preserve the previous redirect:error policy: never forward the API key
          // to a redirect target, including one that bypasses the configured proxy.
          if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
            response.destroy();
            throw new Error('Unsuccessful model discovery response');
          }
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of response) {
            size += chunk.length;
            if (size > 4 * 1024 * 1024) throw new Error('Model discovery response too large');
            chunks.push(chunk);
          }
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        })().catch(reject);
      });
      request.on('error', reject);
      request.end();
    });
  } catch {
    // Do not surface proxy URLs, API credentials, or response bodies in diagnostics.
    throw new Error('Anthropic model discovery failed. Check API credentials, endpoint and proxy.');
  } finally {
    agent?.destroy();
  }
}
