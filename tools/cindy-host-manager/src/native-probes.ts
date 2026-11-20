import type { Engine, ProviderTest, ProviderUsage, UsageWindow } from './runtime-types.js';

// Every probe below runs *inside* the managed container through the native CLI.
// The manager never reads credential files or calls a provider API itself.
const CODEX = '/opt/cindy-host/codex/bin/codex';
const CLAUDE = '/opt/cindy-host/claude/claude';
/** In-container deadline; stays below the 30s Docker command and federation RPC bounds. */
export const PROBE_DEADLINE_MS = 24_000;

// Shared process-group helpers. The probe prints exactly one JSON line, then exits.
const PRELUDE = String.raw`
const {spawn}=require('node:child_process'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
let settled=false,child,bytes=0;
const kill=signal=>{try{if(child&&child.pid)process.kill(-child.pid,signal);}catch{try{child&&child.kill(signal);}catch{}}};
const finish=value=>{if(settled)return;settled=true;clearTimeout(timer);kill('SIGTERM');setTimeout(()=>{kill('SIGKILL');process.stdout.write(JSON.stringify(value)+'\n',()=>process.exit(0));},500);};
const timer=setTimeout(()=>finish(onTimeout()),${PROBE_DEADLINE_MS});
process.once('SIGTERM',()=>{kill('SIGKILL');process.exit(1);});
const lines=(stream,each)=>{let pending='';stream.setEncoding('utf8');stream.on('error',()=>{});stream.on('data',chunk=>{if(settled)return;bytes+=Buffer.byteLength(chunk);if(bytes>1048576){finish({failed:'too-large'});return;}pending+=chunk;let i;while(!settled&&(i=pending.indexOf('\n'))>=0){const line=pending.slice(0,i);pending=pending.slice(i+1);let row;try{row=JSON.parse(line);}catch{continue;}if(row&&typeof row==='object')each(row);}});};
`;

// Codex app-server would otherwise refresh model discovery on initialize, which can rotate
// auth on a failed request. A temporary private catalog disables that side effect.
const CODEX_APP_SERVER = String.raw`
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'cindy-usage-probe-')),catalog=path.join(temporary,'models.json');
process.once('exit',()=>{kill('SIGKILL');try{fs.rmSync(temporary,{recursive:true,force:true});}catch{}});
fs.writeFileSync(catalog,JSON.stringify({models:[{slug:'cindy-usage-probe',display_name:'Usage probe',description:null,supported_reasoning_levels:[],shell_type:'unified_exec',visibility:'none',supported_in_api:true,priority:99,base_instructions:'',include_skills_usage_instructions:false,include_plugin_usage_instructions:false,include_apps_usage_instructions:false,supports_reasoning_summary_parameter:true,default_reasoning_summary:'auto',support_verbosity:false,truncation_policy:{mode:'bytes',limit:10000},context_window:272000,max_context_window:272000,effective_context_window_percent:95,experimental_supported_tools:[],apply_patch_tool_type:null,supports_search_tool:false}]}),{mode:0o600});
child=spawn(${JSON.stringify(CODEX)},['app-server','-c','features.plugins=false','-c','features.remote_plugin=false','-c','model_catalog_json='+JSON.stringify(catalog)],{detached:true,stdio:['pipe','pipe','ignore'],env:process.env});
`;

/** `claude -p` / `codex exec` with the single prompt "hi". Consumes a small amount of quota. */
export function helloProbe(engine: Engine): string {
  if (engine === 'codex') return PRELUDE + String.raw`
let reply,lastError;
const onTimeout=()=>({timedOut:true,reply,error:lastError});
child=spawn(${JSON.stringify(CODEX)},['exec','--ephemeral','--skip-git-repo-check','--json','-s','read-only','--','hi'],{detached:true,stdio:['ignore','pipe','ignore'],env:process.env});
child.on('error',()=>finish({error:'spawn'}));
child.on('close',code=>finish(reply!==undefined&&code===0?{ok:true,reply}:{error:lastError,exitCode:code}));
lines(child.stdout,row=>{
 if(row.type==='item.completed'&&row.item&&row.item.type==='agent_message'&&typeof row.item.text==='string')reply=row.item.text;
 else if(row.type==='error'&&typeof row.message==='string')lastError=row.message;
 else if(row.type==='turn.failed')finish({error:row.error&&typeof row.error.message==='string'?row.error.message:lastError});
 else if(row.type==='turn.completed')finish(reply!==undefined?{ok:true,reply}:{error:lastError});
});
`;
  return PRELUDE + String.raw`
const onTimeout=()=>({timedOut:true});
child=spawn(${JSON.stringify(CLAUDE)},['-p','--output-format','json','--no-session-persistence','--strict-mcp-config','--setting-sources','user','--tools',''],{detached:true,stdio:['pipe','pipe','ignore'],env:process.env});
child.on('error',()=>finish({error:'spawn'}));
child.stdin.on('error',()=>{});
let result;
child.on('close',code=>finish(result?{ok:result.is_error!==true&&result.subtype==='success',reply:result.is_error===true?undefined:result.result,error:result.is_error===true?result.result:undefined,model:result.modelUsage&&typeof result.modelUsage==='object'?Object.keys(result.modelUsage)[0]:undefined}:{exitCode:code}));
lines(child.stdout,row=>{if(row.type==='result')result=row;});
child.stdin.end('hi');
`;
}

