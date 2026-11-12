const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const Module=require('node:module');const ts=require('typescript');
function load(file,mocks={}){const mod=new Module(file);mod.paths=Module._nodeModulePaths(path.dirname(file));const original=mod.require.bind(mod);mod.require=id=>Object.hasOwn(mocks,id)?mocks[id]:original(id);mod._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,file);return mod.exports;}
const manifest={...load(path.resolve(__dirname,'../../mcp/src/app-controls.ts')),...load(path.resolve(__dirname,'../../mcp/src/coordinator.ts'),{'./app-controls.js':load(path.resolve(__dirname,'../../mcp/src/app-controls.ts')),'./workflow-schema.js':load(path.resolve(__dirname,'../../mcp/src/workflow-schema.ts'))}),...load(path.resolve(__dirname,'../../mcp/src/onboarding.ts'))};
function fixture(){const vaultItems=[];const vaultCalls=[];let cancelVault=false;const root=fs.mkdtempSync('/private/tmp/kanbots-coordinator-test-');const {CoordinatorService}=load(path.resolve(__dirname,'../src/coordinator.ts'),{'./vault-runtime.js':{vaultAction:async(action,args,project)=>{vaultCalls.push({action,args,project});return {initialized:true,items:vaultItems,cancelled:cancelVault};}},'./performance-diagnostics.js':{recordPerformanceTiming:()=>{}},'./question-presentation.js':load(path.resolve(__dirname,'../src/question-presentation.ts')),'./providers-ipc.js':{getProviderHandlers:()=>({'providers:get':async()=>({source:'app-store'})})},'./routing-state.js':{routingState:()=>({}),saveRouting:c=>c},'./persona-library.js':load(path.resolve(__dirname,'../src/persona-library.ts')),'./coordinator-outbound.js':load(path.resolve(__dirname,'../src/coordinator-outbound.ts')),electron:{app:{getPath:()=>root,getVersion:()=>"test"}},'@kanborg/mcp':manifest,'./worker-checkpoint.js':load(path.resolve(__dirname,'../src/worker-checkpoint.ts')),'./workflow.js':load(path.resolve(__dirname,'../src/workflow.ts')),'@kanborg/core':load(path.resolve(__dirname,'../../core/src/labels.ts')), './routing-capacity.js':{collectCapacity:async()=>({snapshot:{rows:[]}})}});const svc=new CoordinatorService(root);let starts=0;const resumes=[];const startInputs=[];let issues=[{number:1,title:'Test task',body:'Acceptance: works',labels:[]}];const runs=new Map();let checks=[];const handlers={
 'workspace:get':async()=>({id:'test-board'}),'autopilot:list-active':async()=>[], 'issues:list':async()=>issues,'issues:get':async a=>({issue:issues.find(i=>i.number===a.number)}),'issues:create':async a=>{const i={number:issues.length+1,...a};issues.push(i);return i;},'issues:patch':async a=>Object.assign(issues.find(i=>i.number===a.number),a.patch),
 'config:get':async()=>({owner:'local',repo:'test'}),'decisions:pending':async()=>[],
 'agent-runs:checks:run':async()=>{checks=[{id:1,kind:'tests',status:'running'}];return checks;},'agent-runs:checks:list':async()=>checks,
 'chat:post-message':async a=>({body:a.body}), 'chat:create':async()=>({conversation:{id:99}}),'chat:get':async()=>({activeRun:null,messages:[],events:[]}),
 'agent-runs:diff':async()=>({files:[],empty:true}),
 };
 const context={repoPath:root,source:{},handlers,store:{chatConversations:{findById:()=>({threadId:1})},threads:{getOrCreate:()=>({id:1}),findById:()=>({issueNumber:1})},agentRuns:{findById:id=>runs.get(id),listByThread:id=>[...runs.values()].filter(r=>r.threadId===id)},events:{list:id=>[{seq:0,type:'text',payload:{text:id===2?'Reviewed tests and implementation. KANBOTS_QA_PASS':'Implementation complete'}}]}},supervisor:{start:async a=>{startInputs.push(a);starts++;const r={id:starts,threadId:1,status:starts===1?'running':'complete',worktreePath:root,branchName:'kanbots/test',totalCostUsd:0};runs.set(r.id,r);return r;},resume:async a=>{resumes.push(a);runs.get(a.runId).status='running';return runs.get(a.runId);},stop:async id=>{runs.get(id).status='stopped';return runs.get(id);}}};svc.attach(context);let sha='a'.repeat(40);svc.git=async(cwd,args)=>args[0]==='status'?'':args[0]==='worktree'?`worktree ${root}\nbranch refs/heads/main`:args[0]==='merge'?'':args.at(-1)==='refs/heads/main'?'b'.repeat(40):sha;
 return {svc,root,runs,handlers,resumes,startInputs,supervisor:context.supervisor,source:context.source,vaultCalls,vaultItems,cancelVault:()=>{cancelVault=true;},reload:()=>{const restored=new CoordinatorService(root);restored.attach(context);return restored;},get starts(){return starts;},get checks(){return checks;},setSha:s=>sha=s,cleanup:()=>fs.rmSync(root,{recursive:true,force:true})};}
async function control(f){await f.svc.uiAction('handoff',{mode:'internal'});const w=f.svc.ui().workspace;return {id:w.workspaceId,actor:w.controller};}
async function write(f,c,name,args={},id='request-'+Math.random()){const w=f.svc.ui().workspace;return f.svc.call(c.actor,c.id,name,{workspaceId:c.id,revision:w.revision,requestId:id,...args});}
test('shared schema rejects invalid fields, unbounded inputs and unknown tools',()=>{assert.throws(()=>manifest.validateCoordinatorArgs('dispatchTask',{workspaceId:'x',number:1,requestId:'12345678',revision:0,budgetUsd:-1}));assert.throws(()=>manifest.validateCoordinatorArgs('getCapacity',{workspaceId:'x',secret:'x'}));assert.throws(()=>manifest.validateCoordinatorArgs('executeShell',{}));});
test('handoff revokes old controller; idempotent dispatch survives retry and restart',async()=>{const f=fixture();try{const c=await control(f);const a={workspaceId:c.id,revision:f.svc.ui().workspace.revision,requestId:'dispatch-0001',number:1,qa:false};const first=await f.svc.call(c.actor,c.id,'dispatchTask',a);const second=await f.svc.call(c.actor,c.id,'dispatchTask',a);assert.deepEqual(first,second);assert.equal(f.starts,1);await assert.rejects(f.svc.call('other',c.id,'dispatchTask',a),/controlled elsewhere/);await f.svc.uiAction('handoff',{mode:'off'});await assert.rejects(f.svc.call(c.actor,c.id,'createIssue',{...a,title:'x'}));assert.ok(JSON.parse(fs.readFileSync(path.join(f.root,'coordinators.json'))).workspaces[0].receipts[c.actor+':dispatch-0001']);}finally{f.cleanup();}});
test('full pipeline dispatches independent QA and executes coordinator-directed current release once',async()=>{const f=fixture();try{const c=await control(f);await write(f,c,'dispatchTask',{number:1,qa:true});f.runs.get(1).status='complete';await f.svc.tick();assert.equal(f.svc.ui().jobs[0].state,'checks');f.checks[0].status='pass';await f.svc.tick();assert.equal(f.starts,2);assert.equal(f.svc.ui().jobs[0].state,'qa-passed');const plan=(await write(f,c,'prepareRelease',{runId:1,targetBranch:'main',action:'merge'})).data;assert.equal(plan.state,'ready');const result=await write(f,c,'executeRelease',{releaseId:plan.id});assert.equal(result.data.state,'completed');assert.equal((await write(f,c,'executeRelease',{releaseId:plan.id})).data.state,'completed');}finally{f.cleanup();}});
test('stale commit invalidates QA and release approval',async()=>{const f=fixture();try{const c=await control(f);await write(f,c,'dispatchTask',{number:1,qa:true});f.runs.get(1).status='complete';await f.svc.tick();f.checks[0].status='pass';await f.svc.tick();const plan=(await write(f,c,'prepareRelease',{runId:1,targetBranch:'main',action:'merge'})).data;f.setSha('c'.repeat(40));await assert.rejects(write(f,c,'executeRelease',{releaseId:plan.id}),/revision changed/);}finally{f.cleanup();}});
test('failed checks enter bounded correction and exhausted correction requests attention',async()=>{const f=fixture();try{const c=await control(f);await write(f,c,'dispatchTask',{number:1,qa:true,maxReworks:0});f.runs.get(1).status='complete';await f.svc.tick();f.checks[0].status='fail';await f.svc.tick();assert.equal(f.svc.ui().jobs[0].state,'needs-changes');assert.equal(f.starts,1);}finally{f.cleanup();}});
test('actual stdio clients pair, reconnect after server restart, and enforce workspace scope',async()=>{const f=fixture();let close;let client;try{
 const req=Module.createRequire(path.resolve(__dirname,'../../mcp/package.json'));const {Client}=await import(req.resolve('@modelcontextprotocol/sdk/client/index.js'));const {StdioClientTransport}=await import(req.resolve('@modelcontextprotocol/sdk/client/stdio.js'));const entry=path.resolve(__dirname,'../../mcp/dist/server.js');close=await f.svc.start(entry);assert.equal(fs.readFileSync(path.join(f.root,'kanborg-mcp'),'utf8'),fs.readFileSync(path.join(f.root,'kanbots-mcp'),'utf8'));
 const added=await f.svc.uiAction('add-client',{name:'Test harness'});const connect=async(renamed=false)=>{client=new Client({name:'test-harness',version:'1'},{capabilities:{}});await client.connect(new StdioClientTransport({command:process.env.KANBOTS_TEST_ELECTRON_BIN??process.execPath,args:[process.env.KANBOTS_TEST_MCP_ENTRY??entry],env:{ELECTRON_RUN_AS_NODE:'1',[renamed?'KANBORG_COORDINATOR_CLIENT':'KANBOTS_COORDINATOR_CLIENT']:added.id,KANBOTS_LOCAL_DATA:f.root}}));};await connect();assert.equal((await client.callTool({name:'getCapabilities',arguments:{}})).isError,true);await f.svc.uiAction('approve-client',{id:added.id});const caps=await client.callTool({name:'getCapabilities',arguments:{}});assert.notEqual(caps.isError,true);await f.svc.uiAction('handoff',{mode:'external',clientId:added.id});const id=f.svc.ui().workspace.workspaceId;
 assert.equal((await client.callTool({name:'getCapacity',arguments:{workspaceId:'other'}})).isError,true);assert.notEqual((await client.callTool({name:'getWorkspaceSummary',arguments:{workspaceId:id}})).isError,true);
 close();close=await f.svc.start(entry);assert.notEqual((await client.callTool({name:'getWorkspaceSummary',arguments:{workspaceId:id}})).isError,true);
 await client.close();await connect(true);assert.notEqual((await client.callTool({name:'getCapabilities',arguments:{}})).isError,true);await f.svc.uiAction('revoke-client',{id:added.id});assert.equal((await client.callTool({name:'getCapabilities',arguments:{}})).isError,true);
 }finally{await client?.close();close?.();f.cleanup();}});

test('inventory reconciliation updates the same card and preserves status evidence',async()=>{const f=fixture();try{const c=await control(f);const item={sourceRef:'docs/roadmap.md#sync',title:'Sync feature',kind:'feature',status:'todo',evidence:'Planned in roadmap'};const first=(await write(f,c,'upsertWorkItem',item)).data;const second=(await write(f,c,'upsertWorkItem',{...item,status:'review',evidence:'Implementation ready for review'})).data;assert.equal(first.number,second.number);const result=await f.svc.call(c.actor,c.id,'getIssue',{workspaceId:c.id,number:first.number});assert.match(JSON.stringify(result),/Implementation ready for review/);const list=await f.svc.call(c.actor,c.id,'listIssues',{workspaceId:c.id});assert.equal(list.items.length,2);}finally{f.cleanup();}});

test('one-click onboarding starts the built-in coordinator without prior setup',async()=>{const f=fixture();try{assert.equal(f.svc.ui().workspace.mode,'off');const result=await f.svc.uiAction('onboarding-start');assert.equal(f.svc.ui().workspace.mode,'internal');assert.equal(f.svc.ui().workspace.conversationId,99);assert.match(result.body,/read-only repository inventory/);}finally{f.cleanup();}});

test('built-in coordinator prepares reusable harness setup without handing off or approving it',async()=>{const f=fixture();try{const result=await f.svc.uiAction('external-setup-start');assert.match(result.body,/prepareExternalCoordinator/);const w=f.svc.ui().workspace;const c={id:w.workspaceId,actor:w.controller};const first=(await write(f,c,'prepareExternalCoordinator',{name:'DeepSeek Harness'})).data;const second=(await write(f,c,'prepareExternalCoordinator',{name:'DeepSeek Harness'})).data;assert.equal(first.id,second.id);assert.equal(f.svc.ui().clients.length,1);assert.equal(f.svc.ui().clients[0].status,'pending');assert.equal(f.svc.ui().workspace.mode,'internal');assert.equal(first.humanApprovalRequired,true);assert.ok(first.config);}finally{f.cleanup();}});

test('coordinator activity navigation identifies its run without confusing unrelated runs',async()=>{const f=fixture();try{await control(f);f.runs.set(41,{id:41,threadId:1});f.runs.set(42,{id:42,threadId:2});assert.equal((await f.svc.uiAction('is-coordinator-run',{runId:41})).matches,true);assert.equal((await f.svc.uiAction('is-coordinator-run',{runId:42})).matches,false);assert.equal((await f.svc.uiAction('is-coordinator-run',{runId:999})).matches,false);}finally{f.cleanup();}});

