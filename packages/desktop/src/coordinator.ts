import { newWorkflow, materialize, previewWorkflow, applyWorkflow, undoWorkflowChange, moveWorkflowCard, workflowGuidance } from './workflow.js';
import type { WorkflowState, WorkflowConfig } from '@kanborg/core';
import { app } from 'electron';
import { createServer } from 'node:http';
import { randomBytes,randomUUID,createHash } from 'node:crypto';
import { mkdirSync,existsSync,readFileSync,writeFileSync,renameSync,chmodSync } from 'node:fs';
import { join,basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Handlers,AgentSupervisor } from '@kanborg/api';
import { withStatusLabel } from '@kanborg/core';
import type { IssueSource } from '@kanborg/core';
import type { Store } from '@kanborg/local-store';
import { COORDINATOR_TOOLS,COORDINATOR_GUIDE,COORDINATOR_REMINDER,REPO_ONBOARDING_PROMPT,validateCoordinatorArgs } from '@kanborg/mcp';
import { collectCapacity } from './routing-capacity.js';
const exec=promisify(execFile);
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
const pauseCheckins='Pause recurring check-ins for this KanBorg connection in your harness; leave unrelated schedules unchanged. Do not resume unless the user assigns control back. If unable, tell the user the exact schedule to pause.';
const active=(s:string)=>['starting','running','awaiting_input'].includes(s);
const redact=(s:string)=>s.replace(/\bsk-[A-Za-z0-9_-]{12,}/g,'[redacted]').replace(/Bearer\s+[A-Za-z0-9._-]+/gi,'Bearer [redacted]');
const clip=(v:unknown,n=4000)=>redact(typeof v==='string'?v:JSON.stringify(v)??'').slice(0,n);
export type CoordinatorContext={repoPath:string;source:IssueSource;handlers:Handlers;store:Store;supervisor:AgentSupervisor};
type Client={id:string;name:string;workspaceId:string;role:'observer'|'coordinator';tokenHash:string;status:'pending'|'approved'|'revoked';code:string;lastSeen?:string};
type Job={runId:number;number:number;role:string;qa:boolean;maxReworks:number;reworks:number;budgetUsd:number;state:string;sha?:string;reviewRunId?:number;checkIds?:number[];error?:string};
type Release={id:string;runId:number;sha:string;targetBranch:string;targetSha:string;action:'merge'|'draft-pr';title?:string;body?:string;state:string;result?:unknown};
type Handoff={id:string;from:string|null;to:string;mode:'internal'|'external';state:'requested'|'ready'|'completed';requestedAt:string;summary:string;checkpoint:unknown;receivedBy?:string};
type CoordinatorRequest={id:string;kind:'discovery'|'resume-workflows'|'workflow-change'|'workflow-action';prompt:string;state:'queued'|'received'|'completed';createdAt:string;receivedBy?:string};
type ScheduleReceipt={id?:string;status:'active'|'paused'|'unsupported';cadenceMinutes?:number;cursor?:number;confirmedAt:string};
type Workspace={workflow?:WorkflowState;workflowSignals?:Record<string,string>;schedules?:Record<string,ScheduleReceipt>;requests?:CoordinatorRequest[];handoff?:Handoff;queue?:Array<{id:string;number:number;budgetUsd:number;qa:boolean;maxReworks:number;readOnly:boolean}>;onboardedAt?:string;inventory?:Record<string,{number:number;kind:string;evidence:string;verifiedAt:string;sourceHash?:string}>;id:string;path:string;revision:number;mode:'internal'|'external'|'off';controller:string|null;leaseUntil:number;epoch:number;conversationId?:number;objective:string;summary:string;parallelism:number;qaDefault:boolean;maxReworks:number;budgetUsd:number;dependencies:Record<string,number[]>;jobs:Job[];releases:Release[];decisions:Array<{id:string;cardId:number;value:string;question?:string;label?:string;state:string}>;events:Array<{cursor:number;at:string;type:string;data:unknown}>;nextCursor:number;snapshot?:string;receipts:Record<string,{digest:string;state:string;result?:unknown;error?:string}>};
type Registry={templates?:Record<string,{id:string;name:string;version:number;config:WorkflowConfig;updatedAt:string;actor:string}>;clients:Client[];workspaces:Workspace[]};
export class CoordinatorService{
  private workflowNotifier?:()=>void;
  setWorkflowNotifier(fn:()=>void){this.workflowNotifier=fn;}
  private updater?:{status:()=>any;check:()=>Promise<any>;request:(args:any,repoPath:string)=>Promise<any>;pending:()=>boolean};
  updateIdle(){return !this.polling&&!this.inFlight.size;}
  allowRequests(){this.closing=false;}
  setUpdater(updater:NonNullable<CoordinatorService['updater']>){this.updater=updater;}
  async resumeAfterUpdate(version:string,updateId=version){
    const w=this.current();this.closing=false;
    // One durable kick per update. A restart between saving it and advancing the
    // pipelines must not create a second coordinator turn or duplicate workers.
    const id=`update-resume:${updateId}`;w.requests??=[];
    if(w.mode==='off'){if(!w.events.some(e=>e.type==='application-updated'&&(e.data as any)?.requestId===id))this.event(w,'application-updated',{version,requestId:id,instruction:'Coordination remains paused.'});return {queued:false,reason:'Coordination is paused'};}
    let request=w.requests.find(r=>r.id===id);
    if(!request){
      request={id,kind:'resume-workflows',state:'queued',createdAt:new Date().toISOString(),prompt:`KanBorg ${version} has restarted after an update. Resume the current owner-authorized objective now, not just a status report. Read current coordination state, pending decisions and compact worker results. Preserve running assignments and completed evidence. Advance ready dependencies and dispatch the next authorized implementation or QA through KanBorg. Resume interrupted work from its compact handoff; investigate failed work before deciding how to continue. Do not repeat completed tests, restart intentionally paused work, answer owner-reserved decisions, or approve a release merely because the app restarted. Acknowledge this request as received before acting and completed after the eligible work is running or its real blocker is recorded. If no work remains, record that explicitly.`};
      w.requests.push(request);w.revision++;
      this.event(w,'application-updated',{version,requestId:id,instruction:'Read getCoordinatorRequests and resume the current authorized objective.'});
      this.event(w,'coordinator-request',{requestId:id,kind:request.kind});
    }
    // Advance existing pipelines and queued assignments immediately. External
    // coordinators pick up the durable request on their next connection/check-in.
    await this.tick();return request;
  }