/** Native subscription/quota read: Claude `get_usage` control request, Codex `account/rateLimits/read`. No model call. */
export function usageProbe(engine: Engine): string {
  if (engine === 'codex') return PRELUDE + CODEX_APP_SERVER + String.raw`
const onTimeout=()=>({failed:'timeout'});
child.on('error',()=>finish({failed:'spawn'}));child.stdin.on('error',()=>{});
child.on('close',()=>finish({failed:'exited'}));
lines(child.stdout,row=>{
 if(row.id===1){if(row.error){finish({failed:'initialize',message:row.error.message});return;}
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'initialized'})+'\n');
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:2,method:'account/rateLimits/read'})+'\n');}
 else if(row.id===2)finish(row.error?{failed:'read',message:row.error.message}:{result:row.result});
});
child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{clientInfo:{name:'cindy_host_manager_usage',version:'0.1.0'},capabilities:{experimentalApi:true}}})+'\n');
`;
  return PRELUDE + String.raw`
const onTimeout=()=>({failed:'timeout'});
child=spawn(${JSON.stringify(CLAUDE)},['-p','--input-format','stream-json','--output-format','stream-json','--verbose','--no-session-persistence','--strict-mcp-config','--setting-sources','user'],{detached:true,stdio:['pipe','pipe','ignore'],env:process.env});
child.on('error',()=>finish({failed:'spawn'}));child.stdin.on('error',()=>{});
child.on('close',()=>finish({failed:'exited'}));
lines(child.stdout,row=>{
 if(row.type!=='control_response'||!row.response||row.response.request_id!=='cindy-usage')return;
 if(row.response.subtype!=='success'){finish({failed:'read',message:row.response.error});return;}
 const body=row.response.response||{};
 finish({plan:body.subscription_type,available:body.rate_limits_available,rateLimits:body.rate_limits});
});
child.stdin.write(JSON.stringify({type:'control_request',request_id:'cindy-init',request:{subtype:'initialize'}})+'\n');
child.stdin.write(JSON.stringify({type:'control_request',request_id:'cindy-usage',request:{subtype:'get_usage',skip_behaviors:true}})+'\n');
`;
}

// ── Manager-side allowlisted projection. Never spread or forward native objects. ──

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
/** Visible, bounded single-line text: ANSI and control characters removed. */
export function displayText(value: unknown, maximum = 500): string | undefined {
  if (typeof value !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > maximum ? `${text.slice(0, maximum - 1)}…` : text;
}
const percent = (value: unknown): number | undefined => {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number) ? Math.min(100, Math.max(0, number)) : undefined;
};
/** ISO string or epoch seconds → ISO string. */
const resetTime = (value: unknown): string | undefined => {
  const ms = typeof value === 'number' && value > 0 ? value * 1000 : typeof value === 'string' && value ? Date.parse(value) : NaN;
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : undefined;
};
const minutes = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;

function parseProbeLine(output: string): Record<string, unknown> | null {
  const lines = output.split('\n').map(line => line.trim()).filter(Boolean);
  try { return record(JSON.parse(lines[lines.length - 1] ?? '')); } catch { return null; }
}

export function helloResult(output: string, durationMs: number, now = new Date()): ProviderTest {
  const value = parseProbeLine(output);
  const base = { durationMs: Math.max(0, Math.round(durationMs)), checkedAt: now.toISOString() };
  if (!value) return { ...base, ok: false };
  const reply = displayText(value.reply);
  const error = displayText(value.error, 300);
  const model = displayText(value.model, 100);
  const ok = value.ok === true && !!reply;
  return { ...base, ok, ...(reply ? { reply } : {}), ...(!ok && error && error !== 'spawn' ? { error } : {}),
    ...(model ? { model } : {}), ...(value.timedOut === true ? { timedOut: true } : {}) };
}

function unavailable(value: Record<string, unknown> | null, now: Date): ProviderUsage {
  const error = displayText(value?.message, 300);
  return { state: 'unavailable', windows: [], checkedAt: now.toISOString(),
    ...(error ? { error } : {}), ...(value?.failed === 'timeout' ? { timedOut: true } : {}) };
}

