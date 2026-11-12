const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const Module=require('node:module');const ts=require('typescript');
const file=path.resolve(__dirname,'../src/performance-diagnostics.ts');const mod=new Module(file);const original=mod.require.bind(mod);
mod.require=id=>id==='electron'?{}:original(id);
mod._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,file);
const {PerformanceCounters}=mod.exports;
test('timing aggregation counts slow calls and failures and drains without retaining payloads',()=>{
 const c=new PerformanceCounters();c.record('read',10);c.record('read',250,true);c.record('read',NaN);
 assert.deepEqual(c.drain(),{read:{count:2,totalMs:260,maxMs:250,slow:1,failures:1}});assert.deepEqual(c.drain(),{});
});
test('metric cardinality is bounded',()=>{
 const c=new PerformanceCounters();for(let i=0;i<10000;i++)c.record('channel'+i,1);
 const rows=c.drain();assert.ok(Object.keys(rows).length<=257);assert.equal(Object.values(rows).reduce((n,r)=>n+r.count,0),10000);
});
test('diagnostics retain IPC behavior and write only bounded timing metadata',async()=>{
 const dir=fs.mkdtempSync('/private/tmp/kanborg-perf-test-');const callbacks={};const handlers={};let tick;
 const realInterval=global.setInterval,realClear=global.clearInterval;
 const app={getPath:()=>dir,getVersion:()=> 'test',once:(name,fn)=>callbacks[name]=fn};
 const ipcMain={handle:(name,fn)=>handlers[name]=fn,on:()=>{}};
 const local=new Module(file);const req=local.require.bind(local);local.require=id=>id==='electron'?{app,ipcMain}:req(id);
 local._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,file);
 try{
 global.setInterval=fn=>{tick=fn;return {unref(){}};};global.clearInterval=()=>{};
 local.exports.startPerformanceDiagnostics();
 ipcMain.handle('test-read',(_event,value)=>value);ipcMain.handle('test-failure',()=>{throw Error('private error text');});
 assert.equal(await handlers['test-read']({},'private payload'),'private payload');
 await assert.rejects(handlers['test-failure']({}),/private error text/);
 tick();const log=path.join(dir,'diagnostics/performance.jsonl');
 for(let i=0;i<100&&(!fs.existsSync(log)||!fs.readFileSync(log,'utf8').endsWith('\n'));i++)await new Promise(r=>setTimeout(r,10));
 const text=fs.readFileSync(log,'utf8');assert.ok(!text.includes('private'));const row=JSON.parse(text);
 assert.equal(row.timings['test-read'].count,1);assert.equal(row.timings['test-failure'].failures,1);assert.equal(row.inFlight,0);
 }finally{callbacks['will-quit']?.();global.setInterval=realInterval;global.clearInterval=realClear;fs.rmSync(dir,{recursive:true,force:true});}
});