test('reopening setup while coordinator is active returns progress instead of a stale error',async()=>{const f=fixture();try{await control(f);let posted=0;f.handlers['chat:get']=async()=>({activeRun:{id:77,status:'awaiting_input'},messages:[],events:[]});f.handlers['chat:post-message']=async()=>{posted++;};const result=await f.svc.uiAction('external-setup-start');assert.equal(result.alreadyRunning,true);assert.equal(result.status,'awaiting_input');assert.equal(posted,0);}finally{f.cleanup();}});

test('graceful handoff pauses dispatch, requires outgoing checkpoint and keeps one controller',async()=>{const f=fixture();try{const c=await control(f);const next=await f.svc.uiAction('prepare-connection',{name:'Claude Desktop'});await f.svc.uiAction('approve-client',{id:next.id});await f.svc.uiAction('request-handoff',{mode:'external',clientId:next.id});const h=f.svc.ui().workspace.handoff;assert.equal(h.state,'requested');await assert.rejects(write(f,c,'dispatchTask',{number:1}),/Handoff requested/);await assert.rejects(f.svc.uiAction('finish-handoff'),/Waiting/);const handoffResult=await write(f,c,'completeHandoff',{handoffId:h.id,summary:'Keep existing work; review task 1 next.'});assert.match(handoffResult.data.coordinatorInstruction,/Pause recurring check-ins/);await f.svc.uiAction('finish-handoff');assert.equal(f.svc.ui().workspace.controller,next.id);assert.equal(f.svc.ui().workspace.summary,'Keep existing work; review task 1 next.');await assert.rejects(write(f,c,'createIssue',{title:'stale controller'}),/controlled elsewhere/);await f.svc.call(next.id,c.id,'getWorkspaceSummary',{workspaceId:c.id});assert.equal(f.svc.ui().workspace.handoff.receivedBy,undefined);await f.svc.call(next.id,c.id,'confirmHandoffReconciled',{workspaceId:c.id,handoffId:h.id,epoch:f.svc.ui().workspace.epoch});assert.equal(f.svc.ui().workspace.handoff.receivedBy,next.id);}finally{f.cleanup();}});
test('external handoff can return to built-in using an explicitly chosen saved checkpoint',async()=>{const f=fixture();try{const client=await f.svc.uiAction('prepare-connection',{name:'ChatGPT Desktop'});assert.match(client.toml,/mcp_servers/);assert.match(client.prompt,/Claude Desktop/);await f.svc.uiAction('approve-client',{id:client.id});await f.svc.uiAction('handoff',{mode:'external',clientId:client.id});await f.svc.uiAction('request-handoff',{mode:'internal'});const result=await f.svc.uiAction('finish-handoff',{useSavedProgress:true});assert.equal(f.svc.ui().workspace.mode,'internal');assert.equal(f.svc.ui().workspace.handoff.state,'completed');assert.match(result.body,/getWorkspaceSummary/);}finally{f.cleanup();}});

test('renaming a connection preserves its pairing identity',async()=>{const f=fixture();try{const c=await f.svc.uiAction('prepare-connection',{name:'DeepSeek Harness'});await f.svc.uiAction('rename-client',{id:c.id,name:'Codex'});const renamed=f.svc.ui().clients.find(x=>x.id===c.id);assert.equal(renamed.name,'Codex');assert.equal(renamed.status,'pending');assert.equal((await f.svc.uiAction('config',{id:c.id})).id,c.id);}finally{f.cleanup();}});

test('coordinator can release without passing QA and answers worker decisions directly',async()=>{const f=fixture();try{const c=await control(f);await write(f,c,'dispatchTask',{number:1,qa:false});f.runs.get(1).status='complete';const plan=(await write(f,c,'prepareRelease',{runId:1,targetBranch:'main',action:'merge'})).data;assert.equal(plan.warnings.length,1);assert.equal((await write(f,c,'executeRelease',{releaseId:plan.id})).data.state,'completed');let resolved=0;f.handlers['decisions:pending']=async()=>[{cardId:7,question:'Continue?',options:[{value:'yes',label:'Yes'}]}];f.handlers['cards:resolve']=async a=>{resolved++;assert.equal(a.value,'yes');return {ok:true};};const result=await write(f,c,'answerDecision',{cardId:7,value:'yes'});assert.equal(result.data.state,'answered');assert.equal(resolved,1);}finally{f.cleanup();}});
test('external coordinator configures workflow and dispatches despite advisory dependencies',async()=>{const f=fixture();try{const client=await f.svc.uiAction('add-client',{name:'External'});await f.svc.uiAction('approve-client',{id:client.id});await f.svc.uiAction('handoff',{mode:'external',clientId:client.id});const c={id:f.svc.ui().workspace.workspaceId,actor:client.id};await write(f,c,'configureWorkflow',{qaDefault:false,budgetUsd:9,parallelism:3});assert.equal(f.svc.ui().workspace.qaDefault,false);await write(f,c,'setDependencies',{number:1,dependsOn:[2]});const result=await write(f,c,'dispatchTask',{number:1});assert.ok(result.data.runId);assert.equal(result.data.qa,false);assert.equal(f.svc.ui().jobs[0].budgetUsd,9);await assert.rejects(write(f,{...c,actor:'former'},'configureWorkflow',{qaDefault:true}),/controlled elsewhere/);}finally{f.cleanup();}});

test('fresh setup omits historical instructions and uses compact adaptive reminder',async()=>{const f=fixture();try{const c=await control(f);await write(f,c,'updateCoordinationSession',{objective:'Ship search',summary:'Historical Cline standing instructions MUST NOT be copied.'});const setup=await f.svc.uiAction('prepare-connection',{name:'Codex'});assert.match(setup.prompt,/as Codex/);assert.doesNotMatch(setup.prompt,/MUST NOT be copied|60-second idle/);assert.match(setup.prompt,/5 minutes/);assert.match(setup.prompt,/Retire superseded/);let delta=await f.svc.call(c.actor,c.id,'getChanges',{workspaceId:c.id,cursor:999});assert.equal(delta.checkIn.cadenceMinutes,15);assert.equal(delta.checkIn.prompt,undefined);assert.equal(delta.control.controller,c.actor);await write(f,c,'dispatchTask',{number:1,qa:false});delta=await f.svc.call(c.actor,c.id,'getChanges',{workspaceId:c.id,cursor:999});assert.equal(delta.checkIn.cadenceMinutes,5);assert.equal(delta.events.length,0);}finally{f.cleanup();}});
test('handoff never claims old schedules paused; former owner may confirm only its own retirement',async()=>{const f=fixture();try{const c=await control(f);await write(f,c,'updateCoordinationSession',{schedule:{id:'old-reminder',status:'active',cadenceMinutes:5}});const next=await f.svc.uiAction('prepare-connection',{name:'Codex'});await f.svc.uiAction('approve-client',{id:next.id});await f.svc.uiAction('handoff',{mode:'external',clientId:next.id});let policy=f.svc.ui().workspace.checkIn;assert.equal(policy.confirmed,null);assert.equal(policy.retirementPending[0].id,'old-reminder');await assert.rejects(write(f,c,'updateCoordinationSession',{objective:'take over',schedule:{id:'old-reminder',status:'paused'}}),/controlled elsewhere/);await write(f,c,'updateCoordinationSession',{schedule:{id:'old-reminder',status:'paused'}});policy=f.svc.ui().workspace.checkIn;assert.equal(policy.retirementPending.length,0);assert.equal(f.svc.ui().workspace.controller,next.id);assert.equal(policy.cadenceMinutes,null);}finally{f.cleanup();}});

test('update tools preserve controller permissions and drain workers without dispatching more',async()=>{const f=fixture();try{const c=await control(f);let pending=false;f.svc.setUpdater({status:()=>({pending}),check:async()=>({available:{version:'1.2.14'}}),pending:()=>pending,request:async()=>{pending=true;return {accepted:true};}});await write(f,c,'dispatchTask',{number:1,qa:false});await assert.rejects(write(f,{...c,actor:'other'},'updateApplication',{action:'install'}),/controlled elsewhere/);assert.equal((await write(f,c,'updateApplication',{action:'install'})).data.accepted,true);assert.equal(f.runs.get(1).status,'running');await assert.rejects(write(f,c,'dispatchTask',{number:2}),/update is waiting/);await f.svc.tick();assert.equal(f.starts,1);}finally{f.cleanup();}});

test('external coordinator receives one durable post-update resume request',async()=>{const f=fixture();try{const client=await f.svc.uiAction('add-client',{name:'External'});await f.svc.uiAction('approve-client',{id:client.id});await f.svc.uiAction('handoff',{mode:'external',clientId:client.id});const id=f.svc.ui().workspace.workspaceId;await f.svc.resumeAfterUpdate('1.2.16','test-update');await f.svc.resumeAfterUpdate('1.2.16','test-update');const requests=await f.svc.call(client.id,id,'getCoordinatorRequests',{workspaceId:id});assert.equal(requests.length,1);assert.equal(requests[0].kind,'resume-workflows');assert.equal(requests[0].state,'queued');assert.match(requests[0].prompt,/next authorized implementation or QA/);const delta=await f.svc.call(client.id,id,'getChanges',{workspaceId:id,cursor:999});assert.deepEqual(delta.pendingRequestIds,[requests[0].id]);assert.equal(delta.checkIn.cadenceMinutes,5);assert.equal(f.starts,0);}finally{f.cleanup();}});
test('post-update kick advances queued work once without repeating completed workers',async()=>{const f=fixture();try{const c=await control(f);await write(f,c,'configureWorkflow',{parallelism:1});await write(f,c,'dispatchTask',{number:1,qa:false});const issue=(await write(f,c,'createIssue',{title:'Next task'})).data;await write(f,c,'dispatchTask',{number:issue.number,qa:false});assert.equal(f.svc.ui().queue.length,1);f.runs.get(1).status='complete';const chats=[];f.handlers['chat:post-message']=async a=>{chats.push(a.body);return {};};await f.svc.resumeAfterUpdate('1.2.16','test-update');await f.svc.resumeAfterUpdate('1.2.16','test-update');assert.equal(f.starts,2);assert.equal(f.svc.ui().workspace.requests.filter(r=>r.kind==='resume-workflows').length,1);assert.equal(chats.length,2);assert.equal(new Set(chats).size,2);assert.equal(f.svc.ui().queue.length,0);assert.equal(f.svc.ui().jobs.find(j=>j.runId===1).state,'completed');assert.equal(f.svc.ui().workspace.requests[0].state,'received');}finally{f.cleanup();}});
test('post-update kick respects paused coordination',async()=>{const f=fixture();try{await f.svc.resumeAfterUpdate('1.2.16','test-update');assert.equal(f.svc.ui().workspace.requests.length,0);assert.equal(f.starts,0);}finally{f.cleanup();}});

test('external and app workflow editors share saved versions, card migrations, templates and undo',async()=>{const f=fixture();try{
 const client=await f.svc.uiAction('add-client',{name:'Codex'});await f.svc.uiAction('approve-client',{id:client.id});await f.svc.uiAction('handoff',{mode:'external',clientId:client.id});const c={id:f.svc.ui().workspace.workspaceId,actor:client.id};
 await write(f,c,'dispatchTask',{number:1,qa:false});const before=await f.svc.call(c.actor,c.id,'getWorkflow',{workspaceId:c.id});
 const config=structuredClone(before.config);config.stages.splice(4,0,{...config.stages[4],id:'deployment',name:'Deployment'});config.transitions.push({from:'inProgress',to:'deployment',actor:'coordinator',automatic:false,event:'manual'},{from:'deployment',to:'done',actor:'coordinator',automatic:false,event:'manual'});
 const change={expectedVersion:before.version,config,reason:'Deployment after Review; coordinator releases',moves:[{number:1,to:'deployment',evidence:'PR #10 merged; abc123'}]};
 const preview=await f.svc.call(c.actor,c.id,'previewWorkflowChange',{workspaceId:c.id,...change});assert.deepEqual(preview.errors,[]);
 await write(f,c,'applyWorkflowChange',change);const ui=await f.svc.uiAction('workflow:get');assert.equal(ui.version,2);assert.equal(ui.cards[1].stageId,'deployment');assert.equal(f.starts,1);assert.equal(f.runs.get(1).status,'running');assert.equal(ui.history[0].actor,client.id);
 await f.svc.uiAction('workflow:template',{id:'team-delivery',name:'Team delivery'});assert.equal((await f.svc.call(c.actor,c.id,'getWorkflow',{workspaceId:c.id})).templates.length,1);
 await f.svc.uiAction('workflow:undo',{expectedVersion:2,reason:'Restore original flow'});const undone=await f.svc.call(c.actor,c.id,'getWorkflow',{workspaceId:c.id});assert.equal(undone.version,3);assert.equal(undone.cards[1].stageId,'inProgress');assert.equal(f.starts,1);
 }finally{f.cleanup();}});

test('autopilot becomes a durable coordinator assignment and survives pause and handoff without spawning workers',async()=>{const f=fixture();try{
 const c=await control(f);let stopped;f.handlers['autopilot:list-active']=async()=>[{id:9,children:[{runId:77,status:'running'}]}];f.handlers['autopilot:stop']=async args=>{stopped=args;f.handlers['autopilot:list-active']=async()=>[];return {};};
 await f.svc.uiAction('autopilot',{action:'start',personas:[{id:'engineer',name:'Engineer',prompt:'Find valuable improvements'}],parallelism:2,effort:'medium'});assert.deepEqual(stopped,{sessionId:9,stopChildren:false});assert.equal(f.starts,0);assert.equal(f.svc.ui().workspace.autopilot.status,'active');assert.equal(f.svc.ui().workspace.autopilot.legacyWork[0].runId,77);assert.match(f.svc.ui().workspace.requests.find(r=>r.kind==='autopilot').prompt,/sole coordinator/);
 await write(f,c,'manageAutopilot',{action:'pause'});assert.equal(f.svc.ui().workspace.autopilot.status,'paused');assert.equal(f.starts,0);
 const client=await f.svc.uiAction('add-client',{name:'Next harness'});await f.svc.uiAction('approve-client',{id:client.id});await f.svc.uiAction('handoff',{mode:'external',clientId:client.id});const next={id:c.id,actor:client.id};await assert.rejects(write(f,c,'manageAutopilot',{action:'resume'}),/controlled elsewhere/);await write(f,next,'manageAutopilot',{action:'resume'});const state=await f.svc.call(next.actor,next.id,'getCoordinationSession',{workspaceId:next.id});assert.equal(state.autopilot.status,'active');assert.equal(state.autopilot.personas[0].id,'engineer');assert.equal(state.requests.filter(r=>r.kind==='autopilot').length,1);assert.equal(f.starts,0);
 }finally{f.cleanup();}});
