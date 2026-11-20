import Docker from 'dockerode';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { isIP } from 'node:net';
import { PROXY_PROBE } from './proxy-probe.js';
import { sanitizeAccount, CODEX_ACCOUNT_PROBE } from './account-identity.js';
import { helloProbe, usageProbe, helloResult, claudeUsageResult, codexUsageResult } from './native-probes.js';
import { gatewayAddress, gatewayCommand, gatewayContainerAddress, gatewayFingerprint, gatewayProxyUrl, normalizeDirectDomains, subnetFor, subnetIndex } from './egress-gateway.js';
import type { AccountIdentity, DockerRuntime, NetworkState, ProbeKind, ProviderTest, ProviderUsage, RuntimeInstance, RuntimeNetwork, RuntimeProxy, RuntimeInspection, RuntimeLogin, LoginRequest, ShareRequest } from './runtime-types.js';

const OWNER = 'io.cindy.host-manager';
const CODEX = '/opt/cindy-host/codex/bin/codex';
const CLAUDE = '/opt/cindy-host/claude/claude';
const PROFILE = '/var/lib/cindy-host';
const NATIVE = '/var/lib/cindy-native';
export class RuntimeError extends Error {
  constructor(public readonly code: string, message = 'Docker operation failed. Check the local daemon and managed image.') { super(message); }
}
function identity(instance: RuntimeInstance) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(instance.id)
    || !['codex', 'claude-code'].includes(instance.engine)) throw new RuntimeError('INVALID_INSTANCE');
  return `cindy-managed-${instance.id}`;
}
function labels(instance: RuntimeInstance, role: string) { return { [OWNER]: '1', [`${OWNER}.instance`]: instance.id, [`${OWNER}.engine`]: instance.engine, [`${OWNER}.role`]: role }; }
function assertLabels(actual: Record<string, string> | null | undefined, instance: RuntimeInstance, role?: string) {
  for (const [key, value] of Object.entries(labels(instance, role ?? actual?.[`${OWNER}.role`] ?? ''))) {
    if (actual?.[key] !== value) throw new RuntimeError('RESOURCE_NOT_OWNED', 'Resource ownership does not match this instance.');
  }
}
function absent(error: unknown) { return (error as { statusCode?: number })?.statusCode === 404; }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const networkName = (network: RuntimeNetwork) => `cindy-net-${network.id}`;
const gatewayName = (network: RuntimeNetwork) => `cindy-gateway-${network.id}`;
function networkLabels(network: RuntimeNetwork, role: 'network' | 'gateway' | 'proxy-test') {
  return { [OWNER]: '1', [`${OWNER}.network`]: network.id, [`${OWNER}.role`]: role };
}
function assertNetworkLabels(actual: Record<string, string> | null | undefined, network: RuntimeNetwork, role: 'network' | 'gateway') {
  for (const [key, value] of Object.entries(networkLabels(network, role)))
    if (actual?.[key] !== value) throw new RuntimeError('RESOURCE_NOT_OWNED', 'Resource ownership does not match this network.');
}
function validNetwork(network: RuntimeNetwork) {
  let url: URL | undefined;
  try { url = new URL(network.proxy.url); } catch { /* invalid below */ }
  if (!UUID.test(network.id) || subnetIndex(network.subnet) === null || url?.protocol !== 'http:' || !url.hostname
    || normalizeDirectDomains(network.directDomains)?.length !== network.directDomains.length) throw new RuntimeError('INVALID_NETWORK', 'Invalid network configuration.');
}
function ipv4Range(cidr: string): [number, number] | null {
  const [address, bits] = cidr.split('/'); const parts = address?.split('.').map(Number);
  const length = Number(bits);
  if (!parts || parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255) || !Number.isInteger(length) || length < 0 || length > 32) return null;
  const start = (((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!) >>> 0;
  const size = 2 ** (32 - length);
  const base = start - (start % size);
  return [base, base + size - 1];
}
export function runtimeEnvironment(instance: RuntimeInstance, proxy?: RuntimeProxy | null): string[] {
  identity(instance);
  const values: Record<string, string> = { HOME: NATIVE, CODEX_HOME: `${NATIVE}/.codex`, CINDY_HOST_DATA_DIR: PROFILE,
    CINDY_HOST_CREDENTIAL_STORE: 'file', CINDY_HOST_AGENT: instance.engine, CINDY_HOST_CODEX_BINARY: CODEX,
    CINDY_HOST_CLAUDE_BINARY: CLAUDE, CINDY_HOST_CLAUDE_AUTH: 'native', TERM: 'xterm-256color' };
  if (proxy) {
    let url: URL;
    try { url = new URL(proxy.url); } catch { throw new RuntimeError('INVALID_PROXY', 'Use an HTTP proxy URL.'); }
    if (url.protocol !== 'http:' || !url.hostname || url.pathname !== '/' || url.search || url.hash)
      throw new RuntimeError('INVALID_PROXY', 'Only HTTP CONNECT proxies are supported.');
    if (proxy.username !== undefined) url.username = proxy.username;
    if (proxy.password !== undefined) url.password = proxy.password;
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) values[key] = url.href;
    values.NO_PROXY = values.no_proxy = 'localhost,127.0.0.1,::1';
  }
  return Object.entries(values).map(([key, value]) => `${key}=${value}`);
}

