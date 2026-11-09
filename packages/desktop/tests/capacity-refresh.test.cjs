const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const Module=require('node:module');const ts=require('typescript');
function load(fixture){const file=path.resolve(__dirname,'../src/routing-capacity.ts');const mod=new Module(file);mod.paths=Module._nodeModulePaths(path.dirname(file));const req=mod.require.bind(mod);const mocks={
 './grant-capacity.js':{grantCapacity:()=>({amount:null,since:0,useBy:Infinity,usable:false,detail:''}),grantFunding:()=>({eligibleGrant:false,paid:true})},
 '@kanborg/api':{readClaudeSubscriptionUsage:async()=>({source:'oauth',stale:false,checkedAt:new Date().toISOString(),windows:[{pct:.25,resetsAt:new Date(Date.now()+3600000).toISOString()}]})},'./api-connections.js':{listApiConnections:()=>fixture.rows},'./anthropic-reporting.js':{getAnthropicReportingAccounts:()=>[]},'./claude-auth.js':{},'./subscription-resets.js':{},
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