test('starting autopilot without a harness opens built-in coordination and delivers one request',async()=>{const f=fixture();try{let messages=[];f.handlers['chat:post-message']=async a=>{messages.push(a.body);return {};};await f.svc.uiAction('autopilot',{action:'start',personas:[{id:'qa',name:'QA',prompt:'Assess acceptance'}],objective:'Deliver QA findings'});assert.equal(f.svc.ui().workspace.mode,'internal');await f.svc.tick();await f.svc.tick();assert.equal(messages.length,1);assert.match(messages[0],/Deliver QA findings/);assert.equal(f.starts,0);}finally{f.cleanup();}});

test('perspective reviews queue with the active coordinator without launching a separate provider',async()=>{const f=fixture();try{const c=await control(f);const before=f.svc.ui().workspace.controller;const request=await f.svc.uiAction('request-perspective',{name:'Reliability',prompt:'Look for fragile workflows',notes:'Focus on onboarding'});assert.equal(request.state,'queued');assert.match(request.prompt,/automatic routing/);assert.match(request.prompt,/Focus on onboarding/);assert.match(request.prompt,/not permission to implement/);assert.equal(f.svc.ui().workspace.controller,before);assert.equal(f.starts,0);assert.ok(f.svc.ui().workspace.requests.some(r=>r.id===request.id));}finally{f.cleanup();}});

test('Off blocks autopilot dispatch and queued replacement but preserves active workers',async()=>{const f=fixture();try{const c=await control(f);await f.svc.uiAction('autopilot',{action:'start',personas:[{id:'test',name:'Test',prompt:'Review project'}],parallelism:1});await write(f,c,'dispatchTask',{number:1,qa:true});const issue=(await write(f,c,'createIssue',{title:'Queued'})).data;await write(f,c,'dispatchTask',{number:issue.number,qa:false});await f.svc.uiAction('autopilot',{action:'pause'});assert.match(f.svc.ui().workspace.autopilot.label,/Winding down · 1/);await assert.rejects(write(f,c,'dispatchTask',{number:issue.number}),/Off/);assert.equal(f.runs.get(1).status,'running');f.runs.get(1).status='complete';await f.svc.tick();assert.equal(f.starts,1);assert.equal(f.svc.ui().jobs[0].state,'awaiting-review');assert.equal(f.svc.ui().workspace.autopilot.label,'Off');assert.equal(f.svc.ui().queue.length,1);}finally{f.cleanup();}});
test('expedite records actual worker acknowledgments and preserves checkpoint evidence across reload',async()=>{const f=fixture();try{const c=await control(f);await f.svc.uiAction('autopilot',{action:'start',personas:[{id:'test',name:'Test',prompt:'Review'}]});await write(f,c,'dispatchTask',{number:1,qa:true});await f.svc.uiAction('autopilot',{action:'expedite'});const j=f.svc.ui().jobs[0];const {checkpointDirectory}=load(path.resolve(__dirname,'../src/worker-checkpoint.ts'));const dir=checkpointDirectory(f.root,j.controlId);assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'request.json'))).action,'checkpoint');assert.equal(f.svc.ui().workspace.autopilot.workers[0].state,'requested');fs.writeFileSync(path.join(dir,'response.json'),JSON.stringify({id:j.controlId,state:'acknowledged'}));assert.equal(f.svc.ui().workspace.autopilot.workers[0].state,'acknowledged');fs.writeFileSync(path.join(dir,'response.json'),JSON.stringify({id:j.controlId,state:'checkpointed',summary:'Saved bounded change',remainingValidation:'Unit tests pending',artifacts:['src/test.ts']}));f.runs.get(1).status='complete';await f.svc.tick();assert.equal(f.svc.ui().jobs[0].state,'checkpointed');await f.svc.beforeClose();const saved=JSON.parse(fs.readFileSync(path.join(f.root,'coordinators.json')));assert.equal(saved.workspaces[0].autopilot.status,'paused');assert.equal(saved.workspaces[0].jobs[0].checkpoint.remainingValidation,'Unit tests pending');assert.equal(f.starts,1);}finally{f.cleanup();}});
test('update wind-down preserves Off and restores prior On without duplicating checkpointed work',async()=>{const f=fixture();try{await control(f);await f.svc.uiAction('autopilot',{action:'start',personas:[{id:'test',name:'Test',prompt:'Review'}]});f.svc.beginUpdateWindDown();assert.equal(f.svc.ui().workspace.autopilot.status,'paused');f.svc.beginUpdateWindDown();f.svc.endUpdateWindDown();assert.equal(f.svc.ui().workspace.autopilot.status,'active');f.svc.beginUpdateWindDown();await f.svc.uiAction('autopilot',{action:'pause'});f.svc.endUpdateWindDown();assert.equal(f.svc.ui().workspace.autopilot.status,'paused');assert.equal(f.starts,0);}finally{f.cleanup();}});
test('Stop now records interrupted recovery state rather than completion',async()=>{const f=fixture();try{const c=await control(f);await f.svc.uiAction('autopilot',{action:'start',personas:[{id:'test',name:'Test',prompt:'Review'}]});await write(f,c,'dispatchTask',{number:1,qa:false});await f.svc.uiAction('stop-wind-down-worker',{runId:1});assert.equal(f.svc.ui().jobs[0].state,'interrupted');assert.equal(f.runs.get(1).status,'stopped');assert.match(f.svc.ui().jobs[0].error,/recovery needed/);}finally{f.cleanup();}});

test('coordinator messages queue while busy, support edits and deliver once after the turn',async()=>{const f=fixture();try{await control(f);let working=true;const sent=[];f.handlers['chat:get']=async()=>({activeRun:working?{id:99}:null,messages:[],events:[]});f.handlers['chat:post-message']=async a=>{sent.push(a.body);return {};};await f.svc.uiAction('chat-submit',{id:'message-1',body:'First draft'});await f.svc.uiAction('chat-submit',{id:'message-1',body:'Duplicate click'});await f.svc.tick();assert.equal(sent.length,0);assert.equal(f.svc.ui().workspace.chatOutbox.length,1);await f.svc.uiAction('chat-edit-queued',{id:'message-1',body:'Revised direction'});working=false;await f.svc.tick();await f.svc.tick();assert.deepEqual(sent,['Revised direction']);assert.equal(f.svc.ui().workspace.chatOutbox[0].state,'sent');}finally{f.cleanup();}});
test('steering stops only the coordinator and precedes queued follow-ups',async()=>{const f=fixture();try{await control(f);f.runs.set(99,{id:99,status:'running'});f.runs.set(88,{id:88,status:'running'});f.handlers['chat:get']=async()=>({activeRun:f.runs.get(99).status==='running'?{id:99}:null});const sent=[];f.handlers['chat:post-message']=async a=>{sent.push(a.body);return {};};await f.svc.uiAction('chat-submit',{id:'later',body:'Later'});await f.svc.uiAction('chat-submit',{id:'steer',body:'Change direction',steer:true});assert.equal(f.runs.get(99).status,'stopped');assert.equal(f.runs.get(88).status,'running');await f.svc.tick();assert.match(sent[0],/Change direction/);assert.equal(f.svc.ui().workspace.chatOutbox.find(m=>m.id==='later').state,'queued');await f.svc.uiAction('chat-cancel-queued',{id:'later'});assert.equal(f.svc.ui().workspace.chatOutbox.length,1);}finally{f.cleanup();}});

test('question replies and explanations persist in current coordinator inbox without resuming origin', async()=>{
 const f=fixture();try{
  const c=await control(f);
  const card={id:501,type:'decision',status:'pending',payload:{question:'Which migration path?',options:[{value:'safe',label:'Stage it'}]}};
  f.runs.set(77,{id:77,threadId:22,status:'running',worktreePath:f.root});
  f.svc.context.store.cards={listAllPending:()=>card.status==='pending'?[{card,agentRunId:77}]:[],findById:()=>card,resolve:()=>{card.status='resolved';}};
  const [question]=await f.svc.uiAction('questions-list');
  assert.equal(question.busy,false);assert.equal(question.originBusy,true);
  const explanation=await f.svc.uiAction('question-reply',{id:501,explain:true});
  assert.equal((await f.svc.uiAction('question-reply',{id:501,explain:true})).requestId,explanation.requestId);
  const pending=(await f.svc.uiAction('questions-list'))[0];assert.equal(pending.explanationPending,true);
  assert.equal(card.status,'pending');
  await write(f,c,'recordUserQuestionExplanation',{id:501,explanation:'Staging preserves the rollback option.'});
  assert.equal((await f.svc.uiAction('questions-list'))[0].explanation,'Staging preserves the rollback option.');
  const receipt=await f.svc.uiAction('question-reply',{id:501,reply:'Stage it after backup'});
  const request=f.svc.ui().workspace.requests.find(r=>r.id===receipt.requestId);
  assert.match(request.prompt,/thread 22, run 77/);assert.match(request.prompt,/after backup/);
  assert.equal(request.state,'queued');assert.equal(f.resumes.length,0);assert.equal(f.runs.get(77).status,'running');
  assert.equal(card.status,'resolved');assert.deepEqual(await f.svc.uiAction('questions-list'),[]);
  const history=await f.svc.uiAction('questions-list',{includeAnswered:true});assert.equal(history[0].reply,'Stage it after backup');assert.equal(history[0].answerStatus,'queued');
  await write(f,c,'recordUserQuestionResponse',{id:501,response:'Backup verified; the staged migration is ready for review.'});
  const restored=f.reload();const saved=(await restored.uiAction('questions-list',{includeAnswered:true}))[0];assert.equal(saved.reply,'Stage it after backup');assert.match(saved.response,/Backup verified/);
  assert.deepEqual(await f.svc.uiAction('question-reply',{id:501,reply:'Stage it after backup'}),receipt);
  await assert.rejects(f.svc.uiAction('question-reply',{id:501,reply:'Different answer'}),/no longer/);
 }finally{f.cleanup();}
});

test('unavailable coordinator retains durable answer and records delivery blocker without stopping origin',async()=>{
 const f=fixture();try{
  await control(f);
  const card={id:502,type:'decision',status:'pending',payload:{question:'Proceed?',options:[]}};
  f.runs.set(78,{id:78,threadId:23,status:'running',worktreePath:f.root});
  f.svc.context.store.cards={listAllPending:()=>card.status==='pending'?[{card,agentRunId:78}]:[],findById:()=>card,resolve:()=>{card.status='resolved';}};
  await f.svc.uiAction('questions-list');
  const receipt=await f.svc.uiAction('question-reply',{id:502,reply:'Proceed'});
  f.handlers['chat:post-message']=async()=>({dispatchError:'provider unavailable'});
  await f.svc.tick();
  const requests=f.svc.ui().workspace.requests;
  assert.equal(requests.find(r=>r.id===receipt.requestId).error,'provider unavailable');
  assert.equal(requests.find(r=>r.id===receipt.requestId).state,'queued');
  assert.equal(f.resumes.length,0);assert.equal(f.runs.get(78).status,'running');
  assert.equal(f.reload().ui().workspace.requests.find(r=>r.id===receipt.requestId).state,'queued');
 }finally{f.cleanup();}
});

test('built-in handoff waits for busy turn then delivers wrap-up directly once',async()=>{const f=fixture();try{const c=await control(f);let busy=true;const messages=[];f.handlers['chat:get']=async()=>({activeRun:busy?{id:99}:null});f.handlers['chat:post-message']=async a=>{messages.push(a.body);busy=true;return {activeRun:{id:100}};};const next=await f.svc.uiAction('add-client',{name:'Codex'});await f.svc.uiAction('approve-client',{id:next.id});await f.svc.uiAction('request-handoff',{mode:'external',clientId:next.id});assert.equal(messages.length,0);assert.equal(f.svc.ui().workspace.handoff.delivery,'waiting');busy=false;await f.svc.tick();assert.equal(messages.length,1);assert.match(messages[0],/completeHandoff with handoffId/);assert.equal(f.svc.ui().workspace.handoff.delivery,'sent');await f.svc.tick();assert.equal(messages.length,1);const h=f.svc.ui().workspace.handoff;await write(f,c,'completeHandoff',{handoffId:h.id,summary:'Existing workers continue; review their evidence.'});assert.equal(f.svc.ui().workspace.handoff.state,'ready');assert.equal(f.svc.ui().workspace.controller,c.actor);}finally{f.cleanup();}});

test('built-in wrap-up delivery failure is visible and retries only on request',async()=>{const f=fixture();try{await control(f);let calls=0;f.handlers['chat:post-message']=async()=>{calls++;return {dispatchError:'Provider unavailable'};};const next=await f.svc.uiAction('add-client',{name:'Claude'});await f.svc.uiAction('approve-client',{id:next.id});await f.svc.uiAction('request-handoff',{mode:'external',clientId:next.id});assert.equal(f.svc.ui().workspace.handoff.delivery,'failed');await f.svc.tick();assert.equal(calls,1);await f.svc.uiAction('retry-handoff');assert.equal(calls,2);assert.equal(f.svc.ui().workspace.handoff.state,'requested');}finally{f.cleanup();}});