  private state:Registry;private context:CoordinatorContext|null=null;private url='';private inFlight=new Map<string,Promise<any>>();private polling=false;private closing=false;private internalTokens=new Map<string,{workspaceId:string;actor:string;epoch:number;expires:number;clientId?:string}>();private launcher='';private entry='';
  constructor(private root=app.getPath('userData')){mkdirSync(root,{recursive:true,mode:0o700});this.state=existsSync(this.file())?JSON.parse(readFileSync(this.file(),'utf8')):{clients:[],workspaces:[]};}
  private file(){return join(this.root,'coordinators.json');}
  private save(){writeFileSync(this.file()+'.tmp',JSON.stringify(this.state),{mode:0o600});renameSync(this.file()+'.tmp',this.file());}
  private event(w:Workspace,type:string,data:unknown){w.events.push({cursor:w.nextCursor++,at:new Date().toISOString(),type,data});if(w.events.length>2000)w.events.splice(0,w.events.length-2000);this.save();if(type.startsWith('workflow'))this.workflowNotifier?.();}
  attach(context:CoordinatorContext|null){this.closing=false;this.context=context;if(!context)return;const id=hash(context.repoPath).slice(0,24);if(!this.state.workspaces.some(w=>w.id===id)){this.state.workspaces.push({id,path:context.repoPath,revision:0,mode:'off',controller:null,leaseUntil:0,epoch:0,objective:'',summary:'',parallelism:2,qaDefault:true,maxReworks:1,budgetUsd:5,dependencies:{},jobs:[],releases:[],decisions:[],events:[],nextCursor:1,receipts:{}});this.save();}}
  async beforeClose(){this.closing=true;while(this.polling||this.inFlight.size)await new Promise(r=>setTimeout(r,50));}
  hasController(){return !!this.context&&this.current().mode!=='off';}
  private current(){if(!this.context)throw Error('Open a project in KanBorg first.');return this.state.workspaces.find(w=>w.path===this.context!.repoPath)!;}
  private resolve(id:string){const w=this.current();if(w.id!==id)throw Error('Workspace is not open. Open the selected project in KanBorg.');return w;}
  private h(){if(!this.context)throw Error('Workspace unavailable');return this.context.handlers;}
  private run(id:number){const r=this.context!.store.agentRuns.findById(id);if(!r)throw Error('Run not found in this workspace');return r;}
  private async git(cwd:string,args:string[]){return (await exec('git',args,{cwd,timeout:30000,maxBuffer:2e6})).stdout.trim();}
  private async revision(runId:number){const r=this.run(runId);if(!r.worktreePath)throw Error('Worktree unavailable');if(active(r.status))throw Error('Wait for the worker to finish.');if(await this.git(r.worktreePath,['status','--porcelain']))throw Error('Worker has uncommitted changes. Ask it to commit before QA or release.');return this.git(r.worktreePath,['rev-parse','HEAD']);}
  private compactRun(id:number){const r=this.run(id);return {runId:r.id,status:r.status,branch:r.branchName,model:r.model,provider:r.provider,costUsd:r.totalCostUsd,costSource:'run-reported; may include estimates',exitReason:r.exitReason,successSignal:r.successSignal};}
  private assertControl(w:Workspace,actor:string){if(w.controller!==actor||w.mode==='off')throw Error('This session is controlled elsewhere. Hand off in KanBorg Coordinators.');if(w.leaseUntil<Date.now())throw Error('Controller lease expired. Call renewCoordinator.');}
  private checkinPolicy(w:Workspace,compact=false){
    const running=w.jobs.some(j=>['implementing','checks','reviewing'].includes(j.state))||!!w.queue?.length||(w.requests??[]).some(r=>['resume-workflows','workflow-action','workflow-change'].includes(r.kind)&&r.state!=='completed');
    const continuing=!!w.objective.trim()||(w.requests??[]).some(r=>r.state!=='completed');
    return {owner:w.controller,key:`kanborg:${w.id}`,cadenceMinutes:w.mode==='off'||(!running&&!continuing)?null:running?(w.workflow?.config.cadence.working??5):(w.workflow?.config.cadence.idle??15),
      ...(!compact?{prompt:COORDINATOR_REMINDER}:{}),execution:'harness-managed',confirmed:w.controller?w.schedules?.[w.controller]??null:null,
      retirementPending:Object.entries(w.schedules??{}).filter(([owner,r])=>owner!==w.controller&&r.status==='active').map(([owner,r])=>({owner,id:r.id,status:'pause-required'})),
      ...(!compact?{instruction:'Replace this workspace reminder on takeover. Pause superseded harness reminders; do not claim completion without confirmation. No continuing responsibility means pause.'}:{})};
  }
  private session(w:Workspace){return {workflowVersion:w.workflow?.version??1,workflowContract:w.workflow?.config??newWorkflow().config,workspaceId:w.id,revision:w.revision,mode:w.mode,controller:w.controller,leaseUntil:w.leaseUntil,objective:w.objective,summary:w.summary,authority:{coordination:'assigned-controller',release:w.workflow?.config.releaseOwner==='user'?'owner decision required; tool authorization remains enforced':'assigned-controller within owner-authorized scope',pairing:'owner-only'},checkIn:this.checkinPolicy(w),parallelism:w.parallelism,qaDefault:w.qaDefault,budgetUsd:w.budgetUsd,maxReworks:w.maxReworks,conversationId:w.conversationId,onboardedAt:w.onboardedAt,handoff:w.handoff,requests:(w.requests??[]).filter(r=>r.state!=='completed')};}
  ui(){return {workspace:this.context?this.session(this.current()):null,workspaces:this.state.workspaces.map(w=>({id:w.id,name:basename(w.path),open:w.path===this.context?.repoPath})),clients:this.state.clients.map(({tokenHash,...c})=>c),jobs:this.context?this.current().jobs:[],queue:this.context?this.current().queue??[]:[],releases:this.context?this.current().releases:[],decisions:this.context?this.current().decisions:[],guide:COORDINATOR_GUIDE,applicationUpdate:this.updater?.status()??null};}
  async uiAction(action:string,args:any={}):Promise<any>{
    const w=this.current();
    if(action.startsWith('workflow:')){const name=action.slice(9);const result=await this.workflowAction(w,name,args,'user');return result;}
    if(action==='check-application-update'){if(!this.updater)throw Error('Updater unavailable');return this.updater.check();}
    if(action==='update-application'){if(!this.updater)throw Error('Updater unavailable');return this.updater.request(args,w.path);}
    if(action==='is-coordinator-run'){const conversation=w.conversationId?this.context!.store.chatConversations.findById(w.conversationId):null;return {matches:!!conversation&&this.context!.store.agentRuns.findById(args.runId)?.threadId===conversation.threadId};}
    if(action==='resolve-chat-decision'){const chat=w.conversationId?await this.h()['chat:get']({conversationId:w.conversationId}):null;const card=chat?.cards.find(c=>c.id===args.cardId&&c.status==='pending');if(!card)throw Error('This question is no longer pending.');return this.h()['cards:resolve']({cardId:args.cardId,value:args.value});}
    if(action==='onboarding-start'||action==='external-setup-start'){
      if(w.mode==='external')throw Error('An external coordinator is active. Send it the discovery prompt or switch to KanBorg chat first.');
      if(w.mode!=='internal')await this.uiAction('handoff',{mode:'internal'});
      const chat=await this.h()['chat:get']({conversationId:w.conversationId!});
      if(chat.activeRun)return {alreadyRunning:true,status:chat.activeRun.status};
      const body=action==='onboarding-start'?REPO_ONBOARDING_PROMPT:`Help me connect an external coordinator to this repository. Start by calling getWorkspaceSummary, then prepareExternalCoordinator with name DeepSeek Harness to prepare or reuse its local MCP connection. The app displays the setup request and pairing controls. Reply in at most two short sentences naming the next action. Do not repeat config JSON, pairing codes, tool names, internal revisions or handoff details in the conversation. Do not ask a blocking question just to confirm that setup is ready. Give me a ready-to-paste request for my harness using the returned standard MCP config and DeepSeek fields; it should configure its MCP client if it can, or guide me through its settings if it cannot. Preserve other connections. Do not claim pairing until the connection is actually reported. Explain that I approve the matching pairing in KanBorg, then choose Use coordinator when ready. Stay as my coordinator until I explicitly hand off. Offer other local MCP-compatible harnesses as alternatives. Do not ask for provider keys or perform development. Save a concise handoff summary so the external coordinator can continue with repository discovery and board maintenance.`;
      return this.uiAction('chat-send',{body});
    }
    if(action==='onboarding-status'){const issues=await this.h()['issues:list']({state:'all'});return {needed:!w.onboardedAt||issues.length===0,prompt:REPO_ONBOARDING_PROMPT};}
    if(action==='add-client'){
      const id=randomUUID(),token=randomBytes(32).toString('hex');const name=String(args.name??'External harness').slice(0,80);const role=args.role==='observer'?'observer':'coordinator';
      const client:Client={id,name,workspaceId:w.id,role,tokenHash:hash(token),status:'pending',code:randomBytes(3).toString('hex').toUpperCase()};
      mkdirSync(join(this.root,'coordinator-clients'),{recursive:true,mode:0o700});writeFileSync(join(this.root,'coordinator-clients',id+'.json'),JSON.stringify({token}),{mode:0o600});this.state.clients.push(client);this.save();return {code:client.code,...this.config(id)};
    }
    if(action==='rename-client'){
      const client=this.state.clients.find(c=>c.id===args.id&&c.workspaceId===w.id&&c.status!=='revoked');
      if(!client)throw Error('Connection not found.');
      const name=String(args.name??'').trim().slice(0,80);if(!name)throw Error('Enter a coordinator name.');
      client.name=name;this.save();return this.ui();
    }
    if(action==='config')return this.config(String(args.id));
    if(action==='approve-client'||action==='revoke-client'){
      const c=this.state.clients.find(c=>c.id===args.id&&c.workspaceId===w.id);if(!c)throw Error('Connection not found');c.status=action==='approve-client'?'approved':'revoked';if(c.status==='revoked'&&w.controller===c.id){w.mode='off';w.controller=null;w.epoch++;}this.event(w,action,{clientId:c.id});return this.ui();
    }
    if(action==='request-discovery'){
      w.requests??=[];const existing=w.requests.find(r=>r.kind==='discovery'&&r.state!=='completed');if(existing)return existing;
      const request:CoordinatorRequest={id:randomUUID(),kind:'discovery',prompt:REPO_ONBOARDING_PROMPT,state:'queued',createdAt:new Date().toISOString()};w.requests.push(request);this.event(w,'coordinator-request',{requestId:request.id,kind:request.kind,instruction:'Read getCoordinatorRequests and acknowledge before acting.'});
      if(w.mode==='off')await this.uiAction('handoff',{mode:'internal'});
      return request;
    }
    if(action==='prepare-connection'){
      const name=String(args.name??'External coordinator').trim().slice(0,80);if(!name)throw Error('Enter a coordinator name.');
      const client=this.state.clients.find(c=>c.workspaceId===w.id&&c.name===name&&c.status!=='revoked');
      return client?{...this.config(client.id)}:this.uiAction('add-client',{name});
    }
    if(action==='request-handoff'){
      if(this.inFlight.size)throw Error('Wait for the current action to finish, then try again.');
      const mode=args.mode==='internal'?'internal':'external';
      if(mode==='internal'&&!w.conversationId){const chat=await this.h()['chat:create']({title:'Project coordinator'});w.conversationId=chat.conversation.id;}
      const to=mode==='internal'?`internal:${w.conversationId}`:String(args.clientId);
      if(mode==='external'&&!this.state.clients.some(c=>c.id===to&&c.workspaceId===w.id&&c.status==='approved'&&c.role==='coordinator'))throw Error('Pair and approve the new coordinator first.');
      if(w.controller===to)return this.ui();
      if(w.handoff&&w.handoff.state!=='completed'){if(w.handoff.to===to)return this.ui();throw Error('Finish or cancel the current handoff first.');}
      w.handoff={id:randomUUID(),from:w.controller,to,mode,state:w.controller?'requested':'ready',requestedAt:new Date().toISOString(),summary:w.summary,checkpoint:JSON.parse(JSON.stringify({objective:w.objective,summary:w.summary,jobs:w.jobs,queue:w.queue??[],decisions:w.decisions,releases:w.releases,cursor:w.nextCursor-1}))};
      w.revision++;this.event(w,'handoff-requested',{id:w.handoff.id,to,instruction:'Stop dispatching new work. Save a compact handoff with completeHandoff, then wait for the human to switch control.'});
      if(w.mode==='internal'&&w.conversationId){const chat=await this.h()['chat:get']({conversationId:w.conversationId});if(!chat.activeRun)await this.uiAction('chat-send',{body:'The user requested a coordinator change. Read getCoordinationSession, save current objective, completed work, active workers, decisions and next steps using completeHandoff with its handoffId. Do not start new work. Keep your reply to one short sentence.'});}
      return this.ui();
    }
    if(action==='cancel-handoff'){if(w.handoff?.state!=='completed'){delete w.handoff;w.revision++;this.event(w,'handoff-cancelled',{});}return this.ui();}
    if(action==='finish-handoff'){
      const h=w.handoff;if(!h||h.state==='completed')throw Error('No handoff is waiting.');
      if(h.state!=='ready'&&!args.useSavedProgress)throw Error('Waiting for the current coordinator to wrap up.');
      const result=await this.uiAction('handoff',{mode:h.mode,clientId:h.to,summary:h.summary});
      h.state='completed';this.event(w,'handoff-completed',{id:h.id,from:h.from,to:h.to,instruction:pauseCheckins,usedSavedProgress:!!args.useSavedProgress});
      if(h.mode==='internal')return this.uiAction('chat-send',{body:'You are now the coordinator. Read getWorkspaceSummary and the saved handoff first. Reconcile active workers and pending decisions; do not duplicate work. Briefly tell the user where things stand and the next action. Do not dispatch new development until the objective is clear.'});
      return result;
    }
    if(action==='handoff'){
      if(this.inFlight.size)throw Error('Wait for the current coordinator action to finish before handing off.');
      if(args.mode!=='off'&&(await this.h()['autopilot:list-active']()).length)throw Error('Stop the active Autopilot session before choosing a coordinator.');
      const old=w.conversationId;if(old){const chat=await this.h()['chat:get']({conversationId:old});if(chat.activeRun)await this.context!.supervisor.stop(chat.activeRun.id);}
      if(args.mode==='internal'){
        if(!w.conversationId){const chat=await this.h()['chat:create']({title:'Project coordinator'});w.conversationId=chat.conversation.id;}
        w.mode='internal';w.controller=`internal:${w.conversationId}`;
      }else if(args.mode==='external'){
        const c=this.state.clients.find(c=>c.id===args.clientId&&c.workspaceId===w.id&&c.status==='approved'&&c.role==='coordinator');if(!c)throw Error('Approve this coordinator connection first.');w.mode='external';w.controller=c.id;
      }else{w.mode='off';w.controller=null;}
      w.leaseUntil=Date.now()+30*60000;w.epoch++;w.revision++;if(typeof args.summary==='string')w.summary=args.summary.slice(0,16000);this.event(w,'handoff',this.session(w));return this.ui();
    }
    if(action==='settings'){
      if(!Number.isInteger(args.parallelism)||args.parallelism<1||args.parallelism>8||!Number.isFinite(args.budgetUsd)||args.budgetUsd<=0||args.budgetUsd>1000)throw Error('Choose 1–8 workers and a positive budget up to $1,000.');
      w.parallelism=args.parallelism;w.budgetUsd=args.budgetUsd;w.qaDefault=!!args.qaDefault;w.maxReworks=Math.min(2,Math.max(0,Number(args.maxReworks)||0));w.revision++;this.save();return this.ui();
    }
    if(action==='chat-stop'){const chat=w.conversationId?await this.h()['chat:get']({conversationId:w.conversationId}):null;if(chat?.activeRun)await this.context!.supervisor.stop(chat.activeRun.id);return {stopped:true};}
    if(action==='chat-get')return w.conversationId?this.h()['chat:get']({conversationId:w.conversationId}):null;
    if(action==='chat-send'){
      if(w.mode!=='internal'||!w.conversationId)throw Error('Select internal coordinator mode first.');w.leaseUntil=Date.now()+30*60000;this.save();
      return this.h()['chat:post-message']({conversationId:w.conversationId,body:String(args.body).slice(0,16000),appendSystemPrompt:COORDINATOR_GUIDE+' Keep user-facing replies concise: lead with the next action. Connection setup and approval controls are displayed by the app; do not repeat technical configuration, internal session revisions, or long handoff summaries. Ask a blocking question only when an actual decision is necessary.\nWorkspace: '+w.id+'\nHandoff: '+w.summary});
    }
    if(action==='approve-decision'){
      const d=w.decisions.find(d=>d.id===args.id&&d.state==='pending');if(!d)throw Error('Decision is no longer pending');d.state='executing';this.save();try{const result=await this.h()['cards:resolve']({cardId:d.cardId,value:d.value});d.state='answered';this.event(w,'decision-answered',{id:d.id});return result;}catch(e){d.state='failed';this.save();throw e;}
    }
    if(action==='approve-release'){
      const r=w.releases.find(r=>r.id===args.id&&['pending','ready'].includes(r.state));if(!r)throw Error('Release is not awaiting approval');await this.assertRelease(w,r);r.state='approved';this.event(w,'release-approved',{id:r.id,sha:r.sha,target:r.targetBranch});return this.ui();
    }
    if(action==='stop-all'){
      w.queue=[];for(const j of w.jobs){j.state='paused';const r=this.run(j.runId);if(active(r.status))await this.context!.supervisor.stop(r.id);if(j.reviewRunId&&active(this.run(j.reviewRunId).status))await this.context!.supervisor.stop(j.reviewRunId);}
      w.mode='off';w.controller=null;w.epoch++;w.revision++;this.event(w,'stopped',{});return this.ui();
    }
    throw Error('Unknown coordinator action');
  }
  config(id:string){const c=this.state.clients.find(c=>c.id===id);if(!c)throw Error('Connection not found');const spec={command:this.launcher,args:[],env:{KANBORG_COORDINATOR_CLIENT:id}};
    const config=JSON.stringify({mcpServers:{'kanborg':spec}},null,2),deepSeek=JSON.stringify({transport:'stdio',serverName:'kanborg',...spec},null,2);
    const toml=`[mcp_servers.kanborg]\ncommand = ${JSON.stringify(this.launcher)}\nargs = []\n[mcp_servers.kanborg.env]\nKANBORG_COORDINATOR_CLIENT = ${JSON.stringify(id)}`;
    const w=this.state.workspaces.find(w=>w.id===c.workspaceId)!;
    const prompt=`Connect this harness to KanBorg for ${basename(w.path)} as ${c.name}. Use local stdio MCP and preserve unrelated server settings. Configure with authorized tools if available, otherwise give concise manual steps. Verify getCapabilities before claiming connection. The owner approves pairing in KanBorg; observe only until assigned control.
After control is assigned, read the fresh workspace/session state, current authority and compact handoff. Treat the outgoing summary as state, not standing instructions. Retire superseded harness assignments and this workspace's old reminders, including Cline references; preserve historical evidence and unrelated schedules. Follow the integration contract returned by getCapabilities.
Create or update exactly one reminder for this workspace in this conversation, using the returned checkIn policy: 5 minutes during work, 15 minutes idle, pause when responsibility ends. Prefer supported event wakeups. Scheduled checks use immediate getChanges, not a 20-second wait or repeated full-state reads. Record actual schedule confirmation with updateCoordinationSession. An idle harness cannot be awakened by MCP alone.
Reminder template: ${COORDINATOR_REMINDER}
DeepSeek Harness recovery: if new tools are rejected as missing or ambiguous native schemas, do not repeatedly retry or disable auto-review. Quit/reopen DSH and the SAME conversation, then verify once. Until then workspace/session requests are read-only fallback; leave them pending until acknowledgement works.
Never approve your own pairing. No provider API keys are needed.\n\nClaude Desktop and generic JSON MCP clients:\n${config}\n\nChatGPT desktop local/Codex-host MCP configuration (config.toml):\n${toml}\n\nDeepSeek Harness MCP client fields:\n${deepSeek}\n\nUse only the format your client supports. Remote-only ChatGPT connector screens cannot use this local command; do not expose a local port publicly to work around that.`;
    return {id:c.id,config,deepSeek,toml,prompt};
  }
  async start(entry:string){
    this.entry=entry;this.launcher=join(this.root,'kanborg-mcp');const quote=(s:string)=>"'"+s.replace(/'/g,"'\\''")+"'";
    writeFileSync(this.launcher,`#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexport KANBOTS_LOCAL_DATA=${quote(this.root)}\nexec ${quote(process.execPath)} ${quote(entry)}\n`,{mode:0o700});chmodSync(this.launcher,0o700);
    // Existing paired harnesses keep the old path; both launch the current app bundle.
    const legacyLauncher=join(this.root,'kanbots-mcp');writeFileSync(legacyLauncher,readFileSync(this.launcher),{mode:0o700});chmodSync(legacyLauncher,0o700);
    const server=createServer((req,res)=>void(async()=>{
      try{
        if(req.method!=='POST'||req.headers.origin||!/^127\.0\.0\.1:\d+$/.test(req.headers.host??'')){res.writeHead(403);res.end('Local requests only');return;}
        const token=req.headers.authorization?.replace(/^Bearer /,'')??'';let actor:string,scope:string;
        const internal=this.internalTokens.get(hash(token));
        if(internal){const w=this.state.workspaces.find(w=>w.id===internal.workspaceId);const client=internal.clientId?this.state.clients.find(c=>c.id===internal.clientId):null;if(!w||internal.expires<Date.now()||(internal.clientId?client?.status!=='approved':w.epoch!==internal.epoch))throw Error('Coordinator session expired or revoked.');actor=internal.actor;scope=internal.workspaceId;}
        else{const c=this.state.clients.find(c=>c.tokenHash===hash(token));if(!c||req.url!=='/session')throw Error('Pairing not recognized.');c.lastSeen=new Date().toISOString();this.save();if(c.status!=='approved')throw Error(`Pairing ${c.code}: ${c.status}. Approve in KanBorg Coordinators.`);actor=c.role==='observer'?`observer:${c.id}`:c.id;scope=c.workspaceId;
          const sessionToken=randomBytes(32).toString('hex');this.internalTokens.set(hash(sessionToken),{workspaceId:scope,actor,epoch:0,expires:Date.now()+15*60000,clientId:c.id});for(const [key,value] of this.internalTokens)if(value.expires<Date.now())this.internalTokens.delete(key);
          res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({token:sessionToken}));return;
        }
        const match=/^\/tool\/([A-Za-z][A-Za-z0-9]+)$/.exec(req.url??'');if(!match)throw Error('Unknown endpoint');
        let body='';for await(const chunk of req){body+=chunk.toString();if(Buffer.byteLength(body)>65536)throw Error('Request too large');}
        const args=JSON.parse(body||'{}');const out=await this.call(actor,scope,match[1]!,args);res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(out));
      }catch(e){res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:clip(e instanceof Error?e.message:'Coordinator request failed',1000)}));}
    })());
    server.requestTimeout=35000;server.headersTimeout=10000;await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address() as {port:number};this.url=`http://127.0.0.1:${address.port}`;writeFileSync(join(this.root,'coordinator-endpoint.json'),JSON.stringify({url:this.url}),{mode:0o600});
    const timer=setInterval(()=>void this.tick().catch(()=>{}),3000);timer.unref();return ()=>{clearInterval(timer);server.close();server.closeAllConnections();};
  }
  async prepareInternal(conversationId:number,provider:string){
    const w=this.current();if(w.conversationId!==conversationId)return null;this.assertControl(w,`internal:${conversationId}`);
    const token=randomBytes(32).toString('hex');this.internalTokens.set(hash(token),{workspaceId:w.id,actor:w.controller!,epoch:w.epoch,expires:Date.now()+8*3600000});
    const env={KANBOTS_COORDINATOR:'1',KANBOTS_TOOL_BRIDGE_URL:this.url,KANBOTS_TOOL_BRIDGE_TOKEN:token,KANBOTS_MCP_ENTRY:this.entry,ELECTRON_RUN_AS_NODE:'1'};
    const config=join(this.root,'coordinator-internal-mcp.json');writeFileSync(config,JSON.stringify({mcpServers:{kanbots:{command:process.execPath,args:[this.entry]}}}),{mode:0o600});
    const extraArgs=provider==='codex-cli'?['-c',`mcp_servers.kanbots.command=${JSON.stringify(process.execPath)}`,'-c',`mcp_servers.kanbots.args=[${JSON.stringify(this.entry)}]`,'-c','mcp_servers.kanbots.env_vars=["KANBOTS_COORDINATOR","KANBOTS_TOOL_BRIDGE_URL","KANBOTS_TOOL_BRIDGE_TOKEN","ELECTRON_RUN_AS_NODE"]']:['--mcp-config',config];
    return {env,extraArgs,cleanup:()=>{this.internalTokens.delete(hash(token));},coordinatorPrompt:COORDINATOR_GUIDE+'\nWorkspace: '+w.id+'\nCurrent workflow: '+JSON.stringify(w.workflow?.config??newWorkflow().config)};
  }
  async call(actor:string,scope:string,name:string,raw:unknown):Promise<any>{
    if(this.closing)throw Error('Workspace is closing; reconnect after opening it.');
    const args=validateCoordinatorArgs(name,raw);
    if(name==='getCapabilities')return {version:'1.2.18',authority:'active-coordinator',guide:COORDINATOR_GUIDE,scope,tools:COORDINATOR_TOOLS.map(t=>t.name),releaseActions:['merge','draft-pr'],hosted:false};
    if(name==='listWorkspaces')return this.state.workspaces.filter(w=>w.id===scope).map(w=>({workspaceId:w.id,name:basename(w.path),open:this.context?.repoPath===w.path}));
    if(args.workspaceId!==scope)throw Error('This connection is not permitted for that workspace');const w=this.resolve(scope);
    if(name==='renewCoordinator'){if(w.controller!==actor||w.mode==='off')throw Error('Control belongs elsewhere');w.leaseUntil=Date.now()+30*60000;this.save();return this.session(w);}
    // A former controller may confirm only its own already-recorded schedule was paused.
    // This cannot change task state, ownership, authority or another harness's schedule.
    if(name==='updateCoordinationSession'&&w.controller!==actor&&args.schedule?.status==='paused'&&args.objective===undefined&&args.summary===undefined&&w.schedules?.[actor]&&args.schedule.id===w.schedules[actor]!.id){
      w.schedules[actor]={...w.schedules[actor]!,status:'paused',confirmedAt:new Date().toISOString()};this.save();return {revision:w.revision,data:{schedule:w.schedules[actor]}};
    }
    const isWrite=(COORDINATOR_TOOLS.find(t=>t.name===name)!.inputSchema.required as string[]).includes('requestId');
    if(w.handoff?.state==='completed'&&w.handoff.to===actor&&name==='getWorkspaceSummary'){w.handoff.receivedBy=actor;this.save();}
    if(w.controller===actor&&w.mode!=='off'){w.leaseUntil=Date.now()+30*60000;this.save();}
    if(!isWrite){const result=await this.read(w,name,args);if(['getWorkspaceSummary','getCoordinationSession'].includes(name)&&w.handoff?.from===actor&&w.handoff.state!=='requested')return {...result,coordinatorInstruction:pauseCheckins};return result;}
    if(w.handoff&&w.handoff.state!=='completed'&&!['updateCoordinationSession','completeHandoff'].includes(name))throw Error('Handoff requested. Stop new work and call completeHandoff with a current summary.');
    this.assertControl(w,actor);
    if(this.updater?.pending()&&['dispatchTask','followUpRun','runQA','executeRelease','prepareExternalCoordinator'].includes(name))throw Error('An application update is waiting. Existing runs can finish; new work resumes after restart.');
    const key=actor+':'+args.requestId;const digest=hash(JSON.stringify({name,args}));const existing=w.receipts[key];
    if(existing){if(existing.digest!==digest)throw Error('Request ID was already used with different arguments');const running=this.inFlight.get(key);if(running)return running;if(existing.state==='done')return existing.result;throw Error(existing.error??'Request outcome is uncertain. Inspect workspace and run history; do not blindly repeat.');}
    if(args.revision!==w.revision)throw Error(`Stale revision. Current revision is ${w.revision}; refresh session.`);
    // Reserve synchronously before any await. Unknown outcomes are never replayed.
    w.receipts[key]={digest,state:'pending'};w.revision++;w.leaseUntil=Date.now()+30*60000;this.save();
    const promise=(async()=>{try{const data=await this.mutate(w,name,args);const result={revision:w.revision,data};w.receipts[key]={digest,state:'done',result};this.event(w,name,{actor,requestId:args.requestId});return result;}catch(e){w.receipts[key]={digest,state:'failed',error:clip(e instanceof Error?e.message:'Action failed',1000)};this.save();throw e;}finally{this.inFlight.delete(key);}})();this.inFlight.set(key,promise);return promise;
  }
  private async read(w:Workspace,name:string,a:any):Promise<any>{
    const h=this.h();
    switch(name){
      case 'getWorkflow':return this.workflowAction(w,'get',a,w.controller??'observer');
      case 'previewWorkflowChange':return this.workflowAction(w,'preview',a,w.controller??'observer');
      case 'getApplicationUpdate':if(!this.updater)throw Error('Updater unavailable');return this.updater.check();
      case 'getCoordinatorRequests':return (w.requests??[]).filter(r=>r.state!=='completed');
      case 'getCoordinationSession':return this.session(w);
      case 'getOnboardingBrief':return {prompt:REPO_ONBOARDING_PROMPT,lastReconciledAt:w.onboardedAt??null,inventory:w.inventory??{}};
      case 'getWorkspaceSummary':{const issues=await this.read(w,'listIssues',{});return {session:this.session(w),issues,jobs:w.jobs.slice(-20).map(j=>({...j,run:this.compactRun(j.runId)})),decisions:await h['decisions:pending'](),onboarding:!w.onboardedAt||issues.items.length===0?{needed:true,nextAction:'Call getOnboardingBrief to discover existing work.'}:null,cursor:w.nextCursor-1,releases:w.releases.slice(-10)};}
      case 'listIssues':{const rows=await h['issues:list']({state:'all'});w.workflow??=newWorkflow();materialize(w.workflow,rows);const offset=a.offset??0;return {items:rows.slice(offset,offset+(a.limit??30)).map((i:any)=>({number:i.number,title:i.title,status:i.status,state:i.state,labels:i.labels,workflow:w.workflow!.cards[i.number]})),nextOffset:offset+(a.limit??30)<rows.length?offset+(a.limit??30):null};}
      case 'getIssue':{const d=await h['issues:get']({number:a.number});w.workflow??=newWorkflow();materialize(w.workflow,[d.issue]);return {issue:d.issue,workflow:workflowGuidance(w.workflow,a.number),dependencies:w.dependencies[a.number]??[]};}
      case 'getRunResult':{const r=this.run(a.runId);const events=this.context!.store.events.list(r.id);const text=events.filter(e=>['text','result'].includes(e.type)).map(e=>clip(e.payload,3000)).slice(-3).join('\n');let sha=null;try{sha=await this.revision(r.id);}catch{}return {...this.compactRun(r.id),summary:clip(text,4000),commit:sha,qa:w.jobs.find(j=>j.runId===r.id)??null,checks:await h['agent-runs:checks:list']({runId:r.id}),evidence:{logs:{tool:'readRunLog',runId:r.id},diff:{tool:'getDiffSummary',runId:r.id}},nextAction:active(r.status)?'Wait for changes; answer pending decisions if blocked':'Review outcome and QA evidence; completion is not release approval'};}
      case 'readRunLog':{this.run(a.runId);const rows=this.context!.store.events.list(a.runId).filter(e=>e.seq>(a.offset??-1));const items=rows.slice(0,a.limit??10).map(e=>({seq:e.seq,type:e.type,content:clip(e.payload,2000)}));return {items,nextCursor:items.at(-1)?.seq??a.offset??0,hasMore:rows.length>items.length};}
      case 'getDiffSummary':{const d=await h['agent-runs:diff']({runId:a.runId});if(a.file){const f=d.files.find(f=>f.path===a.file);return {file:a.file,patch:f?.patch.slice(a.offset??0,(a.offset??0)+8000),truncated:(f?.patch.length??0)>(a.offset??0)+8000};}return {files:d.files.map(f=>({path:f.path,status:f.status}))};}
      case 'getChanges':case 'waitForChanges':{const start=Date.now();const wait=name==='waitForChanges'?(a.timeoutMs??20000):0;while(w.nextCursor-1<=(a.cursor??0)&&Date.now()-start<wait)await new Promise(r=>setTimeout(r,250));const events=w.events.filter(e=>e.cursor>(a.cursor??0)).slice(0,50);return {workflowVersion:w.workflow?.version??1,control:{controller:w.controller,mode:w.mode,leaseUntil:w.leaseUntil},handoff:w.handoff?{id:w.handoff.id,state:w.handoff.state,from:w.handoff.from,to:w.handoff.to}:null,pendingRequestIds:(w.requests??[]).filter(r=>r.state!=='completed').map(r=>r.id),checkIn:this.checkinPolicy(w,true),events,cursor:events.at(-1)?.cursor??a.cursor??0,resetRequired:(a.cursor??0)<(w.events[0]?.cursor??0)-1,revision:w.revision};}
      case 'getCapacity':return (await collectCapacity()).snapshot;
      case 'listDecisions':return {pending:await h['decisions:pending'](),proposed:w.decisions.filter(d=>d.state==='pending'),authority:'Active coordinator answers directly with answerDecision'};
      case 'getReleaseStatus':return w.releases;
      default:throw Error('Unsupported read');
    }
  }
  private async mutate(w:Workspace,name:string,a:any):Promise<any>{
    const h=this.h();
    switch(name){
      case 'recordWorkflowEvent':if(!a.evidence.trim())throw Error('Record the exact revision and supporting evidence.');await this.workflowSignal(w,a.number,a.event,a.evidence,a.requestId);return workflowGuidance(w.workflow!,a.number);
      case 'applyWorkflowChange':return this.workflowAction(w,'apply',a,w.controller!);
      case 'undoWorkflowChange':return this.workflowAction(w,'undo',a,w.controller!);
      case 'updateWorkflowCard':return this.workflowAction(w,'card',a,w.controller!);
      case 'saveWorkflowTemplate':return this.workflowAction(w,'template',a,w.controller!);
      case 'updateApplication':if(!this.updater)throw Error('Updater unavailable');return this.updater.request(a,w.path);
      case 'acknowledgeCoordinatorRequest':{const r=w.requests?.find(r=>r.id===a.id);if(!r)throw Error('Request not found.');if(r.state!=='completed'){r.state=a.state;r.receivedBy=w.controller!;}return r;}
      case 'completeHandoff':{const h=w.handoff;if(!h||h.id!==a.handoffId||h.from!==w.controller||h.state==='completed')throw Error('Handoff is no longer current.');h.summary=a.summary;w.summary=a.summary;h.state='ready';return {...h,coordinatorInstruction:pauseCheckins};}
      case 'prepareExternalCoordinator':{if(w.mode!=='internal')throw Error('Prepare external harness setup from the built-in coordinator.');const client=this.state.clients.find(c=>c.workspaceId===w.id&&c.name===a.name&&c.status!=='revoked');const setup=client?{code:client.code,...this.config(client.id)}:await this.uiAction('add-client',{name:a.name});return {...setup,humanApprovalRequired:true,nextAction:'Show the setup request to the user. They connect their harness, approve pairing in KanBorg, then choose Use coordinator. Do not hand off automatically.'};}
      case 'updateCoordinationSession':if(a.objective!==undefined)w.objective=a.objective;if(a.summary!==undefined)w.summary=a.summary;if(a.schedule){w.schedules??={};w.schedules[w.controller!]={...a.schedule,confirmedAt:new Date().toISOString()};}return this.session(w);
      case 'completeOnboarding':for(const r of w.requests??[])if(r.kind==='discovery')r.state='completed';w.onboardedAt=new Date().toISOString();w.summary=a.summary;return this.session(w);
      case 'upsertWorkItem':{
        w.inventory??={};const prior=w.inventory[a.sourceRef];let number=prior?.number??a.number;
        let body=(a.body??'')+`\n\nSource: ${a.sourceRef}\nKind: ${a.kind}\nStatus evidence: ${a.evidence}\nVerified: ${new Date().toISOString()}`;
        if(number){const existing=(await h['issues:get']({number})).issue;if(prior?.sourceHash&&prior.sourceHash!==hash(JSON.stringify([existing.title,existing.body,existing.labels])))throw Error('This card changed outside reconciliation. Read it and incorporate the human edits before updating.');if(!prior&&existing.body)body=existing.body+'\n\n'+body;await h['issues:patch']({number,patch:{title:a.title,body,labels:withStatusLabel(existing.labels,a.status)}});}
        else{const rows=await h['issues:list']({state:'all'});const linked=rows.find(i=>i.body?.includes(`Source: ${a.sourceRef}\n`));if(linked){number=linked.number;await h['issues:patch']({number,patch:{title:a.title,body,labels:withStatusLabel(linked.labels,a.status)}});}else{const created=await h['issues:create']({title:a.title,body,labels:withStatusLabel([],a.status)});number=created.number;}}
        const updated=(await h['issues:get']({number:number!})).issue;w.inventory[a.sourceRef]={number:number!,kind:a.kind,evidence:a.evidence,verifiedAt:new Date().toISOString(),sourceHash:hash(JSON.stringify([updated.title,updated.body,updated.labels]))};return w.inventory[a.sourceRef];
      }
      case 'createIssue':return h['issues:create']({title:a.title,...(a.body?{body:a.body}:{})});
      case 'updateIssue':{if(a.status){const rows=await h['issues:list']({state:'all'});w.workflow??=newWorkflow();materialize(w.workflow,rows);const target=w.workflow.config.stages.find(s=>s.id===a.status)??w.workflow.config.stages.find(s=>s.category===a.status);if(!target)throw Error('Use updateWorkflowCard with a configured stage.');moveWorkflowCard(w.workflow,{number:a.number,to:target.id,reason:'Coordinator status update',evidence:a.body??'Coordinator-directed move; use updateWorkflowCard to record check evidence'},w.controller!);}const existing=a.status?(await h['issues:get']({number:a.number})).issue:null;const updated=await h['issues:patch']({number:a.number,patch:{...(a.title!==undefined?{title:a.title}:{}),...(a.body!==undefined?{body:a.body}:{}),...(a.status?{labels:withStatusLabel(existing!.labels,a.status)}:{})}});for(const item of Object.values(w.inventory??{}))if(item.number===a.number)delete item.sourceHash;return updated;}
      case 'addComment':return h['issues:add-comment']({number:a.number,body:a.body});
      case 'setDependencies':{await h['issues:get']({number:a.number});for(const id of a.dependsOn)await h['issues:get']({number:id});const graph:Record<string,number[]>={...w.dependencies,[a.number]:a.dependsOn};const walk=(id:number,path:number[]):void=>{if(path.includes(id))throw Error('Dependency cycle');for(const next of graph[id]??[])walk(next,[...path,id]);};walk(a.number,[]);w.dependencies=graph;return graph[a.number];}
      case 'dispatchTask':return this.dispatch(w,a.number,a.budgetUsd??w.budgetUsd,a.qa??w.qaDefault,a.maxReworks??w.maxReworks,a.readOnly===true);
      case 'followUpRun':{if(active(this.run(a.runId).status)&&this.run(a.runId).status!=='awaiting_input')throw Error('Wait for this worker or stop it before following up.');const j=w.jobs.find(j=>j.runId===a.runId);if(!j)throw Error('Run is not a delegated implementation');j.state='implementing';delete j.sha;delete j.checkIds;delete j.reviewRunId;this.save();return this.context!.supervisor.resume({runId:a.runId,prompt:a.message+'\nWorkflow: '+JSON.stringify(workflowGuidance(w.workflow??newWorkflow(),j.number))+'\nCommit the completed implementation locally; do not merge or push.',costBudgetUsd:j.budgetUsd});}
      case 'stopRun':{const j=w.jobs.find(j=>j.runId===a.runId||j.reviewRunId===a.runId);if(j)j.state='paused';return h['agent-runs:stop']({runId:a.runId});}
      case 'answerDecision':{const pending=await h['decisions:pending']();const original=pending.find(d=>d.cardId===a.cardId&&d.options.some(o=>o.value===a.value));if(!original)throw Error('Pending decision/option not found');const d={id:randomUUID(),cardId:a.cardId,value:a.value,question:original.question,label:original.options.find(o=>o.value===a.value)!.label,state:'executing'};w.decisions.push(d);this.save();try{const result=await h['cards:resolve']({cardId:a.cardId,value:a.value});d.state='answered';return {...d,result};}catch(e){d.state='failed';throw e;}}
      case 'configureWorkflow':return this.uiAction('settings',{parallelism:a.parallelism??w.parallelism,budgetUsd:a.budgetUsd??w.budgetUsd,qaDefault:a.qaDefault??w.qaDefault,maxReworks:a.maxReworks??w.maxReworks});
      case 'runQA':{let j=w.jobs.find(j=>j.runId===a.runId);if(!j){const r=this.run(a.runId);const t=this.context!.store.threads.findById(r.threadId);if(!t)throw Error('Task not found');j={runId:r.id,number:t.issueNumber,role:'implementation',qa:true,maxReworks:0,reworks:0,budgetUsd:a.budgetUsd??w.budgetUsd,state:'implementing'};w.jobs.push(j);}j.qa=true;await this.startQA(w,j);return j;}
      case 'prepareRelease':{const sha=await this.revision(a.runId);const qaPassed=w.jobs.some(j=>j.runId===a.runId&&j.state==='qa-passed'&&j.sha===sha);if(!/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(a.targetBranch)||a.targetBranch.includes('..'))throw Error('Invalid target branch');const targetSha=await this.git(w.path,['rev-parse',`refs/heads/${a.targetBranch}`]);const r:Release={id:randomUUID(),runId:a.runId,sha,targetBranch:a.targetBranch,targetSha,action:a.action,state:'ready',...(a.title?{title:a.title}:{}),...(a.body?{body:a.body}:{})};w.releases.push(r);return {...r,warnings:qaPassed?[]:['Passing QA is not recorded for this revision. The coordinator decides whether to proceed.'],nextAction:'Call executeRelease when you decide to release this revision.'};}
      case 'executeRelease':if(w.workflow?.config.releaseOwner==='user'&&!w.releases.some(r=>r.id===a.releaseId&&r.state==='approved'))throw Error('This workflow reserves releases for the user. Ask for the owner decision or an explicitly requested policy change.');return this.executeRelease(w,String(a.releaseId));
      default:throw Error('Unsupported action');
    }
  }
  private async workflowAction(w:Workspace,action:string,a:any,actor:string):Promise<any>{
    const issues=await this.h()['issues:list']({state:'all'});w.workflow??=newWorkflow();const flow=w.workflow;materialize(flow,issues);
    const view=()=>({version:flow.version,config:flow.config,cards:flow.cards,history:flow.history,templates:Object.values(this.state.templates??{}),issues:issues.map(i=>({...i,running:!!i.activeRun})),undo:flow.history.length?undoWorkflowChange(flow,'Undo last workflow change'):null});
    if(action==='get'){this.save();return view();}
    const toolName=({preview:'previewWorkflowChange',apply:'applyWorkflowChange',undo:'undoWorkflowChange',card:'updateWorkflowCard',template:'saveWorkflowTemplate'} as Record<string,string>)[action];
    if(!toolName)throw Error('Unknown workflow action.');
    if(actor==='user')validateCoordinatorArgs(toolName,{workspaceId:w.id,...(action==='preview'?{}:{requestId:'app-workflow-edit',revision:w.revision}),...a});
    if(action==='preview')return previewWorkflow(flow,a,issues);
    if(action==='template'){if(!/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(a.id)||!a.name?.trim())throw Error('Choose a template name and identity.');this.state.templates??={};const old=this.state.templates[a.id];const saved={id:a.id,name:a.name,version:(old?.version??0)+1,config:structuredClone(flow.config),updatedAt:new Date().toISOString(),actor};this.state.templates[a.id]=saved;this.event(w,'workflow-template-saved',{id:a.id,version:saved.version,actor});return view();}
    if(action==='card'){
      const data=moveWorkflowCard(flow,a,actor);w.revision++;this.event(w,'workflow-card-updated',{number:a.number,stageId:data.stageId,workflowVersion:flow.version,actor});return view();
    }
    const change=action==='undo'?{...undoWorkflowChange(flow,a.reason),expectedVersion:a.expectedVersion,...(a.migrations?{migrations:a.migrations}:{})}:a;
    if(!['apply','undo'].includes(action))throw Error('Unknown workflow action.');
    const impact=applyWorkflow(flow,change,issues,actor);w.revision++;
    const id='workflow:'+flow.version;w.requests??=[];w.requests.push({id,kind:'workflow-change',state:'queued',createdAt:new Date().toISOString(),prompt:`Workflow version ${flow.version} saved: ${change.reason}. Read getWorkflow and apply its current guidance to future actions. Existing workers and completed evidence are preserved. Affected cards: ${impact.affected.map(c=>'#'+c.number).join(', ')||'none'}.${impact.scheduleChanged?' Update the SAME existing workspace schedule to the new checkIn policy, verify it through harness tools, and record the confirmed receipt. Do not create a duplicate schedule.':''}`});
    this.event(w,'workflow-changed',{version:flow.version,actor,reason:change.reason,affected:impact.affected,scheduleChanged:impact.scheduleChanged});return {...view(),impact};
  }
  private async workflowSignal(w:Workspace,number:number,event:string,evidence:string,key:string){
    w.workflow??=newWorkflow();const flow=w.workflow;const issue=(await this.h()['issues:get']({number})).issue;materialize(flow,[issue]);const card=flow.cards[number]!;
    w.workflowSignals??={};const identity=number+':'+event+':'+key;if(w.workflowSignals[identity])return;w.workflowSignals[identity]=new Date().toISOString();
    // Completion never reopens because a worker exits or the workflow changed.
    if(flow.config.stages.find(s=>s.id===card.stageId)?.category==='done'){this.save();return;}
    if(event==='worker-failed'){card.waiting={reason:flow.config.waitingReasons.includes('Worker recovery')?'Worker recovery':flow.config.waitingReasons[0]??'Worker recovery',owner:'coordinator',trigger:'Review failure and resume or reassign from compact evidence'};card.nextAction='Recover failed worker; not ready for acceptance';}
    else if(event==='worker-started'){delete card.waiting;card.owner='worker';card.nextAction='Submit deliverable and evidence';const target=flow.config.stages.find(s=>s.category==='inProgress');if(target&&flow.config.transitions.some(t=>t.from===card.stageId&&t.to===target.id))try{moveWorkflowCard(flow,{number,to:target.id,evidence,reason:'Worker started'},'system');}catch{/* Required entry gates remain coordinator work. */}}
    else{
      if(event==='worker-completed'||event==='qa-passed')card.checks.deliverable={outcome:'pass',evidence,at:new Date().toISOString(),actor:'system',version:flow.version};
      if(event==='qa-passed')card.checks['qa-findings']={outcome:'pass',evidence,at:new Date().toISOString(),actor:'system',version:flow.version};
      card.evidence=evidence;card.owner='coordinator';card.nextAction=event==='merged'?'Verify exact merged revision through deployment; merge alone is not completion':'Assess deliverable and evidence; accept supporting work or identify remaining delivery';
      const transition=flow.config.transitions.find(t=>t.from===card.stageId&&t.automatic&&t.event===event);
      if(transition)try{moveWorkflowCard(flow,{number,to:transition.to,evidence,reason:event,owner:flow.config.stages.find(s=>s.id===transition.to)?.actor??'coordinator'},'system');}catch(e){card.nextAction=e instanceof Error?e.message:'Assess workflow gates';}
    }
    if(event!=='worker-started'){w.requests??=[];w.requests.push({id:'workflow-event:'+identity,kind:'workflow-action',state:'queued',createdAt:new Date().toISOString(),prompt:`Card #${number}: ${event}. ${evidence}. Read getIssue and its current workflow guidance, then take the next authorized action. Preserve completed evidence; do not rerun QA without a reason.`});}
    this.event(w,'workflow-event',{number,event,workflowVersion:flow.version,evidence});
  }
  private async dispatch(w:Workspace,number:number,budgetUsd:number,qa:boolean,maxReworks:number,readOnly=false,fromQueue=false){
    if(w.jobs.some(j=>j.number===number&&['implementing','checks','reviewing'].includes(j.state)))throw Error('This task already has an active pipeline.');
    const running=w.jobs.filter(j=>active(this.run(j.runId).status)||(j.reviewRunId&&active(this.run(j.reviewRunId).status))).length;const waiting=running>=w.parallelism;
    if(waiting&&!fromQueue){w.queue??=[];let queued=w.queue.find(q=>q.number===number);if(!queued){queued={id:randomUUID(),number,budgetUsd,qa,maxReworks,readOnly};w.queue.push(queued);this.event(w,'task-queued',queued);}return {queueId:queued.id,number,status:'queued',nextAction:'Waiting for worker capacity; adjust configureWorkflow to change parallelism'};}
    if(waiting)throw Error('Task is still waiting for worker capacity');
    const issue=(await this.h()['issues:get']({number})).issue;const thread=this.context!.store.threads.getOrCreate({repoOwner:(await this.h()['config:get']()).owner,repoName:(await this.h()['config:get']()).repo,issueNumber:number});
    w.workflow??=newWorkflow();materialize(w.workflow,[issue]);
    const guidance='\nWorkflow contract: '+JSON.stringify(workflowGuidance(w.workflow,number));
    const run=await this.context!.supervisor.start({threadId:thread.id,issueNumber:number,prompt:guidance+(readOnly?`Read-only discovery task. Do not modify source files, commit, merge, push or deploy. Return concise evidence and an inventory that the coordinator can use.\n${issue.title}\n${issue.body??''}`:`Implement this task, observing repository instructions and acceptance criteria. Do not expand scope. Commit the completed implementation locally in your worktree; do not merge, push or deploy.\n\n${issue.title}\n${issue.body??''}`),costBudgetUsd:budgetUsd,provider:'claude-code',personaId:'implementation'});
    const j:Job={runId:run.id,number,role:readOnly?'discovery':'implementation',qa:readOnly?false:qa,maxReworks,reworks:0,budgetUsd,state:'implementing'};w.jobs.push(j);await this.workflowSignal(w,number,'worker-started',`Worker run ${run.id} started`,String(run.id));this.save();return {runId:run.id,number,status:run.status,qa,prerequisites:w.dependencies[number]??[],nextAction:'Use waitForChanges'};
  }
  private async startQA(w:Workspace,j:Job){j.sha=await this.revision(j.runId);const checks=await this.h()['agent-runs:checks:run']({runId:j.runId});j.checkIds=checks.map(c=>c.id);j.state='checks';delete j.error;this.event(w,'qa-started',{runId:j.runId,sha:j.sha});}
  private async repair(w:Workspace,j:Job,reason:string){
    if(j.reworks>=j.maxReworks){j.state='needs-changes';j.error=reason;await this.workflowSignal(w,j.number,'worker-failed',reason,`${j.runId}:${j.reworks}`);this.event(w,'needs-changes',{runId:j.runId,reason});return;}
    j.reworks++;j.state='implementing';delete j.reviewRunId;delete j.sha;this.save();await this.context!.supervisor.resume({runId:j.runId,prompt:`QA found problems. Fix only these, rerun relevant checks, and commit locally. Do not merge or push.\n${reason}`,costBudgetUsd:j.budgetUsd});this.event(w,'rework-started',{runId:j.runId,attempt:j.reworks});
  }
  async tick(){if(this.polling||this.closing||this.inFlight.size||!this.context||this.updater?.pending())return;this.polling=true;try{const w=this.current();
    if(w.mode==='internal'&&w.conversationId&&(!w.handoff||w.handoff.state==='completed')){const pending=w.requests?.find(r=>r.state==='queued');if(pending){const chat=await this.h()['chat:get']({conversationId:w.conversationId});if(!chat.activeRun){pending.state='received';pending.receivedBy=w.controller!;this.save();try{const result=await this.uiAction('chat-send',{body:pending.prompt});if(result?.dispatchError)throw Error(result.dispatchError);this.event(w,'coordinator-request-received',{id:pending.id});}catch(e){this.event(w,'coordinator-request-blocked',{id:pending.id,error:clip(e instanceof Error?e.message:'Could not start request')});}}}}
    for(const q of [...(w.handoff&&w.handoff.state!=='completed'?[]:w.queue??[])]){
      const slots=w.jobs.filter(j=>active(this.run(j.runId).status)||(j.reviewRunId&&active(this.run(j.reviewRunId).status))).length;
      if(slots>=w.parallelism)break;

      // Persist intent before dispatch; uncertain failures are surfaced, not replayed.
      w.queue=w.queue!.filter(x=>x.id!==q.id);this.save();try{await this.dispatch(w,q.number,q.budgetUsd,q.qa,q.maxReworks,q.readOnly,true);}catch(e){this.event(w,'queued-task-blocked',{number:q.number,error:clip(e instanceof Error?e.message:'Dispatch failed')});}
    }
    const state=w.jobs.map(j=>({run:this.compactRun(j.runId),review:j.reviewRunId?this.compactRun(j.reviewRunId):null}));const snap=JSON.stringify(state);if(w.snapshot!==snap){w.snapshot=snap;this.event(w,'runs-changed',state);}
    for(const j of w.jobs){try{
      if(j.state==='implementing'){const r=this.run(j.runId);if(active(r.status))continue;if(r.status!=='complete'){j.state='blocked';j.error=r.exitReason??r.status;this.event(w,'blocked',{runId:r.id,reason:j.error});await this.workflowSignal(w,j.number,'worker-failed',`Run ${r.id}: ${j.error}`,String(r.id));continue;}if(!j.qa){j.state='completed';this.event(w,'implementation-completed',{runId:r.id});await this.workflowSignal(w,j.number,'worker-completed',`Deliverable from run ${r.id}; inspect getRunResult for evidence and limitations`,String(r.id));continue;}await this.startQA(w,j);}
      if(j.state==='checks'){
        const checks=(await this.h()['agent-runs:checks:list']({runId:j.runId})).filter(c=>j.checkIds?.includes(c.id));if(!checks.length||checks.some(c=>!['pass','fail'].includes(c.status)))continue;
        if(await this.revision(j.runId)!==j.sha)throw Error('Implementation changed during QA. Run QA again.');
        if(checks.some(c=>c.status==='fail')){await this.repair(w,j,checks.filter(c=>c.status==='fail').map(c=>clip(c.summary)).join('\n'));continue;}
        const original=this.run(j.runId);const issue=(await this.h()['issues:get']({number:j.number})).issue;
        const reviewer=await this.context!.supervisor.start({threadId:original.threadId,issueNumber:j.number,baseRef:j.sha!,provider:'claude-code',costBudgetUsd:j.budgetUsd,personaId:'reviewer',prompt:'Workflow: '+JSON.stringify(workflowGuidance(w.workflow??newWorkflow(),j.number))+'\n'+`Independently review this committed implementation against the task. Do not edit files, commit, merge or push. Inspect the actual diff against the project target and identify defects or unmet criteria. Your final answer MUST end with exactly KANBOTS_QA_PASS or KANBOTS_QA_FAIL. Include concise evidence.\nImplementation commit: ${j.sha}\nTask: ${issue.title}\n${issue.body??''}`});j.reviewRunId=reviewer.id;j.state='reviewing';this.event(w,'review-started',{runId:j.runId,reviewRunId:reviewer.id});
      }
      if(j.state==='reviewing'&&j.reviewRunId){const r=this.run(j.reviewRunId);if(active(r.status))continue;
        const events=this.context!.store.events.list(r.id);const texts=events.filter(e=>e.type==='text').map(e=>{const p=e.payload as any;return p.text??p.result??'';}).join('\n');
        if(r.status==='complete'&&/KANBOTS_QA_PASS\s*$/.test(texts)&&await this.revision(r.id)===j.sha&&await this.revision(j.runId)===j.sha){j.state='qa-passed';this.event(w,'qa-passed',{runId:j.runId,sha:j.sha,reviewRunId:r.id});await this.workflowSignal(w,j.number,'qa-passed',`Independent review ${r.id} passed for ${j.sha}`,String(r.id));}else await this.repair(w,j,clip(texts||r.exitReason||'Review did not pass',6000));
      }
    }catch(e){j.state='blocked';j.error=clip(e instanceof Error?e.message:'Pipeline blocked',1000);this.event(w,'blocked',{runId:j.runId,reason:j.error});await this.workflowSignal(w,j.number,'worker-failed',j.error,String(j.runId));}}
  }finally{this.polling=false;}}
  private async assertRelease(w:Workspace,r:Release){if(await this.revision(r.runId)!==r.sha)throw Error('Release revision changed. Prepare a new release.');if(await this.git(w.path,['rev-parse',`refs/heads/${r.targetBranch}`])!==r.targetSha)throw Error('Target branch changed. Prepare a new release.');}
  private async executeRelease(w:Workspace,id:string){const r=w.releases.find(r=>r.id===id);if(!r)throw Error('Release not found');if(r.state==='completed')return r;if(!['pending','ready','approved'].includes(r.state))throw Error('Release already attempted. Inspect its result and prepare a new plan if needed.');await this.assertRelease(w,r);r.state='executing';this.save();
    try{const run=this.run(r.runId);if(r.action==='merge'){
      const listing=await this.git(w.path,['worktree','list','--porcelain']);const target=listing.split('\n\n').find(block=>block.split('\n').includes(`branch refs/heads/${r.targetBranch}`))?.split('\n').find(line=>line.startsWith('worktree '))?.slice(9);if(!target)throw Error('Target must be checked out in a worktree.');if(await this.git(target,['status','--porcelain']))throw Error('Target worktree has uncommitted changes.');
      try{await this.git(target,['merge','--no-ff','--no-edit',r.sha]);}catch(e){await this.git(target,['merge','--abort']).catch(()=>{});throw e;}r.result={merged:true,commit:await this.git(target,['rev-parse','HEAD']),target:r.targetBranch};
    }else{
      const source=this.context!.source;
      if(!source.openDraftPR)throw Error('Draft PR requires a GitHub-backed workspace.');
      const branch=`kanbots-release/${r.id}`;
      await this.git(w.path,['push','origin',`${r.sha}:refs/heads/${branch}`]);
      r.result=await source.openDraftPR({head:branch,base:r.targetBranch,title:r.title??`Implementation ${r.sha.slice(0,8)}`,body:r.body??'Release directed by the KanBorg coordinator.',draft:true});
    }r.state='completed';const job=w.jobs.find(j=>j.runId===r.runId);if(job&&r.action==='merge')await this.workflowSignal(w,job.number,'merged',JSON.stringify(r.result),r.id);this.event(w,'release-completed',{id:r.id,result:r.result});return r;}catch(e){r.state='failed';r.result={error:clip(e instanceof Error?e.message:'Release failed',1000)};this.event(w,'release-failed',{id:r.id,result:r.result});throw e;}
  }
}
