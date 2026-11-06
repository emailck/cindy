// Unit tier: production adapter calls against an in-memory Docker boundary. Protects isolation,
// profile exclusivity and secret-free failures. Minimal failures: foreign labels, running login,
// unresponsive SIGTERM, and nonzero native login status. No real credentials or daemon required.
import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import path from 'node:path';
import { CODEX_ACCOUNT_PROBE } from './account-identity.js';
import type Docker from 'dockerode';
import { DockerRuntimeAdapter, runtimeEnvironment } from './docker-runtime.js';
import type { RuntimeInstance } from './runtime-types.js';
const instance: RuntimeInstance = { id: '12345678-1234-4234-8234-123456789abc', engine: 'codex' };
class FakeDocker {
  containers = new Map<string, FakeContainer>(); volumes = new Map<string, { Labels: Record<string,string> }>();
  created: Docker.ContainerCreateOptions[] = []; killed: string[] = []; nativeCode = 0; nativeOutput: string | undefined; nativeInitFails = false; sticky = false; attachFails = false;
  statusRuntime: Record<string,unknown> = {savedAuthentication:true}; refreshedRuntime: Record<string,unknown> | undefined; refreshCode = 1; refreshStoredRuntime: Record<string,unknown> | undefined; accountProbeOutput = 'null'; nativeExecCommands: string[][] = [];
  modem = { demuxStream: (stream: PassThrough, stdout: PassThrough) => stream.pipe(stdout) };
  getVolume(name: string) { return { inspect: async () => { if (!this.volumes.has(name)) throw { statusCode: 404 }; return this.volumes.get(name)!; } }; }
  async createVolume(options: {Name: string; Labels: Record<string,string>}) { this.volumes.set(options.Name, options); }
  getContainer(name: string) { return this.containers.get(name) ?? { inspect: async () => { throw { statusCode: 404 }; } }; }
  async listContainers(options: {filters: string}) { const filters = JSON.parse(options.filters).label as string[]; return [...this.containers.values()].filter(c=>filters.every(filter=>{const [key,value]=filter.split('=');return c.options.Labels?.[key!]===value;})).map(c => ({ Id: c.options.name, Labels: c.options.Labels, State: c.running ? 'running' : 'exited' })); }
  async createContainer(options: Docker.ContainerCreateOptions) { this.created.push(options); const c = new FakeContainer(this, options); this.containers.set(options.name!, c); return c; }
}
class FakeContainer {
  running = false; stream = new PassThrough(); code = 0; resolveWait!: (value: {StatusCode: number}) => void;
  completion = new Promise<{StatusCode: number}>(resolve => { this.resolveWait = resolve; });
  constructor(readonly docker: FakeDocker, readonly options: Docker.ContainerCreateOptions) {}
  async inspect() { return { Config: this.options, HostConfig: this.options.HostConfig, State: { Running: this.running, ExitCode: this.code }, Mounts: this.options.HostConfig!.Mounts!.map(m => ({ Type: m.Type, Name: m.Source, Destination: m.Target })) }; }
  async attach() { if (this.docker.attachFails) throw new Error('secret daemon response'); return this.stream; }
  finish(code = 0, output = '') { this.code = code; this.running = false; this.stream.end(output); this.resolveWait({StatusCode: code}); }
  async start() {
    this.running = true;
    const argv = [...this.options.Entrypoint as string[], ...this.options.Cmd as string[]];
    if (this.options.Labels?.['io.cindy.host-manager.role'] === 'native-setup' && this.docker.nativeInitFails) { queueMicrotask(()=>this.finish(1)); return; }
    if (argv.includes('serve') || argv.includes('--device-auth') || argv.includes('--claudeai') || argv.includes('--social')) return;
    if (argv[0] === 'node' && this.options.Labels?.['io.cindy.host-manager.role'] === 'check') { queueMicrotask(()=>this.finish(0,this.docker.accountProbeOutput)); return; }
    if (argv.includes('status')) queueMicrotask(() => {
      const refresh=argv.includes('--refresh-account');
      if(refresh&&(this.docker.refreshStoredRuntime||this.docker.refreshCode===0)) this.docker.statusRuntime=this.docker.refreshStoredRuntime??this.docker.refreshedRuntime??this.docker.statusRuntime;
      this.finish(argv[0]!.includes('codex') ? this.docker.nativeCode : refresh ? this.docker.refreshCode : 0,
        argv[0] === 'cindy-host' ? JSON.stringify({ runtime: refresh ? this.docker.refreshedRuntime : this.docker.statusRuntime }) : this.docker.nativeOutput ?? (this.docker.nativeCode === 0 ? 'Logged in' : 'Not logged in'));
    });
    else queueMicrotask(() => this.finish());
  }
  async wait() { return this.completion; }
  async kill(options: {signal: string}) { this.docker.killed.push(options.signal); if (!this.docker.sticky) this.finish(); }
  async remove() { if (this.running) throw new Error('cannot remove running'); this.docker.containers.delete(this.options.name!); }
  async resize() { throw { statusCode: 404 }; }
  async exec(options: {Cmd: string[]}) {
    this.docker.nativeExecCommands.push(options.Cmd);
    const stream = new PassThrough();
    const code = options.Cmd[0]!.includes('codex') ? this.docker.nativeCode : 0;
    const output = options.Cmd[0] === 'node' ? this.docker.accountProbeOutput : options.Cmd.includes('share') ? JSON.stringify({shares:[],usage:{}})
      : options.Cmd[0] === 'cindy-host' ? JSON.stringify({runtime:this.docker.statusRuntime}) : this.docker.nativeOutput ?? (this.docker.nativeCode === 0 ? 'Logged in' : 'Not logged in');
    return {start:async()=>{queueMicrotask(()=>stream.end(output));return stream;},inspect:async()=>({ExitCode:code})};
  }
}
const fixture = () => { const docker = new FakeDocker(); return { docker, runtime: new DockerRuntimeAdapter({ image: 'cindy-host:test', docker: docker as unknown as Docker, stopTimeoutMs: 0 }) }; };
describe('managed Docker runtime', () => {
  it('creates two owned private volumes per instance and starts service only after one-shot config', async () => {
    const { docker, runtime } = fixture();
    await runtime.create(instance);
    await runtime.create({...instance, id: '22345678-1234-4234-8234-123456789abc', engine:'claude-code'});
    expect(docker.volumes.size).toBe(4);
    await runtime.start(instance, {url:'http://proxy.invalid:8080',username:'fake',password:'invalid-secret'});
    expect((await runtime.inspect(instance)).state).toBe('running');
    const config = docker.created.find(c => c.Cmd?.includes('remoteAccessEnabled'))!;
    expect(config.Cmd).toEqual(['config','set','remoteAccessEnabled','true']);
    const service = docker.created.at(-1)!;
    expect(service.Env).toContain('HTTPS_PROXY=http://fake:invalid-secret@proxy.invalid:8080/');
    expect(service.HostConfig?.Mounts).toHaveLength(2);
    // Real Docker smoke reproduced uid0/0755 replacing setup's uid1000/0700 while an empty
    // HOME volume was copied from the image. Every subsequent mount must suppress copy-up.
    expect(docker.created.every(container => container.HostConfig?.Mounts?.every(mount => mount.VolumeOptions?.NoCopy === true))).toBe(true);
    expect(service.HostConfig?.LogConfig?.Type).toBe('none');
    await runtime.stop(instance);
    expect(docker.volumes.size).toBe(4);
    expect(docker.killed).toEqual(['SIGTERM']);
  });
  it('refuses foreign resource labels and sanitizes arbitrary daemon errors', async () => {
    const { docker, runtime } = fixture(); await runtime.create(instance);
    docker.containers.values().next().value!.options.Labels = {};
    await expect(runtime.start(instance)).rejects.toMatchObject({code:'RESOURCE_NOT_OWNED'});
    const other = fixture(); other.docker.createVolume = async () => { throw new Error('credential=secret'); };
    await expect(other.runtime.create(instance)).rejects.toThrow('Docker operation failed.');
  });
  it('blocks login while service runs and blocks start while a temporary login owns the profile', async () => {
    const { docker, runtime } = fixture(); await runtime.create(instance); await runtime.start(instance);
    await expect(runtime.openLogin(instance,{target:'provider'})).rejects.toMatchObject({code:'INSTANCE_RUNNING'});
    await runtime.stop(instance);
    const login = await runtime.openLogin(instance,{target:'provider'});
    expect(docker.created.at(-1)?.Entrypoint).toEqual(['/opt/cindy-host/codex/bin/codex']);
    expect(docker.created.at(-1)?.Tty).toBe(true);
    let output = ''; login.onOutput(data => {output += data;});
    const temporary = [...docker.containers.values()].find(c=>c.options.Tty)!;
    temporary.stream.write('Native login URL'); expect(output).toBe('Native login URL');
    await expect(runtime.start(instance)).rejects.toMatchObject({code:'INSTANCE_RUNNING'});
    const exited = new Promise(resolve => login.onExit(resolve));
    await login.cancel(); expect(await exited).toBe(0);
    expect(docker.volumes.size).toBe(2);
  });
  // Regression: a real Cindy login exited 0 and printed authenticated:true, but cleanup or
  // a late resize changed its UI result to failure. Existing tests only covered successful cleanup.
  // Unit tier minimal input: wait reports 0/7, terminal output drains later, remove rejects.
  it.each([0, 7])('preserves native exit %s after output drain even when cleanup rejects', async code => {
    const {docker,runtime}=fixture(); await runtime.create(instance);
    const login=await runtime.openLogin(instance,{target:'cindy',method:'google'});
    const temporary=[...docker.containers.values()].find(container=>container.options.Tty)!;
    temporary.remove=async()=>{throw new Error('synthetic cleanup failure');};
    const events: string[]=[];
    login.onOutput(data=>events.push(`output:${data}`));
    const exited=new Promise<number>(resolve=>login.onExit(value=>{events.push(`exit:${value}`);resolve(value);}));
    temporary.running=false;temporary.resolveWait({StatusCode:code});
    await Promise.resolve();await Promise.resolve();
    login.onExit(value=>events.push(`late:${value}`));
    expect(events).toEqual([]);
    temporary.stream.end('authenticated:true');
    expect(await exited).toBe(code);
    expect(events).toEqual(['output:authenticated:true',`exit:${code}`,`late:${code}`]);
    await expect(login.resize(80,24)).resolves.toBeUndefined();
    expect(docker.containers.has(temporary.options.name!)).toBe(true);
    expect(docker.volumes.size).toBe(2);
    // Remaining stopped container cannot be mistaken for an active login or force-delete its profile.
    await expect(runtime.start(instance)).resolves.toBeUndefined();
  });
  it('isolates exit subscribers so one callback cannot replace or duplicate the native result', async () => {
    const {docker,runtime}=fixture();await runtime.create(instance);
    const login=await runtime.openLogin(instance,{target:'provider'});
    const temporary=[...docker.containers.values()].find(container=>container.options.Tty)!;
    const received:number[]=[];
    login.onOutput(()=>{throw new Error('synthetic disconnected output subscriber');});
    login.onExit(()=>{throw new Error('synthetic disconnected subscriber');});
    const exited=new Promise<number>(resolve=>login.onExit(code=>{received.push(code);resolve(code);}));
    temporary.finish(0,'complete');
    expect(await exited).toBe(0);
    expect(received).toEqual([0]);
    await expect(login.resize(80,24)).resolves.toBeUndefined();
  });
  it.each([false,true])('uses stopped metadata after wait fails and retains uncertain active process (running=%s)', async running => {
    const {docker,runtime}=fixture();await runtime.create(instance);
    const create=docker.createContainer.bind(docker);
    docker.createContainer=async options=>{
      const container=await create(options);
      if(options.Tty) container.wait=async()=>{
        if(!running) container.finish(9,'native failure');
        throw new Error('synthetic wait transport failure');
      };
      return container;
    };
    const login=await runtime.openLogin(instance,{target:'provider'});
    const exited=new Promise<number>(resolve=>login.onExit(resolve));
    expect(await exited).toBe(running?-1:9);
    expect(docker.volumes.size).toBe(2);
    if(running) {
      await expect(runtime.start(instance)).rejects.toMatchObject({code:'INSTANCE_RUNNING'});
      expect([...docker.containers.values()].some(container=>container.options.Tty&&container.running)).toBe(true);
      await login.cancel();
      expect(docker.killed).toEqual(['SIGTERM']);
    } else expect([...docker.containers.values()].some(container=>container.options.Tty)).toBe(false);
  });
  it('reports graceful-stop timeout without force killing or allowing another login', async () => {
    const {docker,runtime}=fixture(); await runtime.create(instance); await runtime.start(instance); docker.sticky=true;
    await expect(runtime.stop(instance)).rejects.toMatchObject({code:'STOP_TIMEOUT'});
    await expect(runtime.openLogin(instance,{target:'cindy',method:'google'})).rejects.toMatchObject({code:'INSTANCE_RUNNING'});
    expect(docker.killed).toEqual(['SIGTERM']);
  });
  it('reports missing native auth consistently stopped/running and parses live shares', async () => {
    const {docker,runtime}=fixture(); await runtime.create(instance); docker.nativeCode=1;
    expect((await runtime.check(instance)).authentication).toEqual({cindy:'stored',provider:'missing'});
    await runtime.start(instance);
    expect((await runtime.check(instance)).authentication?.provider).toBe('missing');
    expect(await runtime.share(instance,{action:'list'})).toEqual({shares:[],usage:{}});
    await expect(runtime.share(instance,{action:'approve',id:'request',code:'oops'})).rejects.toMatchObject({code:'INVALID_SHARE'});
  });
  // MGR-009: the real Codex missing-CODEX_HOME error was incorrectly reported as logged out.
  // Existing coverage only checked exit1; unit minimum is exit1 with a configuration error.
  it('keeps native configuration failures unknown instead of reporting missing authentication', async () => {
    const {docker,runtime}=fixture();await runtime.create(instance);
    docker.nativeCode=1;docker.nativeOutput='Error loading config: CODEX_HOME does not exist (synthetic)';
    expect((await runtime.check(instance)).authentication?.provider).toBe('unknown');
    await runtime.start(instance);
    expect((await runtime.check(instance)).authentication?.provider).toBe('unknown');
  });
  // MGR-009 legacy instances must run the same uid1000 preparation before any native flow.
  // Minimal input: retained instance whose native directory initialization fails, unit boundary.
  it.each(['check','start','login'] as const)('stops %s when legacy native directory preparation fails', async action => {
    const {docker,runtime}=fixture();await runtime.create(instance);docker.nativeInitFails=true;
    const result=action==='login'?runtime.openLogin(instance,{target:'provider'}):runtime[action](instance);
    await expect(result).rejects.toMatchObject({code:'NATIVE_DIRECTORY_UNAVAILABLE'});
    expect((await runtime.inspect(instance)).state).toBe('stopped');
    expect(docker.volumes.size).toBe(2);
    expect(docker.created.at(-1)?.User).toBe('1000:1000');
    expect(docker.created.at(-1)?.Entrypoint).toEqual(['node']);
    expect(docker.created.some(container=>container.Tty)).toBe(false);
  });
  // MGR-012 public identity is distinct from authentication. Production check must whitelist
  // account fields, preserve old-image auth on optional backfill failure, and never rotate a live profile.
  // Unit tier: injected account payload with secret fields / unsupported legacy command is sufficient.
  it('projects public Cindy/Codex identities and strips secret/invalid fields', async () => {
    const {docker,runtime}=fixture();await runtime.create(instance);
    docker.statusRuntime={savedAuthentication:true,account:{displayName:' Test User ',email:'fake@example.test',loginMethod:'cindy',token:'never-return-secret',id:'internal',organization:'bad\norg',plan:'x'.repeat(81)}};
    docker.accountProbeOutput=JSON.stringify({email:'native@example.test',loginMethod:'chatgpt',plan:'pro',token:'never-return-secret',id:'internal'});
    const view=await runtime.check(instance);
    expect(view.accounts).toEqual({cindy:{displayName:'Test User',email:'fake@example.test',loginMethod:'cindy'},provider:{email:'native@example.test',loginMethod:'chatgpt',plan:'pro'}});
    expect(JSON.stringify(view)).not.toContain('never-return-secret');
    docker.statusRuntime={savedAuthentication:false,account:{email:'old@example.test'}};docker.nativeCode=1;
    expect((await runtime.check(instance)).accounts).toEqual({cindy:null,provider:null});
  });
  it.each([true,false])('backfills stopped legacy Cindy account once without requiring relogin (supported=%s)', async supported => {
    const {docker,runtime}=fixture();await runtime.create(instance);
    docker.refreshedRuntime={savedAuthentication:true,account:{displayName:'Fresh',email:'fresh@example.test'}};docker.refreshCode=supported?0:1;
    const view=await runtime.check(instance);
    expect(view.authentication?.cindy).toBe('stored');
    expect(view.accounts?.cindy).toEqual(supported?{displayName:'Fresh',email:'fresh@example.test',loginMethod:'cindy'}:null);
    expect(docker.created.filter(options=>options.Cmd?.includes('--refresh-account'))).toHaveLength(1);
    docker.statusRuntime={savedAuthentication:true};await runtime.start(instance);docker.created=[];
    expect((await runtime.check(instance)).accounts?.cindy).toBe(null);
    expect(docker.nativeExecCommands.some(command=>command.includes('--refresh-account'))).toBe(false);
    expect(docker.created).toHaveLength(0);
  });
  it('rechecks authoritative saved state when a failed legacy refresh invalidates the old session', async () => {
    const {docker,runtime}=fixture();await runtime.create(instance);
    docker.refreshStoredRuntime={savedAuthentication:false};
    const view=await runtime.check(instance);
    expect(view.authentication?.cindy).toBe('missing');expect(view.accounts?.cindy).toBe(null);
  });
  it('keeps authentication independent of malformed native account detail and handles API-key identity', async () => {
    const {docker,runtime}=fixture();await runtime.create(instance);
    docker.accountProbeOutput='malformed secret payload';
    const view=await runtime.check(instance);
    expect(view.authentication?.provider).toBe('authenticated');expect(view.accounts?.provider).toBe(null);
    docker.nativeOutput='Logged in using an API key - invalid-fixture-only';
    expect((await runtime.check(instance)).accounts?.provider).toEqual({loginMethod:'api-key'});
    const claude={...instance,engine:'claude-code' as const};await runtime.stop(instance);
    docker.containers.clear();docker.volumes.clear();await runtime.create(claude);
    docker.nativeOutput=JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',email:'claude@example.test',displayName:'Claude User',subscriptionType:'max',orgName:'Example',accessToken:'never-return-secret'});
    expect((await runtime.check(claude)).accounts?.provider).toEqual({email:'claude@example.test',displayName:'Claude User',plan:'max',organization:'Example',loginMethod:'claude'});
  });
  // Execute the production inline probe with an in-memory process/filesystem boundary. This
  // proves JSONL framing, false refresh request, projection and malformed/oversized reply handling.
  // No real child, auth files, network, or timers are involved (unit tier).
  it.each([
    {response:JSON.stringify({id:2,result:{activeSessionId:'current',sessions:[{sessionId:'old',isActive:false,email:'old@example.test'},{sessionId:'current',isActive:true,email:'fake@example.test',accessToken:'never-return-secret',accountId:'internal'}]}}),expected:{loginMethod:'chatgpt',email:'fake@example.test'}},
    {response:JSON.stringify({id:2,result:{activeSessionId:'current',sessions:[{sessionId:'current',isActive:true,email:'one@example.test'},{sessionId:'current',isActive:true,email:'two@example.test'}]}}),expected:null},
    {response:'malformed never-return-secret',expected:null},
    {response:'x'.repeat(262145),expected:null},
    {response:JSON.stringify({id:2,result:{activeSessionId:'current',sessions:[{sessionId:'current',isActive:true,email:'bad\nemail',displayName:'x'.repeat(201)}]}}),expected:{loginMethod:'chatgpt'}},
  ])('runs native probe framing and safe projection for reply %#', ({response,expected}) => {
    const child=new EventEmitter() as EventEmitter & {stdout:EventEmitter&{setEncoding():void};stdin:EventEmitter&{write(data:string):void};pid:number};
    child.stdout=Object.assign(new EventEmitter(),{setEncoding(){}});
    const sent:string[]=[];child.stdin=Object.assign(new EventEmitter(),{write(data:string){sent.push(data);}});child.pid=123;
    let output='';const signals:string[]=[];const scheduled=new Map<number,{callback:()=>void;delay:number}>();let timerId=0;
    runInNewContext(CODEX_ACCOUNT_PROBE,{Buffer,require(name:string){
      if(name==='node:child_process')return {spawn:()=>child};
      if(name==='node:fs')return {mkdtempSync:()=>'/synthetic-private-probe',writeFileSync(){},rmSync(){}};
      if(name==='node:os')return {tmpdir:()=>'/synthetic'};
      if(name==='node:path')return path;
      throw new Error('Unexpected dependency');
    },process:{env:{},once(){},kill(_pid:number,signal:string){signals.push(signal);},stdout:{write(data:string){output+=data;}}},setTimeout(callback:()=>void,delay:number){scheduled.set(++timerId,{callback,delay});return timerId;},clearTimeout(id:number){scheduled.delete(id);}});
    expect(sent[0]?.endsWith('\n')).toBe(true);
    child.stdout.emit('data',JSON.stringify({id:1,result:{}})+'\n');
    expect(sent.map(line=>JSON.parse(line).method)).toEqual(['initialize','initialized','accountSession/list']);
    expect(JSON.parse(sent[2]!).params).toEqual({refreshWorkspaceMetadata:false});
    child.stdout.emit('data',response+'\n');
    for(const timer of scheduled.values())if(timer.delay===1000)timer.callback();
    expect(JSON.parse(output)).toEqual(expected);
    expect(output.endsWith('\n')).toBe(true);
    expect(output).not.toContain('never-return-secret');expect(output).not.toContain('internal');
    expect(signals).toEqual(['SIGTERM','SIGKILL']);
  });
  it('cleans up failed login attach and rejects unsupported proxies before contacting Docker', async () => {
    const {docker,runtime}=fixture(); await runtime.create(instance); docker.attachFails=true;
    await expect(runtime.openLogin(instance,{target:'provider'})).rejects.toMatchObject({code:'DOCKER_FAILED'});
    expect(docker.containers.size).toBe(1);
    for (const url of ['https://proxy.invalid','socks5://proxy.invalid']) expect(()=>runtimeEnvironment(instance,{url})).toThrow('Only HTTP CONNECT');
    const env=runtimeEnvironment({...instance,engine:'claude-code'},{url:'http://proxy.invalid'});
    expect(env).toContain('HOME=/var/lib/cindy-native');
    expect(env).toContain('NO_PROXY=localhost,127.0.0.1,::1');
    expect(env.some(value=>value.startsWith('CLAUDE_CONFIG_DIR='))).toBe(false);
  });
});
