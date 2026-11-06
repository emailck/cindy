// Opt-in integration, never part of default unit tests. Requires a built CLI image and local Docker.
// TMPDIR=/var/tmp CINDY_MANAGER_IMAGE=cindy-host:local node --experimental-transform-types scripts/smoke-docker-runtime.mjs
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import Docker from 'dockerode';
const run = promisify(execFile);
const docker = new Docker({ socketPath: process.env.CINDY_MANAGER_DOCKER_SOCKET ?? '/var/run/docker.sock' });
const image = process.env.CINDY_MANAGER_IMAGE ?? 'cindy-host:local';
const fixtureImage = `cindy-host-manager-smoke:${randomUUID()}`;
const temporary = await mkdtemp(path.join(os.tmpdir(), 'cindy-docker-smoke-'));
const managerRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const bundledRuntime=path.join(temporary,'runtime.cjs');
await build({stdin:{contents:"export { DockerRuntimeAdapter, runtimeEnvironment } from './src/docker-runtime.ts'; export { CODEX_ACCOUNT_PROBE } from './src/account-identity.ts';",resolveDir:managerRoot},outfile:bundledRuntime,bundle:true,packages:'external',platform:'node',format:'cjs',target:'node24',banner:{js:`module.paths.push(${JSON.stringify(path.join(managerRoot,'node_modules'))});`}});
const {DockerRuntimeAdapter,runtimeEnvironment,CODEX_ACCOUNT_PROBE}=createRequire(import.meta.url)(bundledRuntime);
const instances = [];
const owned = 'io.cindy.host-manager';
const resourceName = instance => `cindy-managed-${instance.id}`;
const runtime = new DockerRuntimeAdapter({ image, docker });
let fixtureBuilt = false;
function instance(engine) { const value = {id:randomUUID(),engine}; instances.push(value);return value; }
async function waitExit(login) {
  return new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error('Login did not exit')),10_000);
    login.onExit(code=>{clearTimeout(timeout);resolve(code);});
  });
}
async function nativeVolume(target, script, selectedImage=image) {
  // Only UUID test volumes allocated by this script; never mount a real instance or user directory.
  assert.ok(instances.includes(target));
  return run('docker',['run','--rm','--network','none','--user','1000:1000',
    '--mount',`type=volume,src=${resourceName(target)}-native,dst=/var/lib/cindy-native,volume-nocopy`,
    '--mount',`type=volume,src=${resourceName(target)}-profile,dst=/var/lib/cindy-host,volume-nocopy`,
    ...runtimeEnvironment(target).flatMap(value=>['--env',value]),
    '--entrypoint','node',selectedImage,'-e',script],{timeout:30_000});
}
async function nativeAccountWithoutSideEffects(target) {
  // Test-only auth byte comparison and loopback tripwire. The production probe never reads auth files.
  const prefix=String.raw`const fixtureFs=require('node:fs'),fixtureAssert=require('node:assert/strict'),fixtureHttp=require('node:http');const fixtureAuth=process.env.CODEX_HOME+'/auth.json';const fixtureBefore=fixtureFs.existsSync(fixtureAuth)?fixtureFs.readFileSync(fixtureAuth):null;let fixtureAttempts=0;const fixtureServer=fixtureHttp.createServer((request,response)=>{fixtureAttempts++;response.writeHead(502);response.end();});fixtureServer.on('connect',(request,socket)=>{fixtureAttempts++;socket.destroy();});fixtureServer.listen(0,'127.0.0.1',()=>{for(const key of ['HTTP_PROXY','HTTPS_PROXY','http_proxy','https_proxy'])process.env[key]='http://127.0.0.1:'+fixtureServer.address().port;const fixtureWrite=process.stdout.write.bind(process.stdout);process.stdout.write=data=>{fixtureAssert.equal(fixtureAttempts,0,'Native metadata probe attempted network I/O');const after=fixtureFs.existsSync(fixtureAuth)?fixtureFs.readFileSync(fixtureAuth):null;fixtureAssert.deepEqual(after,fixtureBefore,'Native metadata probe changed auth bytes');fixtureServer.close();return fixtureWrite(data);};`;
  return nativeVolume(target,prefix+CODEX_ACCOUNT_PROBE+'});');
}
async function assertNativeDirectory(target,selectedImage=image) {
  const suffix=target.engine==='codex'?'.codex':'.claude';
  await nativeVolume(target,`const fs=require('node:fs'),assert=require('node:assert/strict');const p='/var/lib/cindy-native/${suffix}';const info=fs.lstatSync(p);assert.ok(info.isDirectory()&&!info.isSymbolicLink());assert.equal(info.uid,1000);assert.equal(info.mode&0o777,0o700);fs.accessSync(p,fs.constants.W_OK|fs.constants.X_OK);`,selectedImage);
}
async function assertCodexLoggedOut(target) {
  const result=await run('docker',['run','--rm','--user','1000:1000',
    '--mount',`type=volume,src=${resourceName(target)}-native,dst=/var/lib/cindy-native,volume-nocopy`,
    ...runtimeEnvironment(target).flatMap(value=>['--env',value]),
    '--entrypoint','/opt/cindy-host/codex/bin/codex',image,'login','status'],{timeout:30_000}).then(value=>({...value,code:0}),error=>({stdout:error.stdout??'',stderr:error.stderr??'',code:error.code}));
  assert.equal(result.code,1);
  const output=result.stdout+result.stderr;
  assert.match(output,/^Not logged in\r?$/m);
  assert.doesNotMatch(output,/CODEX_HOME.*(?:not exist|missing)|(?:error|failed).*config/i);
}
async function cleanup() {
  for(const target of instances) {
    const containers = await docker.listContainers({all:true,filters:JSON.stringify({label:[`${owned}=1`,`${owned}.instance=${target.id}`]})});
    for(const item of containers) {
      assert.equal(item.Labels[`${owned}.instance`],target.id);
      const container=docker.getContainer(item.Id);
      if((await container.inspect()).State.Running) {
        await container.kill({signal:'SIGTERM'});
        await container.wait();
      }
      await container.remove();
    }
    for(const role of ['profile','native']) {
      const volume=docker.getVolume(`${resourceName(target)}-${role}`);
      try { const data=await volume.inspect();assert.equal(data.Labels[`${owned}.instance`],target.id);await volume.remove(); }
      catch(error) {if(error.statusCode!==404) throw error;}
    }
  }
  if(fixtureBuilt) await docker.getImage(fixtureImage).remove();
  await rm(temporary,{recursive:true,force:true});
}
try {
  // Phase 1: actual production image/CLI; unique empty volumes, no official account login.
  for(const engine of ['codex','claude-code']) {
    const target=instance(engine);
    await runtime.create(target);
    await assertNativeDirectory(target);
    if(engine==='codex') await assertCodexLoggedOut(target);
    const checked=await runtime.check(target);
    assert.equal(checked.state,'stopped');
    assert.equal(checked.authentication.cindy,'missing');
    assert.equal(checked.authentication.provider,'missing');
    if(engine==='codex') {
      await nativeVolume(target,`const fs=require('node:fs');fs.writeFileSync('/var/lib/cindy-native/fixture-retained','native-marker');fs.writeFileSync('/var/lib/cindy-host/fixture-retained','cindy-marker');fs.rmSync(process.env.CODEX_HOME,{recursive:true});`);
      assert.equal((await runtime.check(target)).authentication.provider,'missing');
      await assertNativeDirectory(target);await assertCodexLoggedOut(target);
      const preserved=`const fs=require('node:fs'),assert=require('node:assert/strict');assert.equal(fs.readFileSync('/var/lib/cindy-native/fixture-retained','utf8'),'native-marker');assert.equal(fs.readFileSync('/var/lib/cindy-host/fixture-retained','utf8'),'cindy-marker');assert.equal(fs.readFileSync(process.env.CODEX_HOME+'/config.toml','utf8'),'# synthetic retained configuration\\n');assert.equal(fs.statSync(process.env.CODEX_HOME).mode&0o777,0o750);`;
      await nativeVolume(target,`const fs=require('node:fs');fs.writeFileSync(process.env.CODEX_HOME+'/config.toml','# synthetic retained configuration\\n');fs.chmodSync(process.env.CODEX_HOME,0o750);`);
      await runtime.check(target);await nativeVolume(target,preserved);
      await nativeVolume(target,`const fs=require('node:fs');fs.renameSync(process.env.CODEX_HOME,process.env.CODEX_HOME+'-retained');fs.symlinkSync(process.env.CODEX_HOME+'-retained',process.env.CODEX_HOME);`);
      await assert.rejects(runtime.check(target),{code:'NATIVE_DIRECTORY_UNAVAILABLE'});
      await nativeVolume(target,`const fs=require('node:fs');if(!fs.lstatSync(process.env.CODEX_HOME).isSymbolicLink())throw Error('Expected retained symlink');fs.unlinkSync(process.env.CODEX_HOME);fs.renameSync(process.env.CODEX_HOME+'-retained',process.env.CODEX_HOME);`);
      await nativeVolume(target,preserved);
      const emptyAccount=await nativeAccountWithoutSideEffects(target);
      assert.equal(JSON.parse(emptyAccount.stdout),null);
      // Explicitly synthetic tokens, generated inside this script's new private test volume.
      // The manager/probe never reads auth.json: native accountSession/list owns loading these fixture credentials.
      await nativeVolume(target,`const fs=require('node:fs');const token=Buffer.from(JSON.stringify({alg:'none',typ:'JWT'})).toString('base64url')+'.'+Buffer.from(JSON.stringify({email:'native-fixture@example.test',exp:4102444800,'https://api.openai.com/auth':{chatgpt_account_id:'fixture-only',chatgpt_user_id:'fixture-user-only',chatgpt_plan_type:'pro'}})).toString('base64url')+'.c3ludGhldGlj';fs.writeFileSync(process.env.CODEX_HOME+'/auth.json',JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:token,id_token:token,refresh_token:'invalid-fixture-refresh',account_id:'fixture-only'},last_refresh:new Date().toISOString()}),{mode:0o600});`);
      const account=await nativeAccountWithoutSideEffects(target);
      assert.deepEqual(JSON.parse(account.stdout),{loginMethod:'chatgpt',email:'native-fixture@example.test'});
      assert.doesNotMatch(account.stdout,/invalid-fixture|access_token|id_token|refresh_token|fixture-only/);
      const projected=(await runtime.check(target)).accounts;
      assert.deepEqual(projected,{cindy:null,provider:{loginMethod:'chatgpt',email:'native-fixture@example.test'}});
      console.log('production codex: native accountSession/list current identity passed; zero network attempts, auth bytes unchanged, token fields absent');
      console.log('production codex: new/legacy directory repair, real Not logged in result, existing config/modes/markers retained, unsafe symlink refused');
    }
    const binary=engine==='codex'?'/opt/cindy-host/codex/bin/codex':'/opt/cindy-host/claude/claude';
    const version=await run('docker',['run','--rm','--entrypoint',binary,image,'--version'],{timeout:30_000});
    assert.match(version.stdout,/\d+\.\d+/);
    console.log(`production ${engine}: empty-profile check, native binary version passed (${version.stdout.trim()})`);
  }
  // Phase 2 is intentionally a fake CLI overlay: exercises actual Docker transport and persistent mounts.
  if(process.env.CINDY_DOCKER_SMOKE_NATIVE_ONLY!=='1') {
  const fake=String.raw`#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2), host=path.basename(process.argv[1])==='cindy-host';
const profile=process.env.CINDY_HOST_DATA_DIR,native=process.env.HOME;
const marker=path.join(host?profile:native,host?'fixture-cindy':'fixture-provider');
if(args[0]==='status') console.log(JSON.stringify({runtime:{savedAuthentication:fs.existsSync(marker)}}));
else if(host&&args[0]==='config') fs.writeFileSync(path.join(profile,'config.json'),JSON.stringify({remoteAccessEnabled:true}));
else if(host&&args[0]==='serve') {
 if(!JSON.parse(fs.readFileSync(path.join(profile,'config.json'))).remoteAccessEnabled) process.exit(1);
 fs.writeFileSync(path.join(profile,'fixture-service'),'retained');
 process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);
} else if(host&&args[0]==='share') console.log(JSON.stringify({shares:{requests:[],members:[]},usage:{},action:args[1]}));
else if(args.includes('status')) {
 if(host) throw Error('unexpected');
 const loggedIn=fs.existsSync(marker);
 console.log(process.env.CINDY_HOST_AGENT==='claude-code'?JSON.stringify({loggedIn,authMethod:'claude.ai',apiProvider:'firstParty'}):(loggedIn?'Logged in':'Not logged in'));
 process.exit(loggedIn?0:1);
} else if(args.includes('login')) {
 process.stdout.write('FAKE LOGIN ONLY: enter complete\r\n');
 if(process.stdin.isTTY)process.stdin.setRawMode(true);
 let data='';process.stdin.on('data',chunk=>{
  data+=chunk;if(data.includes('complete')){fs.writeFileSync(marker,'fixture-only-no-credentials');process.stdout.write('FAKE LOGIN COMPLETE\r\n');process.exit(0);}
 });
 process.on('SIGTERM',()=>process.exit(0));
} else process.exit(1);
`;
  await writeFile(path.join(temporary,'fake.cjs'),fake,{mode:0o755});
  // Image is trusted deployment configuration, not browser input; JSON COPY keeps paths literal.
  await writeFile(path.join(temporary,'Dockerfile'),`FROM ${image}\nUSER root\nCOPY --chmod=755 fake.cjs /usr/local/bin/cindy-host\nCOPY --chmod=755 fake.cjs /opt/cindy-host/codex/bin/codex\nCOPY --chmod=755 fake.cjs /opt/cindy-host/claude/claude\nUSER node\n`);
  await run('docker',['build','--tag',fixtureImage,temporary],{timeout:60_000,maxBuffer:1024*1024});fixtureBuilt=true;
  const fakeRuntime=new DockerRuntimeAdapter({image:fixtureImage,docker});
  for(const engine of ['codex','claude-code']) {
    const target=instance(engine);await fakeRuntime.create(target);
    const ownership=await run('docker',['run','--rm','--volume',`${resourceName(target)}-native:/v`,'--entrypoint','stat',fixtureImage,'-c','%u %g %a','/v']);assert.equal(ownership.stdout.trim(),'1000 1000 700','Native HOME ownership must survive empty-volume reuse');
    if(engine==='codex') await nativeVolume(target,`const fs=require('node:fs');fs.writeFileSync('/var/lib/cindy-host/fixture-retained','cindy-marker');fs.rmSync(process.env.CODEX_HOME,{recursive:true});`,fixtureImage);
    const login=await fakeRuntime.openLogin(target,{target:'provider'});
    await assertNativeDirectory(target,fixtureImage);
    if(engine==='codex') await nativeVolume(target,`const fs=require('node:fs');if(fs.readFileSync('/var/lib/cindy-host/fixture-retained','utf8')!=='cindy-marker')throw Error('Cindy marker changed');`,fixtureImage);
    let output='';login.onOutput(data=>{output+=data;});
    await assert.rejects(fakeRuntime.start(target),{code:'INSTANCE_RUNNING'});
    await login.resize(100,30);
    const exited=waitExit(login);login.input('complete\r');assert.equal(await exited,0,output);
    assert.match(output,/FAKE LOGIN COMPLETE/);
    assert.equal((await fakeRuntime.check(target)).authentication.provider,'authenticated');
    const cancelled=await fakeRuntime.openLogin(target,{target:'cindy',method:'google'});
    const cancelledExit=waitExit(cancelled);await cancelled.cancel();assert.ok([0,143].includes(await cancelledExit),'Cancellation must stop the login process');
    if(engine==='codex') await nativeVolume(target,`require('node:fs').rmSync(process.env.CODEX_HOME,{recursive:true});`,fixtureImage);
    await fakeRuntime.start(target);assert.equal((await fakeRuntime.inspect(target)).state,'running');
    await assertNativeDirectory(target,fixtureImage);
    if(engine==='codex') {
      await nativeVolume(target,`require('node:fs').rmSync(process.env.CODEX_HOME,{recursive:true});`,fixtureImage);
      assert.equal((await fakeRuntime.check(target)).authentication.provider,'authenticated');
      await assertNativeDirectory(target,fixtureImage);
      console.log('fixture codex: legacy login/start/running-check recreate missing .codex and retain Cindy marker');
    }
    await assert.rejects(fakeRuntime.openLogin(target,{target:'provider'}),{code:'INSTANCE_RUNNING'});
    assert.equal((await fakeRuntime.share(target,{action:'list'})).action,'list');
    await fakeRuntime.stop(target);assert.equal((await fakeRuntime.inspect(target)).state,'stopped');
    await fakeRuntime.start(target);await fakeRuntime.stop(target);
    assert.equal((await fakeRuntime.check(target)).authentication.provider,'authenticated');
    assert.equal((await docker.getVolume(`${resourceName(target)}-profile`).inspect()).Labels[`${owned}.instance`],target.id);
    console.log(`fixture ${engine}: real Docker native directory preparation, TTY input/cancel, exclusivity, share, graceful stop/restart and retained native auth passed`);
  }
  }
  console.log('No official accounts, real credentials, or real proxy egress were used.');
} finally { await cleanup(); }
