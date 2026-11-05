const {test}=require('node:test');
const assert=require('node:assert/strict');
const ts=require('typescript');const fs=require('node:fs');const path=require('node:path');const Module=require('node:module');const {EventEmitter}=require('node:events');
function load(name,mocks={}){
 const file=path.join(__dirname,'../src',name+'.ts');const mod=new Module(file);const original=mod.require.bind(mod);
 mod.require=id=>Object.hasOwn(mocks,id)?mocks[id]:original(id);
 mod._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,file);return mod.exports;
}
const {resetToRedeem}=load('reset-policy');
const now=Date.parse('2026-11-05T20:00:00Z');
function resetDetails(hours=24,used=100,natural=48){return {accountIdentity:'account',subscriptionUsage:{checkedAt:new Date(now).toISOString(),windows:[{usedPercent:used,resetsAt:now/1000+natural*3600}],resetCredits:{availableCount:1,credits:[{id:'reset1',expiresAt:now/1000+hours*3600,status:'available',resetType:'codexRateLimits'}]}}};}
test('reset policy saves offers near natural reset but redeems before expiry without work',()=>{
 assert.equal(resetToRedeem(resetDetails(24,100,2),true,now),null);
 assert.equal(resetToRedeem(resetDetails(24,95,48),true,now),'reset1');
 assert.equal(resetToRedeem(resetDetails(.25,10,2),false,now),'reset1');
 assert.equal(resetToRedeem(resetDetails(-1),true,now),null);
 assert.equal(resetToRedeem(resetDetails(),false,now),null);
});
test('concurrent reservations and unknown outcomes survive restart',()=>{
 const dir=fs.mkdtempSync('/private/tmp/kanbots-route-state-');try{
 const mocks={electron:{app:{getPath:()=>dir}}};const state=load('routing-state',mocks);
 const first=state.reserveCharge('org','key1',4,5,0);assert.ok(first);
 assert.equal(state.reserveCharge('org','key2',2,5,0),null);
 state.settleCharge(first);assert.equal(load('routing-state',mocks).charged('org',Date.now()+1),4);
 state.settleCharge(first,1);assert.equal(state.charged('org',0),1);
 assert.ok(state.reserveCharge('org','key2',4,5,0));
 }finally{fs.rmSync(dir,{recursive:true});}
});
test('model selection requires discovered tool-capable models and nonzero known prices',()=>{
 const {selectApiModel}=load('routing-models',{electron:{app:{}}});
 const row={provider:'anthropic',models:[{id:'claude-sonnet-new'},{id:'unknown'}]};
 assert.equal(selectApiModel(row,{}),null);
 const catalogue={anthropic:{models:{'claude-sonnet-new':{tool_call:true,cost:{input:3,output:15},release_date:'2026-11-01'}}}};
 assert.equal(selectApiModel(row,catalogue).id,'claude-sonnet-new');
 assert.equal(selectApiModel({...row,defaultModel:'not-discovered'},catalogue),null);
});
test('API execution uses saved key only in provider header and records usage',async()=>{
 const original=global.fetch;let charge=0;let settled;const dir=fs.mkdtempSync('/private/tmp/kanbots-api-task-');
 try{
 const {apiTurn}=load('api-task',{
 '@kanbots/mcp':{KANBOTS_TOOLS:[]},'./api-connections.js':{unlockApiConnection:()=> 'test-only-key',listApiConnections:()=>[{id:'key',provider:'anthropic'}]},
 './routing-state.js':{reserveCharge:()=>{charge++;return 'r1';},settleCharge:(...args)=>{settled=args;}}
 });
 global.fetch=async(url,opts)=>{assert.equal(url,'https://api.anthropic.com/v1/messages');assert.equal(opts.headers['x-api-key'],'test-only-key');assert.ok(!opts.body.includes('test-only-key'));return {ok:true,json:async()=>({content:[{type:'text',text:'Done'}],stop_reason:'end_turn',usage:{input_tokens:100,output_tokens:10}})};};
 const route={row:{id:'key',provider:'anthropic'},model:{id:'claude-test',input:3,output:15,context:64000,maxOutput:4096},pool:'org',available:200,since:0};
 const transcript=[{role:'user',text:'Say done'}];const events=[];
 const result=await apiTurn(route,{cwd:dir,prompt:'Say done'},transcript,new AbortController().signal,e=>events.push(e),5);
 assert.equal(charge,1);assert.equal(result.done,true);assert.equal(settled[0],'r1');assert.equal(result.input,100);assert.equal(transcript.at(-1).text,'Done');
 }finally{global.fetch=original;fs.rmSync(dir,{recursive:true});}
});
test('API refuses insufficient funds before calling provider; ambiguous failures keep reservation',async()=>{
 const original=global.fetch;let settled=0;try{
 const mocks={'@kanbots/mcp':{KANBOTS_TOOLS:[]},'./api-connections.js':{unlockApiConnection:()=> 'test',listApiConnections:()=>[{id:'key',provider:'openai'}]},'./routing-state.js':{reserveCharge:()=>null,settleCharge:()=>settled++}};
 const route={row:{id:'key',provider:'openai'},model:{id:'gpt-test',input:1,output:5,context:64000,maxOutput:4096},pool:'org',available:0,since:0};
 let calls=0;global.fetch=async()=>{calls++;throw Error('network');};
 const args=[route,{cwd:'/tmp',prompt:'test'},[{role:'user',text:'test'}],new AbortController().signal,()=>{},5];
 await assert.rejects(load('api-task',mocks).apiTurn(...args),/cannot cover/);assert.equal(calls,0);
 mocks['./routing-state.js'].reserveCharge=()=> 'held';
 await assert.rejects(load('api-task',mocks).apiTurn(...args),/outcome is unknown/);assert.equal(calls,1);assert.equal(settled,0);
 }finally{global.fetch=original;}
});
test('router switches exhausted API grant to subscription and preserves routed session identity',async()=>{
 const dir=fs.mkdtempSync('/private/tmp/kanbots-router-');try{
 class RouteUnavailable extends Error{}
 const api={id:'grant',kind:'api',provider:'claude-code',row:{name:'Grant'},model:{id:'claude-test'},funding:'grant',reason:'grant'};
 const sub={id:'sub',kind:'subscription',provider:'codex-cli',reason:'included'};
 let starts=0;
 const worker=()=>{starts++;const e=new EventEmitter();let resolve;const done=new Promise(r=>resolve=r);const h={pid:null,on:(n,f)=>{e.on(n,f);return h;},off:()=>h,stop:()=>{},done};setImmediate(()=>{e.emit('event',{kind:'session',sessionId:'native-session',model:'gpt-test'});e.emit('event',{kind:'text',text:'Done'});resolve({exitCode:0,result:{isError:false},killedByStop:false});});return h;};
 const {startRoutedRun}=load('automatic-routing',{
 electron:{app:{getPath:()=>dir}},'@kanbots/dispatcher':{startAgentRun:worker},
 './api-task.js':{RouteUnavailable,apiTurn:async()=>{throw new RouteUnavailable('grant empty');}},
 './routing-capacity.js':{collectCapacity:async()=>({candidates:[api,sub]}),invalidateCapacity:()=>{}},
 './routing-state.js':{readRouting:()=>({config:{enabled:true,maxRunUsd:5}}),recordDecision:()=>{}}
 });
 const h=startRoutedRun({cwd:dir,prompt:'Do a task',provider:'claude-code'});const events=[];h.on('event',e=>events.push(e));const result=await h.done;
 assert.equal(result.exitCode,0);assert.equal(starts,1);assert.ok(events.some(e=>e.kind==='text'&&e.text.includes('Switching payment')));
 assert.ok(events.filter(e=>e.kind==='session').every(e=>e.sessionId.startsWith('kanbots-auto-')));
 assert.equal(events.filter(e=>e.kind==='session').at(-1).provider,'codex-cli');
 }finally{fs.rmSync(dir,{recursive:true});}
});
test('routing excludes stopped and unknown grants, reclassifies allowed pay-go, and honors six-hour deadline',async()=>{
 const date=Date.now();
 const model={id:'claude-test',input:1,output:5,context:64000,maxOutput:4096};
 const base={id:'key',provider:'anthropic',name:'Test key',enabled:true,funding:'grant',remaining:100,budget:200,models:[{id:model.id}],renewal:'none',expiresAt:new Date(date+72*3600000).toISOString()};
 async function candidates(row){
  const {collectCapacity}=load('routing-capacity',{
   '@kanbots/api':{readClaudeSubscriptionUsage:async()=>null},
   './api-connections.js':{listApiConnections:()=>[row]},
   './anthropic-reporting.js':{getAnthropicReportingAccounts:()=>[],updateAnthropicReporting:async()=>{}},
   './claude-auth.js':{getClaudeDetails:async()=>null},'./subscription-resets.js':{manageCodexResets:async()=>null},
   './routing-state.js':{readRouting:()=>({config:{}}),routingState:()=>({}),charged:()=>0},
   './routing-models.js':{modelCatalogue:async()=>({}),selectApiModel:()=>model},
  });return (await collectCapacity()).candidates;
 }
 assert.equal((await candidates({...base,remaining:0,afterGrant:'stop'})).length,0);
 assert.equal((await candidates({...base,remaining:null,afterGrant:'stop'})).length,0);
 assert.equal((await candidates({...base,remaining:0,afterGrant:'paygo'}))[0].funding,'paid');
 assert.equal((await candidates(base))[0].funding,'grant');
 assert.equal((await candidates({...base,expiresAt:new Date(date+5*3600000).toISOString(),afterGrant:'stop'})).length,0);
});
