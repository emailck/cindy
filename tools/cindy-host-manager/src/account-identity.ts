import type { AccountIdentity } from './runtime-types.js';
const methods = new Set(['cindy', 'chatgpt', 'claude', 'api-key']);
export function safeAccountText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== 'string' || /[\x00-\x1f\x7f-\x9f]/.test(value)) return undefined;
  const text = value.trim(); return text && text.length <= maximum ? text : undefined;
}
/** Public presentation fields only. Never spread or stringify an upstream account object. */
export function sanitizeAccount(value: unknown, method?: AccountIdentity['loginMethod']): AccountIdentity | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const result: AccountIdentity = {};
  for (const [field, maximum] of [['displayName', 200], ['email', 320], ['plan', 80], ['organization', 200]] as const) {
    const text = safeAccountText(input[field], maximum);
    if (text && (field !== 'email' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text))) result[field] = text;
  }
  const loginMethod = method ?? input.loginMethod;
  if (typeof loginMethod === 'string' && methods.has(loginMethod)) result.loginMethod = loginMethod as AccountIdentity['loginMethod'];
  return Object.keys(result).length ? result : null;
}

// Executed inside the managed container: only this allowlisted projection crosses its stdout.
// Native app-server owns auth loading; no credential file access or JWT decoding in the manager.
// account/read performs workspace routing I/O in 0.166; accountSession/list(false) reads only its cache.
export const CODEX_ACCOUNT_PROBE = String.raw`
const {spawn}=require('node:child_process'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'cindy-account-probe-')),catalog=path.join(temporary,'models.json');
// Native initialize otherwise refreshes model discovery and may rotate auth on a failed request.
// This private control probe never starts a thread; its temporary catalog disables that network side effect.
fs.writeFileSync(catalog,JSON.stringify({models:[{slug:'cindy-account-probe',display_name:'Account probe',description:null,supported_reasoning_levels:[],shell_type:'unified_exec',visibility:'none',supported_in_api:true,priority:99,base_instructions:'',include_skills_usage_instructions:false,include_plugin_usage_instructions:false,include_apps_usage_instructions:false,supports_reasoning_summary_parameter:true,default_reasoning_summary:'auto',support_verbosity:false,truncation_policy:{mode:'bytes',limit:10000},context_window:272000,max_context_window:272000,effective_context_window_percent:95,experimental_supported_tools:[],apply_patch_tool_type:null,supports_search_tool:false}]}),{mode:0o600});
const child=spawn('/opt/cindy-host/codex/bin/codex',['app-server','-c','features.plugins=false','-c','features.remote_plugin=false','-c','model_catalog_json='+JSON.stringify(catalog)],{detached:true,stdio:['pipe','pipe','ignore'],env:process.env});
let pending='',bytes=0,settled=false,answer=null,killTimer;
const text=(value,max)=>typeof value==='string'&&!/[\x00-\x1f\x7f-\x9f]/.test(value)&&value.trim()&&value.trim().length<=max?value.trim():undefined;
const project=value=>{
 if(!value||typeof value!=='object'||Array.isArray(value)||typeof value.activeSessionId!=='string'||!Array.isArray(value.sessions))return null;
 const active=value.sessions.filter(session=>session&&session.sessionId===value.activeSessionId&&session.isActive===true);
 if(active.length!==1)return null;
 const result={loginMethod:'chatgpt'},email=text(active[0].email,320),displayName=text(active[0].displayName,200);
 if(email&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))result.email=email;
 if(displayName)result.displayName=displayName;
 return result;
};
const kill=signal=>{try{if(child.pid)process.kill(-child.pid,signal);}catch{try{child.kill(signal);}catch{}}};
const finish=value=>{if(settled)return;settled=true;answer=value??null;clearTimeout(timer);kill('SIGTERM');killTimer=setTimeout(()=>{kill('SIGKILL');process.stdout.write(JSON.stringify(answer)+'\n');},1000);};
const timer=setTimeout(()=>finish(),8000);
child.on('error',()=>finish());child.stdin.on('error',()=>finish());child.stdout.on('error',()=>finish());
child.on('close',()=>{if(!settled)finish();});
process.once('exit',()=>{kill('SIGKILL');try{fs.rmSync(temporary,{recursive:true,force:true});}catch{}});
process.once('SIGTERM',()=>{kill('SIGKILL');process.exit(1);});
child.stdout.setEncoding('utf8');
child.stdout.on('data',chunk=>{
 if(settled)return;bytes+=Buffer.byteLength(chunk);if(bytes>262144){finish();return;}pending+=chunk;
 let newline;while(!settled&&(newline=pending.indexOf('\n'))>=0){const line=pending.slice(0,newline);pending=pending.slice(newline+1);let row;try{row=JSON.parse(line);}catch{finish();return;}
 if(!row||typeof row!=='object'){finish();return;}
 if(row.id===1){if(row.error){finish();return;}child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'initialized'})+'\n');child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:2,method:'accountSession/list',params:{refreshWorkspaceMetadata:false}})+'\n');}
 if(row.id===2){finish(row.error?null:project(row.result));return;}
 }
});
child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{clientInfo:{name:'cindy_host_manager_accounts',version:'0.1.0'},capabilities:{experimentalApi:true}}})+'\n');
// Keep the bounded group cleanup timer alive even if Codex exits before its descendants.
`;
