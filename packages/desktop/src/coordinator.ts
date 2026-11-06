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
import { COORDINATOR_TOOLS,COORDINATOR_GUIDE,REPO_ONBOARDING_PROMPT,validateCoordinatorArgs } from '@kanborg/mcp';
import { collectCapacity } from './routing-capacity.js';
const exec=promisify(execFile);
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
const active=(s:string)=>['starting','running','awaiting_input'].includes(s);
const redact=(s:string)=>s.replace(/\bsk-[A-Za-z0-9_-]{12,}/g,'[redacted]').replace(/Bearer\s+[A-Za-z0-9._-]+/gi,'Bearer [redacted]');
const clip=(v:unknown,n=4000)=>redact(typeof v==='string'?v:JSON.stringify(v)??'').slice(0,n);
export type CoordinatorContext={repoPath:string;source:IssueSource;handlers:Handlers;store:Store;supervisor:AgentSupervisor};
type Client={id:string;name:string;workspaceId:string;role:'observer'|'coordinator';tokenHash:string;status:'pending'|'approved'|'revoked';code:string;lastSeen?:string};
type Job={runId:number;number:number;role:string;qa:boolean;maxReworks:number;reworks:number;budgetUsd:number;state:string;sha?:string;reviewRunId?:number;checkIds?:number[];error?:string};
type Release={id:string;runId:number;sha:string;targetBranch:string;targetSha:string;action:'merge'|'draft-pr';title?:string;body?:string;state:string;result?:unknown};
type Handoff={id:string;from:string|null;to:string;mode:'internal'|'external';state:'requested'|'ready'|'completed';requestedAt:string;summary:string;checkpoint:unknown;receivedBy?:string};
type CoordinatorRequest={id:string;kind:'discovery';prompt:string;state:'queued'|'received'|'completed';createdAt:string;receivedBy?:string};
type Workspace={requests?:CoordinatorRequest[];handoff?:Handoff;queue?:Array<{id:string;number:number;budgetUsd:number;qa:boolean;maxReworks:number;readOnly:boolean}>;onboardedAt?:string;inventory?:Record<string,{number:number;kind:string;evidence:string;verifiedAt:string;sourceHash?:string}>;id:string;path:string;revision:number;mode:'internal'|'external'|'off';controller:string|null;leaseUntil:number;epoch:number;conversationId?:number;objective:string;summary:string;parallelism:number;qaDefault:boolean;maxReworks:number;budgetUsd:number;dependencies:Record<string,number[]>;jobs:Job[];releases:Release[];decisions:Array<{id:string;cardId:number;value:string;question?:string;label?:string;state:string}>;events:Array<{cursor:number;at:string;type:string;data:unknown}>;nextCursor:number;snapshot?:string;receipts:Record<string,{digest:string;state:string;result?:unknown;error?:string}>};
type Registry={clients:Client[];workspaces:Workspace[]};
export class CoordinatorService{
  private state:Registry;private context:CoordinatorContext|null=null;private url='';private inFlight=new Map<string,Promise<any>>();private polling=false;private closing=false;private internalTokens=new Map<string,{workspaceId:string;actor:string;epoch:number;expires:number;clientId?:string}>();private launcher='';private entry='';
  constructor(private root=app.getPath('userData')){mkdirSync(root,{recursive:true,mode:0o700});this.state=existsSync(this.file())?JSON.parse(readFileSync(this.file(),'utf8')):{clients:[],workspaces:[]};}
  private file(){return join(this.root,'coordinators.json');}
  private save(){writeFileSync(this.file()+'.tmp',JSON.stringify(this.state),{mode:0o600});renameSync(this.file()+'.tmp',this.file());}
  private event(w:Workspace,type:string,data:unknown){w.events.push({cursor:w.nextCursor++,at:new Date().toISOString(),type,data});if(w.events.length>2000)w.events.splice(0,w.events.length-2000);this.save();}
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
  private session(w:Workspace){return {workspaceId:w.id,revision:w.revision,mode:w.mode,controller:w.controller,leaseUntil:w.leaseUntil,objective:w.objective,summary:w.summary,parallelism:w.parallelism,qaDefault:w.qaDefault,budgetUsd:w.budgetUsd,maxReworks:w.maxReworks,conversationId:w.conversationId,onboardedAt:w.onboardedAt,handoff:w.handoff,requests:(w.requests??[]).filter(r=>r.state!=='completed')};}
  ui(){return {workspace:this.context?this.session(this.current()):null,workspaces:this.state.workspaces.map(w=>({id:w.id,name:basename(w.path),open:w.path===this.context?.repoPath})),clients:this.state.clients.map(({tokenHash,...c})=>c),jobs:this.context?this.current().jobs:[],queue:this.context?this.current().queue??[]:[],releases:this.context?this.current().releases:[],decisions:this.context?this.current().decisions:[],guide:COORDINATOR_GUIDE};}
  async uiAction(action:string,args:any={}):Promise<any>{
    const w=this.current();
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
      h.state='completed';this.event(w,'handoff-completed',{id:h.id,from:h.from,to:h.to,usedSavedProgress:!!args.useSavedProgress});
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
      const r=w.releases.find(r=>r.id===args.id&&r.state==='pending');if(!r)throw Error('Release is not awaiting approval');await this.assertRelease(w,r);r.state='approved';this.event(w,'release-approved',{id:r.id,sha:r.sha,target:r.targetBranch});return this.ui();
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
    const prompt=`Help connect this harness to KanBorg as a coordinator. Use a local stdio MCP connection; preserve all unrelated server settings. If you can configure your MCP client with authorized tools, do so; otherwise give concise manual steps. Do not claim the connection works until getCapabilities succeeds. The user approves pairing in KanBorg. Until control is assigned to you, observe only. After handoff, call getWorkspaceSummary and getCoordinationSession, read the handoff summary, inspect active workers and decisions, and continue without duplicating work. Delegate implementation and QA to KanBorg. Maintain a compact summary. While actively coordinating, use waitForChanges with a 20-second timeout and getCoordinatorRequests when notified; acknowledge each request as received before acting, then completed when done. Also check requests on every new user turn and reconnect. If your harness supports a scheduled check-in, offer a 60-second idle cadence; do not claim such a schedule exists unless configured. An idle chat cannot be awakened by this MCP server alone. If handoff is requested, stop dispatching, call completeHandoff with the requested handoffId and a summary, then relinquish control. Never approve your own pairing or release. No provider API keys are needed.\n\nClaude Desktop and generic JSON MCP clients:\n${config}\n\nChatGPT desktop local/Codex-host MCP configuration (config.toml):\n${toml}\n\nDeepSeek Harness MCP client fields:\n${deepSeek}\n\nUse only the format your client supports. Remote-only ChatGPT connector screens cannot use this local command; do not expose a local port publicly to work around that.`;
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
    return {env,extraArgs,cleanup:()=>{this.internalTokens.delete(hash(token));},coordinatorPrompt:COORDINATOR_GUIDE+'\nWorkspace: '+w.id};
  }
  async call(actor:string,scope:string,name:string,raw:unknown):Promise<any>{
    if(this.closing)throw Error('Workspace is closing; reconnect after opening it.');
    const args=validateCoordinatorArgs(name,raw);
    if(name==='getCapabilities')return {version:'1.2.5',guide:COORDINATOR_GUIDE,scope,tools:COORDINATOR_TOOLS.map(t=>t.name),releaseActions:['merge','draft-pr'],hosted:false};
    if(name==='listWorkspaces')return this.state.workspaces.filter(w=>w.id===scope).map(w=>({workspaceId:w.id,name:basename(w.path),open:this.context?.repoPath===w.path}));
    if(args.workspaceId!==scope)throw Error('This connection is not permitted for that workspace');const w=this.resolve(scope);
    if(name==='renewCoordinator'){if(w.controller!==actor||w.mode==='off')throw Error('Control belongs elsewhere');w.leaseUntil=Date.now()+30*60000;this.save();return this.session(w);}
    const isWrite=(COORDINATOR_TOOLS.find(t=>t.name===name)!.inputSchema.required as string[]).includes('requestId');
    if(w.handoff?.state==='completed'&&w.handoff.to===actor&&name==='getWorkspaceSummary'){w.handoff.receivedBy=actor;this.save();}
    if(w.controller===actor&&w.mode!=='off'){w.leaseUntil=Date.now()+30*60000;this.save();}
    if(!isWrite){const result=await this.read(w,name,args);return result;}
    if(w.handoff&&w.handoff.state!=='completed'&&!['updateCoordinationSession','completeHandoff'].includes(name))throw Error('Handoff requested. Stop new work and call completeHandoff with a current summary.');
    this.assertControl(w,actor);
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
      case 'getCoordinatorRequests':return (w.requests??[]).filter(r=>r.state!=='completed');
      case 'getCoordinationSession':return this.session(w);
      case 'getOnboardingBrief':return {prompt:REPO_ONBOARDING_PROMPT,lastReconciledAt:w.onboardedAt??null,inventory:w.inventory??{}};
      case 'getWorkspaceSummary':{const issues=await this.read(w,'listIssues',{});return {session:this.session(w),issues,jobs:w.jobs.slice(-20).map(j=>({...j,run:this.compactRun(j.runId)})),decisions:await h['decisions:pending'](),onboarding:!w.onboardedAt||issues.items.length===0?{needed:true,nextAction:'Call getOnboardingBrief to discover existing work.'}:null,cursor:w.nextCursor-1,releases:w.releases.slice(-10)};}
      case 'listIssues':{const rows=await h['issues:list']({state:'all'});const offset=a.offset??0;return {items:rows.slice(offset,offset+(a.limit??30)).map((i:any)=>({number:i.number,title:i.title,status:i.status,state:i.state,labels:i.labels})),nextOffset:offset+(a.limit??30)<rows.length?offset+(a.limit??30):null};}
      case 'getIssue':{const d=await h['issues:get']({number:a.number});return {issue:d.issue,dependencies:w.dependencies[a.number]??[]};}
      case 'getRunResult':{const r=this.run(a.runId);const events=this.context!.store.events.list(r.id);const text=events.filter(e=>['text','result'].includes(e.type)).map(e=>clip(e.payload,3000)).slice(-3).join('\n');let sha=null;try{sha=await this.revision(r.id);}catch{}return {...this.compactRun(r.id),summary:clip(text,4000),commit:sha,qa:w.jobs.find(j=>j.runId===r.id)??null,checks:await h['agent-runs:checks:list']({runId:r.id}),evidence:{logs:{tool:'readRunLog',runId:r.id},diff:{tool:'getDiffSummary',runId:r.id}},nextAction:active(r.status)?'Wait for changes; answer pending decisions if blocked':'Review outcome and QA evidence; completion is not release approval'};}
      case 'readRunLog':{this.run(a.runId);const rows=this.context!.store.events.list(a.runId).filter(e=>e.seq>(a.offset??-1));const items=rows.slice(0,a.limit??10).map(e=>({seq:e.seq,type:e.type,content:clip(e.payload,2000)}));return {items,nextCursor:items.at(-1)?.seq??a.offset??0,hasMore:rows.length>items.length};}
      case 'getDiffSummary':{const d=await h['agent-runs:diff']({runId:a.runId});if(a.file){const f=d.files.find(f=>f.path===a.file);return {file:a.file,patch:f?.patch.slice(a.offset??0,(a.offset??0)+8000),truncated:(f?.patch.length??0)>(a.offset??0)+8000};}return {files:d.files.map(f=>({path:f.path,status:f.status}))};}
      case 'getChanges':case 'waitForChanges':{const start=Date.now();const wait=name==='waitForChanges'?(a.timeoutMs??20000):0;while(w.nextCursor-1<=(a.cursor??0)&&Date.now()-start<wait)await new Promise(r=>setTimeout(r,250));const events=w.events.filter(e=>e.cursor>(a.cursor??0)).slice(0,50);return {events,cursor:events.at(-1)?.cursor??a.cursor??0,resetRequired:(a.cursor??0)<(w.events[0]?.cursor??0)-1,revision:w.revision};}
      case 'getCapacity':return (await collectCapacity()).snapshot;
      case 'listDecisions':return {pending:await h['decisions:pending'](),proposed:w.decisions.filter(d=>d.state==='pending'),approval:'Confirm proposed answers in KanBorg'};
      case 'getReleaseStatus':return w.releases;
      default:throw Error('Unsupported read');
    }
  }
  private async mutate(w:Workspace,name:string,a:any):Promise<any>{
    const h=this.h();
    switch(name){
      case 'acknowledgeCoordinatorRequest':{const r=w.requests?.find(r=>r.id===a.id);if(!r)throw Error('Request not found.');if(r.state!=='completed'){r.state=a.state;r.receivedBy=w.controller!;}return r;}
      case 'completeHandoff':{const h=w.handoff;if(!h||h.id!==a.handoffId||h.from!==w.controller||h.state==='completed')throw Error('Handoff is no longer current.');h.summary=a.summary;w.summary=a.summary;h.state='ready';return h;}
      case 'prepareExternalCoordinator':{if(w.mode!=='internal')throw Error('Prepare external harness setup from the built-in coordinator.');const client=this.state.clients.find(c=>c.workspaceId===w.id&&c.name===a.name&&c.status!=='revoked');const setup=client?{code:client.code,...this.config(client.id)}:await this.uiAction('add-client',{name:a.name});return {...setup,humanApprovalRequired:true,nextAction:'Show the setup request to the user. They connect their harness, approve pairing in KanBorg, then choose Use coordinator. Do not hand off automatically.'};}
      case 'updateCoordinationSession':if(a.objective!==undefined)w.objective=a.objective;if(a.summary!==undefined)w.summary=a.summary;return this.session(w);
      case 'completeOnboarding':for(const r of w.requests??[])if(r.kind==='discovery')r.state='completed';w.onboardedAt=new Date().toISOString();w.summary=a.summary;return this.session(w);
      case 'upsertWorkItem':{
        w.inventory??={};const prior=w.inventory[a.sourceRef];let number=prior?.number??a.number;
        let body=(a.body??'')+`\n\nSource: ${a.sourceRef}\nKind: ${a.kind}\nStatus evidence: ${a.evidence}\nVerified: ${new Date().toISOString()}`;
        if(number){const existing=(await h['issues:get']({number})).issue;if(prior?.sourceHash&&prior.sourceHash!==hash(JSON.stringify([existing.title,existing.body,existing.labels])))throw Error('This card changed outside reconciliation. Read it and incorporate the human edits before updating.');if(!prior&&existing.body)body=existing.body+'\n\n'+body;await h['issues:patch']({number,patch:{title:a.title,body,labels:withStatusLabel(existing.labels,a.status)}});}
        else{const rows=await h['issues:list']({state:'all'});const linked=rows.find(i=>i.body?.includes(`Source: ${a.sourceRef}\n`));if(linked){number=linked.number;await h['issues:patch']({number,patch:{title:a.title,body,labels:withStatusLabel(linked.labels,a.status)}});}else{const created=await h['issues:create']({title:a.title,body,labels:withStatusLabel([],a.status)});number=created.number;}}
        const updated=(await h['issues:get']({number:number!})).issue;w.inventory[a.sourceRef]={number:number!,kind:a.kind,evidence:a.evidence,verifiedAt:new Date().toISOString(),sourceHash:hash(JSON.stringify([updated.title,updated.body,updated.labels]))};return w.inventory[a.sourceRef];
      }
      case 'createIssue':return h['issues:create']({title:a.title,...(a.body?{body:a.body}:{})});
      case 'updateIssue':{const existing=a.status?(await h['issues:get']({number:a.number})).issue:null;const updated=await h['issues:patch']({number:a.number,patch:{...(a.title!==undefined?{title:a.title}:{}),...(a.body!==undefined?{body:a.body}:{}),...(a.status?{labels:withStatusLabel(existing!.labels,a.status)}:{})}});for(const item of Object.values(w.inventory??{}))if(item.number===a.number)delete item.sourceHash;return updated;}
      case 'addComment':return h['issues:add-comment']({number:a.number,body:a.body});
      case 'setDependencies':{await h['issues:get']({number:a.number});for(const id of a.dependsOn)await h['issues:get']({number:id});const graph:Record<string,number[]>={...w.dependencies,[a.number]:a.dependsOn};const walk=(id:number,path:number[]):void=>{if(path.includes(id))throw Error('Dependency cycle');for(const next of graph[id]??[])walk(next,[...path,id]);};walk(a.number,[]);w.dependencies=graph;return graph[a.number];}
      case 'dispatchTask':return this.dispatch(w,a.number,a.budgetUsd??w.budgetUsd,a.qa??w.qaDefault,a.maxReworks??w.maxReworks,a.readOnly===true);
      case 'followUpRun':{if(active(this.run(a.runId).status)&&this.run(a.runId).status!=='awaiting_input')throw Error('Wait for this worker or stop it before following up.');const j=w.jobs.find(j=>j.runId===a.runId);if(!j)throw Error('Run is not a delegated implementation');j.state='implementing';delete j.sha;delete j.checkIds;delete j.reviewRunId;this.save();return this.context!.supervisor.resume({runId:a.runId,prompt:a.message+'\nCommit the completed implementation locally; do not merge or push.',costBudgetUsd:j.budgetUsd});}
      case 'stopRun':{const j=w.jobs.find(j=>j.runId===a.runId||j.reviewRunId===a.runId);if(j)j.state='paused';return h['agent-runs:stop']({runId:a.runId});}
      case 'answerDecision':{const pending=await h['decisions:pending']();if(!pending.some(d=>d.cardId===a.cardId&&d.options.some(o=>o.value===a.value)))throw Error('Pending decision/option not found');const original=pending.find(d=>d.cardId===a.cardId)!;const d={id:randomUUID(),cardId:a.cardId,value:a.value,question:original.question,label:original.options.find(o=>o.value===a.value)!.label,state:'pending'};w.decisions.push(d);return {...d,nextAction:'Human confirms in KanBorg Coordinators'};}
      case 'runQA':{let j=w.jobs.find(j=>j.runId===a.runId);if(!j){const r=this.run(a.runId);const t=this.context!.store.threads.findById(r.threadId);if(!t)throw Error('Task not found');j={runId:r.id,number:t.issueNumber,role:'implementation',qa:true,maxReworks:0,reworks:0,budgetUsd:a.budgetUsd??w.budgetUsd,state:'implementing'};w.jobs.push(j);}j.qa=true;await this.startQA(w,j);return j;}
      case 'prepareRelease':{const sha=await this.revision(a.runId);const job=w.jobs.find(j=>j.runId===a.runId&&j.state==='qa-passed'&&j.sha===sha);if(!job)throw Error('Run QA on this exact committed revision before preparing a release.');if(!/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(a.targetBranch)||a.targetBranch.includes('..'))throw Error('Invalid target branch');const targetSha=await this.git(w.path,['rev-parse',`refs/heads/${a.targetBranch}`]);const r:Release={id:randomUUID(),runId:a.runId,sha,targetBranch:a.targetBranch,targetSha,action:a.action,state:'pending',...(a.title?{title:a.title}:{}),...(a.body?{body:a.body}:{})};w.releases.push(r);return {...r,nextAction:'Human reviews and approves this exact release in KanBorg'};}
      case 'executeRelease':return this.executeRelease(w,String(a.releaseId));
      default:throw Error('Unsupported action');
    }
  }
  private async dispatch(w:Workspace,number:number,budgetUsd:number,qa:boolean,maxReworks:number,readOnly=false,fromQueue=false){
    if(w.jobs.some(j=>j.number===number&&['implementing','checks','reviewing'].includes(j.state)))throw Error('This task already has an active pipeline.');
    const running=w.jobs.filter(j=>active(this.run(j.runId).status)||(j.reviewRunId&&active(this.run(j.reviewRunId).status))).length;const waiting=running>=w.parallelism||(w.dependencies[number]??[]).some(id=>!w.jobs.some(j=>j.number===id&&j.state==='qa-passed'));
    if(waiting&&!fromQueue){w.queue??=[];let queued=w.queue.find(q=>q.number===number);if(!queued){queued={id:randomUUID(),number,budgetUsd,qa,maxReworks,readOnly};w.queue.push(queued);this.event(w,'task-queued',queued);}return {queueId:queued.id,number,status:'queued',nextAction:'Waiting for worker capacity or prerequisite QA'};}
    if(waiting)throw Error('Task is still waiting for prerequisites or worker capacity');
    const issue=(await this.h()['issues:get']({number})).issue;const thread=this.context!.store.threads.getOrCreate({repoOwner:(await this.h()['config:get']()).owner,repoName:(await this.h()['config:get']()).repo,issueNumber:number});
    const run=await this.context!.supervisor.start({threadId:thread.id,issueNumber:number,prompt:readOnly?`Read-only discovery task. Do not modify source files, commit, merge, push or deploy. Return concise evidence and an inventory that the coordinator can use.\n${issue.title}\n${issue.body??''}`:`Implement this task, observing repository instructions and acceptance criteria. Do not expand scope. Commit the completed implementation locally in your worktree; do not merge, push or deploy.\n\n${issue.title}\n${issue.body??''}`,costBudgetUsd:budgetUsd,provider:'claude-code',personaId:'implementation'});
    const j:Job={runId:run.id,number,role:readOnly?'discovery':'implementation',qa:readOnly?false:qa,maxReworks,reworks:0,budgetUsd,state:'implementing'};w.jobs.push(j);this.save();return {runId:run.id,number,status:run.status,qa,nextAction:'Use waitForChanges'};
  }
  private async startQA(w:Workspace,j:Job){j.sha=await this.revision(j.runId);const checks=await this.h()['agent-runs:checks:run']({runId:j.runId});j.checkIds=checks.map(c=>c.id);j.state='checks';delete j.error;this.event(w,'qa-started',{runId:j.runId,sha:j.sha});}
  private async repair(w:Workspace,j:Job,reason:string){
    if(j.reworks>=j.maxReworks){j.state='needs-changes';j.error=reason;this.event(w,'needs-changes',{runId:j.runId,reason});return;}
    j.reworks++;j.state='implementing';delete j.reviewRunId;delete j.sha;this.save();await this.context!.supervisor.resume({runId:j.runId,prompt:`QA found problems. Fix only these, rerun relevant checks, and commit locally. Do not merge or push.\n${reason}`,costBudgetUsd:j.budgetUsd});this.event(w,'rework-started',{runId:j.runId,attempt:j.reworks});
  }
  async tick(){if(this.polling||this.closing||this.inFlight.size||!this.context)return;this.polling=true;try{const w=this.current();
    if(w.mode==='internal'&&w.conversationId&&(!w.handoff||w.handoff.state==='completed')){const pending=w.requests?.find(r=>r.state==='queued');if(pending){const chat=await this.h()['chat:get']({conversationId:w.conversationId});if(!chat.activeRun){pending.state='received';pending.receivedBy=w.controller!;this.save();try{const result=await this.uiAction('chat-send',{body:pending.prompt});if(result?.dispatchError)throw Error(result.dispatchError);this.event(w,'coordinator-request-received',{id:pending.id});}catch(e){this.event(w,'coordinator-request-blocked',{id:pending.id,error:clip(e instanceof Error?e.message:'Could not start request')});}}}}
    for(const q of [...(w.handoff&&w.handoff.state!=='completed'?[]:w.queue??[])]){
      const slots=w.jobs.filter(j=>active(this.run(j.runId).status)||(j.reviewRunId&&active(this.run(j.reviewRunId).status))).length;
      if(slots>=w.parallelism)break;
      if((w.dependencies[q.number]??[]).some(id=>!w.jobs.some(j=>j.number===id&&j.state==='qa-passed')))continue;
      // Persist intent before dispatch; uncertain failures are surfaced, not replayed.
      w.queue=w.queue!.filter(x=>x.id!==q.id);this.save();try{await this.dispatch(w,q.number,q.budgetUsd,q.qa,q.maxReworks,q.readOnly,true);}catch(e){this.event(w,'queued-task-blocked',{number:q.number,error:clip(e instanceof Error?e.message:'Dispatch failed')});}
    }
    const state=w.jobs.map(j=>({run:this.compactRun(j.runId),review:j.reviewRunId?this.compactRun(j.reviewRunId):null}));const snap=JSON.stringify(state);if(w.snapshot!==snap){w.snapshot=snap;this.event(w,'runs-changed',state);}
    for(const j of w.jobs){try{
      if(j.state==='implementing'){const r=this.run(j.runId);if(active(r.status))continue;if(r.status!=='complete'){j.state='blocked';j.error=r.exitReason??r.status;this.event(w,'blocked',{runId:r.id,reason:j.error});continue;}if(!j.qa){j.state='completed';this.event(w,'implementation-completed',{runId:r.id});continue;}await this.startQA(w,j);}
      if(j.state==='checks'){
        const checks=(await this.h()['agent-runs:checks:list']({runId:j.runId})).filter(c=>j.checkIds?.includes(c.id));if(!checks.length||checks.some(c=>!['pass','fail'].includes(c.status)))continue;
        if(await this.revision(j.runId)!==j.sha)throw Error('Implementation changed during QA. Run QA again.');
        if(checks.some(c=>c.status==='fail')){await this.repair(w,j,checks.filter(c=>c.status==='fail').map(c=>clip(c.summary)).join('\n'));continue;}
        const original=this.run(j.runId);const issue=(await this.h()['issues:get']({number:j.number})).issue;
        const reviewer=await this.context!.supervisor.start({threadId:original.threadId,issueNumber:j.number,baseRef:j.sha!,provider:'claude-code',costBudgetUsd:j.budgetUsd,personaId:'reviewer',prompt:`Independently review this committed implementation against the task. Do not edit files, commit, merge or push. Inspect the actual diff against the project target and identify defects or unmet criteria. Your final answer MUST end with exactly KANBOTS_QA_PASS or KANBOTS_QA_FAIL. Include concise evidence.\nImplementation commit: ${j.sha}\nTask: ${issue.title}\n${issue.body??''}`});j.reviewRunId=reviewer.id;j.state='reviewing';this.event(w,'review-started',{runId:j.runId,reviewRunId:reviewer.id});
      }
      if(j.state==='reviewing'&&j.reviewRunId){const r=this.run(j.reviewRunId);if(active(r.status))continue;
        const events=this.context!.store.events.list(r.id);const texts=events.filter(e=>e.type==='text').map(e=>{const p=e.payload as any;return p.text??p.result??'';}).join('\n');
        if(r.status==='complete'&&/KANBOTS_QA_PASS\s*$/.test(texts)&&await this.revision(r.id)===j.sha&&await this.revision(j.runId)===j.sha){j.state='qa-passed';this.event(w,'qa-passed',{runId:j.runId,sha:j.sha,reviewRunId:r.id});}else await this.repair(w,j,clip(texts||r.exitReason||'Review did not pass',6000));
      }
    }catch(e){j.state='blocked';j.error=clip(e instanceof Error?e.message:'Pipeline blocked',1000);this.event(w,'blocked',{runId:j.runId,reason:j.error});}}
  }finally{this.polling=false;}}
  private async assertRelease(w:Workspace,r:Release){if(await this.revision(r.runId)!==r.sha)throw Error('Release revision changed. Prepare a new release.');if(await this.git(w.path,['rev-parse',`refs/heads/${r.targetBranch}`])!==r.targetSha)throw Error('Target branch changed. Prepare a new release.');if(!w.jobs.some(j=>j.runId===r.runId&&j.sha===r.sha&&j.state==='qa-passed'))throw Error('QA evidence is no longer current.');}
  private async executeRelease(w:Workspace,id:string){const r=w.releases.find(r=>r.id===id);if(!r)throw Error('Release not found');if(r.state==='completed')return r;if(r.state!=='approved')throw Error('Approve this release in KanBorg before executing.');await this.assertRelease(w,r);r.state='executing';this.save();
    try{const run=this.run(r.runId);if(r.action==='merge'){
      const listing=await this.git(w.path,['worktree','list','--porcelain']);const target=listing.split('\n\n').find(block=>block.split('\n').includes(`branch refs/heads/${r.targetBranch}`))?.split('\n').find(line=>line.startsWith('worktree '))?.slice(9);if(!target)throw Error('Target must be checked out in a worktree.');if(await this.git(target,['status','--porcelain']))throw Error('Target worktree has uncommitted changes.');
      try{await this.git(target,['merge','--no-ff','--no-edit',r.sha]);}catch(e){await this.git(target,['merge','--abort']).catch(()=>{});throw e;}r.result={merged:true,commit:await this.git(target,['rev-parse','HEAD']),target:r.targetBranch};
    }else{
      const source=this.context!.source;
      if(!source.openDraftPR)throw Error('Draft PR requires a GitHub-backed workspace.');
      const branch=`kanbots-release/${r.id}`;
      await this.git(w.path,['push','origin',`${r.sha}:refs/heads/${branch}`]);
      r.result=await source.openDraftPR({head:branch,base:r.targetBranch,title:r.title??`Implementation ${r.sha.slice(0,8)}`,body:r.body??'Implementation and QA completed in KanBorg.',draft:true});
    }r.state='completed';this.event(w,'release-completed',{id:r.id,result:r.result});return r;}catch(e){r.state='failed';r.result={error:clip(e instanceof Error?e.message:'Release failed',1000)};this.event(w,'release-failed',{id:r.id,result:r.result});throw e;}
  }
}
