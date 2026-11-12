const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const Module=require('node:module');
const ts=require('typescript');
test('saved view selection and edits send a complete atomic group without repeated failed saves',async()=>{
 const file=path.resolve(__dirname,'../../web/src/stores/usePrefsStore.ts');
 const webRequire=Module.createRequire(path.resolve(__dirname,'../../web/package.json'));
 const oldWindow=global.window;
 const oldStorage=global.localStorage;
 const storage={getItem:()=>null,setItem(){},removeItem(){},length:0,key:()=>null};
 let tick,version=1,value={savedViews:{views:[],activeViewId:null,seeded:false}};
 const saves=[];
 global.window={localStorage:storage,setInterval(fn){tick=fn;}};global.localStorage=storage;
 const bridge={coordinatorAction:async(name,args)=>{
  if(name==='preferences-get')return {workspaceId:'workspace',boardWorkspaceId:'board',version,value:structuredClone(value)};
  assert.equal(name,'preferences-save');
  assert.equal(args.expectedVersion,version);
  const group=args.preferences.savedViews;
  if(group){for(const field of ['views','activeViewId','seeded'])assert.ok(Object.hasOwn(group,field),'missing '+field);assert.ok(group.activeViewId===null||group.views.some(v=>v.id===group.activeViewId));}
  saves.push(structuredClone(args.preferences));
  for(const [key,patch] of Object.entries(args.preferences))value[key]={...value[key],...patch};
  return {workspaceId:'workspace',boardWorkspaceId:'board',version:++version,value:structuredClone(value)};
 }};
 try{
  const mod=new Module(file);mod.require=id=>id==='../desktop-bridge.js'?{getBridge:()=>bridge}:webRequire(id);
  mod._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,file);
  await new Promise(r=>setImmediate(r));
  const store=mod.exports.usePrefsStore;
  const view={id:'one',name:'First',createdAt:'2026-11-12',sortMode:'manual',includeBacklog:true,filters:{hasAgent:false,priorities:[],areas:[]}};
  store.getState().upsertBoardView('board',view);tick();await new Promise(r=>setImmediate(r));
  store.getState().setActiveBoardView('board','one');tick();await new Promise(r=>setImmediate(r));
  assert.equal(value.savedViews.activeViewId,'one');
  store.getState().upsertBoardView('board',{...view,name:'Renamed'});tick();await new Promise(r=>setImmediate(r));
  assert.equal(value.savedViews.views[0].name,'Renamed');assert.equal(value.savedViews.activeViewId,'one');
  store.getState().setActiveBoardView('board',null);assert.equal(store.getState().boardViews.board.activeViewId,null);tick();await new Promise(r=>setImmediate(r));
  assert.equal(value.savedViews.activeViewId,null);
  const count=saves.length;tick();await new Promise(r=>setImmediate(r));tick();await new Promise(r=>setImmediate(r));assert.equal(saves.length,count);
 }finally{global.window=oldWindow;global.localStorage=oldStorage;}
});