test('existing-chat binding requires owner approval and receiver receipts never confer authority',async()=>{const f=fixture();try{await control(f);const client=await f.svc.uiAction('add-client',{name:'Existing chat'});await f.svc.uiAction('approve-client',{id:client.id});const workspaceId=f.svc.ui().workspace.workspaceId;const args={workspaceId,hostId:'mac',chatId:'existing-chat',adapterId:'verified-test'};const b=await f.svc.call(client.id,workspaceId,'proposeHostBinding',args);assert.equal(b.state,'pending');assert.equal((await f.svc.call(client.id,workspaceId,'proposeHostBinding',args)).id,b.id);await assert.rejects(f.svc.uiAction('approve-binding',{id:b.id}),/not installed/);f.svc.registerHostAdapter({id:'verified-test',reachable:async()=>({state:'available',observedAt:Date.now()}),send:async()=>({state:'accepted',receipt:'test'}),reconcile:async()=>({state:'accepted'})});await f.svc.uiAction('approve-binding',{id:b.id});await f.svc.uiAction('handoff',{mode:'external',clientId:client.id});await f.svc.tick();const feed=await f.svc.call(client.id,workspaceId,'getOutboundEvents',{workspaceId});const e=feed.events.find(e=>e.state==='accepted');assert.ok(e);await assert.rejects(f.svc.call(client.id,workspaceId,'acknowledgeWake',{workspaceId,id:e.id,epoch:e.epoch+1,state:'received'}),/authority/);await f.svc.call(client.id,workspaceId,'acknowledgeWake',{workspaceId,id:e.id,epoch:e.epoch,state:'received'});await f.svc.call(client.id,workspaceId,'acknowledgeWake',{workspaceId,id:e.id,epoch:e.epoch,state:'acted',summary:'Read state; no work pending'});assert.equal(e.state,'acted');await f.svc.uiAction('revoke-binding',{id:b.id});assert.equal(f.svc.ui().workspace.controller,client.id);}finally{f.cleanup();}});

test('passed gates save compact phase evidence available through run result',async()=>{const f=fixture();try{const c=await control(f);await write(f,c,'dispatchTask',{number:1,qa:true});f.runs.get(1).status='complete';await f.svc.tick();f.checks[0].status='pass';await f.svc.tick();const r=await f.svc.call(c.actor,c.id,'getRunResult',{workspaceId:c.id,runId:1});assert.equal(r.qa.phaseCheckpoint.phase,'qa-passed');assert.equal(r.qa.phaseCheckpoint.evidence.commit,'a'.repeat(40));assert.deepEqual(r.qa.phaseCheckpoint.evidence.checkIds,[1]);assert.equal(r.qa.phaseCheckpoint.task.number,1);assert.match(r.qa.phaseCheckpoint.constraints,/does not authorize/);}finally{f.cleanup();}});

test('phase follow-up uses checkpoint once without replacing run or worktree',async()=>{const f=fixture();try{const c=await control(f);await write(f,c,'dispatchTask',{number:1,qa:false});f.runs.get(1).status='complete';await f.svc.tick();await write(f,c,'followUpRun',{runId:1,message:'Continue with the next authorized phase'});assert.equal(f.starts,1);assert.equal(f.resumes[0].runId,1);assert.equal(f.resumes[0].freshContext,true);assert.match(f.resumes[0].prompt,/Phase checkpoint/);assert.match(f.resumes[0].prompt,/Continue with the next authorized phase/);f.runs.get(1).status='complete';await write(f,c,'followUpRun',{runId:1,message:'Clarify this phase'});assert.equal(f.resumes[1].freshContext,false);}finally{f.cleanup();}});

test('cancelled updater reconciles stale wind-down before owner resume',async()=>{const f=fixture();try{const c=await control(f);await write(f,c,'manageAutopilot',{action:'start',personas:[{id:'engineer',name:'Engineer',prompt:'Improve scoped work'}]});f.svc.beginUpdateWindDown();f.svc.setUpdater({pending:()=>false,status:()=>({update:{phase:'cancelled'}}),check:async()=>({}),request:async()=>({})});await write(f,c,'manageAutopilot',{action:'resume'});assert.equal(f.svc.ui().workspace.autopilot.status,'active');assert.equal(f.starts,0);}finally{f.cleanup();}});

test('normal relaunch restores active Autopilot settings and queues one reconciliation without duplicate workers',async()=>{const f=fixture();try{await control(f);await f.svc.uiAction('autopilot',{action:'start',personas:[{id:'qa',name:'QA',prompt:'Review'}],parallelism:2,effort:'high',objective:'Existing objective'});await f.svc.tick();await f.svc.beforeClose();const restored=f.reload();const before=restored.ui().workspace.autopilot;restored.resumeAutopilotAfterLaunch();restored.resumeAutopilotAfterLaunch();assert.deepEqual(restored.ui().workspace.autopilot,before);assert.equal(before.status,'active');assert.equal(before.parallelism,2);assert.equal(before.effort,'high');assert.equal(before.objective,'Existing objective');assert.equal(restored.ui().workspace.requests.filter(r=>r.id.startsWith('launch-resume:')).length,1);assert.equal(f.starts,0);}finally{f.cleanup();}});
test('normal relaunch retains Off and expedited wind-down without enabling Autopilot',async()=>{for(const action of ['pause','expedite','complete']){const f=fixture();try{await control(f);await f.svc.uiAction('autopilot',{action:'start',personas:[{id:'qa',name:'QA',prompt:'Review'}]});await f.svc.uiAction('autopilot',{action});await f.svc.beforeClose();const restored=f.reload();const before=restored.ui().workspace.autopilot;restored.resumeAutopilotAfterLaunch();assert.deepEqual(restored.ui().workspace.autopilot,before);assert.equal(restored.ui().workspace.requests.filter(r=>r.id.startsWith('launch-resume:')).length,0);assert.equal(f.starts,0);}finally{f.cleanup();}}});
test('relaunch reuses queued Autopilot work and defers to update wind-down',async()=>{const f=fixture();try{await control(f);f.handlers['chat:get']=async()=>({activeRun:{id:999}});await f.svc.uiAction('autopilot',{action:'start',personas:[{id:'qa',name:'QA',prompt:'Review'}]});const restored=f.reload();restored.resumeAutopilotAfterLaunch();assert.equal(restored.ui().workspace.requests.length,1);f.svc.beginUpdateWindDown();const drained=f.reload();drained.resumeAutopilotAfterLaunch();assert.equal(drained.ui().workspace.autopilot.status,'paused');assert.equal(drained.ui().workspace.requests.filter(r=>r.kind==='autopilot').length,1);assert.equal(drained.ui().workspace.requests.filter(r=>r.id.startsWith('update-wind-down:')).length,1);}finally{f.cleanup();}});

test('Autopilot start and apply deliver the displayed settings immediately while preserving workers',async()=>{const f=fixture();try{await control(f);const messages=[];f.handlers['chat:post-message']=async a=>{messages.push(a.body);return {};};await f.svc.uiAction('autopilot',{action:'start',personas:[{id:'qa',name:'QA',prompt:'Review'}],parallelism:4,effort:'high'});assert.equal(messages.length,1);assert.match(messages[0],/"parallelism":4/);assert.match(messages[0],/"effort":"high"/);await f.svc.uiAction('autopilot',{action:'update',personas:[{id:'engineer',name:'Engineer',prompt:'Inspect'}],parallelism:2,effort:'low'});assert.equal(messages.length,2);assert.equal(f.svc.ui().workspace.parallelism,2);assert.match(messages[1],/"effort":"low"/);assert.equal(f.starts,0);}finally{f.cleanup();}});
test('failed Autopilot delivery remains visibly pending and applying settings retries once',async()=>{const f=fixture();try{await control(f);let attempts=0;f.handlers['chat:post-message']=async()=>{attempts++;throw Error('Provider offline');};let result=await f.svc.uiAction('autopilot',{action:'start',personas:[{id:'qa',name:'QA',prompt:'Review'}]});let request=result.workspace.requests.find(r=>r.kind==='autopilot');assert.equal(request.state,'queued');assert.match(request.error,/Provider offline/);await f.svc.tick();assert.equal(attempts,1);f.handlers['chat:post-message']=async()=>{attempts++;return {};};result=await f.svc.uiAction('autopilot',{action:'update',effort:'high'});request=result.workspace.requests.find(r=>r.kind==='autopilot');assert.equal(request.state,'received');assert.equal(request.error,undefined);assert.equal(attempts,2);}finally{f.cleanup();}});
test('update readiness preserves idle questions but waits for live processes',async()=>{const f=fixture();try{const c=await control(f);await write(f,c,'dispatchTask',{number:1,qa:false});const run=f.runs.get(1);assert.equal(await f.svc.updateWorkersReady(),false);run.status='awaiting_input';run.pid=null;assert.equal(await f.svc.updateWorkersReady(),true);assert.equal(run.status,'awaiting_input');run.pid=123;assert.equal(await f.svc.updateWorkersReady(),false);}finally{f.cleanup();}});
test('update pause and recovery fan out durably without duplicate notices or changing ownership',async()=>{const f=fixture();try{await control(f);const w=f.svc.state.workspaces[0];w.autopilot={status:'active',personas:[],effort:'high',parallelism:3,objective:'Keep',updatedAt:'now',legacyWork:[]};const other=JSON.parse(JSON.stringify(w));other.id='other';other.path=f.root+'/other';other.controller='other-controller';other.mode='external';other.requests=[];other.jobs=[];other.events=[];other.autopilot.status='paused';f.svc.state.workspaces.push(other);f.svc.beginUpdateWindDown();f.svc.beginUpdateWindDown();for(const workspace of [w,other]){assert.equal(workspace.autopilot.status,'paused');assert.equal(workspace.requests.filter(r=>r.id.startsWith('update-wind-down:')).length,1);}const restored=f.reload();assert.equal(restored.updateCoordination().length,2);await restored.resumeAfterUpdate('1.2.31','one-update');await restored.resumeAfterUpdate('1.2.31','one-update');const rows=restored.state.workspaces;assert.equal(rows[0].autopilot.status,'active');assert.equal(rows[1].autopilot.status,'paused');assert.equal(rows[1].controller,'other-controller');for(const workspace of rows){assert.equal(workspace.requests.filter(r=>r.id==='update-resume:one-update').length,1);assert.equal(workspace.requests.find(r=>r.id.startsWith('update-wind-down:')).state,'completed');}assert.equal(f.starts,0);}finally{f.cleanup();}});
test('closed workspace coordinator receives update delta and can acknowledge without touching open project',async()=>{const f=fixture();try{await control(f);const other=JSON.parse(JSON.stringify(f.svc.state.workspaces[0]));other.id='closed';other.path=f.root+'/closed';other.controller='closed-controller';other.mode='external';other.jobs=[];other.requests=[];other.receipts={};other.events=[];f.svc.state.workspaces.push(other);f.svc.beginUpdateWindDown();const delta=await f.svc.call(other.controller,other.id,'getChanges',{workspaceId:other.id,cursor:0});assert.equal(delta.pendingRequestIds.length,1);const notices=await f.svc.call(other.controller,other.id,'getCoordinatorRequests',{workspaceId:other.id});await f.svc.call(other.controller,other.id,'acknowledgeCoordinatorRequest',{workspaceId:other.id,id:notices[0].id,state:'received',revision:other.revision,requestId:'ack-update-notice'});assert.equal(other.requests[0].state,'received');await assert.rejects(f.svc.call(other.controller,other.id,'dispatchTask',{workspaceId:other.id,number:1,revision:other.revision,requestId:'blocked-dispatch'}),/not open/);assert.equal(f.starts,0);}finally{f.cleanup();}});

