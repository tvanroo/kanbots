const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const Module=require('node:module');const ts=require('typescript');
function load(name){const file=path.resolve(__dirname,'../src',name);const mod=new Module(file);mod.paths=Module._nodeModulePaths(path.dirname(file));mod._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,file);return mod.exports;}
const {createCodexCliAdapter,CODEX_CLI_ADAPTER_ID}=load('coordinator-codex-cli.ts');
const {enqueueWake,deliverWake,acknowledgeWake,reconcileAuthority}=load('coordinator-outbound.ts');
function fixture(runner){
 const binding={id:'binding-1',clientId:'client-1',hostId:'local',chatId:'01a1acc4-e627-7c10-9c24-83a0fc538e32',adapterId:CODEX_CLI_ADAPTER_ID,state:'approved',createdAt:0};
 const out={bindings:[binding],events:[]};let saves=0;
 const adapter=createCodexCliAdapter({executable:'/trusted/codex',localHostId:'local',isDesktopRunning:async()=>true,checkExecutable:async()=>{},runner});
 const event=enqueueWake(out,{workspaceId:'workspace-1',clientId:binding.clientId,epoch:1,kind:'changes',cursor:5},0);
 return {out,binding,event,adapters:new Map([[adapter.id,adapter]]),save:()=>{saves++;},saved:()=>saves};
}
const valid=e=>e.epoch===1;
const ok={stdout:'Queued message 01a1b2f3-ed01-7491-8cb4-0d5581240038 for thread 01a1acc4-e627-7c10-9c24-83a0fc538e32.\n',stderr:'Warning: resume failed'};
test('real queue seam persists sending then accepts, received and acted remain distinct',async()=>{
 const f=fixture(async()=>{assert.equal(f.event.state,'sending');assert.ok(f.saved()>0);return ok;});
 await deliverWake(f.out,f.adapters,f.save,valid,1);assert.equal(f.event.state,'accepted');
 assert.throws(()=>acknowledgeWake(f.out,f.binding.clientId,f.event.id,1,'acted',valid),/receipt/);
 acknowledgeWake(f.out,f.binding.clientId,f.event.id,1,'received',valid);assert.equal(f.event.state,'received');
 acknowledgeWake(f.out,f.binding.clientId,f.event.id,1,'acted',valid);assert.equal(f.event.state,'acted');
});
test('uncertain delivery reconciles without a second CLI invocation',async()=>{
 let calls=0;const f=fixture(async()=>{calls++;throw Object.assign(Error(),{code:'ETIMEDOUT'});});
 await deliverWake(f.out,f.adapters,f.save,valid,1);assert.equal(f.event.state,'uncertain');
 await deliverWake(f.out,f.adapters,f.save,valid,100000);assert.equal(f.event.state,'uncertain');assert.equal(calls,1);
});
test('revoked binding and transferred epoch cancel delivery and deny old acknowledgement',async()=>{
 let calls=0;const f=fixture(async()=>{calls++;return ok;});f.binding.state='revoked';
 await deliverWake(f.out,f.adapters,f.save,valid,1);assert.equal(f.event.state,'cancelled');assert.equal(calls,0);
 assert.throws(()=>acknowledgeWake(f.out,f.binding.clientId,f.event.id,1,'received',valid));
 const g=fixture(async()=>ok);reconcileAuthority(g.out,()=>false);assert.equal(g.event.state,'cancelled');
});
test('receiver acknowledgement racing transport completion is preserved',async()=>{
 const f=fixture(async()=>{acknowledgeWake(f.out,f.binding.clientId,f.event.id,1,'received',valid);return ok;});
 await deliverWake(f.out,f.adapters,f.save,valid,1);assert.equal(f.event.state,'received');
});
