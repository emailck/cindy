import { createHash } from 'node:crypto';
import type { RuntimeNetwork } from './runtime-types.js';

/**
 * Forced-egress network ("网络"): instances join a dedicated Docker bridge whose gateway
 * address is held by a mihomo gateway container, not by the host. Every packet from an
 * instance therefore passes the gateway, which sends direct-listed domains (Cindy by
 * default) directly, rejects UDP other than DNS, and sends everything else to the
 * network's upstream HTTP proxy. If the gateway stops, instances have no route at all.
 */
export const DEFAULT_DIRECT_DOMAINS = ['cindy.app', 'cindy.com.cn'];
export const GATEWAY_PROXY_PORT = 7890;
const SUBNET = /^172\.30\.(\d{1,3})\.0\/24$/;
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function subnetIndex(subnet: string): number | null {
  const match = SUBNET.exec(subnet);
  const index = match ? Number(match[1]) : NaN;
  return Number.isInteger(index) && index >= 0 && index <= 255 ? index : null;
}
export function subnetFor(index: number) { return `172.30.${index}.0/24`; }
/** Address instances use as their default route, DNS server and proxy. Held by the gateway. */
export function gatewayAddress(subnet: string) {
  const index = subnetIndex(subnet);
  if (index === null) throw new Error('Invalid network subnet.');
  return `172.30.${index}.1`;
}
/** Docker-assigned address of the gateway container itself. */
export function gatewayContainerAddress(subnet: string) { return gatewayAddress(subnet).replace(/\.1$/, '.2'); }
export function gatewayProxyUrl(subnet: string) { return `http://${gatewayAddress(subnet)}:${GATEWAY_PROXY_PORT}`; }

export function normalizeDirectDomains(value: unknown): string[] | null {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,]+/) : null;
  if (!raw || raw.length > 32) return null;
  const domains = [...new Set(raw.map(item => typeof item === 'string' ? item.trim().toLowerCase().replace(/^\*?\./, '') : '').filter(Boolean))];
  return domains.every(domain => DOMAIN.test(domain)) ? domains : null;
}

/** mihomo configuration as JSON (valid YAML); no user text is ever concatenated into syntax. */
export function gatewayConfig(network: RuntimeNetwork): Record<string, unknown> {
  const gateway = gatewayAddress(network.subnet);
  const upstream = new URL(network.proxy.url);
  return {
    mode: 'rule', 'log-level': 'warning', ipv6: false,
    'allow-lan': true, 'bind-address': gateway, 'mixed-port': GATEWAY_PROXY_PORT, 'lan-allowed-ips': [network.subnet],
    profile: { 'store-selected': false, 'store-fake-ip': false },
    dns: { enable: true, listen: `${gateway}:53`, ipv6: false, 'enhanced-mode': 'fake-ip', 'fake-ip-range': '198.18.0.1/16', nameserver: ['system'] },
    // Connections made to a literal IP still carry the domain in TLS SNI / HTTP Host.
    sniffer: { enable: true, 'parse-pure-ip': true, sniff: { TLS: { ports: [443, 8443] }, HTTP: { ports: [80, '8080-8880'] } } },
    tun: { enable: true, stack: 'system', 'auto-route': true, 'auto-detect-interface': true, 'dns-hijack': ['any:53'] },
    proxies: [{ name: 'upstream', type: 'http', server: upstream.hostname.replace(/^\[|\]$/g, ''), port: Number(upstream.port || 80),
      ...(network.proxy.username ? { username: network.proxy.username } : {}),
      ...(network.proxy.password ? { password: network.proxy.password } : {}) }],
    rules: [...network.directDomains.map(domain => `DOMAIN-SUFFIX,${domain},DIRECT`), 'NETWORK,UDP,REJECT', 'MATCH,upstream'],
  };
}

// Runs as the gateway entrypoint (busybox sh). $1 config, $2 gateway address, $3 host bridge gateway.
// Docker reserves the network gateway address but does not assign it (inhibit_ipv4), so the
// gateway claims it itself; instances' default route then resolves to this container.
export const GATEWAY_SCRIPT = [
  'set -e',
  'IF=$(ip -4 addr | awk -v gw="$2" \'$1=="inet"{split($2,a,"/");split(a[1],b,".");split(gw,c,".");if(b[1]==c[1]&&b[2]==c[2]&&b[3]==c[3])print $NF}\' | head -n1)',
  '[ -n "$IF" ]',
  'ip addr show dev "$IF" | grep -q "inet $2/" || ip addr add "$2/24" dev "$IF"',
  'ip route replace default via "$3"',
  'exec /usr/bin/mihomo -d /data -config "$1"',
].join('\n');

export function gatewayCommand(network: RuntimeNetwork, hostBridgeGateway: string): string[] {
  const config = Buffer.from(JSON.stringify(gatewayConfig(network))).toString('base64');
  return ['sh', '-c', GATEWAY_SCRIPT, 'gateway', config, gatewayAddress(network.subnet), hostBridgeGateway];
}
/** Detects configuration drift without storing the upstream credentials in a label. */
export function gatewayFingerprint(image: string, command: string[]) {
  return createHash('sha256').update(JSON.stringify([image, command])).digest('hex');
}