test('app controls share handlers, require current authority, and replay once across restart',async()=>{const f=fixture();try{const c=await control(f);let archived=0;f.handlers['issues:archive']=async a=>{archived++;return {number:a.number,state:'archived'};};const input={workspaceId:c.id,revision:f.svc.ui().workspace.revision,requestId:'archive-exact-once',number:1};const first=await f.svc.call(c.actor,c.id,'archiveIssue',input);assert.equal(first.data.state,'archived');assert.deepEqual(await f.svc.call(c.actor,c.id,'archiveIssue',input),first);assert.equal(archived,1);const restored=f.reload();assert.deepEqual(await restored.call(c.actor,c.id,'archiveIssue',input),first);assert.equal(archived,1);await assert.rejects(f.svc.call('other-controller',c.id,'archiveIssue',{...input,requestId:'other-controller'}),/controlled elsewhere/);await assert.rejects(f.svc.call(c.actor,c.id,'archiveIssue',{...input,workspaceId:'other'}),/not permitted/);await assert.rejects(f.svc.call(c.actor,c.id,'archiveIssue',{...input,requestId:'stale-revision'}),/Stale revision/);await assert.rejects(f.svc.call(c.actor,c.id,'archiveIssue',{...input,number:2}),/different arguments/);}finally{f.cleanup();}});
test('app provider reads use the same application store and reject secret inputs',async()=>{const f=fixture();try{const c=await control(f);const result=await f.svc.call(c.actor,c.id,'getProviderConfiguration',{workspaceId:c.id});assert.equal(result.source,'app-store');assert.throws(()=>manifest.validateCoordinatorArgs('updateProviderPreferences',{workspaceId:c.id,revision:1,requestId:'secret-rejected',id:'claude-code',apiKey:'must-not-enter-mcp'}),/Unexpected/);assert.throws(()=>manifest.validateCoordinatorArgs('saveErrorMonitorConfiguration',{workspaceId:c.id,revision:1,requestId:'secret-rejected',token:'must-not-enter-mcp'}),/Unexpected/);}finally{f.cleanup();}});
test('remote handoff uses approved connections and permits checkpoint and finish under one receipt',async()=>{const f=fixture();try{const c=await control(f);const pending=await f.svc.uiAction('add-client',{name:'Next'});await assert.rejects(write(f,c,'requestCoordinatorHandoff',{mode:'external',clientId:pending.id}),/approve/);await f.svc.uiAction('approve-client',{id:pending.id});await write(f,c,'requestCoordinatorHandoff',{mode:'external',clientId:pending.id});await write(f,c,'completeHandoff',{handoffId:f.svc.ui().workspace.handoff.id,summary:'Retain exact work'});await write(f,c,'finishCoordinatorHandoff');assert.equal(f.svc.ui().workspace.controller,pending.id);await assert.rejects(write(f,c,'setHouseRules',{houseRules:'stale authority'}),/controlled elsewhere/);}finally{f.cleanup();}});
test('remote controls cannot start new work during update wind-down',async()=>{const f=fixture();try{const c=await control(f);f.svc.setUpdater({pending:()=>true,status:()=>({})});await assert.rejects(write(f,c,'startRunPreview',{runId:1}),/Run not found|wind-down/);await assert.rejects(write(f,c,'requestRepositoryDiscovery'),/wind-down/);}finally{f.cleanup();}});
test('nullable controls validate null and reject unexpected nested fields',()=>{assert.doesNotThrow(()=>manifest.validateCoordinatorArgs('setHouseRules',{workspaceId:'x',revision:0,requestId:'nullable-test',houseRules:null}));assert.throws(()=>manifest.validateCoordinatorArgs('setRoutingPolicy',{workspaceId:'x',revision:0,requestId:'nested-test',config:{enabled:true,maxRunUsd:1,autoResets:false,claudeResetExpiresAt:null,execute:'arbitrary'}}),/Unexpected/);});
test('owner approvals are pending until app confirmation and remain durable without granting self-approval',async()=>{const f=fixture();try{const c=await control(f);const client=await f.svc.uiAction('add-client',{name:'Pending'});const requested=await write(f,c,'requestOwnerAction',{action:'approve-client',target:client.id,reason:'Owner requested this connection'});assert.equal(requested.data.state,'pending');assert.equal(f.svc.ui().clients.find(x=>x.id===client.id).status,'pending');assert.throws(()=>manifest.validateCoordinatorArgs('approveOwnerAction',{}),/Unknown/);await f.svc.uiAction('owner-action-answer',{id:requested.data.id,approve:true});assert.equal(f.svc.ui().clients.find(x=>x.id===client.id).status,'approved');const restored=f.reload();assert.equal(restored.ui().workspace.ownerActions[0].state,'completed');await assert.rejects(f.svc.uiAction('owner-action-answer',{id:requested.data.id,approve:true}),/no longer/);}finally{f.cleanup();}});
test('MCP and app preference edits share persisted state and detect stale UI saves',async()=>{const f=fixture();try{const c=await control(f);await write(f,c,'setUiPreferences',{preferences:{tweaks:{theme:'dark'},board:{includeBacklog:true}}});let saved=await f.svc.uiAction('preferences-get');assert.equal(saved.value.tweaks.theme,'dark');await f.svc.uiAction('preferences-save',{expectedVersion:saved.version,preferences:{tweaks:{showRail:false}}});await assert.rejects(f.svc.uiAction('preferences-save',{expectedVersion:saved.version,preferences:{tweaks:{theme:'paper'}}}),/changed/);const result=await f.svc.call(c.actor,c.id,'getUiPreferences',{workspaceId:c.id});assert.equal(result.value.tweaks.showRail,false);assert.equal(result.value.tweaks.theme,'dark');assert.equal((await f.reload().uiAction('preferences-get')).value.tweaks.theme,'dark');}finally{f.cleanup();}});

test('interrupted owner action stays uncertain after restart and cannot be replayed',async()=>{const f=fixture();try{const c=await control(f);const request=(await write(f,c,'requestOwnerAction',{action:'approve-client',target:'pending-client',reason:'Owner requested pairing'})).data;const file=path.join(f.root,'coordinators.json');const state=JSON.parse(fs.readFileSync(file));state.workspaces[0].ownerActions[0].state='executing';fs.writeFileSync(file,JSON.stringify(state));const restored=f.reload();assert.equal(restored.ui().workspace.ownerActions[0].state,'uncertain');await assert.rejects(restored.uiAction('owner-action-answer',{id:request.id,approve:true}),/no longer pending/);}finally{f.cleanup();}});

test('saved chats require workspace sharing and use the same host runtime',async()=>{const f=fixture();try{const c=await control(f);const calls=[];f.svc.setAppRuntime(async(action,args)=>{calls.push({action,args});if(action==='saved-chat:create')return {conversation:{id:42}};return {ok:true};});await assert.rejects(f.svc.call(c.actor,c.id,'getSavedChat',{workspaceId:c.id,conversationId:41}),/not shared/);const created=await write(f,c,'createSavedChat',{title:'Existing project work'});assert.equal(created.data.conversation.id,42);await f.svc.call(c.actor,c.id,'getSavedChat',{workspaceId:c.id,conversationId:42});const request=(await write(f,c,'requestOwnerAction',{action:'share-chat',target:'41',reason:'Continue the owner-selected chat'})).data;await f.svc.uiAction('owner-action-answer',{id:request.id,approve:true});await f.svc.call(c.actor,c.id,'getSavedChat',{workspaceId:c.id,conversationId:41});assert.ok(calls.some(x=>x.action==='saved-chat:verify'));assert.equal(f.starts,0);}finally{f.cleanup();}});

test('a paired coordinator can reopen only its own closed project',async()=>{const f=fixture();try{const c=await control(f);const revision=f.svc.ui().workspace.revision;f.svc.setAppRuntime(async(action,args,project)=>{assert.equal(action,'workspace-open');assert.equal(project,f.root);return {accepted:true,open:false};});f.svc.attach(null);const args={workspaceId:c.id,revision,requestId:'reopen-project-001'};assert.equal((await f.svc.call(c.actor,c.id,'openScopedWorkspace',args)).data.accepted,true);await assert.rejects(f.svc.call(c.actor,c.id,'openScopedWorkspace',{...args,workspaceId:'another'}),/not permitted/);}finally{f.cleanup();}});

test('Autopilot continuously reconciles deficits with one durable request across restart',async()=>{const f=fixture();try{await control(f);const w=f.svc.state.workspaces[0];w.mode='external';w.autopilot={status:'active',parallelism:4,personas:[],effort:'medium',objective:'Useful work',updatedAt:'now',legacyWork:[]};w.parallelism=4;
 await f.svc.tick();let request=w.requests.find(r=>r.id.startsWith('autopilot-capacity:'));assert.ok(request);assert.match(request.prompt,/currently 0, 4 slots open/);assert.equal(f.starts,0);await f.svc.tick();assert.equal(w.requests.filter(r=>r.id.startsWith('autopilot-capacity:')).length,1);
 const restored=f.reload();await restored.tick();const next=restored.state.workspaces[0];assert.equal(next.replenishment.requestId,request.id);request=next.requests.find(r=>r.id===request.id);request.state='completed';next.replenishment.lastAttemptAt=Date.now()-120001;await restored.tick();assert.equal(request.state,'completed');const oldId=request.id;request=next.requests.find(r=>r.id===next.replenishment.requestId);assert.notEqual(request.id,oldId);assert.equal(request.state,'queued');assert.equal(next.requests.filter(r=>r.id.startsWith('autopilot-capacity:')&&r.state!=='completed').length,1);
 for(let id=1;id<=4;id++){f.runs.set(id,{id,status:'running'});next.jobs.push({runId:id,number:1,state:'completed',qa:false});}await restored.tick();assert.equal(request.state,'completed');assert.equal(restored.ui().workspace.autopilot.capacity.active,4);assert.equal(next.replenishment,undefined);
 f.runs.get(4).status='complete';await restored.tick();assert.equal(restored.ui().workspace.autopilot.capacity.missing,1);assert.ok(next.replenishment);assert.notEqual(next.replenishment.requestId,request.id);
 }finally{f.cleanup();}});
test('Autopilot target maintenance stops for Off, update drain, and handoff and resumes after',async()=>{const f=fixture();try{await control(f);const w=f.svc.state.workspaces[0];w.mode='external';w.autopilot={status:'active',parallelism:4,personas:[],effort:'medium',objective:'Useful',updatedAt:'now',legacyWork:[]};await f.svc.tick();assert.ok(w.replenishment);w.autopilot.status='paused';await f.svc.tick();assert.equal(w.replenishment,undefined);assert.equal(f.svc.ui().workspace.autopilot.capacity.suspended,true);w.autopilot.status='active';w.handoff={state:'requested',from:w.controller,to:'other'};await f.svc.tick();assert.equal(w.replenishment,undefined);delete w.handoff;w.updateDrain={priorStatus:'active',at:new Date().toISOString()};f.svc.maintainAutopilot(w);assert.equal(w.replenishment,undefined);delete w.updateDrain;await f.svc.tick();assert.ok(w.replenishment);assert.equal(f.starts,0);}finally{f.cleanup();}});
test('Autopilot refills approved queued assignments before asking for new work',async()=>{const f=fixture();try{const c=await control(f);const w=f.svc.state.workspaces[0];w.mode='external';w.parallelism=1;w.autopilot={status:'active',parallelism:1,personas:[],effort:'medium',objective:'Useful',updatedAt:'now',legacyWork:[]};await write(f,c,'dispatchTask',{number:1,qa:false});const issue=(await write(f,c,'createIssue',{title:'Second bounded task'})).data;await write(f,c,'dispatchTask',{number:issue.number,qa:false});assert.equal(w.queue.length,1);f.runs.get(1).status='complete';const start=f.svc.context.supervisor.start;f.svc.context.supervisor.start=async a=>{const r=await start(a);r.status='running';return r;};await f.svc.tick();assert.equal(f.starts,2);assert.equal(w.queue.length,0);assert.equal(f.svc.ui().workspace.autopilot.capacity.active,1);assert.equal(w.replenishment,undefined);}finally{f.cleanup();}});

test('authorized publication is supported through initial dispatch and checkpoint follow-up', async () => {
 const f = fixture();
 try {
  const c = await control(f);
  f.handlers['issues:patch']({number:1,patch:{body:'Owner authorizes pushing the owned branch and publishing its PR. Release manager retains merge and deployment.'}});
  await write(f,c,'dispatchTask',{number:1,qa:false});
  const initial = f.startInputs[0].prompt;
  assert.match(initial,/explicitly authorizes publication/);
  assert.match(initial,/push only your own assigned branch/);
  assert.match(initial,/Do not self-merge/);
  assert.match(initial,/separately assigned release manager/);
  assert.doesNotMatch(initial,/do not merge, push or deploy/i);
  f.runs.get(1).status = 'complete';
  await f.svc.tick();
  await write(f,c,'followUpRun',{runId:1,message:'Owner authorizes publication of the reviewed branch and PR.'});
  const followUp = f.resumes[0].prompt;
  assert.match(followUp,/Owner authorizes publication/);
  assert.match(followUp,/push only your own assigned branch/);
  assert.match(followUp,/Preserve explicit task-specific read-only, no-push and publication holds/);
  assert.doesNotMatch(followUp,/Commit the completed implementation locally; do not merge or push/);
 } finally { f.cleanup(); }
});

test('read-only assignment remains read-only after restart and a follow-up', async () => {
 const f = fixture();
 try {
  const c = await control(f);
  await write(f,c,'dispatchTask',{number:1,readOnly:true,qa:false});
  assert.match(f.startInputs[0].prompt,/Read-only assignment/);
  f.runs.get(1).status = 'complete';
  const restored = f.reload();
  const state = restored.ui().workspace;
  await restored.call(c.actor,c.id,'followUpRun',{workspaceId:c.id,revision:state.revision,
   requestId:'readonly-followup',runId:1,message:'Continue the inventory'});
  assert.match(f.resumes[0].prompt,/Read-only assignment/);
  assert.match(f.resumes[0].prompt,/Do not modify source files, commit, push, merge or deploy/);
  assert.doesNotMatch(f.resumes[0].prompt,/push only your own assigned branch/);
 } finally { f.cleanup(); }
});

test('legacy discovery jobs retain read-only follow-up restrictions', async () => {
 const f = fixture();
 try {
  const c = await control(f);
  await write(f,c,'dispatchTask',{number:1,readOnly:true,qa:false});
  f.runs.get(1).status = 'complete';
  const stateFile = path.join(f.root,'coordinators.json');
  const state = JSON.parse(fs.readFileSync(stateFile,'utf8'));
  delete state.workspaces[0].jobs[0].readOnly;
  fs.writeFileSync(stateFile,JSON.stringify(state));
  const restored = f.reload();
  await restored.call(c.actor,c.id,'followUpRun',{workspaceId:c.id,revision:restored.ui().workspace.revision,
   requestId:'legacy-readonly-followup',runId:1,message:'Continue read-only research'});
  assert.match(f.resumes[0].prompt,/Read-only assignment/);
 } finally { f.cleanup(); }
});

test('run results distinguish working from awaiting input and terminal recovery', async () => {
 const f = fixture();
 try {
  const c = await control(f);
  await write(f,c,'dispatchTask',{number:1,qa:false});
  for (const [status,waiting,expected] of [
   ['starting',false,/Worker is starting/],['running',false,/Worker is running/],
   ['awaiting_input',true,/Worker is awaiting input/],['complete',false,/Review outcome/],
   ['failed',false,/how to recover/],['stopped',false,/how to recover/],
  ]) {
   f.runs.get(1).status = status;
   const result = await f.svc.call(c.actor,c.id,'getRunResult',{workspaceId:c.id,runId:1});
   assert.equal(result.waitingForInput,waiting);
   assert.match(result.nextAction,expected);
  }
 } finally { f.cleanup(); }
});