/** All commands are argv arrays; the browser cannot supply entrypoints, mounts or Docker IDs. */
export class DockerRuntimeAdapter implements DockerRuntime {
  private readonly docker: Docker;
  private readonly image: string;
  private readonly stopTimeoutMs: number;
  private readonly gatewayImage?: string;
  private readonly networkQueue = new Map<string, Promise<unknown>>();
  constructor(options: { image: string; gatewayImage?: string; socketPath?: string; docker?: Docker; stopTimeoutMs?: number }) {
    if (!options.image || options.image.startsWith('-') || options.gatewayImage?.startsWith('-')) throw new RuntimeError('INVALID_IMAGE');
    this.image = options.image;
    this.gatewayImage = options.gatewayImage || undefined;
    this.docker = options.docker ?? new Docker({ socketPath: options.socketPath ?? '/var/run/docker.sock' });
    this.stopTimeoutMs = options.stopTimeoutMs ?? 30_000;
  }
  async testProxy(proxy: RuntimeProxy) {
    const env = runtimeEnvironment({ id: randomUUID(), engine: 'claude-code' }, proxy)
      .filter(value => /^(HTTPS_PROXY|https_proxy)=/.test(value));
    return this.probeExit({
      name: `cindy-proxy-test-${randomUUID()}`, Image: this.image, User: '1000:1000',
      Entrypoint: ['node'], Cmd: ['-e', PROXY_PROBE], Env: env,
      Labels: { [OWNER]: '1', [`${OWNER}.role`]: 'proxy-test' },
      HostConfig: { NetworkMode: 'bridge', Mounts: [], LogConfig: { Type: 'none', Config: {} } },
    });
  }
  private async probeExit(options: Docker.ContainerCreateOptions) {
    try {
      const result = await this.oneShot(options, true);
      if (result.code !== 0) throw new Error();
      const value = JSON.parse(result.output);
      if (typeof value.ip !== 'string' || !isIP(value.ip)) throw new Error();
      const location = (key: string): string => typeof value[key] === 'string'
        ? value[key].replace(/[\x00-\x1f\x7f]/g, '').slice(0, 100) : '';
      return { ip: value.ip, country: location('country'), region: location('region'), city: location('city') };
    } catch {
      throw new RuntimeError('PROXY_TEST_FAILED', 'Proxy test failed. Check the address, authentication and connectivity.');
    }
  }
  /** Network operations for one network never interleave (two instances may start at once). */
  private serialize<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.networkQueue.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    const settled = next.catch(() => {});
    this.networkQueue.set(id, settled);
    void settled.then(() => { if (this.networkQueue.get(id) === settled) this.networkQueue.delete(id); });
    return next;
  }
  private async egress(instance: RuntimeInstance) {
    if (instance.network) await this.ensureNetwork(instance.network);
  }
  async allocateSubnet(used: string[]): Promise<string> {
    return this.safe(async () => {
      const taken = (await this.docker.listNetworks()).flatMap(item => (item.IPAM?.Config ?? []).map(config => config.Subnet ?? ''))
        .concat(used).map(ipv4Range).filter((range): range is [number, number] => !!range);
      for (let index = 0; index <= 255; index++) {
        const [start, end] = ipv4Range(subnetFor(index))!;
        if (!taken.some(([from, to]) => start <= to && from <= end)) return subnetFor(index);
      }
      throw new RuntimeError('NO_FREE_SUBNET', 'No free 172.30.N.0/24 subnet is available.');
    });
  }
  async applyNetwork(network: RuntimeNetwork): Promise<void> {
    return this.safe(() => this.ensureNetwork(network));
  }
  private ensureNetwork(network: RuntimeNetwork): Promise<void> {
    validNetwork(network);
    return this.serialize(network.id, async () => {
      const image = this.gatewayImage;
      if (!image) throw new RuntimeError('GATEWAY_UNAVAILABLE', 'Set CINDY_MANAGER_GATEWAY_IMAGE to use networks.');
      let imageId: string;
      try { imageId = String((await this.docker.getImage(image).inspect()).Id ?? ''); }
      catch (error) { if (absent(error)) throw new RuntimeError('GATEWAY_IMAGE_MISSING', 'Build the gateway image first (scripts/build-gateway-image.sh).'); throw error; }
      const dockerNetwork = this.docker.getNetwork(networkName(network));
      let info: Docker.NetworkInspectInfo;
      try { info = await dockerNetwork.inspect(); }
      catch (error) {
        if (!absent(error)) throw error;
        await this.docker.createNetwork({ Name: networkName(network), Driver: 'bridge', CheckDuplicate: true, EnableIPv6: false,
          IPAM: { Driver: 'default', Config: [{ Subnet: network.subnet, Gateway: gatewayAddress(network.subnet) }] },
          // The host takes no address on this bridge: instances can only route through the gateway.
          Options: { 'com.docker.network.bridge.inhibit_ipv4': 'true', 'com.docker.network.bridge.name': `cnet-${network.id.slice(0, 8)}` },
          Labels: networkLabels(network, 'network') });
        info = await dockerNetwork.inspect();
      }
      assertNetworkLabels(info.Labels, network, 'network');
      if (info.IPAM?.Config?.[0]?.Subnet !== network.subnet || info.Options?.['com.docker.network.bridge.inhibit_ipv4'] !== 'true')
        throw new RuntimeError('RESOURCE_NOT_OWNED', 'Docker network does not match this network.');
      const bridgeGateway = (await this.docker.getNetwork('bridge').inspect()).IPAM?.Config?.[0]?.Gateway;
      if (!bridgeGateway) throw new RuntimeError('DOCKER_FAILED');
      const command = gatewayCommand(network, bridgeGateway);
      // The image ID is part of the fingerprint: rebuilding the image (mihomo upgrade) replaces the gateway on next apply.
      const fingerprint = gatewayFingerprint(`${image}@${imageId}`, command);
      const container = this.docker.getContainer(gatewayName(network));
      let current: Docker.ContainerInspectInfo | undefined;
      try { current = await container.inspect(); } catch (error) { if (!absent(error)) throw error; }
      if (current) {
        assertNetworkLabels(current.Config.Labels, network, 'gateway');
        if (current.Config.Labels?.[`${OWNER}.config`] === fingerprint && current.Config.Image === image && !current.HostConfig.Privileged) {
          if (!current.State.Running) await container.start();
          return;
        }
        // Configuration changed: replace the gateway. Attached instances lose their route briefly, never fall back to direct.
        // The gateway is stateless; a restart-policy container must be stopped (not killed) to stay down.
        if (current.State.Running) await container.stop({ t: 5 });
        await container.remove();
      }
      const created = await this.docker.createContainer({ name: gatewayName(network), Image: image, User: '0:0',
        Entrypoint: ['/bin/busybox'], Cmd: command, Labels: { ...networkLabels(network, 'gateway'), [`${OWNER}.config`]: fingerprint },
        HostConfig: { NetworkMode: 'bridge', RestartPolicy: { Name: 'unless-stopped' }, LogConfig: { Type: 'none', Config: {} },
          CapDrop: ['ALL'], CapAdd: ['NET_ADMIN', 'NET_BIND_SERVICE'], SecurityOpt: ['no-new-privileges'], ReadonlyRootfs: true,
          Devices: [{ PathOnHost: '/dev/net/tun', PathInContainer: '/dev/net/tun', CgroupPermissions: 'rwm' }],
          Sysctls: { 'net.ipv4.ip_forward': '1', 'net.ipv4.conf.all.rp_filter': '0' },
          Tmpfs: { '/data': 'size=16m' }, Memory: 128 * 1024 * 1024 } });
      await dockerNetwork.connect({ Container: created.id, EndpointConfig: { IPAMConfig: { IPv4Address: gatewayContainerAddress(network.subnet) } } });
      await created.start();
    });
  }
  async inspectNetwork(network: RuntimeNetwork): Promise<NetworkState> {
    return this.safe(async () => {
      validNetwork(network);
      try { assertNetworkLabels((await this.docker.getNetwork(networkName(network)).inspect()).Labels, network, 'network'); }
      catch (error) { if (absent(error)) return 'missing'; throw error; }
      try {
        const info = await this.docker.getContainer(gatewayName(network)).inspect();
        assertNetworkLabels(info.Config.Labels, network, 'gateway');
        return info.State.Running ? 'running' : 'stopped';
      } catch (error) { if (absent(error)) return 'missing'; throw error; }
    });
  }
  async removeNetwork(network: RuntimeNetwork): Promise<void> {
    return this.safe(() => { validNetwork(network); return this.serialize(network.id, async () => {
      const dockerNetwork = this.docker.getNetwork(networkName(network));
      let info: Docker.NetworkInspectInfo | undefined;
      try { info = await dockerNetwork.inspect(); assertNetworkLabels(info.Labels, network, 'network'); }
      catch (error) { if (!absent(error)) throw error; }
      // The service has already verified no instance is assigned here. A running container still
      // depends on the route; a stopped one only holds a stale reference (instances are recreated
      // from current settings on start), so it is detached instead of blocking deletion.
      const attached = (await this.docker.listContainers({ all: true, filters: JSON.stringify({ network: [networkName(network)] }) }))
        .filter(item => !item.Names?.includes(`/${gatewayName(network)}`));
      if (attached.some(item => item.State === 'running' || item.State === 'restarting' || item.State === 'paused'))
        throw new RuntimeError('NETWORK_IN_USE', 'Containers are still attached to this network.');
      for (const item of attached) await dockerNetwork.disconnect({ Container: item.Id, Force: true });
      const gateway = this.docker.getContainer(gatewayName(network));
      try {
        const current = await gateway.inspect();
        assertNetworkLabels(current.Config.Labels, network, 'gateway');
        if (current.State.Running) await gateway.stop({ t: 5 });
        await gateway.remove();
      } catch (error) { if (!absent(error)) throw error; }
      if (info) await dockerNetwork.remove();
    }); });
  }
  async testNetwork(network: RuntimeNetwork) {
    await this.applyNetwork(network);
    return this.probeExit({ name: `cindy-network-test-${randomUUID()}`, Image: this.image, User: '1000:1000',
      Entrypoint: ['node'], Cmd: ['-e', PROXY_PROBE], Env: [],
      Labels: networkLabels(network, 'proxy-test'),
      HostConfig: { NetworkMode: networkName(network), Dns: [gatewayAddress(network.subnet)], Mounts: [], LogConfig: { Type: 'none', Config: {} } } });
  }
  private async safe<T>(action: () => Promise<T>): Promise<T> {
    try { return await action(); } catch (error) { if (error instanceof RuntimeError) throw error; throw new RuntimeError('DOCKER_FAILED'); }
  }
  private async volume(instance: RuntimeInstance, role: 'profile' | 'native') {
    const name = `${identity(instance)}-${role}`;
    const volume = this.docker.getVolume(name);
    try { assertLabels((await volume.inspect()).Labels, instance, role); }
    catch (error) {
      if (!absent(error)) throw error;
      await this.docker.createVolume({ Name: name, Labels: labels(instance, role) });
      assertLabels((await volume.inspect()).Labels, instance, role);
    }
  }
  private options(instance: RuntimeInstance, role: string, command: string[], proxy?: RuntimeProxy | null, tty = false): Docker.ContainerCreateOptions {
    const name = identity(instance);
    const network = instance.network;
    // On a forced-egress network the gateway is the only proxy, DNS server and route.
    const env = runtimeEnvironment(instance, network ? { url: gatewayProxyUrl(network.subnet) } : proxy);
    return { name: role === 'service' ? name : `${name}-${role}-${randomUUID()}`, Image: this.image,
      Entrypoint: [command[0]!], Cmd: command.slice(1), Env: env,
      User: '1000:1000', WorkingDir: NATIVE, Labels: labels(instance, role),
      Tty: tty, OpenStdin: tty, StdinOnce: false, AttachStdin: tty, AttachStdout: true, AttachStderr: true,
      HostConfig: { Init: true, RestartPolicy: { Name: 'no' }, LogConfig: { Type: 'none', Config: {} },
        ...(network ? { NetworkMode: networkName(network), Dns: [gatewayAddress(network.subnet)] } : {}),
        Mounts: [{ Type: 'volume', Source: `${name}-profile`, Target: PROFILE, VolumeOptions: { NoCopy: true, Labels: {}, DriverConfig: { Name: 'local', Options: {} } } }, { Type: 'volume', Source: `${name}-native`, Target: NATIVE, VolumeOptions: { NoCopy: true, Labels: {}, DriverConfig: { Name: 'local', Options: {} } } }] } };
  }
  private async containers(instance: RuntimeInstance) {
    identity(instance);
    const found = await this.docker.listContainers({ all: true, filters: JSON.stringify({ label: [`${OWNER}=1`, `${OWNER}.instance=${instance.id}`] }) });
    for (const item of found) assertLabels(item.Labels, instance);
    return found;
  }
  private async idle(instance: RuntimeInstance) {
    if ((await this.containers(instance)).some(item => item.State === 'running' || item.State === 'restarting' || item.State === 'paused'))
      throw new RuntimeError('INSTANCE_RUNNING', 'Stop the instance and finish any login before continuing.');
  }
  private async service(instance: RuntimeInstance) {
    const container = this.docker.getContainer(identity(instance));
    try {
      const info = await container.inspect();
      assertLabels(info.Config.Labels, instance, 'service');
      // Refuse replaced/modified containers, even if someone copied the public ownership labels.
      const expected = this.options(instance, 'service', ['cindy-host', 'serve']);
      if (info.Config.Image !== this.image || info.Config.User !== '1000:1000' || info.HostConfig.Privileged
        || JSON.stringify(info.Config.Entrypoint) !== JSON.stringify(['cindy-host']) || JSON.stringify(info.Config.Cmd) !== JSON.stringify(['serve'])
        || !info.Config.Env?.includes(`CINDY_HOST_AGENT=${instance.engine}`)
        || (info.HostConfig.Binds?.length ?? 0) > 0 || info.Mounts.length !== 2
        || !info.Mounts.every(m => m.Type === 'volume' && expected.HostConfig!.Mounts!.some(e => e.Source === m.Name && e.Target === m.Destination)))
        throw new RuntimeError('RESOURCE_NOT_OWNED');
      for (const role of ['profile', 'native']) {
        assertLabels((await this.docker.getVolume(`${identity(instance)}-${role}`).inspect()).Labels, instance, role);
      }
      return { container, info };
    } catch (error) { if (absent(error)) return null; throw error; }
  }
  private async prepareNative(instance: RuntimeInstance, proxy?: RuntimeProxy | null, running?: Docker.Container): Promise<void> {
    const directory = instance.engine === 'codex' ? `${NATIVE}/.codex` : `${NATIVE}/.claude`;
    // Run as the instance UID. Only mkdir a missing native config directory; never rewrite
    // existing configuration, chmod existing directories, recurse, or follow a symlink.
    const command = ['node', '-e', `const fs=require('node:fs');const root=${JSON.stringify(NATIVE)},target=${JSON.stringify(directory)};const uid=process.getuid();const parent=fs.lstatSync(root);if(!parent.isDirectory()||parent.isSymbolicLink()||parent.uid!==uid)throw Error('Unsafe native HOME');try{fs.mkdirSync(target,{mode:0o700})}catch(error){if(error.code!=='EEXIST')throw error}const fd=fs.openSync(target,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);try{const dir=fs.fstatSync(fd);if(!dir.isDirectory()||dir.uid!==uid)throw Error('Unsafe native directory');fs.accessSync(target,fs.constants.W_OK|fs.constants.X_OK)}finally{fs.closeSync(fd)}`];
    try {
      if (running) await this.exec(running, command);
      else await this.oneShot(this.options(instance, 'native-setup', command, proxy));
    } catch (error) {
      if (error instanceof RuntimeError && error.code === 'COMMAND_FAILED') throw new RuntimeError('NATIVE_DIRECTORY_UNAVAILABLE', 'Native configuration directory is unavailable. Check ownership and permissions; existing files are retained.');
      throw error;
    }
  }
  async create(instance: RuntimeInstance, proxy?: RuntimeProxy | null): Promise<void> {
    return this.safe(async () => {
      runtimeEnvironment(instance, proxy);
      await this.idle(instance);
      await this.egress(instance);
      await this.volume(instance, 'profile'); await this.volume(instance, 'native');
      // New named volumes are root-owned; only their two roots are initialized, never recursive user data.
      const setup = this.options(instance, 'setup', ['node', '-e', `const fs=require('node:fs');for(const p of ['${PROFILE}','${NATIVE}']){fs.chownSync(p,1000,1000);fs.chmodSync(p,0o700)}`], proxy);
      setup.User = '0:0';
      await this.oneShot(setup);
      await this.prepareNative(instance, proxy);
      if (!await this.service(instance)) await this.docker.createContainer(this.options(instance, 'service', ['cindy-host', 'serve'], proxy));
    });
  }
  async inspect(instance: RuntimeInstance): Promise<RuntimeInspection> {
    return this.safe(async () => { const service = await this.service(instance); return { state: !service ? 'missing' : service.info.State.Running ? 'running' : 'stopped' }; });
  }
  async start(instance: RuntimeInstance, proxy?: RuntimeProxy | null): Promise<void> {
    return this.safe(async () => {
      await this.idle(instance);
      const old = await this.service(instance);
      if (!old) throw new RuntimeError('INSTANCE_MISSING');
      await this.egress(instance);
      await this.prepareNative(instance, proxy);
      await this.oneShot(this.options(instance, 'config', ['cindy-host', 'config', 'set', 'remoteAccessEnabled', 'true'], proxy));
      // Recreate only the proven-stopped service so changed proxy settings are actually applied. Volumes stay.
      await old.container.remove();
      const next = await this.docker.createContainer(this.options(instance, 'service', ['cindy-host', 'serve'], proxy));
      await next.start();
    });
  }
  private async graceful(container: Docker.Container): Promise<void> {
    if (!(await container.inspect()).State.Running) return;
    await container.kill({ signal: 'SIGTERM' }); // Docker stop's timeout implicitly SIGKILLs; never use it here.
    const deadline = Date.now() + this.stopTimeoutMs;
    while ((await container.inspect()).State.Running) {
      if (Date.now() >= deadline) throw new RuntimeError('STOP_TIMEOUT', 'The process has not stopped. Its data is retained; retry after it finishes.');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  async stop(instance: RuntimeInstance): Promise<void> {
    return this.safe(async () => { const service = await this.service(instance); if (service) await this.graceful(service.container); });
  }
  private async output(stream: NodeJS.ReadableStream, tty = false): Promise<string> {
    const sink = new PassThrough(); sink.setEncoding('utf8'); let output = ''; let overflow = false;
    sink.on('data', chunk => { if (output.length + chunk.length > 1024 * 1024) overflow = true; else output += chunk.toString(); });
    if (tty) stream.pipe(sink); else this.docker.modem.demuxStream(stream, sink, sink);
    await new Promise<void>((resolve, reject) => { stream.once('end', resolve); stream.once('error', reject); });
    if (overflow) throw new RuntimeError('OUTPUT_TOO_LARGE');
    return output;
  }
  private async oneShot(options: Docker.ContainerCreateOptions, allowFailure = false) {
    const container = await this.docker.createContainer(options);
    let stream: NodeJS.ReadWriteStream | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      stream = await container.attach({ stream: true, stdout: true, stderr: true });
      const collected = this.output(stream);
      // Attach collection can reject before start/wait; register both branches immediately.
      const completion = collected.then(output => output);
      void completion.catch(() => {});
      await container.start();
      const operation = Promise.all([container.wait(), completion]);
      const [result, output] = await Promise.race([operation, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new RuntimeError('COMMAND_TIMEOUT', 'The native command timed out.')), 30_000);
      })]);
      if (result.StatusCode !== 0 && !allowFailure) throw new RuntimeError('COMMAND_FAILED', 'The native command failed. Check login and profile availability.');
      return { output, code: result.StatusCode };
    } finally {
      clearTimeout(timer);
      if ((await container.inspect()).State.Running) await this.graceful(container);
      if (!(await container.inspect()).State.Running) await container.remove();
    }
  }
  private async exec(container: Docker.Container, command: string[], allowFailure = false) {
    const execution = await container.exec({ Cmd: command, AttachStdout: true, AttachStderr: true });
    const stream = await execution.start({ hijack: true, stdin: false });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let output: string;
    try {
      output = await Promise.race([this.output(stream), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new RuntimeError('COMMAND_TIMEOUT', 'The native command timed out.')), 30_000);
      })]);
    } finally { clearTimeout(timer); }
    const result = await execution.inspect();
    if (result.ExitCode !== 0 && !allowFailure) throw new RuntimeError('COMMAND_FAILED', 'The native command failed. Check login and service availability.');
    return { output, code: result.ExitCode ?? -1 };
  }
  /**
   * Native commands for a non-missing instance: exec in the running service, or a one-shot
   * container on the same volumes once the instance is proven idle (no login or service).
   */
  private async nativeRunner(instance: RuntimeInstance, proxy: RuntimeProxy | null | undefined, role: string) {
    const view = await this.inspect(instance);
    if (view.state === 'missing') return { view, run: undefined };
    const service = (await this.service(instance))!;
    if (view.state !== 'running') await this.idle(instance);
    await this.egress(instance);
    await this.prepareNative(instance, proxy, view.state === 'running' ? service.container : undefined);
    const run = async (command: string[]) => view.state === 'running' ? await this.exec(service.container, command, true)
      : (await this.idle(instance), await this.oneShot(this.options(instance, role, command, proxy), true));
    return { view, run };
  }
  async probe(instance: RuntimeInstance, kind: ProbeKind, proxy?: RuntimeProxy | null): Promise<ProviderTest | ProviderUsage> {
    return this.safe(async () => {
      if (kind !== 'hello' && kind !== 'usage') throw new RuntimeError('INVALID_PROBE');
      const { run } = await this.nativeRunner(instance, proxy, kind === 'hello' ? 'hello' : 'usage');
      if (!run) throw new RuntimeError('INSTANCE_MISSING');
      const started = Date.now();
      const { output } = await run(['node', '-e', kind === 'hello' ? helloProbe(instance.engine) : usageProbe(instance.engine)]);
      if (kind === 'hello') return helloResult(output, Date.now() - started);
      return instance.engine === 'codex' ? codexUsageResult(output) : claudeUsageResult(output);
    });
  }
  async check(instance: RuntimeInstance, proxy?: RuntimeProxy | null): Promise<RuntimeInspection> {
    return this.safe(async () => {
      const { view, run } = await this.nativeRunner(instance, proxy, 'check');
      if (!run) return { ...view, accounts: { cindy: null, provider: null } };
      const readStatus = (output: string) => {
        try {
          const runtime = JSON.parse(output)?.runtime;
          return { saved: typeof runtime?.savedAuthentication === 'boolean' ? runtime.savedAuthentication as boolean : undefined,
            account: sanitizeAccount(runtime?.account, 'cindy') };
        } catch { return { saved: undefined, account: null }; }
      };
      const status = readStatus((await run(['cindy-host', 'status'])).output);
      let saved = status.saved;
      let cindy = saved === true ? status.account : null;
      if (saved === true && !cindy && view.state === 'stopped') {
        // One explicit legacy backfill per check. Never rotate from a second process while serve owns the profile.
        let latest: ReturnType<typeof readStatus> | undefined;
        try {
          const refreshed = await run(['cindy-host', 'status', '--refresh-account']);
          if (refreshed.code === 0) latest = readStatus(refreshed.output);
        } catch { /* Optional command may be unavailable or unable to reach the auth service. */ }
        // A terminal auth failure may have cleared the session even when refresh itself failed.
        try {
          const after = await run(['cindy-host', 'status']);
          if (after.code === 0) latest = readStatus(after.output);
        } catch { /* Preserve the last authoritative state if the read is unavailable. */ }
        if (latest?.saved !== undefined) saved = latest.saved;
        cindy = saved === true ? latest?.account ?? null : null;
      }
      const native = await run(instance.engine === 'codex' ? [CODEX, 'login', 'status'] : [CLAUDE, 'auth', 'status', '--json']);
      let provider: 'authenticated' | 'missing' | 'unknown' = 'unknown';
      let providerAccount: AccountIdentity | null = null;
      if (instance.engine === 'codex') {
        provider = native.code === 0 ? 'authenticated' : native.code === 1 && /^Not logged in\r?$/m.test(native.output) ? 'missing' : 'unknown';
        if (provider === 'authenticated' && /^Logged in using an API key\b/im.test(native.output)) providerAccount = { loginMethod: 'api-key' };
        else if (provider === 'authenticated') {
          try {
            const probe = await run(['node', '-e', CODEX_ACCOUNT_PROBE]);
            if (probe.code === 0) providerAccount = sanitizeAccount(JSON.parse(probe.output));
          } catch { /* Authentication remains independent of public account detail availability. */ }
        }
      } else {
        try {
          const auth = JSON.parse(native.output);
          provider = auth.loggedIn === true && auth.authMethod === 'claude.ai' && !auth.apiKeySource && (!auth.apiProvider || auth.apiProvider === 'firstParty') ? 'authenticated' : 'missing';
          if (provider === 'authenticated') providerAccount = sanitizeAccount({ email: auth.email, displayName: auth.displayName, plan: auth.subscriptionType, organization: auth.orgName }, 'claude');
        } catch { /* Native output unavailable. */ }
      }
      return { ...view, authentication: { cindy: saved === true ? 'stored' : saved === false ? 'missing' : 'unknown', provider }, accounts: { cindy, provider: providerAccount } };
    });
  }
  async share(instance: RuntimeInstance, request: ShareRequest): Promise<unknown> {
    return this.safe(async () => {
      const { action, id, code } = request; const args: string[] = ['cindy-host', 'share', action];
      if (action === 'quota' || action === 'usage') { if (id !== undefined && !['on', 'off'].includes(id)) throw new RuntimeError('INVALID_SHARE'); if (id) args.push(id); }
      else if (['approve', 'reject', 'pause', 'resume', 'remove'].includes(action)) {
        if (!id || !/^[\w-]{1,200}$/.test(id)) throw new RuntimeError('INVALID_SHARE'); args.push(id);
        if (action === 'approve') { if (!code || !/^\d{4}$/.test(code)) throw new RuntimeError('INVALID_SHARE'); args.push(code); }
      } else if (!['list', 'link'].includes(action)) throw new RuntimeError('INVALID_SHARE');
      const service = await this.service(instance);
      if (!service?.info.State.Running) throw new RuntimeError('INSTANCE_STOPPED', 'Start the instance before managing shares.');
      try { return JSON.parse((await this.exec(service.container, args)).output); } catch (error) { if (error instanceof RuntimeError) throw error; throw new RuntimeError('INVALID_RESPONSE'); }
    });
  }
  async openLogin(instance: RuntimeInstance, request: LoginRequest, proxy?: RuntimeProxy | null): Promise<RuntimeLogin> {
    return this.safe(async () => {
      await this.idle(instance);
      if (!await this.service(instance)) throw new RuntimeError('INSTANCE_MISSING');
      await this.egress(instance);
      await this.prepareNative(instance, proxy);
      let command: string[];
      if (request.target === 'provider') command = instance.engine === 'codex' ? [CODEX, 'login', '--device-auth'] : [CLAUDE, 'auth', 'login', '--claudeai'];
      else if (request.target === 'cindy') {
        if (request.method === 'google') command = ['cindy-host', 'login', '--social', 'google'];
        else if (!request.method || request.method === 'email') {
          if (request.email !== undefined && (request.email.length > 320 || /[\x00-\x1f]/.test(request.email))) throw new RuntimeError('INVALID_LOGIN');
          command = ['cindy-host', 'login', ...(request.email ? ['--email', request.email] : [])];
        } else throw new RuntimeError('INVALID_LOGIN');
      } else throw new RuntimeError('INVALID_LOGIN');
      const container = await this.docker.createContainer(this.options(instance, 'login', command, proxy, true));
      const outputs = new Set<(data: string) => void>(); const exits = new Set<(code: number) => void>();
      let pending = ''; let processExitCode: number | undefined; let exitCode: number | undefined;
      let processStopped = false;
      let stream: import('node:stream').Duplex;
      try { stream = await container.attach({ stream: true, stdin: true, stdout: true, stderr: true, hijack: true }) as import('node:stream').Duplex; }
      catch (error) { await container.remove(); throw error; }
      const drained = new Promise<void>(resolve => { stream.once('end', resolve); stream.once('close', resolve); stream.once('error', resolve); });
      stream.setEncoding('utf8');
      stream.on('error', () => {});
      stream.on('data', (chunk: Buffer) => { const data = chunk.toString(); if (outputs.size) { for (const listener of outputs) { try { listener(data); } catch { /* Isolate disconnected subscribers. */ } } } else pending = (pending + data).slice(-65536); });
      try { await container.start(); } catch (error) { stream.destroy(); await container.remove(); throw error; }
      const processResult = async (): Promise<number> => {
        try {
          const result = await container.wait();
          if (Number.isInteger(result.StatusCode)) { processStopped = true; return result.StatusCode; }
        } catch { /* The wait transport can fail independently of the native process. */ }
        try {
          const info = await container.inspect();
          if (!info.State.Running && Number.isInteger(info.State.ExitCode)) {
            processStopped = true; return info.State.ExitCode;
          }
        } catch { /* No authoritative process result is available. */ }
        return -1;
      };
      void processResult().then(async code => {
        processExitCode = code;
        if (!processStopped) stream.destroy();
        await drained;
        // A cleanup failure may leave this stopped, owned container for maintenance. It cannot
        // change the native result, delete profile data, or justify force-removing a live process.
        if (processStopped) { try { await container.remove(); } catch { /* Retain stopped resource. */ } }
        stream.destroy();
        exitCode = code;
        for (const listener of exits) { try { listener(code); } catch { /* Isolate disconnected subscribers. */ } }
        exits.clear();
      });
      return {
        input(data) { if (processExitCode === undefined && data.length <= 65536) stream.write(data); },
        resize: (cols, rows) => this.safe(async () => {
          if (processExitCode !== undefined) return;
          if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || cols > 500 || rows < 1 || rows > 200) throw new RuntimeError('INVALID_SIZE');
          try { await container.resize({ w: cols, h: rows }); }
          catch (error) {
            if (processExitCode !== undefined || absent(error)) return;
            try { if (!(await container.inspect()).State.Running) return; }
            catch (inspectError) { if (absent(inspectError)) return; }
            throw error;
          }
        }),
        cancel: () => this.safe(async () => { if (!processStopped) { try { await this.graceful(container); } catch (error) { if (!processStopped || !absent(error)) throw error; } } pending = ''; }),
        onOutput(listener) { outputs.add(listener); if (pending) { listener(pending); pending = ''; } return () => outputs.delete(listener); },
        onExit(listener) { if (exitCode === undefined) exits.add(listener); else { try { listener(exitCode); } catch { /* Isolate disconnected subscribers. */ } } return () => exits.delete(listener); },
      };
    });
  }
}