export function claudeUsageResult(output: string, now = new Date()): ProviderUsage {
  const value = parseProbeLine(output);
  if (!value || value.failed !== undefined) return unavailable(value, now);
  const plan = displayText(value.plan, 80);
  const base = { checkedAt: now.toISOString(), ...(plan ? { plan } : {}) };
  if (value.available === false) return { ...base, state: 'no-limits', windows: [] };
  const data = record(value.rateLimits);
  if (!data) return { ...unavailable(null, now), ...base };
  const windows: UsageWindow[] = [];
  const add = (kind: UsageWindow['kind'], raw: unknown, field: 'percent' | 'utilization', label?: string, windowMinutes?: number) => {
    const entry = record(raw); const used = percent(entry?.[field]);
    if (used === undefined || windows.length >= 32) return;
    const resetsAt = resetTime(entry?.resets_at);
    windows.push({ kind, usedPercent: used, ...(label ? { label } : {}), ...(resetsAt ? { resetsAt } : {}), ...(windowMinutes ? { windowMinutes } : {}) });
  };
  for (const raw of Array.isArray(data.limits) ? data.limits : []) {
    const entry = record(raw);
    if (entry?.kind === 'session') add('session', entry, 'percent', undefined, 300);
    else if (entry?.kind === 'weekly_all') add('week', entry, 'percent', undefined, 10080);
    else if (entry?.kind === 'weekly_scoped') {
      const label = displayText(record(record(entry.scope)?.model)?.display_name, 80);
      if (label) add('model', entry, 'percent', label, 10080);
    }
  }
  // Older get_usage bodies use top-level keys; limits[] wins whenever it is present.
  if (!windows.some(window => window.kind === 'session')) add('session', data.five_hour, 'utilization', undefined, 300);
  if (!windows.some(window => window.kind === 'week')) add('week', data.seven_day, 'utilization', undefined, 10080);
  for (const [key, label] of [['seven_day_opus', 'Opus'], ['seven_day_sonnet', 'Sonnet'], ['seven_day_fable', 'Fable']] as const)
    if (!windows.some(window => window.kind === 'model' && window.label?.toLowerCase().includes(label.toLowerCase())))
      add('model', data[key], 'utilization', label, 10080);
  const extra = record(data.extra_usage);
  const extraUsed = percent(extra?.utilization);
  const extraUsage = extra && (extra.is_enabled === true || extraUsed !== undefined)
    ? { enabled: extra.is_enabled === true, ...(extraUsed !== undefined ? { usedPercent: extraUsed } : {}) } : undefined;
  if (!windows.length && !extraUsage) return { ...unavailable(null, now), ...base };
  return { ...base, state: 'ready', windows, ...(extraUsage ? { extraUsage } : {}) };
}

export function codexUsageResult(output: string, now = new Date()): ProviderUsage {
  const value = parseProbeLine(output);
  if (!value || value.failed !== undefined) return unavailable(value, now);
  const response = record(value.result);
  const main = record(response?.rateLimits);
  if (!response || !main) return unavailable(null, now);
  const windows: UsageWindow[] = [];
  let reached = false;
  const addBucket = (bucket: Record<string, unknown>, label?: string) => {
    if (displayText(bucket.rateLimitReachedType, 80)) reached = true;
    for (const raw of [bucket.primary, bucket.secondary]) {
      const entry = record(raw); const used = percent(entry?.usedPercent);
      if (used === undefined || windows.length >= 32) continue;
      const windowMinutes = minutes(entry?.windowMinutes) ?? minutes(entry?.windowDurationMins);
      const resetsAt = resetTime(entry?.resetsAt);
      const kind: UsageWindow['kind'] = label ? 'model' : windowMinutes === undefined ? 'other' : windowMinutes >= 10080 ? 'week' : 'session';
      windows.push({ kind, usedPercent: used, ...(label ? { label } : {}), ...(resetsAt ? { resetsAt } : {}), ...(windowMinutes ? { windowMinutes } : {}) });
    }
  };
  addBucket(main);
  // Model-specific buckets are shown separately; they must never impersonate the account window.
  const mainId = typeof main.limitId === 'string' ? main.limitId : 'codex';
  for (const [id, raw] of Object.entries(record(response.rateLimitsByLimitId) ?? {}).slice(0, 16)) {
    const bucket = record(raw);
    if (!bucket || id === mainId || ['codex', '__default__', 'default'].includes(id)) continue;
    const label = displayText(bucket.limitName, 80) ?? displayText(id, 80);
    if (label) addBucket(bucket, label);
  }
  const plan = displayText(main.planType, 80);
  const rawCredits = record(main.credits);
  const balance = displayText(rawCredits?.balance, 40);
  const credits = rawCredits && (rawCredits.hasCredits === true || rawCredits.unlimited === true)
    ? { hasCredits: rawCredits.hasCredits === true, unlimited: rawCredits.unlimited === true, ...(balance ? { balance } : {}) } : undefined;
  if (!windows.length && !credits) return { ...unavailable(null, now), ...(plan ? { plan } : {}) };
  return { state: 'ready', checkedAt: now.toISOString(), windows, ...(plan ? { plan } : {}),
    ...(credits ? { credits } : {}), ...(reached ? { limitReached: true } : {}) };
}