test('stale question records cannot hide actionable questions or accept another answer', async () => {
 const f = fixture();
 try {
  const cards = [601, 602, 603].map(id => ({
   id, type:'decision', status:'pending', payload:{question:`Question ${id}?`,options:[]},
  }));
  for (const card of cards) f.runs.set(card.id, {id:card.id,threadId:card.id,status:'awaiting_input',worktreePath:f.root});
  f.svc.context.store.cards = {
   listAllPending:()=>cards.filter(card=>card.status==='pending').map(card=>({card,agentRunId:card.id})),
   findById:id=>cards.find(card=>card.id===id),
   resolve:id=>{cards.find(card=>card.id===id).status='resolved';},
  };
  assert.equal((await f.svc.uiAction('questions-list')).length,3);
  cards[0].status = 'resolved';
  await assert.rejects(f.svc.uiAction('question-reply',{id:601,reply:'Yes'}),/no longer/);
  f.runs.delete(602);
  assert.deepEqual((await f.svc.uiAction('questions-list')).map(q=>q.id),[603]);
  await f.svc.uiAction('question-reply',{id:603,reply:'Yes'});
  assert.equal(cards[2].status,'resolved');
 } finally {
  f.cleanup();
 }
});

test('six consecutive answers from the same busy thread save once each and survive restart',async()=>{
 const f=fixture();try{
  await control(f);
  const cards=Array.from({length:6},(_,i)=>({id:611+i,type:'decision',status:'pending',payload:{question:`Question ${i}`,options:[]}}));
  f.runs.set(611,{id:611,threadId:611,status:'running',worktreePath:f.root});
  f.svc.context.store.cards={listAllPending:()=>cards.filter(card=>card.status==='pending').map(card=>({card,agentRunId:611})),findById:id=>cards.find(card=>card.id===id),resolve:id=>{cards.find(card=>card.id===id).status='resolved';}};
  await f.svc.uiAction('questions-list');
  for(const card of cards){
   const receipt=await f.svc.uiAction('question-reply',{id:card.id,reply:`Answer ${card.id}`});
   assert.equal(receipt.queued,true);
   assert.deepEqual(await f.svc.uiAction('question-reply',{id:card.id,reply:`Answer ${card.id}`}),receipt);
  }
  const restored=f.reload();
  assert.deepEqual(await restored.uiAction('questions-list'),[]);
  assert.equal(restored.ui().workspace.requests.filter(r=>r.id.startsWith('question-answer:')).length,6);
  assert.equal(f.resumes.length,0);assert.equal(f.runs.get(611).status,'running');
 }finally{f.cleanup();}
});

test('coordinator closes answered-elsewhere busy questions without stopping release worker and stale decisions disappear',async()=>{
 const f=fixture();try{
  const c=await control(f);const card={id:630,type:'decision',status:'pending',payload:{question:'Old release question?',options:[]}};
  f.runs.set(67,{id:67,threadId:43,status:'running',worktreePath:f.root});
  f.svc.context.store.cards={listAllPending:()=>card.status==='pending'?[{card,agentRunId:67}]:[],findById:()=>card,resolve:()=>{card.status='resolved';}};
  await f.svc.uiAction('questions-list');
  await write(f,c,'closeUserQuestion',{id:630,reason:'Already answered in owner chat, release run continues.'});
  assert.deepEqual(await f.svc.uiAction('questions-list'),[]);assert.equal(f.runs.get(67).status,'running');assert.equal(f.resumes.length,0);
  const w=f.svc.state.workspaces[0];w.decisions.push({id:'old',cardId:2,value:'reconfigure',state:'pending'});
  const decisions=await f.svc.call(c.actor,c.id,'listDecisions',{workspaceId:c.id});
  assert.deepEqual(decisions.proposed,[]);assert.equal(w.decisions[0].state,'superseded');
  await assert.rejects(f.svc.call('other',c.id,'closeUserQuestion',{workspaceId:c.id,revision:w.revision,requestId:'close-test',id:630,reason:'No control'}),/controlled elsewhere/);
 }finally{f.cleanup();}
});

test('successful follow-up clears worker recovery waiting only after resume and on every continuation', async () => {
 const f = fixture();
 try {
  const c = await control(f);
  await write(f,c,'dispatchTask',{number:1,qa:false});
  const w = f.svc.state.workspaces[0];
  f.runs.get(1).status = 'failed';
  await f.svc.tick();
  assert.equal(w.workflow.cards[1].waiting.reason,'Worker recovery');
  const resume = f.svc.context.supervisor.resume;
  f.svc.context.supervisor.resume = async args => {
   assert.equal(w.workflow.cards[1].waiting.reason,'Worker recovery');
   return resume(args);
  };
  await write(f,c,'followUpRun',{runId:1,message:'Recover using the saved checkpoint'});
  assert.equal(w.workflow.cards[1].waiting,undefined);
  assert.equal(w.workflow.cards[1].owner,'worker');
  assert.equal(w.jobs[0].state,'implementing');
  assert.equal(w.jobs[0].error,undefined);
  const firstControl = w.jobs[0].controlId;
  f.runs.get(1).status = 'failed';
  await f.svc.tick();
  assert.equal(w.workflow.cards[1].waiting.reason,'Worker recovery');
  assert.equal(w.workflow.cards[1].waiting.owner,'coordinator');
  await write(f,c,'followUpRun',{runId:1,message:'Continue the next bounded step'});
  assert.notEqual(w.jobs[0].controlId,firstControl);
  assert.equal(w.workflow.cards[1].waiting,undefined);
 } finally { f.cleanup(); }
});

test('rejected follow-up preserves failed job and recovery waiting evidence', async () => {
 const f = fixture();
 try {
  const c = await control(f);
  await write(f,c,'dispatchTask',{number:1,qa:false});
  f.runs.get(1).status = 'failed';
  await f.svc.tick();
  const w=f.svc.state.workspaces[0];
  const beforeJob=structuredClone(w.jobs[0]);
  const beforeCard=structuredClone(w.workflow.cards[1]);
  f.svc.context.supervisor.resume=async()=>{throw Error('Provider unavailable');};
  await assert.rejects(write(f,c,'followUpRun',{runId:1,message:'Try recovering'}),/Provider unavailable/);
  assert.deepEqual(w.jobs[0],beforeJob);
  assert.deepEqual(w.workflow.cards[1],beforeCard);
  const saved=JSON.parse(fs.readFileSync(path.join(f.root,'coordinators.json'),'utf8'));
  assert.deepEqual(saved.workspaces[0].jobs[0],beforeJob);
 } finally { f.cleanup(); }
});

test('accepted resume persists before workflow read failure and reconciles after restart', async () => {
 const f=fixture();
 try {
  const c=await control(f);
  await write(f,c,'dispatchTask',{number:1,qa:false});
  f.runs.get(1).status='failed';
  await f.svc.tick();
  const getIssue=f.handlers['issues:get'];
  f.handlers['issues:get']=async()=>{throw Error('Issue source unavailable');};
  const result=await write(f,c,'followUpRun',{runId:1,message:'Resume authorized work'});
  assert.equal(result.data.status,'running');
  const saved=JSON.parse(fs.readFileSync(path.join(f.root,'coordinators.json'),'utf8')).workspaces[0];
  assert.equal(saved.jobs[0].state,'implementing');
  assert.equal(saved.jobs[0].workflowStartPending,saved.jobs[0].controlId);
  assert.equal(saved.workflow.cards[1].waiting.reason,'Worker recovery');
  f.handlers['issues:get']=getIssue;
  const restored=f.reload();
  await restored.tick();
  const w=restored.state.workspaces[0];
  assert.equal(w.jobs[0].workflowStartPending,undefined);
  assert.equal(w.workflow.cards[1].waiting,undefined);
  assert.equal(f.resumes.length,1);
 }finally{f.cleanup();}
});

test('delivered answer survives card resolution failure and restart without resending',async()=>{
 const f=fixture();
 try{
  const card={id:620,type:'decision',status:'pending',payload:{question:'Proceed?',options:[]}};
  f.runs.set(620,{id:620,threadId:620,status:'awaiting_input',worktreePath:f.root});
  let fail=true;
  f.svc.context.store.cards={
   listAllPending:()=>card.status==='pending'?[{card,agentRunId:620}]:[],
   findById:()=>card,
   resolve:()=>{if(fail)throw Error('Card write failed');card.status='resolved';},
  };
  await f.svc.uiAction('questions-list');
  assert.equal((await f.svc.uiAction('question-reply',{id:620,reply:'Proceed within scope'})).queued,true);
  const saved=JSON.parse(fs.readFileSync(path.join(f.root,'coordinators.json'),'utf8'));
  assert.equal(saved.workspaces[0].questions[0].state,'answered');
  assert.equal(saved.workspaces[0].questions[0].reply,'Proceed within scope');
  fail=false;
  const restored=f.reload();
  assert.deepEqual(await restored.uiAction('questions-list'),[]);
  assert.equal(card.status,'resolved');
  assert.equal(f.resumes.length,0);
  assert.equal(restored.ui().workspace.requests.filter(r=>r.id==='question-answer:620').length,1);
  await assert.rejects(restored.uiAction('question-reply',{id:620,reply:'Again'}),/no longer/);
 }finally{f.cleanup();}
});

test('explicit assignment transition preserves task/run evidence and survives restart for authorized follow-up',async()=>{
 const f=fixture();
 try{
  const c=await control(f);
  await write(f,c,'dispatchTask',{number:1,readOnly:true,qa:false});
  f.runs.get(1).status='complete';
  const w=f.svc.state.workspaces[0];
  const job=w.jobs[0];
  job.phaseCheckpoint={commit:'9a24',evidence:'Independent UI review'};
  job.sha='a'.repeat(40);job.checkIds=[123];job.state='completed';
  const before=structuredClone(job);
  await write(f,c,'updateWorkflowCard',{number:1,taskType:'implementation',reason:'Accepted implementation',evidence:'Owner accepted UI delivery'});
  assert.equal(job.role,'discovery');
  const initialAssignment=await f.svc.call(c.actor,c.id,'getRunResult',{workspaceId:c.id,runId:1});
  assert.deepEqual(initialAssignment.assignment,{role:'discovery',readOnly:true,lastChange:null});
  assert.match(f.startInputs[0].prompt,/Read-only assignment/);
  const args={workspaceId:c.id,revision:f.svc.ui().workspace.revision,requestId:'promote-same-worker',runId:1,
   expectedRole:'discovery',expectedReadOnly:true,role:'implementation',
   reason:'Owner accepted implementation and publication',evidence:'Owner authorization to publish assigned branch and PR, existing release manager retains merge.'};
  const result=await f.svc.call(c.actor,c.id,'setWorkerAssignment',args);
  assert.equal(result.data.assignment.readOnly,false);
  assert.equal(job.role,'implementation');
  for(const key of ['runId','number','phaseCheckpoint','sha','checkIds','state','controlId','budgetUsd','qa'])assert.deepEqual(job[key],before[key]);
  assert.equal(job.assignmentHistory.length,1);
  assert.equal(job.assignmentHistory[0].actor,c.actor);
  assert.equal(job.assignmentHistory[0].requestId,'promote-same-worker');
  assert.equal(f.starts,1);assert.equal(f.resumes.length,0);
  const restored=f.reload();
  assert.deepEqual(await restored.call(c.actor,c.id,'setWorkerAssignment',args),result);
  const savedJob=restored.state.workspaces[0].jobs[0];
  assert.equal(savedJob.assignmentHistory.length,1);
  await restored.call(c.actor,c.id,'followUpRun',{workspaceId:c.id,revision:restored.ui().workspace.revision,
   requestId:'resume-promoted-worker',runId:1,message:'Publish the authorized reviewed branch and PR'});
  assert.equal(f.resumes[0].runId,1);
  assert.match(f.resumes[0].prompt,/Explicit saved assignment transition/);
  assert.match(f.resumes[0].prompt,/Owner authorization to publish/);
  assert.match(f.resumes[0].prompt,/push only your own assigned branch/);
  assert.doesNotMatch(f.resumes[0].prompt,/Read-only assignment\. Inspect/);
  assert.equal(f.starts,1);
 }finally{f.cleanup();}
});

test('assignment transition rejects active workers, stale expected state, mismatched tasks and missing authorization evidence',async()=>{
 const f=fixture();
 try{
  const c=await control(f);
  await write(f,c,'dispatchTask',{number:1,readOnly:true,qa:false});
  const promote=overrides=>write(f,c,'setWorkerAssignment',{runId:1,expectedRole:'discovery',expectedReadOnly:true,role:'implementation',reason:'Accepted work',evidence:'Owner publication instruction',...overrides});
  await assert.rejects(promote(),/Wait for this worker/);
  f.runs.get(1).status='starting';
  await assert.rejects(promote(),/Wait for this worker/);
  f.runs.get(1).status='complete';
  await assert.rejects(promote({expectedReadOnly:false}),/assignment changed/);
  await assert.rejects(promote({evidence:'  '}),/authorization evidence/);
  const w=f.svc.state.workspaces[0];
  w.jobs[0].number=999;
  await assert.rejects(promote(),/identity/);
  w.jobs[0].number=1;
  w.jobs[0].reviewRunId=5;f.runs.set(5,{id:5,status:'running'});
  await assert.rejects(promote(),/reviewer/);
  delete w.jobs[0].reviewRunId;
  await assert.rejects(f.svc.call('other',c.id,'setWorkerAssignment',{workspaceId:c.id,revision:w.revision,requestId:'unauthorized-promotion',runId:1,expectedRole:'discovery',expectedReadOnly:true,role:'implementation',reason:'x',evidence:'x'}),/controlled elsewhere/);
  assert.equal(w.jobs[0].role,'discovery');
  assert.equal(w.jobs[0].assignmentHistory,undefined);
  assert.equal(f.resumes.length,0);
 }finally{f.cleanup();}
});

