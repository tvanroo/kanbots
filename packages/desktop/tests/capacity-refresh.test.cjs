const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const Module=require('node:module');const ts=require('typescript');
function load(fixture){const file=path.resolve(__dirname,'../src/routing-capacity.ts');const mod=new Module(file);mod.paths=Module._nodeModulePaths(path.dirname(file));const req=mod.require.bind(mod);const budgetFile=path.resolve(__dirname,'../src/subscription-budget.ts');const budget=new Module(budgetFile);budget._compile(ts.transpileModule(fs.readFileSync(budgetFile,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,budgetFile);const mocks={'./subscription-budget.js':budget.exports,
 './grant-capacity.js':{grantCapacity:()=>fixture.grant??({amount:null,since:0,useBy:Infinity,usable:false,detail:''}),grantFunding:()=>({eligibleGrant:!!fixture.grant,paid:!fixture.grant})},
 '@kanborg/api':{readClaudeSubscriptionUsage:async()=>fixture.quota??({source:'oauth',stale:false,checkedAt:new Date().toISOString(),windows:[{pct:.25,resetsAt:new Date(Date.now()+3600000).toISOString()}]})},'./api-connections.js':{listApiConnections:()=>fixture.rows},'./anthropic-reporting.js':{getAnthropicReportingAccounts:()=>[]},'./claude-auth.js':{getClaudeDetails:async()=>({cliAvailable:true,hasKey:true,authenticationLabel:'Claude subscription'})},'./subscription-resets.js':{},
 './routing-state.js':{readRouting:()=>({config:{}}),routingState:()=>({}),charged:()=>0},'./routing-models.js':{modelCatalogue:()=>fixture.catalogue(),selectApiModel:()=>({input:1,output:1})}};
 mod.require=id=>mocks[id]??req(id);mod._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,file);return mod.exports;}
const row={id:'key',provider:'openai',name:'Test',enabled:true,funding:'paid'};
test('saving a disabled key invalidates cached routing immediately',async()=>{const f={rows:[row],catalogue:async()=>[]};const api=load(f);assert.equal((await api.collectCapacity()).candidates.length,1);f.rows=[{...row,enabled:false}];assert.equal((await api.collectCapacity()).candidates.length,0);});
test('settings changes during a pending refresh cannot republish the older result',async()=>{let finish;let calls=0;const f={rows:[row],catalogue:()=>++calls===1?new Promise(resolve=>{finish=resolve;}):Promise.resolve([])};const api=load(f);const first=api.collectCapacity();f.rows=[{...row,enabled:false}];const second=api.collectCapacity();finish([]);assert.equal((await first).candidates.length,0);assert.equal((await second).candidates.length,0);assert.equal(calls,2);});
test('concurrent explicit refreshes share one provider read',async()=>{let finish;let calls=0;const f={rows:[row],catalogue:()=>{calls++;return new Promise(resolve=>{finish=resolve;});}};const api=load(f);const first=api.collectCapacity(false,true);const second=api.collectCapacity(false,true);finish([]);await Promise.all([first,second]);assert.equal(calls,1);});

test('authenticated Claude quota is sufficient without spawning an auth-status process',async()=>{const api=load({rows:[],catalogue:async()=>[]});api.configureRoutingProviders(()=>[{id:'claude-code',enabled:true}]);const result=await api.collectCapacity();assert.equal(result.candidates[0].id,'claude-sub');assert.equal(result.snapshot.rows[0].remaining,75);});

test('historical quota confidence declines without converting an outage into exhaustion',()=>{
 const {historicalQuotaUsable:usable}=load({rows:[],catalogue:async()=>[]});const now=Date.now();const stamp=h=>new Date(now-h*3600000).toISOString();
 assert.equal(usable(60,stamp(1),[now+3600000],now),true);
 assert.equal(usable(60,stamp(20),[now+3600000],now),false);
 assert.equal(usable(94,stamp(1),[],now),false);
 assert.equal(usable(6,stamp(25),[],now),false);
 assert.equal(usable(6,stamp(1),[now-1],now),false);
 assert.equal(usable(null,stamp(1),[],now),false);
});

 test('usable historical Claude quota retains its known reset deadline and displays it',async()=>{
 const reset=new Date(Date.now()+16*3600000).toISOString();
 const api=load({rows:[],catalogue:async()=>[],quota:{source:'unavailable',stale:true,checkedAt:new Date(Date.now()-3600000).toISOString(),windows:[{id:'seven_day',label:'Weekly quota',pct:.26,resetsAt:reset}]}});
 api.configureRoutingProviders(()=>[{id:'claude-code',enabled:true}]);
 const result=await api.collectCapacity();
 assert.equal(result.candidates[0].resetAt,Date.parse(reset));
 assert.match(result.snapshot.rows[0].detail,/Last known Weekly quota reset/);
 assert.equal(result.snapshot.rows[0].stale,true);
 });
 test('past reset permits an authenticated attempt without inventing replenished quota',async()=>{
 const api=load({rows:[],catalogue:async()=>[],quota:{source:'unavailable',stale:true,checkedAt:new Date(Date.now()-3600000).toISOString(),windows:[{id:'seven_day',label:'Weekly quota',pct:.26,resetsAt:new Date(Date.now()-1000).toISOString()}]}});
 api.configureRoutingProviders(()=>[{id:'claude-code',enabled:true}]);
 const result=await api.collectCapacity();assert.equal(result.candidates.length,1);assert.equal(result.candidates[0].resetAt,undefined);assert.equal(result.snapshot.rows[0].remaining,74);assert.equal(result.snapshot.rows[0].stale,true);
 });

test('saved Claude reset in sixteen hours takes precedence over an eighteen-day grant',async()=>{
 const now=Date.now();const api=load({rows:[{id:'grant',provider:'anthropic',name:'Grant',enabled:true,funding:'grant',afterGrant:'stop'}],catalogue:async()=>[],grant:{amount:175,since:0,useBy:now+18*86400000,usable:true,detail:'Saved balance'},quota:{source:'unavailable',stale:true,checkedAt:new Date(now-3600000).toISOString(),windows:[{id:'seven_day',label:'Weekly quota',pct:.26,resetsAt:new Date(now+16*3600000).toISOString()}]}});
 api.configureRoutingProviders(()=>[{id:'claude-code',enabled:true}]);
 const result=await api.collectCapacity();assert.equal(result.candidates[0].id,'claude-sub');assert.equal(result.candidates[1].funding,'grant');assert.match(result.candidates[0].reason,/resets sooner/);
});

test('Fable reset cannot accelerate the total subscription deadline or inflate its usage',async()=>{
 const now=Date.now();const api=load({rows:[],catalogue:async()=>[],quota:{source:'oauth',stale:false,checkedAt:new Date(now).toISOString(),windows:[{id:'seven_day',label:'Weekly quota',pct:.27,resetsAt:new Date(now+16*3600000).toISOString()},{id:'seven_day_fable',label:'Fable quota',pct:.8,resetsAt:new Date(now+3600000).toISOString()}]}});
 api.configureRoutingProviders(()=>[{id:'claude-code',enabled:true}]);const result=await api.collectCapacity();
 assert.equal(result.candidates[0].resetAt,now+16*3600000);
 assert.equal(result.snapshot.rows.find(r=>r.id==='claude-sub').remaining,73);
 const fable=result.snapshot.rows.find(r=>r.id==='claude-model:seven_day_fable');assert.equal(fable.usedPercent,80);assert.match(fable.detail,/Not an additional pool/);
});

test('exhausted Fable subset routes useful work on Sonnet without exhausting the shared pool',async()=>{
 const api=load({rows:[],catalogue:async()=>[],quota:{source:'oauth',stale:false,checkedAt:new Date().toISOString(),windows:[{id:'seven_day',label:'Weekly',pct:.27,resetsAt:new Date(Date.now()+16*3600000).toISOString()},{id:'seven_day_fable',label:'Fable',pct:1,resetsAt:new Date(Date.now()+3600000).toISOString()}]}});
 api.configureRoutingProviders(()=>[{id:'claude-code',enabled:true,defaultModel:'fable'}]);const result=await api.collectCapacity();assert.equal(result.candidates[0].nativeModel,'sonnet');assert.equal(result.snapshot.rows.find(r=>r.id==='claude-sub').remaining,73);
});
test('Fable uses both budgets when selected and total exhaustion blocks it',async()=>{
 const f={rows:[],catalogue:async()=>[],quota:{source:'oauth',stale:false,checkedAt:new Date().toISOString(),windows:[{id:'seven_day',label:'Weekly',pct:.3,resetsAt:new Date(Date.now()+3600000).toISOString()},{id:'seven_day_fable',label:'Fable',pct:.5,resetsAt:new Date(Date.now()+3600000).toISOString()}]}};
 const api=load(f);api.configureRoutingProviders(()=>[{id:'claude-code',enabled:true,defaultModel:'fable'}]);assert.equal((await api.collectCapacity()).candidates[0].nativeModel,'fable');f.quota.windows[0].pct=1;assert.equal((await api.collectCapacity(false,true)).candidates.length,0);
});

test('signed-in Claude with missing or very stale quota stays eligible without reporting a fresh balance',async()=>{for(const quota of [{source:'unavailable',stale:true,windows:[]},{source:'unavailable',stale:true,checkedAt:new Date(Date.now()-7*86400000).toISOString(),windows:[{id:'seven_day',pct:1}]}]){const api=load({rows:[],catalogue:async()=>[],quota});api.configureRoutingProviders(()=>[{id:'claude-code',enabled:true}]);const result=await api.collectCapacity();assert.equal(result.candidates[0].id,'claude-sub');assert.match(result.snapshot.rows[0].detail,/Quota is unverified/);assert.equal(result.snapshot.rows[0].remaining,quota.windows.length?0:null);}});
