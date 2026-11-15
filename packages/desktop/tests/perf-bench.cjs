// Coordinator hot-path benchmark. Not part of the test suite; run with
//   node packages/desktop/tests/perf-bench.cjs [jobs]
// It builds a workspace shaped like a long-running Autopilot board (default
// 1,250 finished jobs, 2 runs each, 4,200 unacknowledged coordinator requests)
// on a real SQLite store and times the work the main process repeats: the 3 s
// coordinator tick, the renderer's coordinator-state poll, a registry save and
// the board's workflow read. Needs `pnpm --filter @kanborg/local-store build`.
// WHO_SAVES=1 prints which call sites save during idle ticks; ONLY_TICK=1 runs
// ticks only (pair with node --cpu-prof).
const fs=require('node:fs');const path=require('node:path');const Module=require('node:module');const ts=require('typescript');const {performance}=require('node:perf_hooks');
function load(file,mocks={}){const mod=new Module(file);mod.paths=Module._nodeModulePaths(path.dirname(file));const original=mod.require.bind(mod);mod.require=id=>Object.hasOwn(mocks,id)?mocks[id]:original(id);mod._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,file);return mod.exports;}
(async()=>{
 const JOBS=Number(process.argv[2]??1250);
 const {openStoreInMemory}=await import(path.resolve(__dirname,'../../local-store/dist/index.js'));
 const store=openStoreInMemory();
 fs.mkdirSync('/private/tmp',{recursive:true});const root=fs.mkdtempSync('/private/tmp/kanbots-bench-');
 const manifest={...load(path.resolve(__dirname,'../../mcp/src/app-controls.ts')),...load(path.resolve(__dirname,'../../mcp/src/coordinator.ts'),{'./app-controls.js':load(path.resolve(__dirname,'../../mcp/src/app-controls.ts')),'./workflow-schema.js':load(path.resolve(__dirname,'../../mcp/src/workflow-schema.ts'))}),...load(path.resolve(__dirname,'../../mcp/src/onboarding.ts'))};
 const {CoordinatorService}=load(path.resolve(__dirname,'../src/coordinator.ts'),{'./capacity-summary.js':load(path.resolve(__dirname,'../src/capacity-summary.ts')),'./secret-vault.js':load(path.resolve(__dirname,'../src/secret-vault.ts')),'./vault-runtime.js':{vaultAction:async()=>({})},'./performance-diagnostics.js':{recordPerformanceTiming:()=>{}},'./question-presentation.js':load(path.resolve(__dirname,'../src/question-presentation.ts')),'./providers-ipc.js':{getProviderHandlers:()=>({})},'./routing-state.js':{routingState:()=>({}),saveRouting:c=>c},'./persona-library.js':load(path.resolve(__dirname,'../src/persona-library.ts')),'./coordinator-outbound.js':load(path.resolve(__dirname,'../src/coordinator-outbound.ts')),electron:{app:{getPath:()=>root,getVersion:()=>'bench'}},'@kanborg/mcp':manifest,'./worker-checkpoint.js':load(path.resolve(__dirname,'../src/worker-checkpoint.ts')),'./workflow.js':load(path.resolve(__dirname,'../src/workflow.ts')),'./run-snapshot.js':load(path.resolve(__dirname,'../src/run-snapshot.ts')),'./coordinator-retention.js':load(path.resolve(__dirname,'../src/coordinator-retention.ts')),'@kanborg/core':load(path.resolve(__dirname,'../../core/src/labels.ts')),'./routing-capacity.js':{collectCapacity:async()=>({snapshot:{rows:[]}})}});
 const jobs=[];
 for(let n=1;n<=JOBS;n++){const thread=store.threads.create({repoOwner:'local',repoName:'bench',issueNumber:n});
  const a=store.agentRuns.create({threadId:thread.id,branchName:'kanbots/'+n,worktreePath:root});store.agentRuns.update(a.id,{status:'complete',endedAt:new Date().toISOString(),exitReason:'success'});
  const b=store.agentRuns.create({threadId:thread.id,branchName:'kanbots/r'+n,worktreePath:root});store.agentRuns.update(b.id,{status:'complete',endedAt:new Date().toISOString()});
  jobs.push({runId:a.id,number:n,role:'implementation',qa:true,maxReworks:1,reworks:0,budgetUsd:5,state:'qa-passed',reviewRunId:b.id,autopilot:true,controlId:'c'+n,reviewControlId:'r'+n,sha:'a'.repeat(40),checkpoint:{state:'checkpointed',summary:'x'.repeat(600),remainingValidation:'',artifacts:[]}});}
 const handlers={'issues:list':async()=>[],'chat:get':async()=>({activeRun:null}),'agent-runs:checks:list':async()=>[]};
 const svc=new CoordinatorService(root);svc.attach({repoPath:root,handlers,store,supervisor:{}});
 const w=svc.state.workspaces[0];w.jobs=jobs;w.mode='internal';w.controller='internal';w.autopilot={status:'active',parallelism:4};
 w.requests=[];for(let i=0;i<4200;i++)w.requests.push({id:'wa-'+i,kind:'workflow-action',state:'received',createdAt:new Date().toISOString(),receivedBy:'internal',prompt:'x'.repeat(1400)});
 for(let i=0;i<1500;i++)w.events.push({cursor:w.nextCursor++,at:new Date().toISOString(),type:'runs-changed',data:[{run:{runId:i},review:null}]});
 const time=async(label,fn,reps=5)=>{await fn();const t=[];for(let i=0;i<reps;i++){const s=performance.now();await fn();t.push(performance.now()-s);}t.sort((a,b)=>a-b);console.log(label.padEnd(34),'median',t[Math.floor(reps/2)].toFixed(1),'ms');};
 await time('tick()',()=>svc.tick());
 if(process.env.WHO_SAVES){const orig=svc.save.bind(svc);const seen=new Map();svc.save=()=>{const k=new Error().stack.split('\n').slice(2,4).join(' | ');seen.set(k,(seen.get(k)??0)+1);orig();};for(let i=0;i<10;i++)await svc.tick();console.log(seen);return;}
 if(process.env.ONLY_TICK){for(let i=0;i<20;i++)await svc.tick();return;}
 await time('ui() (coordinator-state poll)',()=>svc.ui());
 {const u=svc.ui();for(const [k,v] of Object.entries(u))console.log('  ui.'+k,(JSON.stringify(v)??'').length);for(const [k,v] of Object.entries(u.workspace))if(JSON.stringify(v)?.length>5000)console.log('  ui.workspace.'+k,JSON.stringify(v).length);}
 console.log('ui() payload'.padEnd(34),(JSON.stringify(svc.ui()).length/1024).toFixed(0),'KB');
 await time('save()',()=>svc.save());
 console.log('coordinators.json'.padEnd(34),(fs.statSync(path.join(root,'coordinators.json')).size/1024).toFixed(0),'KB');
 handlers['workspace:get']=async()=>({id:'b'});const issues=[];for(let n=1;n<=JOBS;n++)issues.push({number:n,title:'Task '+n,body:'b'.repeat(800),labels:['feature'],state:n%3?'closed':'open',updatedAt:new Date().toISOString(),activeRun:null});handlers['issues:list']=async()=>issues;
 await svc.uiAction('workflow:get');for(const c of Object.values(w.workflow.cards))for(let h=0;h<8;h++)c.history.push({at:new Date().toISOString(),actor:'system',version:1,from:'todo',to:'done',reason:'r'.repeat(120),evidence:'e'.repeat(300)});
 for(let h=0;h<20;h++)w.workflow.history.push({version:h,at:new Date().toISOString(),actor:'user',reason:'x',config:JSON.parse(JSON.stringify(w.workflow.config)),moves:[]});
 console.log('workflow:get payload'.padEnd(34),(JSON.stringify(await svc.uiAction('workflow:get')).length/1024).toFixed(0),'KB');await time('uiAction(preferences-get)',()=>svc.uiAction('preferences-get'));
 console.log('workflow:board payload'.padEnd(34),(JSON.stringify(await svc.uiAction('workflow:board').catch(()=>null)).length/1024).toFixed(0),'KB');
 await time('uiAction(workflow:get)',()=>svc.uiAction('workflow:get').catch(()=>{}));
 await time('uiAction(questions-list)',()=>svc.uiAction('questions-list').catch(()=>{}));
 fs.rmSync(root,{recursive:true,force:true});
})().catch(e=>{console.error(e);process.exit(1);});