test('awaiting-input legacy discovery assignment supports explicit promotion and reversible demotion',async()=>{
 const f=fixture();
 try{
  const c=await control(f);
  await write(f,c,'dispatchTask',{number:1,readOnly:true,qa:false});
  const job=f.svc.state.workspaces[0].jobs[0];
  delete job.readOnly;
  f.runs.get(1).status='awaiting_input';
  await write(f,c,'setWorkerAssignment',{runId:1,expectedRole:'discovery',expectedReadOnly:true,role:'implementation',reason:'Accepted implementation scope',evidence:'Owner directive'});
  await write(f,c,'setWorkerAssignment',{runId:1,expectedRole:'implementation',expectedReadOnly:false,role:'discovery',reason:'Return to inspection',evidence:'Coordinator narrows scope'});
  assert.equal(job.readOnly,true);
  assert.equal(job.assignmentHistory.length,2);
  await write(f,c,'followUpRun',{runId:1,message:'Inspect only'});
  assert.match(f.resumes[0].prompt,/Read-only assignment/);
 }finally{f.cleanup();}
});

test('demotion preserves QA evidence but blocks automatic correction after a failed reviewer',async()=>{
 const f=fixture();
 try{
  const c=await control(f);
  await write(f,c,'dispatchTask',{number:1,qa:true,maxReworks:1});
  f.runs.get(1).status='complete';
  await f.svc.tick();
  f.checks[0].status='pass';
  const start=f.svc.context.supervisor.start;
  f.svc.context.supervisor.start=async args=>{const run=await start(args);run.status='running';return run;};
  await f.svc.tick();
  const job=f.svc.state.workspaces[0].jobs[0];
  const reviewer=f.runs.get(job.reviewRunId);
  assert.equal(job.state,'reviewing');
  reviewer.status='complete';
  f.svc.context.store.events.list=id=>[{seq:0,type:'text',payload:{text:id===reviewer.id?'Review failed. KANBOTS_QA_FAIL':'Implementation complete'}}];
  const evidence={sha:job.sha,reviewRunId:job.reviewRunId,checkIds:structuredClone(job.checkIds)};
  await write(f,c,'setWorkerAssignment',{runId:1,expectedRole:'implementation',expectedReadOnly:false,role:'discovery',reason:'Restrict to inspection',evidence:'Coordinator read-only scope'});
  await f.svc.tick();
  assert.equal(job.state,'needs-changes');
  assert.equal(job.readOnly,true);
  assert.equal(f.resumes.length,0);
  assert.equal(job.sha,evidence.sha);
  assert.equal(job.reviewRunId,evidence.reviewRunId);
  assert.deepEqual(job.checkIds,evidence.checkIds);
 }finally{f.cleanup();}
});

test('completed demoted discovery does not restart its inherited automatic QA pipeline',async()=>{
 const f=fixture();
 try{
  const c=await control(f);
  await write(f,c,'dispatchTask',{number:1,qa:true,maxReworks:1});
  f.runs.get(1).status='complete';
  await write(f,c,'setWorkerAssignment',{runId:1,expectedRole:'implementation',expectedReadOnly:false,role:'discovery',reason:'Inspection only',evidence:'Owner narrowed scope'});
  await write(f,c,'followUpRun',{runId:1,message:'Report findings only'});
  f.runs.get(1).status='complete';
  await f.svc.tick();
  const job=f.svc.state.workspaces[0].jobs[0];
  assert.equal(job.state,'completed');
  assert.equal(job.qa,true);
  assert.equal(f.checks.length,0);
  assert.equal(f.starts,1);
  assert.equal(f.resumes.length,1);
 }finally{f.cleanup();}
});

test('built-in coordinator awaiting user input receives the saved answer once rather than deadlocking',async()=>{
 const f=fixture();try{
  await control(f);
  const card={id:650,type:'decision',status:'pending',payload:{question:'Choose the next phase',options:[]}};
  f.runs.set(650,{id:650,threadId:1,status:'awaiting_input'});
  f.svc.context.store.cards={listAllPending:()=>card.status==='pending'?[{card,agentRunId:650}]:[],findById:()=>card,resolve:()=>{card.status='resolved';}};
  let busy=false;const delivered=[];
  f.handlers['chat:get']=async()=>({activeRun:{id:650,status:busy?'running':'awaiting_input'}});
  f.handlers['chat:post-message']=async a=>{delivered.push(a.body);busy=true;return {activeRun:{id:650,status:'running'}};};
  await f.svc.uiAction('questions-list');
  await f.svc.uiAction('question-reply',{id:650,explain:true});
  const receipt=await f.svc.uiAction('question-reply',{id:650,reply:'Continue to review'});
  await f.svc.tick();await f.svc.tick();
  assert.equal(delivered.length,1);assert.match(delivered[0],/owner answered: Continue to review/);
  assert.equal(f.svc.ui().workspace.requests.find(r=>r.id===receipt.requestId).state,'received');
  assert.equal(f.svc.state.workspaces[0].requests.find(r=>r.id==='question:650').state,'completed');
  assert.equal(f.resumes.length,0);
 }finally{f.cleanup();}
});

test('question save failure leaves no successful receipt or orphaned answer request',async()=>{
 const f=fixture();try{
  await control(f);const card={id:651,type:'decision',status:'pending',payload:{question:'Save safely?',options:[]}};
  f.runs.set(651,{id:651,threadId:651,status:'running',worktreePath:f.root});
  f.svc.context.store.cards={listAllPending:()=>card.status==='pending'?[{card,agentRunId:651}]:[],findById:()=>card,resolve:()=>{card.status='resolved';}};
  await f.svc.uiAction('questions-list');
  const save=f.svc.save;f.svc.save=()=>{throw Error('Disk unavailable');};
  await assert.rejects(f.svc.uiAction('question-reply',{id:651,reply:'Yes'}),/Disk unavailable/);
  f.svc.save=save;
  assert.equal((await f.svc.uiAction('questions-list'))[0].state,'pending');assert.equal(card.status,'pending');
  assert.equal(f.svc.ui().workspace.requests.filter(r=>r.id==='question-answer:651').length,0);
  const receipt=await f.svc.uiAction('question-reply',{id:651,reply:'Yes'});
  assert.equal(receipt.queued,true);assert.equal(f.svc.ui().workspace.requests.filter(r=>r.id===receipt.requestId).length,1);
 }finally{f.cleanup();}
});

test('external wait checkpoint returns responsibility to current coordinator without QA, completion, duplicate worker or update',async()=>{
 const f=fixture();try{
  const c=await control(f);await write(f,c,'dispatchTask',{number:1,qa:true});
  const job=f.svc.ui().jobs[0];
  const {checkpointDirectory}=load(path.resolve(__dirname,'../src/worker-checkpoint.ts'));
  const dir=checkpointDirectory(f.root,job.controlId);
  const waiting={kind:'external',reason:'Hosted CI is pending',nextTrigger:'Exact CI run 123 reaches a terminal status',checkedAt:'2026-11-11T00:00:00Z',references:['https://example.test/actions/runs/123']};
  fs.writeFileSync(path.join(dir,'response.json'),JSON.stringify({id:job.controlId,state:'checkpointed',summary:'Implementation preserved; hosted evidence pending',remainingValidation:'Read exact CI result; do not repeat local tests',artifacts:['review.json'],waiting}));
  f.runs.get(1).status='complete';
  await f.svc.tick();await f.svc.tick();
  const result=await f.svc.call(c.actor,c.id,'getRunResult',{workspaceId:c.id,runId:1});
  assert.equal(result.qa.state,'checkpointed');assert.deepEqual(result.qa.checkpoint.waiting,waiting);
  assert.equal(result.waitingForInput,false);assert.match(result.nextAction,/unfinished work/);
  assert.equal(f.checks.length,0);assert.equal(f.starts,1);assert.equal(f.resumes.length,0);
  assert.equal(f.svc.ui().workspace.requests.filter(r=>r.id.startsWith('worker-wait:')).length,1);
  assert.equal(f.svc.ui().workspace.updateDrain,undefined);
  const restored=f.reload();await restored.tick();
  assert.deepEqual(restored.ui().jobs[0].checkpoint.waiting,waiting);
  assert.equal(restored.ui().workspace.requests.filter(r=>r.id.startsWith('worker-wait:')).length,1);
  assert.equal(f.starts,1);
 }finally{f.cleanup();}
});

test('invalid external wait metadata does not invent a next trigger or bypass checkpoint state',()=>{
 const root=fs.mkdtempSync('/private/tmp/kanborg-wait-test-');
 const {createCheckpoint,checkpointDirectory,readCheckpoint}=load(path.resolve(__dirname,'../src/worker-checkpoint.ts'));
 const control=createCheckpoint(root);const dir=checkpointDirectory(root,control.id);
 try{
  for(const waiting of [{kind:'external',reason:'Pending',checkedAt:'2026-11-11T00:00:00Z',references:[]},{kind:'external',reason:'Pending',nextTrigger:'CI',checkedAt:'not a date',references:[]}]){
   fs.writeFileSync(path.join(dir,'response.json'),JSON.stringify({id:control.id,state:'checkpointed',remainingValidation:'Unverified external result',waiting}));
   const result=readCheckpoint(root,control.id);assert.equal(result.state,'checkpointed');assert.equal(result.waiting,undefined);assert.equal(result.remainingValidation,'Unverified external result');
  }
 }finally{fs.rmSync(root,{recursive:true,force:true});fs.rmSync(dir,{recursive:true,force:true});}
});

test('independent reviewer external wait never triggers implementation rework and resumes same reviewer after trigger',async()=>{
 const f=fixture();try{
  const c=await control(f);await write(f,c,'dispatchTask',{number:1,qa:true});
  f.runs.get(1).status='complete';await f.svc.tick();f.checks[0].status='pass';
  // Keep reviewer alive until its explicit checkpoint is saved.
  const start=f.svc.context.supervisor.start;
  f.svc.context.supervisor.start=async a=>{const run=await start(a);run.status='running';return run;};
  await f.svc.tick();const job=f.svc.ui().jobs[0];assert.equal(job.state,'reviewing');
  const {checkpointDirectory}=load(path.resolve(__dirname,'../src/worker-checkpoint.ts'));
  const waiting={kind:'external',reason:'Exact hosted evidence pending',nextTrigger:'Hosted run123 completes',checkedAt:'2026-11-11T00:00:00Z',references:['https://example.test/actions/runs/123']};
  const dir=checkpointDirectory(f.root,job.reviewControlId);
  fs.writeFileSync(path.join(dir,'response.json'),JSON.stringify({id:job.reviewControlId,state:'checkpointed',summary:'Local independent review preserved',remainingValidation:'Check exact hosted evidence',waiting}));
  f.runs.get(job.reviewRunId).status='complete';await f.svc.tick();await f.svc.tick();
  const pending=await f.svc.call(c.actor,c.id,'getRunResult',{workspaceId:c.id,runId:job.reviewRunId});
  assert.equal(pending.qa.state,'review-checkpointed');assert.equal(pending.assignment.role,'reviewer');assert.equal(pending.assignment.readOnly,true);
  assert.deepEqual(pending.qa.reviewCheckpoint.waiting,waiting);assert.match(pending.nextAction,/not failed/);
  assert.equal(pending.qa.reworks,0);assert.equal(f.resumes.length,0);assert.equal(f.starts,2);assert.equal(f.checks.length,1);
  assert.equal(f.svc.ui().workspace.requests.filter(r=>r.id.startsWith(`worker-wait:${job.reviewRunId}:`)).length,1);
  const restored=f.reload();await restored.tick();assert.equal(restored.ui().jobs[0].state,'review-checkpointed');
  f.setSha('b'.repeat(40));
  await assert.rejects(write(f,c,'followUpRun',{runId:job.reviewRunId,message:'Continue review',origin:'manual'}),/Review revision changed/);
  assert.equal(f.resumes.length,0);assert.equal(f.svc.ui().jobs[0].state,'review-checkpointed');
  f.setSha('a'.repeat(40));
  const resume=f.svc.context.supervisor.resume;
  f.svc.context.supervisor.resume=async()=>{throw Error('Provider unavailable');};
  await assert.rejects(write(f,c,'followUpRun',{runId:job.reviewRunId,message:'Continue review',origin:'manual'}),/Provider unavailable/);
  assert.equal(f.svc.ui().jobs[0].state,'review-checkpointed');assert.equal(f.svc.ui().jobs[0].reviewControlId,job.reviewControlId);
  f.svc.context.supervisor.resume=resume;
  await write(f,c,'followUpRun',{runId:job.reviewRunId,message:'Hosted evidence is now available; complete the remaining independent assessment',origin:'manual'});
  assert.equal(f.resumes.length,1);assert.equal(f.resumes[0].runId,job.reviewRunId);
  assert.match(f.resumes[0].prompt,/Do not edit files/);assert.equal(f.svc.ui().jobs[0].reworks,0);assert.equal(f.starts,2);
  f.runs.get(job.reviewRunId).status='complete';await f.svc.tick();assert.equal(f.svc.ui().jobs[0].state,'qa-passed');
 }finally{f.cleanup();}
});
test('priority edit shares app and MCP persistence, validates null and protects active workers',async()=>{
 const f=fixture();try{
 const c=await control(f);await f.handlers['issues:create']({title:'Second',status:'todo'});
 let view=await f.svc.uiAction('workflow:get');const stage=view.cards[1].stageId;
 await f.svc.uiAction('workflow:card',{number:1,priorityStage:stage,beforeNumber:null,reason:'Owner priority',evidence:'Drag on board'});
 assert.deepEqual(f.reload().ui().workspace.stagePriority[stage],[1]);
 await write(f,c,'updateWorkflowCard',{number:1,priorityStage:stage,beforeNumber:null,reason:'Coordinator priority',evidence:'Owner request'});
 assert.deepEqual((await f.svc.uiAction('workflow:get')).stageOrder[stage],[1]);
 await write(f,c,'dispatchTask',{number:1,qa:false});
 await assert.rejects(f.svc.uiAction('workflow:card',{number:1,priorityStage:(await f.svc.uiAction('workflow:get')).cards[1].stageId,beforeNumber:null,reason:'Move running',evidence:'Test'}),/pinned/);
 }finally{f.cleanup();}
});

