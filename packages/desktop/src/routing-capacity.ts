import { getClaudeDetails } from './claude-auth.js';
import { grantCapacity, grantFunding } from './grant-capacity.js';
import type { ApiConnection,CapacitySnapshot,CapacityRow } from '@kanborg/api';
import { readClaudeSubscriptionUsage } from '@kanborg/api';
import { listApiConnections } from './api-connections.js';
import { getAnthropicReportingAccounts,updateAnthropicReporting } from './anthropic-reporting.js';
import { manageCodexResets } from './subscription-resets.js';
import { readRouting,routingState,charged } from './routing-state.js';
import { modelCatalogue,selectApiModel,type PricedModel } from './routing-models.js';
export type Candidate={id:string;provider:'claude-code'|'codex-cli';kind:'api'|'subscription';score:number;reason:string;row?:ApiConnection;model?:PricedModel;pool?:string;available?:number;since?:number;funding?:'grant'|'paid';deadline?:number};
let configuration:()=>Array<{id:string;enabled:boolean}>=()=>[];
export function configureRoutingProviders(fn:typeof configuration){configuration=fn;}
const reportingAttempts = new Map<string, number>();
let cached:{at:number;snapshot:CapacitySnapshot;candidates:Candidate[]}|undefined;
let pending:Promise<{snapshot:CapacitySnapshot;candidates:Candidate[]}>|undefined;
let revision=0;
let settingsKey='';
export function invalidateCapacity(){revision++;cached=undefined;}
export async function collectCapacity(hasWork=false,force=false):Promise<{snapshot:CapacitySnapshot;candidates:Candidate[]}>{
  const nextKey=JSON.stringify([configuration(),listApiConnections(),readRouting().config]);
  if(nextKey!==settingsKey){settingsKey=nextKey;invalidateCapacity();}
  if(!force&&cached&&Date.now()-cached.at<60000)return cached;
  if(pending){const value=await pending;if(cached)return value;return collectCapacity(hasWork,force);}
  const started=revision;
  pending=load(hasWork).then(value=>{if(started===revision)cached={...value,at:Date.now()};return value;}).finally(()=>{pending=undefined;});
  const value=await pending;
  return started===revision?value:collectCapacity(hasWork,force);
}
async function load(hasWork:boolean){
  let now=Date.now();const enabled=new Set(configuration().filter(p=>p.enabled).map(p=>p.id));
  // A successful OAuth quota response already verifies subscription access.
  // Do not launch short-lived CLI auth commands on every monitoring tick.
  const [quota,codex,catalogue]=await Promise.all([
    enabled.has('claude-code')?readClaudeSubscriptionUsage().catch(()=>null):null,
    enabled.has('codex-cli')?manageCodexResets(hasWork).catch(()=>null):null,
    modelCatalogue().catch(()=>[]),
  ]);
  now=Date.now();
  const rows:CapacityRow[]=[];const candidates:Candidate[]=[];
  const state=readRouting();
  if(enabled.has('claude-code')){
    const windows=quota?.windows??[];
    const fresh=quota?.source==='oauth'&&!quota.stale&&!!quota.checkedAt&&now-Date.parse(quota.checkedAt)>=0&&now-Date.parse(quota.checkedAt)<=6*60000&&windows.every(w=>!w.resetsAt||Date.parse(w.resetsAt)>now);
    const used=windows.length?Math.max(...windows.map(w=>w.pct*100)):null;
    const cli = !fresh && quota?.source==='unauthorized' ? await getClaudeDetails().catch(()=>null) : null;
    // A renewable access token is not a revoked CLI login. Let Claude Code own
    // renewal on the next authorized run; never label the old quota as fresh.
    const renewable=cli?.cliAvailable===true&&cli.hasKey&&cli.authenticationLabel==='Claude subscription'&&used!==null&&used<95;
    const usable=(fresh&&used!==null&&used<95)||renewable;
    if(state.config.claudeResetExpiresAt)rows.push({id:'claude-reset',label:'Claude reset offer',kind:'unknown',usedPercent:null,remaining:null,spent:null,available:false,detail:`Manually tracked · ${Date.parse(state.config.claudeResetExpiresAt)>now?'expires':'expired'} ${new Date(state.config.claudeResetExpiresAt).toLocaleString()} · redeem in Claude Usage`});
    const resetSoon=state.config.claudeResetExpiresAt&&Date.parse(state.config.claudeResetExpiresAt)>now&&Date.parse(state.config.claudeResetExpiresAt)-now<48*3600000;
    rows.push({id:'claude-sub',label:'Claude subscription',kind:'subscription',needsAttention:quota?.source==='unauthorized'&&!renewable,stale:!fresh&&used!==null,usedPercent:used,remaining:used!==null?100-used:null,spent:null,available:!!usable,detail:!fresh?`${used!==null?'Last reported quota · ':''}${renewable?'Claude Code is signed in; usage-token renewal is pending. The next eligible subscription run will let the CLI renew it.':quota?.message??'Quota unavailable; retrying automatically.'}${quota?.checkedAt?` Last successful reading ${new Date(quota.checkedAt).toLocaleString()}.`:''}${quota?.retryAt?` Next check ${new Date(quota.retryAt).toLocaleTimeString()}.`:''}`:windows.map(w=>`${w.label}: ${Math.round(w.pct*100)}% used${w.resetsAt?` · resets ${new Date(w.resetsAt).toLocaleString()}`:''}`).join('; ')});
    const resetHours=Math.min(...windows.filter(w=>w.resetsAt&&Date.parse(w.resetsAt)>now).map(w=>(Date.parse(w.resetsAt!)-now)/3600000));
    if(usable)candidates.push({id:'claude-sub',provider:'claude-code',kind:'subscription',score:renewable?100:resetSoon?280:resetHours<24?270-resetHours:180-(used??0)/10,reason:renewable?'Authenticated Claude subscription; CLI-managed renewal pending (quota is last known)':resetSoon?'Use included capacity before the tracked Claude reset expires':resetHours<24?'Use subscription quota before its approaching reset':'Available Claude subscription quota'});
  }
  if(enabled.has('codex-cli')){
    const usage=codex?.subscriptionUsage;
    const used=usage?.windows.length?Math.max(...usage.windows.map(w=>w.usedPercent)):null;
    const fresh=!!usage?.checkedAt && now-Date.parse(usage.checkedAt)>=0&&now-Date.parse(usage.checkedAt)<=6*60000 && !codex?.subscriptionUsageError && usage.windows.every(w=>!w.resetsAt||w.resetsAt*1000>now);
    const usable=fresh&&codex?.authenticationLabel==='ChatGPT subscription'&&usage?.ordinaryUsageAllowed!==false&&used!==null&&used<95;
    const resetSoon=usage?.resetCredits?.credits.some(c=>c.expiresAt!==null&&c.expiresAt*1000>now&&c.expiresAt*1000-now<48*3600000);
    rows.push({id:'codex-sub',label:'ChatGPT subscription',kind:'subscription',stale:!fresh&&used!==null,usedPercent:used,remaining:used===null?null:100-used,spent:null,available:!!usable,detail:usage?`${!fresh?'Last reported quota · ':''}${codex?.subscriptionUsageError??''} ${usage.resetCredits?.availableCount??0} reset credits reported. `+usage.windows.map(w=>`${w.name}: ${Math.round(w.usedPercent)}% used${w.resetsAt?` · resets ${new Date(w.resetsAt*1000).toLocaleString()}`:''}`).join('; '):'Quota unavailable'});
    for(const [i,credit] of (usage?.credits??[]).entries())rows.push({id:`codex-credit-${i}`,label:`ChatGPT credits · ${credit.name}`,kind:'grant',usedPercent:null,remaining:credit.balance!==null&&Number.isFinite(Number(credit.balance))?Number(credit.balance):null,spent:null,available:false,detail:credit.unlimited?'Unlimited reported; paid fallback is not selected automatically':'Credit balance reported; preserved while included capacity is available. Not a dollar balance.'});
    const resetHours=Math.min(...(usage?.windows??[]).filter(w=>w.resetsAt&&w.resetsAt*1000>now).map(w=>(w.resetsAt!*1000-now)/3600000));
    if(usable)candidates.push({id:'codex-sub',provider:'codex-cli',kind:'subscription',score:resetSoon?280:resetHours<24?270-resetHours:180-(used??0)/10,reason:resetSoon?'Use included capacity before the ChatGPT reset expires':resetHours<24?'Use subscription quota before its approaching reset':'Available ChatGPT subscription quota'});
  }
  let reports=getAnthropicReportingAccounts();
  const refresh=reports.filter(a=>listApiConnections().some(k=>k.organizationId===a.organizationId&&k.grantBillingDay)&&(a.report.connected||a.report.eligibility==='supported'||!!a.report.attemptedAt||a.report.eligibility==='denied')&&(!a.report.retryAt||Date.parse(a.report.retryAt)<=now)&&now-(reportingAttempts.get(a.organizationId)??0)>15*60000&&(!a.report.checkedAt||now-Date.parse(a.report.checkedAt)>15*60000));
  await Promise.all(refresh.map(async a=>{reportingAttempts.set(a.organizationId,now);try{await updateAnthropicReporting('refresh',false,a.organizationId);}catch{/* Keep other accounts available if one reporting service fails. */}}));
  if(refresh.length)reports=getAnthropicReportingAccounts();
  now=Date.now();
  const month=new Date();month.setUTCDate(1);month.setUTCHours(0,0,0,0);
  const displayed=new Set<string>();
  for(const row of listApiConnections().filter(r=>r.enabled)){
    const pool=`${row.provider}:${row.organizationId??row.id}`;
    const model=selectApiModel(row,catalogue);
    const estimate=reports.find(a=>a.organizationId===row.organizationId)?.report.grantEstimates?.find(e=>e.connectionId===row.id);
    const grant=!['paid','unknown'].includes(row.funding);
    const {amount,since,useBy,usable:balanceUsable,detail:balanceDetail}=grantCapacity(row,estimate,now);
    const remaining=amount===null?null:Math.max(0,amount-charged(pool,since));
    const {eligibleGrant,paid}=grantFunding(grant,balanceUsable,remaining,useBy,now,row.afterGrant);
    const inactive=row.expired||!!(row.keyExpiresAt&&Date.parse(row.keyExpiresAt)<=now);
    const available=!inactive&&!!model&&(eligibleGrant||paid);
    const spend=charged(pool,month.getTime());
    if(!displayed.has(pool)){
      displayed.add(pool);
      rows.push({id:pool,label:`${row.provider==='anthropic'?'Anthropic':'OpenAI'} · ${row.name}`,kind:grant?'grant':'paygo',needsAttention:grant&&!balanceUsable,stale:grant&&!balanceUsable&&remaining!==null,usedPercent:grant?(remaining!==null&&row.budget?Math.max(0,Math.min(100,(1-remaining/row.budget)*100)):null):(row.budget?Math.min(100,spend/row.budget*100):null),remaining:grant?remaining:null,spent:grant?null:spend,available,detail:!model?'Refresh models; a current tool-capable model with known pricing is required':grant?`${balanceDetail}${Number.isFinite(useBy)?` · use by ${new Date(useBy).toLocaleString()}`:' · expiry unknown'} · ${row.afterGrant==='paygo'?'pay-go allowed afterward':'stop afterward'}`:`KanBorg spend this month${row.budget?` / $${row.budget} budget`:' · no monthly budget set'}`});
    }
    if(available){
      const score=eligibleGrant?250+Math.max(0,100-(useBy-now)/3600000):10-(model!.input+model!.output)/100;
      candidates.push({id:row.id,provider:row.provider==='anthropic'?'claude-code':'codex-cli',kind:'api',row,model:model!,pool,available:eligibleGrant?amount!:(grant?Infinity:row.budget??Infinity),since:eligibleGrant?since:month.getTime(),funding:eligibleGrant?'grant':'paid',...(eligibleGrant&&Number.isFinite(useBy)?{deadline:useBy}:{}),score,reason:eligibleGrant?(Number.isFinite(useBy)?'Use available grant ahead of its six-hour safety deadline':'Use available grant before paid capacity; expiry is not configured'):grant?'Grant unavailable; explicitly permitted pay-go fallback':'Paid API fallback after included capacity'});
    }
  }
  for(const id of enabled)if(!['claude-code','codex-cli'].includes(id))rows.push({id,label:id,kind:'unknown',usedPercent:null,remaining:null,spent:null,available:false,detail:'Capacity reporting not supported yet; manual provider selection remains available.'});
  const ordered=candidates.sort((a,b)=>b.score-a.score);
  for(const row of rows){const candidate=ordered.find(c=>c.id===row.id||c.pool===row.id);
    if(candidate){row.routingOrder=candidate.score>=250?1:candidate.score>=100?2:4;row.routingTier=row.routingOrder===1?'Time-sensitive / grants':row.routingOrder===2?'Included capacity':'Pay-as-you-go';row.preferredNow=candidate===ordered[0];row.routingReason=candidate.reason;}
    else{row.routingOrder=3;row.routingTier=row.id.startsWith('codex-credit')?'Held in reserve':'Unavailable for automatic routing';row.routingReason=row.id.startsWith('codex-credit')?'Provider-managed credit fallback; expiry not reported by this connection.':'';}
  }
  rows.sort((a,b)=>(a.routingOrder??9)-(b.routingOrder??9)||Number(!!b.preferredNow)-Number(!!a.preferredNow));
  return {snapshot:{checkedAt:new Date().toISOString(),rows,routing:routingState()},candidates:ordered};
}