test('question context is scoped to the original thread and commands survive restart',async()=>{
 const f=fixture();try{const c=await control(f);const card={id:801,type:'decision',status:'pending',payload:{question:'Run the exact snippet?',options:[]}};
 f.runs.set(77,{id:77,threadId:22,status:'complete'});
 f.svc.context.store.cards={listAllPending:()=>[{card,agentRunId:77}],findById:()=>card};
 f.svc.context.store.agentRuns.listByThread=id=>id===22?[f.runs.get(77)]:[];
 f.svc.context.store.messages={list:()=>[{role:'user',body:'Original request',agentRunId:null}]};
 await f.svc.uiAction('questions-list');
 const code='const result = await fetch("/status");\nconsole.log(await result.json());';
 await write(f,c,'recordUserQuestionExplanation',{id:801,explanation:'Routing: hidden\nThis checks status only.',commands:[{title:'Check status',code,language:'javascript',where:'Browser console on your signed-in site',expected:'Status JSON'}]});
 const q=(await f.reload().uiAction('questions-list'))[0];assert.equal(q.commands[0].code,code);assert.equal(q.explanation,'This checks status only.');
 const context=await f.svc.call(c.actor,c.id,'getUserQuestionContext',{workspaceId:c.id,id:801});assert.equal(context.threadId,22);assert.equal(context.messages[0].body,'Original request');
 await assert.rejects(f.svc.uiAction('question-context',{id:801,runId:999}),/does not belong/);
 await assert.rejects(f.svc.uiAction('question-explanation-record',{id:801,explanation:'Bad',commands:[{code:'x'}]}),/Invalid/);
 assert.equal((await f.svc.uiAction('questions-list'))[0].commands[0].code,code);
 }finally{f.cleanup();}
});
test('large durable receipts are externalized and replay exactly across restart without re-execution',async()=>{
 const f=fixture();try{const c=await control(f);const w=f.svc.state.workspaces[0];const key=c.actor+':large-retry';const args={workspaceId:w.id,requestId:'large-retry',revision:w.revision};const crypto=require('node:crypto');
 const expected={revision:123,data:{text:'x'.repeat(100000)}};
 w.receipts[key]={digest:crypto.createHash('sha256').update(JSON.stringify({name:'configureWorkflow',args})).digest('hex'),state:'done',result:expected};
 f.svc.save();assert.equal(w.receipts[key].result,undefined);assert.ok(w.receipts[key].resultFile);
 const restored=f.reload();assert.deepEqual(await restored.call(c.actor,c.id,'configureWorkflow',args),expected);
 const receipt=w.receipts[key];fs.unlinkSync(path.join(f.root,'coordinator-receipts',crypto.createHash('sha256').update(w.id).digest('hex'),receipt.resultFile));
 await assert.rejects(restored.call(c.actor,c.id,'configureWorkflow',args),/will not be replayed/);assert.equal(f.starts,0);
 }finally{f.cleanup();}
});
test('parallel targets above four persist and share workflow configuration',async()=>{
 const f=fixture();try{const c=await control(f);
 await write(f,c,'manageAutopilot',{action:'start',personas:[{id:'engineering',name:'Engineering',prompt:'Review existing work'}],parallelism:12});
 assert.equal(f.svc.ui().workspace.parallelism,12);assert.equal(f.reload().ui().workspace.autopilot.parallelism,12);
 await write(f,c,'configureWorkflow',{parallelism:9});assert.equal(f.svc.ui().workspace.autopilot.parallelism,9);
 await assert.rejects(write(f,c,'configureWorkflow',{parallelism:0}));
 }finally{f.cleanup();}
});

test('coordinator phase continuation supersedes inspection without owner reapproval',async()=>{
 for(const phase of ['implementation','testing']){
  const f=fixture();try{
   const c=await control(f);
   await write(f,c,'dispatchTask',{number:1,readOnly:true,qa:false});
   f.runs.get(1).status='awaiting_input';
   await write(f,c,'followUpRun',{runId:1,phase,message:'Continue authorized work using reversible fixtures; preserve explicit owner holds.'});
   const job=f.svc.state.workspaces[0].jobs[0];
   assert.equal(job.readOnly,false);assert.equal(job.role,'implementation');
   assert.equal(job.assignmentHistory.length,1);
   assert.match(job.assignmentHistory[0].reason,new RegExp(phase));
   assert.equal(f.starts,1);assert.equal(f.resumes[0].runId,1);
   assert.doesNotMatch(f.resumes[0].prompt,/Read-only assignment\. Inspect/);
   assert.match(f.resumes[0].prompt,/do not ask the owner to lift it again/);
   assert.equal(f.reload().state.workspaces[0].jobs[0].readOnly,false);
  }finally{f.cleanup();}
 }
});

test('remote vault changes require owner approval, deduplicate requests and retain cancelled recovery',async()=>{const f=fixture();try{const c=await control(f);const result=await write(f,c,'requestOwnerAction',{action:'vault-activate',target:'version-id',reason:'Activate verified replacement'},'vault-request-001');assert.equal(f.vaultCalls.length,0);const request=f.svc.ui().workspace.ownerActions[0];await f.svc.uiAction('owner-action-answer',{id:request.id,approve:true});assert.deepEqual(f.vaultCalls,[{action:'activate',args:{id:'version-id'},project:c.id}]);await assert.rejects(f.svc.uiAction('owner-action-answer',{id:request.id,approve:true}),/no longer pending/);assert.equal(f.vaultCalls.length,1);await write(f,c,'requestOwnerAction',{action:'vault-restore',target:c.id,reason:'Restore verified package'});const restore=f.svc.ui().workspace.ownerActions.at(-1);f.cancelVault();await f.svc.uiAction('owner-action-answer',{id:restore.id,approve:true});assert.equal(restore.state,'pending');}finally{f.cleanup();}});

test('overlapping dispatches reserve capacity before asynchronous work',async()=>{const f=fixture();try{const c=await control(f);await write(f,c,'configureWorkflow',{parallelism:1});await f.handlers['issues:create']({title:'Second',labels:[]});const get=f.handlers['issues:get'];let release;f.handlers['issues:get']=async a=>{await new Promise(r=>{release=r;});return get(a);};const first=write(f,c,'dispatchTask',{number:1,qa:false});await new Promise(r=>setImmediate(r));assert.equal(Object.keys(f.svc.ui().workspace.dispatchReservations).length,1);await assert.rejects(write(f,c,'dispatchTask',{number:1,qa:false}),/unresolved dispatch/);const second=await write(f,c,'dispatchTask',{number:2,qa:false});assert.equal(second.data.status,'queued');f.handlers['issues:get']=get;release();await first;assert.equal(f.starts,1);assert.deepEqual(f.svc.ui().workspace.dispatchReservations,{});}finally{f.cleanup();}});
test('lost worker start response survives restart and adopts the original run',async()=>{const f=fixture();try{const c=await control(f);const start=f.supervisor.start;f.supervisor.start=async a=>{await start(a);throw Error('response lost');};await assert.rejects(write(f,c,'dispatchTask',{number:1,qa:false}),/response lost/);const reservation=f.svc.ui().workspace.dispatchReservations[1];assert.equal(reservation.state,'uncertain');const restored=f.reload();const session=restored.ui().workspace;const result=await restored.call(c.actor,c.id,'reconcileDispatch',{workspaceId:c.id,revision:session.revision,requestId:'reconcile-lost-start',number:1,reservationId:reservation.id,evidence:'Inspected durable thread runs after lost response'});assert.equal(result.data.status,'adopted');assert.equal(result.data.runId,1);assert.equal(f.starts,1);assert.equal(restored.ui().jobs[0].runId,1);assert.deepEqual(restored.ui().workspace.dispatchReservations,{});}finally{f.cleanup();}});

test('concurrent release calls serialize before asynchronous revision checks',async()=>{const f=fixture();try{const c=await control(f);await write(f,c,'dispatchTask',{number:1,qa:false});f.runs.get(1).status='complete';const plan=(await write(f,c,'prepareRelease',{runId:1,targetBranch:'main',action:'merge'})).data;const git=f.svc.git;let release;let held=true;let merges=0;f.svc.git=async(cwd,args)=>{if(held){held=false;await new Promise(r=>{release=r;});}if(args[0]==='merge'&&args[1]!=='--abort')merges++;return git(cwd,args);};const first=write(f,c,'executeRelease',{releaseId:plan.id});await new Promise(r=>setImmediate(r));await assert.rejects(write(f,c,'executeRelease',{releaseId:plan.id}),/already attempted/);release();await first;assert.equal(merges,1);}finally{f.cleanup();}});

test('release reconciliation proves exact merge parents without repeating merge',async()=>{const f=fixture();try{const c=await control(f);await write(f,c,'dispatchTask',{number:1,qa:false});f.runs.get(1).status='complete';const plan=(await write(f,c,'prepareRelease',{runId:1,targetBranch:'main',action:'merge'})).data;const git=f.svc.git;let merges=0;f.svc.git=async(cwd,args)=>{if(args[0]==='merge'&&args[1]!=='--abort'){merges++;throw Error('lost merge response');}return git(cwd,args);};await assert.rejects(write(f,c,'executeRelease',{releaseId:plan.id}),/lost merge response/);assert.equal(f.svc.ui().releases[0].state,'uncertain');f.svc.git=async(cwd,args)=>args[0]==='rev-list'?'c'.repeat(40)+' '+'x'.repeat(40)+' '+plan.sha:git(cwd,args);await assert.rejects(write(f,c,'reconcileRelease',{releaseId:plan.id,evidence:'Read target parents'}),/not proven/);f.svc.git=async(cwd,args)=>args[0]==='rev-list'?'c'.repeat(40)+' '+plan.targetSha+' '+plan.sha:git(cwd,args);const result=await write(f,c,'reconcileRelease',{releaseId:plan.id,evidence:'Exact parents match preserved plan'});assert.equal(result.data.state,'completed');assert.equal(result.data.result.commit,'c'.repeat(40));assert.equal(merges,1);}finally{f.cleanup();}});

test('lost PR response reconciles exact remote revision without duplicate publication',async()=>{const f=fixture();try{const c=await control(f);await write(f,c,'dispatchTask',{number:1,qa:false});f.runs.get(1).status='complete';const plan=(await write(f,c,'prepareRelease',{runId:1,targetBranch:'main',action:'draft-pr'})).data;let creates=0,pushes=0;const git=f.svc.git;f.source.openDraftPR=async()=>{creates++;throw Error('response lost after creation');};f.svc.git=async(cwd,args)=>{if(args[0]==='push')pushes++;return git(cwd,args);};await assert.rejects(write(f,c,'executeRelease',{releaseId:plan.id}),/response lost/);const other=(await write(f,c,'prepareRelease',{runId:1,targetBranch:'main',action:'draft-pr'})).data;await assert.rejects(write(f,c,'executeRelease',{releaseId:other.id}),/Another release/);const restored=f.reload();f.source.findOpenPullForBranch=async branch=>({number:42,head:branch,base:'main',state:'open',draft:true,htmlUrl:'https://example.invalid/pull/42'});restored.git=async(cwd,args)=>args[0]==='ls-remote'?'f'.repeat(40)+' refs/heads/release':git(cwd,args);const reconcile=()=>restored.call(c.actor,c.id,'reconcileRelease',{workspaceId:c.id,revision:restored.ui().workspace.revision,requestId:'pr-reconcile-'+Math.random(),releaseId:plan.id,evidence:'Authenticated lookup of stable release branch'});await assert.rejects(reconcile(),/revision does not match/);restored.git=async(cwd,args)=>args[0]==='ls-remote'?plan.sha+' refs/heads/release':git(cwd,args);const result=await reconcile();assert.equal(result.data.state,'completed');assert.equal(result.data.result.number,42);assert.equal(creates,1);assert.equal(pushes,1);}finally{f.cleanup();}});

test('coordination metrics expose current reservations and bounded event coverage without claiming delivery',async()=>{const f=fixture();try{const c=await control(f);await write(f,c,'dispatchTask',{number:1,qa:false});const w=f.svc.current();w.dispatchReservations={2:{id:'pending',state:'uncertain',at:'invalid'}};w.events=[{cursor:2001,at:new Date().toISOString(),type:'release-completed',data:{}}];const result=await f.svc.call(c.actor,c.id,'getCoordinationMetrics',{workspaceId:c.id});assert.equal(result.workers.active,1);assert.equal(result.workers.reserved,1);assert.equal(result.recovery.dispatches[0].ageMs,null);assert.equal(result.eventWindow.truncated,true);assert.equal(result.eventWindow.counts['release-completed'],1);assert.match(result.limits,/not verified deployment/);assert.equal(result.pendingRequests.every(r=>r.ageMs===null||r.ageMs>=0),true);}finally{f.cleanup();}});

test('remote secret entry requests expose metadata and require a new matching app entry',async()=>{const f=fixture();try{const c=await control(f);f.vaultItems.push({id:'old',name:'API key',consumer:'api:anthropic',state:'active',version:1});const response=await write(f,c,'requestSecretEntry',{name:'API key',consumer:'api:anthropic',reason:'Connect the approved provider'});const id=response.data.id;await assert.rejects(f.svc.uiAction('owner-action-answer',{id,approve:true}),/Save the requested secret/);assert.equal(f.svc.ui().workspace.ownerActions[0].state,'pending');f.vaultItems.push({id:'new',name:'API key',consumer:'api:anthropic',state:'staged',version:2});const result=await f.svc.uiAction('owner-action-answer',{id,approve:true});assert.equal(result.state,'completed');assert.equal(result.result.id,'new');assert.equal(result.result.state,'staged');assert.throws(()=>manifest.validateCoordinatorArgs('requestSecretEntry',{workspaceId:c.id,requestId:'never-secret',revision:1,name:'API key',consumer:'api:anthropic',reason:'Connect',value:'forbidden'}));}finally{f.cleanup();}});
