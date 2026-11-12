import { recordPerformanceTiming } from './performance-diagnostics.js';
import { questionCommands, questionExplanation, fencedQuestionCommands, type QuestionCommand } from './question-presentation.js';
import { reorderWorkflowCard, prioritizeWorkflowQueue } from './workflow.js';
import {getProviderHandlers} from './providers-ipc.js';
import {routingState,saveRouting} from './routing-state.js';
import {invalidateCapacity} from './routing-capacity.js';
import {newPersonaLibrary, editPersonaLibrary, type PersonaLibrary} from './persona-library.js';
import {enqueueWake, deliverWake, reconcileAuthority, acknowledgeWake, type Outbound, type Wake, type HostAdapter} from './coordinator-outbound.js';
import {createCheckpoint, resumeWithCheckpoint, requestCheckpoint, readCheckpoint, stageDispositionPrompt, readStageDisposition} from './worker-checkpoint.js';
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
import { APP_CONTROLS, APP_CONTROL_EQUIVALENTS,COORDINATOR_TOOLS,COORDINATOR_GUIDE,COORDINATOR_REMINDER,REPO_ONBOARDING_PROMPT,validateCoordinatorArgs } from '@kanborg/mcp';
import { collectCapacity } from './routing-capacity.js';
const exec=promisify(execFile);
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
const pauseCheckins='Pause recurring check-ins for this KanBorg connection in your harness; leave unrelated schedules unchanged. Do not resume unless the user assigns control back. If unable, tell the user the exact schedule to pause.';
export const blocksUpdate=(run:{status:string;pid?:number|null})=>['starting','running'].includes(run.status)||(run.status==='awaiting_input'&&run.pid!=null);
const active=(s:string)=>['starting','running','awaiting_input'].includes(s);
const redact=(s:string)=>s.replace(/\bsk-[A-Za-z0-9_-]{12,}/g,'[redacted]').replace(/Bearer\s+[A-Za-z0-9._-]+/gi,'Bearer [redacted]');
const clip=(v:unknown,n=4000)=>redact(typeof v==='string'?v:JSON.stringify(v)??'').slice(0,n);
export type CoordinatorContext={repoPath:string;source:IssueSource;handlers:Handlers;store:Store;supervisor:AgentSupervisor};
type Client={id:string;name:string;workspaceId:string;role:'observer'|'coordinator';tokenHash:string;status:'pending'|'approved'|'revoked';code:string;lastSeen?:string};
export const INDEPENDENT_REVIEW_AUTHORITY = 'Owner-authorized KanBorg review policy: a separate reviewer agent run is the independent second opinion. The reviewer may use the same harness, provider, model or GitHub account as the implementation worker; do not require a different harness. The assigned reviewer is authorized to review and merge PRs from any KanBorg or coordinator worker, including coordinator-authored PRs, without another coordinator relay or owner approval. Review the exact current head, record reviewer run identity and evidence, and merge only after required checks and applicable release gates pass. Recheck the head immediately before merging; changed code needs a review of the new head. Never approve your own implementation. Serialize shared release operations and preserve explicit task-specific holds unrelated to harness identity. A merge is not deployment or production acceptance; record those separately.';
function workerDeliveryInstructions(readOnly: boolean, independentReviewer=false): string {
  if (readOnly) {
    return 'Read-only assignment. Inspect and report evidence only. Do not modify source files, commit, push, merge or deploy. This restriction applies to this inspection phase. The active coordinator may advance the saved assignment to implementation or testing within the owner-authorized objective without requesting another owner approval.';
  }
  if(independentReviewer)return INDEPENDENT_REVIEW_AUTHORITY+' Do not modify product code during review. Return defects for implementation; an authored correction requires another reviewer. Use the existing release lane and record the merge receipt or specific blocker.';
  return 'Work within the assigned task and repository instructions. Commit completed implementation in your own worktree. When the owner or active coordinator explicitly authorizes publication, push only your own assigned branch and create or update its pull request, then report the exact commit and checks. Preserve explicit task-specific read-only, no-push and publication holds until an authorized instruction explicitly supersedes them. Do not self-merge your implementation. Merging belongs to the separately assigned release manager or independent reviewer under the owner-authorized review policy. Deployment remains subject to its own gates and authority.';
}

function runNextAction(status: string): string {
  if (status === 'awaiting_input') return 'Worker is awaiting input; inspect and answer its pending question.';
  if (status === 'starting') return 'Worker is starting; observe startup progress.';
  if (status === 'running') return 'Worker is running; follow progress or send authorized steering.';
  if (status === 'complete') return 'Review outcome and QA evidence; completion is not release approval.';
  return 'Inspect the stopped or failed run and saved evidence before deciding how to recover.';
}

type AssignmentChange={at:string;actor:string;requestId:string;from:{role:string;readOnly:boolean};to:{role:'discovery'|'implementation';readOnly:boolean};reason:string;evidence:string};
type StageAssignment={baseRevision?:string;workflowVersion?:number;stageId:string;entry:string;personaId:string;personaVersion:number;prompt:string};
type Job={ciReview?:{head:string;url:string;checkedAt:string;checks:unknown[]};ciCheckedAt?:number;stageAssignment?:StageAssignment;assignmentHistory?:AssignmentChange[];workflowStartPending?:string;readOnly?:boolean;phaseContextPending?:boolean;phaseCheckpoint?:unknown;manualQA?:boolean;controlId?:string;reviewControlId?:string;checkpoint?:unknown;reviewCheckpoint?:unknown;autopilot?:boolean;runId:number;number:number;role:string;qa:boolean;maxReworks:number;reworks:number;budgetUsd:number;state:string;sha?:string;reviewRunId?:number;checkIds?:number[];error?:string};
type Release={validationPriorState?:string;id:string;runId:number;sha:string;targetBranch:string;targetSha:string;action:'merge'|'draft-pr';title?:string;body?:string;state:string;result?:unknown};
type Handoff={delivery?:'waiting'|'sending'|'sent'|'failed';deliveryError?:string;deliveryRunId?:number;id:string;from:string|null;to:string;mode:'internal'|'external';state:'requested'|'ready'|'completed';requestedAt:string;summary:string;checkpoint:unknown;receivedBy?:string};
type CoordinatorRequest={id:string;kind:'discovery'|'resume-workflows'|'workflow-change'|'workflow-action'|'autopilot';prompt:string;state:'queued'|'received'|'completed';createdAt:string;receivedBy?:string;error?:string};
type ScheduleReceipt={id?:string;status:'active'|'paused'|'unsupported';cadenceMinutes?:number;cursor?:number;confirmedAt:string};
type ChatDraft={id:string;body:string;steer:boolean;state:'queued'|'sending'|'sent'|'failed';createdAt:string;error?:string};
type UserQuestion={response?:string;answeredAt?:string;commands?:QuestionCommand[];id:number;runId:number;threadId:number;question:string;options:Array<{value:string;label:string}>;state:string;reply?:string;responseRunId?:number;explanationAfter?:number;explanation?:string;explanationRequestId?:string;answerRequestId?:string;closedReason?:string};
type Workspace={releaseParallelism?:number;laneBlockers?:Array<{number?:number;reason:string}>;stageAssignments?:Record<string,{number:number;stageId:string;entry:string;state:string;runId?:number;error?:string}>;dispatchReservations?:Record<string,{lane?:'implementation'|'release';autopilot?:boolean;id:string;at:string;state:string;error?:string;threadId?:number;priorRunIds?:number[];job?:Omit<Job,'runId'>}>;replenishment?:{requestId:string;epoch:number;lastAttemptAt:number};sharedChats?:number[];ownerActions?:Array<{entry?:{name:string;consumer:string;previousIds:string[]};id:string;action:string;target:string;reason:string;epoch:number;state:string;result?:unknown;error?:string}>;uiPreferences?:{version:number;value:Record<string,any>};personas?:PersonaLibrary;outbound?:Outbound;questions?:UserQuestion[];chatOutbox?:ChatDraft[];updateDrain?:{priorStatus:string;at:string;requestId?:string};expediting?:boolean;autopilot?:{status:string;personas:Array<{id:string;name:string;prompt:string}>;effort:string;parallelism:number;objective:string;updatedAt:string;legacyWork:unknown[]};workflow?:WorkflowState;workflowSignals?:Record<string,string>;schedules?:Record<string,ScheduleReceipt>;requests?:CoordinatorRequest[];handoff?:Handoff;queue?:Array<{autopilot?:boolean;id:string;number:number;budgetUsd:number;qa:boolean;maxReworks:number;readOnly:boolean}>;onboardedAt?:string;inventory?:Record<string,{number:number;kind:string;evidence:string;verifiedAt:string;sourceHash?:string}>;id:string;path:string;revision:number;mode:'internal'|'external'|'off';controller:string|null;leaseUntil:number;epoch:number;conversationId?:number;objective:string;summary:string;parallelism:number;qaDefault:boolean;maxReworks:number;budgetUsd:number;dependencies:Record<string,number[]>;jobs:Job[];releases:Release[];decisions:Array<{id:string;cardId:number;value:string;question?:string;label?:string;state:string}>;events:Array<{cursor:number;at:string;type:string;data:unknown}>;nextCursor:number;snapshot?:string;receipts:Record<string,{digest:string;state:string;result?:unknown;resultFile?:string;error?:string}>};
type Registry={templates?:Record<string,{id:string;name:string;version:number;config:WorkflowConfig;updatedAt:string;actor:string}>;clients:Client[];workspaces:Workspace[]};
export class CoordinatorService{
  private appRuntime?: (action:string,args:Record<string,any>,path:string)=>Promise<any>;
  setAppRuntime(fn:(action:string,args:Record<string,any>,path:string)=>Promise<any>){this.appRuntime=fn;}
  private workflowNotifier?:()=>void;
  setWorkflowNotifier(fn:()=>void){this.workflowNotifier=fn;}
  private updater?:{status:()=>any;check:()=>Promise<any>;request:(args:any,repoPath:string)=>Promise<any>;pending:()=>boolean};
  beginUpdateWindDown(){
    // Persist the pause and notice for every saved workspace before attempting delivery.
    for(const w of this.state.workspaces){if(w.updateDrain)continue;
      const id=`update-wind-down:${randomUUID()}`;
      w.updateDrain={priorStatus:w.autopilot?.status??'off',at:new Date().toISOString(),requestId:id};
      if(w.autopilot)w.autopilot.status='paused';
      if(w.mode!=='off'){
        w.requests??=[];w.requests.push({id,kind:'workflow-action',state:'queued',createdAt:new Date().toISOString(),prompt:'KanBorg is preparing an application update. Stop discovery, new assignments and replacement work across this workspace. Let existing workers finish their bounded step; preserve checkpoints, pending questions and exact review/release evidence. Do not answer owner decisions merely to unblock restart. Acknowledge this notice, save a compact coordination summary, and wait for the post-update resume request. Keep your existing check-in mechanism; do not create another schedule.'});
      }
      w.revision++;this.event(w,'update-wind-down',{});
      if(w.mode!=='off')this.event(w,'coordinator-request',{requestId:id,kind:'workflow-action'});
    }
  }
  endUpdateWindDown(){for(const w of this.state.workspaces){if(!w.updateDrain)continue;
    if(w.autopilot)w.autopilot.status=w.updateDrain.priorStatus;
    const request=w.requests?.find(r=>r.id===w.updateDrain?.requestId);
    // Supersede an obsolete pause instruction so it cannot arrive after recovery.
    if(request)request.state='completed';
    delete w.updateDrain;w.revision++;this.event(w,'update-wind-down-ended',{});
  }}
  updateCoordination(){return this.state.workspaces.filter(w=>w.updateDrain).map(w=>({workspaceId:w.id,name:basename(w.path),coordinator:this.state.clients.find(c=>c.id===w.controller)?.name??(w.mode==='internal'?'KanBorg chat':'Paused'),notification:w.mode==='off'?'not-needed':w.requests?.find(r=>r.id===w.updateDrain?.requestId)?.state??'queued',open:w.path===this.context?.repoPath}));}
  private reconcileUpdateWindDown(){if(this.updater&&!this.updater.pending()&&['cancelled','failed','completed'].includes(this.updater.status()?.update?.phase))this.endUpdateWindDown();}
  async updateWorkersReady(){if(!this.context)return false;const w=this.current();this.session(w);this.save();for(const j of w.jobs){if(blocksUpdate(this.run(j.runId))||(j.reviewRunId&&blocksUpdate(this.run(j.reviewRunId))))return false;if(j.state==='checks'){const checks=await this.h()['agent-runs:checks:list']({runId:j.runId});if(checks.some(c=>j.checkIds?.includes(c.id)&&!['pass','fail'].includes(c.status)))return false;}}return true;}
  async expediteUpdate(){
    for(const w of this.state.workspaces){if(!w.updateDrain)continue;
      for(const j of w.jobs)for(const id of [j.controlId,j.reviewControlId])if(id)requestCheckpoint(this.root,id);
      this.event(w,'update-checkpoint-requested',{instruction:'Finish the current bounded step and save a checkpoint. Preserve unfinished validation.'});
    }
  }
  updateIdle(){return !this.polling&&!this.inFlight.size;}
  allowRequests(){this.closing=false;}
  setUpdater(updater:NonNullable<CoordinatorService['updater']>){this.updater=updater;}
  async resumeAfterUpdate(version:string,updateId=version){
    this.closing=false;this.endUpdateWindDown();
    let resumed:CoordinatorRequest|undefined;
    for(const w of this.state.workspaces){
    // One durable kick per update. A restart between saving it and advancing the
    // pipelines must not create a second coordinator turn or duplicate workers.
    const id=`update-resume:${updateId}`;w.requests??=[];
    if(w.mode==='off'){if(!w.events.some(e=>e.type==='application-updated'&&(e.data as any)?.requestId===id))this.event(w,'application-updated',{version,requestId:id,instruction:'Coordination remains paused.'});continue;}
    let request=w.requests.find(r=>r.id===id);
    if(!request){
      request={id,kind:'resume-workflows',state:'queued',createdAt:new Date().toISOString(),prompt:`KanBorg ${version} has restarted after an update. Resume the current owner-authorized objective now, not just a status report. Read current coordination state, pending decisions and compact worker results. Preserve running assignments and completed evidence. Advance ready dependencies and dispatch the next authorized implementation or QA through KanBorg. Read saved worker checkpoints and remaining validation. Resume checkpointed existing runs through followUpRun only when Autopilot is On or the owner explicitly authorizes manual continuation; never redispatch the same task. Resume interrupted work from its compact handoff; investigate failed work before deciding how to continue. Do not repeat completed tests, restart intentionally paused work, answer owner-reserved decisions, or approve a release merely because the app restarted. Acknowledge this request as received before acting and completed after the eligible work is running or its real blocker is recorded. If no work remains, record that explicitly.`};
      w.requests.push(request);w.revision++;
      this.event(w,'application-updated',{version,requestId:id,instruction:'Read getCoordinatorRequests and resume the current authorized objective.'});
      this.event(w,'coordinator-request',{requestId:id,kind:request.kind});
    }
    // Advance existing pipelines and queued assignments immediately. External
    // coordinators pick up the durable request on their next connection/check-in.
    resumed=request;
    }
    await this.tick();return resumed??{queued:false,reason:'Coordination is paused'};
  }

  // Reconcile every tick, using persisted request identity and retry time so
  // restarts and acknowledgements cannot quietly disable an active target.
  private releaseStage(w:Workspace,stageId?:string){return !!stageId&&w.workflow?.config.stages.find(s=>s.id===stageId)?.actor==='reviewer';}
  private laneUsage(w:Workspace){
    const implementation=new Set<number>(),release=new Set<number>();
    const occupying=(id:number)=>blocksUpdate(this.run(id));
    for(const job of w.jobs){if(occupying(job.runId))(this.releaseStage(w,job.stageAssignment?.stageId)?release:implementation).add(job.runId);if(job.reviewRunId&&occupying(job.reviewRunId))release.add(job.reviewRunId);}
    // Owner-started card workers share execution capacity even before adoption
    // into coordinator jobs. Device/coordinator chats are not task lanes.
    const liveTasks=this.context?.store.agentRuns.listActive?.()??[];
    for(const run of liveTasks){if(run.issueNumber>0&&blocksUpdate(run)&&!release.has(run.id))implementation.add(run.id);}
    const reservations=Object.values(w.dispatchReservations??{});
    return {implementation:implementation.size+reservations.filter(r=>r.lane!=='release').length,release:release.size+reservations.filter(r=>r.lane==='release').length};
  }
  private autopilotCapacity(w:Workspace){
    const lanes=this.laneUsage(w),target=w.autopilot?.parallelism??w.parallelism,releaseTarget=w.releaseParallelism??4;
    const suspended=w.autopilot?.status!=='active'||w.mode==='off'||!!w.updateDrain||!!this.updater?.pending()||!!(w.handoff&&w.handoff.state!=='completed');
    const missing=Math.max(0,target-lanes.implementation);
    return {active:lanes.implementation,target,missing,suspended,release:{active:lanes.release,target:releaseTarget,available:Math.max(0,releaseTarget-lanes.release)},blockers:w.laneBlockers??[],
      message:suspended?'Replenishment paused':!missing?'Implementation target maintained':w.laneBlockers?.length?`${missing} implementation lanes open: ${w.laneBlockers[0]!.reason}`:`Filling ${missing} implementation lanes from authorized Ready work`};
  }
  private async refillReadyWork(w:Workspace){
    if(this.autopilotCapacity(w).suspended)return;
    w.laneBlockers=[];
    if(!this.autopilotCapacity(w).missing)return;
    const issues=await this.h()['issues:list']({});w.workflow??=newWorkflow();materialize(w.workflow,issues);
    const ready=issues.filter(issue=>w.workflow!.config.stages.find(s=>s.id===w.workflow!.cards[issue.number]?.stageId)?.category==='todo');
    const ordered=prioritizeWorkflowQueue(ready.map(issue=>({number:issue.number})),w.workflow);
    for(const candidate of ordered){
      if(this.autopilotCapacity(w).suspended||!this.autopilotCapacity(w).missing)break;
      const card=w.workflow.cards[candidate.number],stage=w.workflow.config.stages.find(s=>s.id===card?.stageId);
      let blocker=card?.waiting?`Waiting for ${card.waiting.owner}: ${card.waiting.trigger}`:undefined;
      if(stage?.actor==='user'||stage?.actor==='reviewer')blocker='Ready stage is reserved for a different actor';
      const unmet=(w.dependencies[candidate.number]??[]).filter(number=>w.workflow!.config.stages.find(s=>s.id===w.workflow!.cards[number]?.stageId)?.category!=='done');
      if(unmet.length)blocker='Dependencies are not complete: '+unmet.map(n=>'#'+n).join(', ');
      const prior=[...w.jobs].reverse().find(j=>j.number===candidate.number);
      const attached=issues.find(i=>i.number===candidate.number)?.activeRun;
      if(w.dispatchReservations?.[candidate.number]||w.queue?.some(q=>q.number===candidate.number))continue;
      if(attached&&active(attached.status)||prior&&(active(this.run(prior.runId).status)||prior.reviewRunId&&active(this.run(prior.reviewRunId).status)||!['completed','qa-passed','review-delegated'].includes(prior.state)))blocker='Existing assignment '+(prior?.runId??attached?.id)+' needs continuation or reconciliation; no duplicate worker will be created';
      if(blocker){w.laneBlockers.push({number:candidate.number,reason:blocker});continue;}
      try{const result=await this.dispatch(w,candidate.number,w.budgetUsd,w.qaDefault,w.maxReworks,false,true,true);this.event(w,'autopilot-lane-filled',{number:candidate.number,runId:result.runId,trigger:'authorized-ready-work',lane:'implementation'});}
      catch(error){const reason=clip(error instanceof Error?error.message:'Dispatch failed');w.laneBlockers.push({number:candidate.number,reason});card!.nextAction=reason;}
    }
    if(this.autopilotCapacity(w).missing&&!w.laneBlockers.length)w.laneBlockers.push({reason:'No unassigned authorized Ready work; coordinator must reconcile existing checkpoints or discover useful work'});
    this.save();
  }
  private maintainAutopilot(w:Workspace){
    const capacity=this.autopilotCapacity(w);
    const previous=w.replenishment;
    const pending=previous&&w.requests?.find(r=>r.id===previous.requestId);
    if(capacity.suspended||!capacity.missing||previous&&previous.epoch!==w.epoch){
      if(pending&&pending.state!=='completed'){pending.state='completed';w.revision++;this.event(w,'autopilot-capacity-settled',capacity);}
      if(previous){delete w.replenishment;this.save();}
      if(capacity.suspended||!capacity.missing)return;
    }
    // Do not flood a busy or offline harness. One durable request is retried
    // after two minutes; completing it without filling slots does not stop us.
    const tracking=w.replenishment;
    if(!tracking&&w.requests?.some(r=>r.kind==='autopilot'&&r.state!=='completed'&&Date.now()-Date.parse(r.createdAt)<120_000))return;
    if(tracking&&Date.now()-tracking.lastAttemptAt<120_000)return;
    const prompt=`Autopilot target: ${capacity.target} active workers; currently ${capacity.active}, ${capacity.missing} slots open. Maintain the configured target now. Reconcile active work and checkpoints, resume eligible existing assignments, then assign distinct authorized ready work using saved perspectives and automatic routing. Queue additional approved assignments so KanBorg can refill immediately when workers finish. Do not duplicate tasks, invent busywork, or exceed the target. If dependencies, capacity, or owner decisions prevent filling slots, record the concrete blocker and next action in the coordination summary. Recheck current control and Autopilot status before dispatch; Off, handoff and update wind-down suspend replenishment. Acknowledge this request received, then completed after assignments are running or blockers are recorded.`;
    const request=tracking&&w.requests?.find(r=>r.id===tracking.requestId);
    // Each attempt gets a fresh identity: late or replayed acknowledgements for
    // an earlier attempt must never consume the current replenishment request.
    if(request)request.state='completed';
    const id=`autopilot-capacity:${w.epoch}:${randomUUID()}`;
    w.requests??=[];w.requests.push({id,kind:'autopilot',state:'queued',createdAt:new Date().toISOString(),prompt});
    w.replenishment={requestId:id,epoch:w.epoch,lastAttemptAt:Date.now()};w.revision++;
    this.event(w,'coordinator-request',{requestId:id,kind:'autopilot',capacity});
  }

  private restoredAutopilot = new Set<string>();
  resumeAutopilotAfterLaunch(){
    const w=this.current();
    if(this.restoredAutopilot.has(w.id)||this.updater?.pending()||w.updateDrain)return;
    this.restoredAutopilot.add(w.id);
    if(w.autopilot?.status!=='active'||w.mode==='off'||(w.handoff&&w.handoff.state!=='completed'))return;
    // Existing queued instructions already provide the kick. Never restart workers
    // directly: the assigned coordinator reconciles their saved identities first.
    if(w.requests?.some(r=>r.state==='queued'&&['autopilot','resume-workflows'].includes(r.kind)))return;
    const request:CoordinatorRequest={id:`launch-resume:${randomUUID()}`,kind:'resume-workflows',state:'queued',createdAt:new Date().toISOString(),prompt:'KanBorg has reopened with Autopilot On. Read the saved Autopilot settings, objective, active assignments, checkpoints and pending decisions. Continue the existing authorized objective using those settings. Reconcile interrupted runs and resume eligible existing work through followUpRun before considering new assignments; never duplicate tasks or repeat completed validation. Preserve Off, wind-down and handoff controls if they changed since this request was queued. Acknowledge this request and record the result or blocker.'};
    w.requests??=[];w.requests.push(request);w.revision++;
    this.event(w,'coordinator-request',{requestId:request.id,kind:request.kind});
  }

  private adapters=new Map<string,HostAdapter>();
  registerHostAdapter(adapter:HostAdapter){if(this.adapters.has(adapter.id))throw Error('Host adapter already registered');this.adapters.set(adapter.id,adapter);}
  private wakeValid(w:Workspace,e:Wake){
    if(e.epoch!==w.epoch)return false;
    if(e.kind==='handoff-requested')return w.handoff?.id===e.handoffId&&w.handoff?.from===e.clientId&&w.handoff?.state!=='completed';
    if(e.kind==='retire-schedule')return w.handoff?.id===e.handoffId&&w.handoff?.from===e.clientId&&w.handoff?.state==='completed'&&!!w.schedules?.[e.clientId];
    return e.clientId===w.controller;
  }
  private outbound(w:Workspace){return w.outbound??={bindings:[],events:[]};}
  private releaseInFlight=new Set<string>();private state:Registry;private context:CoordinatorContext|null=null;private url='';private inFlight=new Map<string,Promise<any>>();private polling=false;private closing=false;private internalTokens=new Map<string,{workspaceId:string;actor:string;epoch:number;expires:number;clientId?:string}>();private launcher='';private entry='';
  constructor(private root=app.getPath('userData')){mkdirSync(root,{recursive:true,mode:0o700});this.state=existsSync(this.file())?JSON.parse(readFileSync(this.file(),'utf8')):{clients:[],workspaces:[]};for(const w of this.state.workspaces)for(const m of w.chatOutbox??[])if(m.state==='sending'){m.state='failed';m.error='Delivery was interrupted by restart. Check the transcript before resending.';}for(const w of this.state.workspaces){if(w.handoff?.delivery==='sending'){w.handoff.delivery='failed';w.handoff.deliveryError='Wrap-up delivery was interrupted. Review the conversation before retrying.';}}for(const w of this.state.workspaces)for(const q of w.questions??[])if(q.state==='sending')q.state='pending';for(const w of this.state.workspaces)for(const r of w.ownerActions??[])if(r.state==='executing'){r.state='uncertain';r.error='Restart interrupted this action. Verify its actual state before requesting it again; it will not be replayed.';}for(const w of this.state.workspaces){for(const r of Object.values(w.dispatchReservations??{}))r.state='uncertain';for(const r of w.releases)if(r.state==='validating'){r.state=r.validationPriorState??'ready';delete r.validationPriorState;}}this.save();}
  private file(){return join(this.root,'coordinators.json');}
  private save(){
    const started=performance.now();
    // Completed mutation results can contain full snapshots. Keep immutable retry
    // evidence outside the hot registry; a missing receipt must never replay work.
    for(const w of this.state.workspaces) for(const [key,receipt] of Object.entries(w.receipts)) {
      if(receipt.state!=='done'||receipt.result===undefined) continue;
      const serialized=JSON.stringify(receipt.result);
      if(serialized.length<16000) continue;
      const directory=join(this.root,'coordinator-receipts',hash(w.id));
      mkdirSync(directory,{recursive:true,mode:0o700});
      const filename=hash(key)+'.json';
      writeFileSync(join(directory,filename)+'.tmp',serialized,{mode:0o600});
      renameSync(join(directory,filename)+'.tmp',join(directory,filename));
      receipt.resultFile=filename;delete receipt.result;
    }
    writeFileSync(this.file()+'.tmp',JSON.stringify(this.state),{mode:0o600});renameSync(this.file()+'.tmp',this.file());
    recordPerformanceTiming('coordinator-state-save',performance.now()-started);
  }
  private receiptResult(w:Workspace,receipt:Workspace['receipts'][string]){
    if(!receipt.resultFile)return receipt.result;
    if(!/^[a-f0-9]{64}\.json$/.test(receipt.resultFile))throw Error('Invalid saved receipt. Inspect outcome before retrying.');
    try{return JSON.parse(readFileSync(join(this.root,'coordinator-receipts',hash(w.id),receipt.resultFile),'utf8'));}
    catch{throw Error('Saved outcome receipt is unavailable. Inspect the existing work; this request will not be replayed.');}
  }
  private event(w:Workspace,type:string,data:unknown){w.events.push({cursor:w.nextCursor++,at:new Date().toISOString(),type,data});if(w.events.length>2000)w.events.splice(0,w.events.length-2000);
    const out=this.outbound(w);reconcileAuthority(out,e=>this.wakeValid(w,e));
    if(w.mode==='external'&&w.controller&&!['wake-acknowledged','binding-proposed'].includes(type))enqueueWake(out,{workspaceId:w.id,clientId:w.controller,epoch:w.epoch,kind:['coordinator-request','handoff-requested','question-response','decision-needed'].includes(type)?type:'changes',cursor:w.nextCursor-1,...(type==='handoff-requested'&&w.handoff?{handoffId:w.handoff.id}:{})});this.save();if(type.startsWith('workflow'))this.workflowNotifier?.();}
  attach(context:CoordinatorContext|null){this.closing=false;this.context=context;if(!context)return;const id=hash(context.repoPath).slice(0,24);if(!this.state.workspaces.some(w=>w.id===id)){this.state.workspaces.push({id,path:context.repoPath,revision:0,mode:'off',controller:null,leaseUntil:0,epoch:0,objective:'',summary:'',parallelism:2,qaDefault:true,maxReworks:1,budgetUsd:5,dependencies:{},jobs:[],releases:[],decisions:[],events:[],nextCursor:1,receipts:{}});this.save();}}
  async beforeClose(){if(this.context){this.session(this.current());this.save();}this.closing=true;while(this.polling||this.inFlight.size)await new Promise(r=>setTimeout(r,50));}
  hasController(){return !!this.context&&this.current().mode!=='off';}
  private current(){if(!this.context)throw Error('Open a project in KanBorg first.');return this.state.workspaces.find(w=>w.path===this.context!.repoPath)!;}
  private resolve(id:string){const w=this.state.workspaces.find(w=>w.id===id);if(!w)throw Error('Workspace not found.');return w;}
  private h(){if(!this.context)throw Error('Workspace unavailable');return this.context.handlers;}
  private run(id:number){const r=this.context!.store.agentRuns.findById(id);if(!r)throw Error('Run not found in this workspace');return r;}
  private async git(cwd:string,args:string[]){return (await exec('git',args,{cwd,timeout:30000,maxBuffer:2e6})).stdout.trim();}
  private async revision(runId:number){const r=this.run(runId);if(!r.worktreePath)throw Error('Worktree unavailable');if(active(r.status))throw Error('Wait for the worker to finish.');if(await this.git(r.worktreePath,['status','--porcelain']))throw Error('Worker has uncommitted changes. Ask it to commit before QA or release.');return this.git(r.worktreePath,['rev-parse','HEAD']);}
  private compactRun(id:number){const r=this.run(id);return {runId:r.id,status:r.status,branch:r.branchName,model:r.model,provider:r.provider,costUsd:r.totalCostUsd,costSource:'run-reported; may include estimates',exitReason:r.exitReason,successSignal:r.successSignal};}
  private assertControl(w:Workspace,actor:string){if(w.controller!==actor||w.mode==='off')throw Error('This session is controlled elsewhere. Hand off in KanBorg Coordinators.');if(w.leaseUntil<Date.now())throw Error('Controller lease expired. Call renewCoordinator.');}
  private checkinPolicy(w:Workspace,compact=false){
    const running=w.jobs.some(j=>['implementing','checks','reviewing'].includes(j.state))||!!w.queue?.length||(w.requests??[]).some(r=>['resume-workflows','workflow-action','workflow-change','autopilot'].includes(r.kind)&&r.state!=='completed');
    const continuing=w.autopilot?.status==='active'||!!w.objective.trim()||(w.requests??[]).some(r=>r.state!=='completed');
    return {owner:w.controller,key:`kanborg:${w.id}`,cadenceMinutes:w.mode==='off'||(!running&&!continuing)?null:running?(w.workflow?.config.cadence.working??5):(w.workflow?.config.cadence.idle??15),
      ...(!compact?{prompt:COORDINATOR_REMINDER}:{}),execution:'harness-managed',confirmed:w.controller?w.schedules?.[w.controller]??null:null,
      retirementPending:Object.entries(w.schedules??{}).filter(([owner,r])=>owner!==w.controller&&r.status==='active').map(([owner,r])=>({owner,id:r.id,status:'pause-required'})),
      ...(!compact?{instruction:'Replace this workspace reminder on takeover. Pause superseded harness reminders; do not claim completion without confirmation. No continuing responsibility means pause.'}:{})};
  }
  private personaLibrary(w:Workspace){if(!w.personas){w.personas=newPersonaLibrary(basename(w.path));this.save();}return w.personas;}
  private session(w:Workspace){const workers=w.jobs.filter(j=>j.autopilot||w.updateDrain).flatMap(j=>[j.runId,...(j.reviewRunId?[j.reviewRunId]:[])].map(runId=>{const controlId=runId===j.runId?j.controlId:j.reviewControlId;const report=controlId?readCheckpoint(this.root,controlId):null;if(report){if(runId===j.runId)j.checkpoint=report;else j.reviewCheckpoint=report;}return {runId,number:j.number,active:active(this.run(runId).status),state:j.state==='interrupted'?'interrupted—recovery needed':report?.state??(active(this.run(runId).status)?w.expediting?(controlId?'requested':'waiting for worker to finish (legacy run)'):'finishing':'finished'),checkpoint:report??(runId===j.runId?j.checkpoint:j.reviewCheckpoint)};}));const remaining=w.jobs.filter(j=>j.autopilot&&(active(this.run(j.runId).status)||(j.reviewRunId&&active(this.run(j.reviewRunId).status)))).length;return {stageAssignments:w.stageAssignments??{},dispatchReservations:w.dispatchReservations??{},ownerActions:w.ownerActions??[],personas:this.personaLibrary(w),epoch:w.epoch,outbound:{adapterIds:[...this.adapters.keys()],bindings:this.outbound(w).bindings,events:this.outbound(w).events.slice(-50),supported:this.adapters.size>0},chatOutbox:w.chatOutbox??[],autopilot:w.autopilot?{...w.autopilot,capacity:this.autopilotCapacity(w),workers,expediting:!!w.expediting,remaining,label:w.autopilot.status==='active'?'On':remaining?`Winding down · ${remaining} tasks remaining`:'Off'}:null,workflowVersion:w.workflow?.version??1,workflowContract:w.workflow?.config??newWorkflow().config,stagePriority:w.workflow?.stageOrder??{},workspaceId:w.id,revision:w.revision,mode:w.mode,controller:w.controller,leaseUntil:w.leaseUntil,objective:w.objective,summary:w.summary,authority:{coordination:'assigned-controller',release:w.workflow?.config.releaseOwner==='user'?'owner decision required; tool authorization remains enforced':'assigned-controller within owner-authorized scope',pairing:'owner-only'},checkIn:this.checkinPolicy(w),parallelism:w.parallelism,releaseParallelism:w.releaseParallelism??4,qaDefault:w.qaDefault,budgetUsd:w.budgetUsd,maxReworks:w.maxReworks,conversationId:w.conversationId,onboardedAt:w.onboardedAt,handoff:w.handoff,requests:(w.requests??[]).filter(r=>r.state!=='completed')};}
  ui(){return {workspace:this.context?this.session(this.current()):null,workspaces:this.state.workspaces.map(w=>({id:w.id,name:basename(w.path),open:w.path===this.context?.repoPath})),clients:this.state.clients.map(({tokenHash,...c})=>c),jobs:this.context?this.current().jobs:[],queue:this.context?this.current().queue??[]:[],releases:this.context?this.current().releases:[],decisions:this.context?this.current().decisions:[],guide:COORDINATOR_GUIDE,applicationUpdate:this.updater?{...this.updater.status(),coordination:this.updateCoordination()}:null};}
  private coordinationMetrics(w:Workspace){
    const now=Date.now();const age=(at:string|undefined)=>{const time=Date.parse(at??'');return Number.isFinite(time)&&time<=now?now-time:null;};
    const activeJobs=w.jobs.filter(j=>[j.runId,j.reviewRunId].some(id=>id!==undefined&&active(this.context!.store.agentRuns.findById(id)?.status??'')));
    const liveTasks=(this.context?.store.agentRuns.listActive?.()??[]).filter(run=>run.issueNumber>0);
    const activeRunIds=[...new Set([...activeJobs.flatMap(j=>[j.runId,j.reviewRunId].filter((id):id is number=>id!==undefined&&active(this.context!.store.agentRuns.findById(id)?.status??''))),...liveTasks.map(run=>run.id)])];
    const runStates=activeRunIds.map(runId=>{const run=this.run(runId);return {runId,status:run.status,processAttached:run.pid!=null};});
    const waitingRunIds=runStates.filter(r=>r.status==='awaiting_input').map(r=>r.runId);
    const executingRunIds=runStates.filter(r=>r.status==='starting'||r.status==='running').map(r=>r.runId);
    const byTask=new Map<number,Set<number>>();
    const addTask=(number:number,id:number)=>{const ids=byTask.get(number)??new Set<number>();ids.add(id);byTask.set(number,ids);};
    for(const job of activeJobs)if(activeRunIds.includes(job.runId))addTask(job.number,job.runId);
    const reviewIds=new Set(activeJobs.flatMap(job=>job.reviewRunId?[job.reviewRunId]:[]));
    for(const run of liveTasks)if(!reviewIds.has(run.id))addTask(run.issueNumber,run.id);
    const reservations=Object.entries(w.dispatchReservations??{}).map(([number,r])=>({number:Number(number),id:r.id,state:r.state,ageMs:age(r.at)}));
    const counts:Record<string,number>={};for(const event of w.events)counts[event.type]=(counts[event.type]??0)+1;
    return {observedAt:new Date(now).toISOString(),workspaceId:w.id,revision:w.revision,
      workers:{target:w.autopilot?.parallelism??w.parallelism,active:activeRunIds.length,executing:executingRunIds.length,waitingForInput:waitingRunIds.length,executingRunIds,waitingRunIds,runStates,activeAssignments:activeJobs.length,runIds:activeRunIds,reserved:reservations.length,queued:w.queue?.length??0,activeRunLimit:null,availableSlots:null,autopilot:this.autopilotCapacity(w),duplicateTasks:[...byTask].filter(([,ids])=>ids.size>1).map(([number,runIds])=>({number,runIds:[...runIds]}))},
      recovery:{dispatches:reservations,releases:w.releases.filter(r=>['executing','uncertain','failed'].includes(r.state)).map(r=>({id:r.id,state:r.state,sha:r.sha,action:r.action})),workers:w.jobs.filter(j=>['blocked','checkpointed','review-checkpointed','interrupted'].includes(j.state)).map(j=>({runId:j.runId,number:j.number,state:j.state}))},
      stages:Object.values(w.workflow?.cards??{}).map(c=>({number:c.number,stageId:c.stageId,enteredAt:c.enteredAt,ageMs:age(c.enteredAt),waiting:c.waiting??null})),
      pendingRequests:(w.requests??[]).filter(r=>r.state!=='completed').map(r=>({id:r.id,kind:r.kind,state:r.state,ageMs:age(r.createdAt)})),
      eventWindow:{firstCursor:w.events[0]?.cursor??null,lastCursor:w.events.at(-1)?.cursor??null,from:w.events[0]?.at??null,through:w.events.at(-1)?.at??null,retained:w.events.length,truncated:(w.events[0]?.cursor??1)>1,counts},
      limits:'Current worker counts are a snapshot. Active assignments include awaiting-input runs and are not a count of executing agents. Process attachment is recorded metadata, not a liveness probe. Event counts cover only the retained window, not lifetime totals. Merge/PR completion is not verified deployment. Unknown or future timestamps have null age.'};
  }
  private async vaultAuthorizationOptions(){
    const {vaultAction}=await import('./vault-runtime.js');
    const options:Array<{label:string;scope:import('./secret-vault.js').VaultScope}>= [{label:'All KanBorg consumers · any repository',scope:{kind:'all'}}];
    const seen=new Set<string>();
    for(const workspace of this.state.workspaces){
      const name=basename(workspace.path);
      options.push({label:`${name} · all consumers in this project`,scope:{kind:'project',projectId:workspace.id}});
      const status=await vaultAction('status',{},workspace.id);
      const consumers=[...status.items.flatMap((item:any)=>(item.authorizedScopes??[{kind:'consumer',projectId:workspace.id,consumer:item.consumer}]).filter((scope:any)=>scope.kind==='consumer')), ...(workspace.ownerActions??[]).filter(r=>r.entry&&r.state==='pending').map(r=>({kind:'consumer',projectId:workspace.id,consumer:r.entry!.consumer}))];
      for(const scope of consumers){const key=JSON.stringify(scope);if(seen.has(key))continue;seen.add(key);const project=this.state.workspaces.find(w=>w.id===scope.projectId);if(project)options.push({label:`${scope.consumer} · ${basename(project.path)}`,scope});}
    }
    return options;
  }
  async uiAction(action:string,args:any={},ownReceipt=false):Promise<any>{
    const w=this.current();
    if(action==='coordination-metrics')return this.coordinationMetrics(w);
    if(action==='vault-options')return this.vaultAuthorizationOptions();
    if(action==='vault-stage'&&args.authorizedScopes!==undefined){
      const {validateVaultScopes}=await import('./secret-vault.js');
      const selected=validateVaultScopes(args.authorizedScopes),options=await this.vaultAuthorizationOptions();
      if(selected.some(scope=>!options.some(option=>JSON.stringify(option.scope)===JSON.stringify(scope))))throw Error('An authorization option is no longer available. Refresh the consumer list.');
      args={...args,authorizedScopes:selected,consumer:selected.map(scope=>options.find(o=>JSON.stringify(o.scope)===JSON.stringify(scope))!.label).join(', ')};
    }
    if(action.startsWith('vault-'))return (await import('./vault-runtime.js')).vaultAction(action.slice(6),args,w.id);
    if(action==='owner-action-answer'){
      const request=w.ownerActions?.find(r=>r.id===args.id&&r.state==='pending');if(!request)throw Error('Approval is no longer pending');
      if(!args.approve){request.state='declined';this.event(w,'owner-action-declined',{id:request.id});return request;}
      if(request.epoch!==w.epoch)throw Error('Coordinator changed; request a fresh approval');
      request.state='executing';this.save();
      try{if(request.action==='vault-entry'){if(!request.entry)throw Error('Secret entry request is missing its metadata');const vault=await (await import('./vault-runtime.js')).vaultAction('status',{},w.id);const entry=vault.items.find((item:any)=>item.name===request.entry!.name&&(item.authorizedScopes??[{kind:'consumer',projectId:w.id,consumer:item.consumer}]).some((scope:any)=>scope.kind==='all'||scope.projectId===w.id&&(scope.kind==='project'||scope.consumer===request.entry!.consumer))&&!request.entry!.previousIds.includes(item.id)&&['staged','active'].includes(item.state));if(!entry)throw Error('Save the requested secret in the app before verifying setup');request.result={id:entry.id,name:entry.name,consumer:entry.consumer,version:entry.version,state:entry.state};}else if(['vault-initialize','vault-activate','vault-revoke','vault-backup','vault-restore'].includes(request.action)){if(!['vault-activate','vault-revoke'].includes(request.action)&&request.target!==w.id)throw Error('Vault request targets a different workspace');const result=await this.uiAction(request.action,{id:request.target});if(result.cancelled){request.state='pending';this.event(w,'owner-action-cancelled',{id:request.id});return request;}}else if(request.action==='share-chat'){const id=Number(request.target);if(!Number.isSafeInteger(id)||id<1)throw Error('Invalid chat ID');if(!this.appRuntime)throw Error('Saved chats unavailable');await this.appRuntime('saved-chat:verify',{conversationId:id},w.path);w.sharedChats=[...new Set([...(w.sharedChats??[]),id])];}else if(request.action==='add-repo'){await this.h()['workspace:repos-add']({repoPath:request.target});}else if(request.action==='add-folder'){await this.h()['folders:add']({name:basename(request.target),path:request.target});}else if(request.action==='remove-worktree'){if(!this.appRuntime)throw Error('Desktop control unavailable');await this.appRuntime('tree-remove',{path:request.target},w.path);}else if(request.action==='configure-provider'){const result=await getProviderHandlers()['providers:test-connection']({id:request.target as any});if(!result.ok)throw Error(result.error??'Provider connection has not been verified');}else if(request.action==='remove-provider-credential'){await getProviderHandlers()['providers:save']({id:request.target as any,apiKey:null});}else if(request.action==='open-project'){if(!this.appRuntime)throw Error('Desktop control unavailable');await this.appRuntime('owner-open-project',{path:request.target},w.path);}else await this.uiAction(request.action,{id:request.target});request.result={...request.result as object,action:request.action,target:request.target,completedAt:new Date().toISOString()};request.state='completed';this.event(w,'owner-action-completed',{id:request.id});return request;}catch(e){request.state=['configure-provider','vault-entry'].includes(request.action)?'pending':'failed';request.error=e instanceof Error?e.message:'Action failed';this.save();throw e;}
    }
    if(action==='preferences-get')return {workspaceId:w.id,boardWorkspaceId:(await this.h()['workspace:get']()).id,...(w.uiPreferences??{version:0,value:{}})};
    if(action==='preferences-save'){
      validateCoordinatorArgs('setUiPreferences',{workspaceId:w.id,revision:w.revision,requestId:'app-preferences-save',preferences:args.preferences});
      const views=args.preferences.savedViews;if(views){if(new Set(views.views.map((v:any)=>v.id)).size!==views.views.length)throw Error('Saved view IDs must be unique');if(views.activeViewId!==null&&!views.views.some((v:any)=>v.id===views.activeViewId))throw Error('Active view does not exist');}const old=w.uiPreferences??{version:0,value:{}};if(args.expectedVersion!==undefined&&args.expectedVersion!==old.version)throw Error('Preferences changed; reload before saving');
      const value={...old.value};for(const [key,patch] of Object.entries(args.preferences))value[key]={...value[key],...(patch as object)};
      w.uiPreferences={version:old.version+1,value};this.event(w,'preferences-changed',{version:w.uiPreferences.version});return {workspaceId:w.id,boardWorkspaceId:(await this.h()['workspace:get']()).id,...w.uiPreferences};
    }
    if(action==='upsert-persona'||action==='remove-persona'){
      const name=action==='upsert-persona'?'upsertPersona':'removePersona';
      validateCoordinatorArgs(name,{...args,workspaceId:w.id,revision:w.revision,requestId:'app-persona-change'});
      editPersonaLibrary(this.personaLibrary(w),action==='upsert-persona'?'upsert':'remove',args,'owner-app',[...(w.autopilot?.personas.map((p:any)=>p.id)??[]),...(w.workflow?.config.stages.flatMap(s=>s.personaId?[s.personaId]:[])??[])]);
      w.revision++;this.event(w,name,{id:args.persona?.id??args.id});return this.ui();
    }
    if(action==='approve-binding'||action==='revoke-binding'){
      const b=this.outbound(w).bindings.find(b=>b.id===args.id);if(!b)throw Error('Binding not found');
      if(action==='approve-binding'){if(!this.adapters.has(b.adapterId))throw Error('This host adapter is not installed. Automatic wakeup is unavailable.');if(!this.state.clients.some(c=>c.id===b.clientId&&c.status==='approved'))throw Error('Approve the connection first');for(const other of this.outbound(w).bindings)if(other.clientId===b.clientId&&other.id!==b.id)other.state='revoked';b.state='approved';}else b.state='revoked';
      this.event(w,action,{bindingId:b.id});return this.ui();
    }
    if(action==='stop-wind-down-worker'){const j=w.jobs.find(j=>j.runId===args.runId||j.reviewRunId===args.runId);if(!j)throw Error('Worker not found');j.state='interrupted';j.error='Interrupted—recovery needed';this.event(w,'worker-interrupted',{runId:args.runId});await this.context!.supervisor.stop(args.runId);return this.ui();}
    if(action==='autopilot'){validateCoordinatorArgs('manageAutopilot',{workspaceId:w.id,requestId:'app-autopilot-change',revision:w.revision,...args});await this.manageAutopilot(w,args);await this.tick();return this.ui();}
    if(action.startsWith('workflow:')){const name=action.slice(9);const result=await this.workflowAction(w,name,args,'user');return result;}
    if(action==='check-application-update'){if(!this.updater)throw Error('Updater unavailable');return {...await this.updater.check(),coordination:this.updateCoordination()};}
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
    if(action==='request-perspective'){
      const name=String(args.name??'').trim().slice(0,100),prompt=String(args.prompt??'').trim(),notes=String(args.notes??'').trim();
      if(!name||!prompt||prompt.length>12000||notes.length>4000)throw Error('Choose a perspective and keep its guidance concise.');
      if(w.mode==='off')await this.uiAction('handoff',{mode:'internal'});
      const request:CoordinatorRequest={id:randomUUID(),kind:'discovery',state:'queued',createdAt:new Date().toISOString(),prompt:`Review this repository from the ${name} perspective. Perspective guidance: ${prompt}\nOwner notes: ${notes||'None'}. Read existing tasks and active assignments first. Delegate a read-only review through dispatchTask using automatic routing; do not select a fixed provider or model. Reconcile findings with existing cards, add useful nonduplicate suggestions to the board, and report the results through this coordinator. This is a one-time discovery request, not permission to implement suggestions or start continuous Autopilot.`};
      w.requests??=[];w.requests.push(request);w.revision++;this.event(w,'coordinator-request',{requestId:request.id,kind:request.kind});return request;
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
      if(this.inFlight.size>(ownReceipt?1:0))throw Error('Wait for the current action to finish, then try again.');
      const mode=args.mode==='internal'?'internal':'external';
      if(mode==='internal'&&!w.conversationId){const chat=await this.h()['chat:create']({title:'Project coordinator'});w.conversationId=chat.conversation.id;}
      const to=mode==='internal'?`internal:${w.conversationId}`:String(args.clientId);
      if(mode==='external'&&!this.state.clients.some(c=>c.id===to&&c.workspaceId===w.id&&c.status==='approved'&&c.role==='coordinator'))throw Error('Pair and approve the new coordinator first.');
      if(w.controller===to)return this.ui();
      if(w.handoff&&w.handoff.state!=='completed'){if(w.handoff.to===to)return this.ui();throw Error('Finish or cancel the current handoff first.');}
      w.handoff={id:randomUUID(),from:w.controller,to,mode,state:w.controller?'requested':'ready',requestedAt:new Date().toISOString(),summary:w.summary,checkpoint:JSON.parse(JSON.stringify({objective:w.objective,summary:w.summary,jobs:w.jobs,queue:w.queue??[],decisions:w.decisions,releases:w.releases,cursor:w.nextCursor-1}))};
      w.revision++;this.event(w,'handoff-requested',{id:w.handoff.id,to,instruction:'Stop dispatching new work. Save a compact handoff with completeHandoff, then wait for the human to switch control.'});
      await this.deliverHandoff(w);
      return this.ui();
    }
    if(action==='retry-handoff'){if(w.handoff?.delivery==='failed'){w.handoff.delivery='waiting';delete w.handoff.deliveryError;this.save();await this.deliverHandoff(w);}return this.ui();}
    if(action==='cancel-handoff'){if(w.handoff?.state!=='completed'){delete w.handoff;w.revision++;this.event(w,'handoff-cancelled',{});}return this.ui();}
    if(action==='finish-handoff'){
      const h=w.handoff;if(!h||h.state==='completed')throw Error('No handoff is waiting.');
      if(h.state!=='ready'&&!args.useSavedProgress)throw Error('Waiting for the current coordinator to wrap up.');
      const result=await this.uiAction('handoff',{mode:h.mode,clientId:h.to,summary:h.summary},ownReceipt);
      h.state='completed';this.event(w,'handoff-completed',{id:h.id,from:h.from,to:h.to,instruction:pauseCheckins,usedSavedProgress:!!args.useSavedProgress});if(h.from&&w.schedules?.[h.from]?.status==='active'){enqueueWake(this.outbound(w),{workspaceId:w.id,clientId:h.from,epoch:w.epoch,kind:'retire-schedule',cursor:w.nextCursor-1,handoffId:h.id});this.save();}
      if(h.mode==='internal')return this.uiAction('chat-send',{body:'You are now the coordinator. Read getWorkspaceSummary and the saved handoff first. Reconcile active workers and pending decisions; do not duplicate work. Briefly tell the user where things stand and the next action. Do not dispatch new development until the objective is clear.'});
      return result;
    }
    if(action==='handoff'){
      if(this.inFlight.size>(ownReceipt?1:0))throw Error('Wait for the current coordinator action to finish before handing off.');
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
      if(!Number.isSafeInteger(args.parallelism)||args.parallelism<1||!Number.isFinite(args.budgetUsd)||args.budgetUsd<=0||args.budgetUsd>1000)throw Error('Choose a positive whole number of workers and a positive budget up to $1,000.');
      if(args.releaseParallelism!==undefined&&(!Number.isSafeInteger(args.releaseParallelism)||args.releaseParallelism<1))throw Error('Choose a positive whole number of release workers.');
      w.releaseParallelism=args.releaseParallelism??w.releaseParallelism??4;w.parallelism=args.parallelism;if(w.autopilot)w.autopilot.parallelism=args.parallelism;w.budgetUsd=args.budgetUsd;w.qaDefault=!!args.qaDefault;w.maxReworks=Math.min(2,Math.max(0,Number(args.maxReworks)||0));w.revision++;this.save();return this.ui();
    }
    if (action === 'questions-list') {
      const { store } = this.context!;
      w.questions ??= [];
      // Keep durable answer receipts, including when card synchronization failed.
      // Do not restart a worker merely to reconcile its old question card.
      for (const q of w.questions) {
        if ((q.state === 'answered' || q.state === 'closed') && store.cards.findById(q.id)?.status === 'pending') {
          try {
            store.cards.resolve(q.id, q.state === 'answered'
              ? { value: q.reply, label: q.reply, source: 'questions-for-user' }
              : { disposition: 'obsolete', reason: q.closedReason, source: 'coordinator-reconciliation' });
          } catch { /* Saved receipt is authoritative; retry metadata synchronization later. */ }
        }
      }
      // A resolved decision is no longer an owner wait. Preserve the run as a
      // checkpoint, never success, and leave continuation to current authority.
      for (const runId of new Set(w.questions.map(q => q.runId))) {
        const run = store.agentRuns.findById(runId);
        if (!run || run.status !== 'awaiting_input' || run.pid != null) continue;
        const decisions = store.cards.listByRun?.(runId)?.filter(c => c.type === 'decision');
        if (!decisions?.length || decisions.some(c => c.status === 'pending')) continue;
        const job = w.jobs.find(j => j.runId === runId || j.reviewRunId === runId);
        if (job) {
          const review = job.reviewRunId === runId;
          job.state = review ? 'review-checkpointed' : 'checkpointed';
          job.error = 'Question resolved; saved work awaits coordinator continuation. Not task completion.';
        }
        // Persist the resumable assignment before releasing its active run slot.
        this.save();
        store.agentRuns.update(runId, {status:'stopped', endedAt:new Date().toISOString(), exitReason:'checkpoint: question resolved; coordinator continuation pending'});
        this.event(w, 'resolved-question-checkpoint', {runId, questionIds: decisions.map(c => c.id)});
      }
      for (const { card, agentRunId } of store.cards.listAllPending()) {
        const payload = card.payload as { question?: string; options?: UserQuestion['options']; commands?:QuestionCommand[] };
        if (card.type !== 'decision' || !payload?.question || w.questions.some(q => q.id === card.id)) continue;
        const run = store.agentRuns.findById(agentRunId);
        if (!run) continue;
        w.questions.push({ id: card.id, runId: agentRunId, threadId: run.threadId,
          question: payload.question, options: payload.options ?? [], commands: questionCommands(payload.commands), state: 'pending' });
        this.event(w, 'decision-needed', { cardId: card.id });
      }
      for (const q of w.questions) {
        if (q.state !== 'pending' || store.cards.findById(q.id)?.status === 'resolved') continue;
        w.requests ??= [];
        const id = `question:${q.id}`;
        if (w.requests.some(r => r.id === id)) continue;
        w.requests.push({ id, kind: 'workflow-action', state: 'queued', createdAt: new Date().toISOString(),
          prompt: `Reconcile question ${q.id} from thread ${q.threadId}, run ${q.runId}: ${q.question}\nOptions: ${JSON.stringify(q.options)}\nPoll listUserQuestions explicitly. Handle routine choices within your authority. Owner-reserved questions remain in the app inbox. If answered elsewhere or obsolete, use closeUserQuestion with evidence; do not interrupt an active worker to dismiss old questions.` });
        this.event(w, 'coordinator-request', { id, questionId: q.id });
      }
      return w.questions.flatMap(q => {
        const card = store.cards.findById(q.id);
        if (q.state === 'closed' || (q.state === 'answered' ? args.includeAnswered !== true : !card || card.status === 'resolved')) return [];
        const run = store.agentRuns.findById(q.responseRunId ?? q.runId) ?? store.agentRuns.findById(q.runId);
        if (!run && q.state !== 'answered') return [];
        const explanation = questionExplanation(q.explanation ?? '');
        const origin = store.threads.findById(q.threadId);
        const commands = q.commands?.length ? q.commands : fencedQuestionCommands(q.question + '\n' + explanation);
        // A running origin is informational. Answers are durably queued to the
        // CURRENT coordinator, so worker activity must never disable the inbox.
        return [{ ...q, answerStatus:q.answerRequestId?w.requests?.find(r=>r.id===q.answerRequestId)?.state:undefined, commands, issueNumber: origin?.issueNumber, busy: q.state === 'sending', originBusy: !!run && active(run.status) && run.status !== 'awaiting_input',
          explanation, explanationPending: !!q.explanationRequestId && w.requests?.find(r => r.id === q.explanationRequestId)?.state !== 'completed' }];
      });
    }
    if (action === 'question-context') {
      const q = w.questions?.find(q => q.id === args.id);
      if (!q) throw Error('Question not found in this workspace.');
      const {store} = this.context!;
      const runs = store.agentRuns.listByThread(q.threadId);
      const selected = args.runId ?? q.runId;
      if (!runs.some(run => run.id === selected)) throw Error('Run does not belong to this question thread.');
      const offset = Math.max(0, Number(args.offset) || 0);
      const events = store.events.list(selected);
      return {threadId:q.threadId, runId:selected, issueNumber:store.threads.findById(q.threadId)?.issueNumber,
        runs:runs.map(run=>({id:run.id,status:run.status})),
        messages:offset===0?store.messages.list(q.threadId).map(m=>({role:m.role,body:m.body,runId:m.agentRunId})):[],
        events:events.slice(offset,offset+100).map(e=>({seq:e.seq,type:e.type,payload:e.payload})),
        nextOffset:offset+100<events.length?offset+100:null};
    }
    if (action === 'question-reply') {
      const { store } = this.context!;
      const q = w.questions?.find(q => q.id === args.id);
      const reply = String(args.reply ?? '').trim();
      // An uncertain UI receipt may be retried safely with the same answer.
      if (q?.state === 'answered' && q.reply === reply && args.explain !== true) {
        return { ok: true, queued: true, requestId: q.answerRequestId };
      }
      const card = q && store.cards.findById(q.id);
      if (!q || q.state !== 'pending' || !card || card.status === 'resolved') throw Error('This question is no longer awaiting an answer. Refresh questions.');
      const explaining = args.explain === true;
      if (!explaining && (!reply || reply.length > 4000)) throw Error('Enter an answer up to 4,000 characters.');
      w.requests ??= [];
      const existing = explaining && q.explanationRequestId ? w.requests.find(r => r.id === q.explanationRequestId && r.state !== 'completed') : undefined;
      if (existing) return { ok: true, queued: true, requestId: existing.id };
      const before = structuredClone(w);
      const requestId = explaining ? `question-explanation:${q.id}:${randomUUID()}` : `question-answer:${q.id}`;
      const prompt = `Question ${q.id}, originating thread ${q.threadId}, run ${q.runId}.\n${q.question}\nOptions: ${JSON.stringify(q.options)}\n` + (explaining
        ? `The owner requested an explanation. Provide a short, owner-facing explanation: what is needed, why it matters, and the consequences of each option. Do not include sibling briefings, routing notices or internal instructions. If a command or snippet is requested, retrieve the exact artifact from the originating thread and include it in the commands field, with where to run it and the expected result. A file path or paraphrase is not a substitute. If unavailable, clearly state that and recover the artifact before asking the owner to run it. Do not choose an answer. Save the explanation with recordUserQuestionExplanation (id ${q.id}) so it appears in Questions. Do not create a replacement question or interrupt an active worker.`
        : `The owner answered: ${reply}\nThis answer is saved. Reconcile it with the originating thread using its existing work and current authority; do not duplicate workers or interrupt active work. Save a concise user-facing response with recordUserQuestionResponse (id ${q.id}) so the owner can see what happened on the question card. Acknowledge this request as received before acting and completed after applying the answer or recording its blocker.`);
      w.requests.push({ id: requestId, kind: 'workflow-action', prompt, state: 'queued', createdAt: new Date().toISOString() });
      if (explaining) q.explanationRequestId = requestId;
      else {
        q.state = 'answered'; q.answeredAt=new Date().toISOString(); q.reply = reply; q.answerRequestId = requestId;
        for (const notice of w.requests.filter(r => r.id === `question:${q.id}` || r.id === q.explanationRequestId)) notice.state = 'completed';
      }
      // One synchronous durable commit contains both the answer and its inbox
      // request. No provider/process start is awaited by the button handler.
      try { this.event(w, 'coordinator-request', { id: requestId, questionId: q.id, explaining }); }
      catch (error) {
        Object.assign(w, before);
        throw error;
      }
      if (!explaining && card.status === 'pending') {
        try { store.cards.resolve(q.id, { value: reply, label: reply, source: 'questions-for-user' }); }
        catch (error) { this.event(w, 'question-card-sync-pending', { id: q.id, error: clip(error instanceof Error ? error.message : 'Card synchronization failed') }); }
      }
      return { ok: true, queued: true, requestId };
    }
    if(action==='question-response-record'){const q=w.questions?.find(q=>q.id===args.id&&q.state==='answered');if(!q)throw Error('Answered question not found');const response=String(args.response??'').trim();if(!response||response.length>16000)throw Error('Provide a response up to 16,000 characters');q.response=questionExplanation(response);this.event(w,'question-response-recorded',{id:q.id});return {id:q.id,response:q.response};}
    if (action === 'question-explanation-record') {
      const q = w.questions?.find(q => q.id === args.id && q.state === 'pending');
      if (!q) throw Error('Question is no longer pending.');
      const explanation = String(args.explanation ?? '').trim();
      if (!explanation || explanation.length > 16000) throw Error('Provide an explanation up to 16,000 characters.');
      const commands = args.commands === undefined ? q.commands : questionCommands(args.commands);
      q.explanation = questionExplanation(explanation);
      if(commands !== undefined) q.commands = commands;
      const request = w.requests?.find(r => r.id === q.explanationRequestId);
      if (request) request.state = 'completed';
      this.event(w, 'question-explained', { id: q.id });
      return { id: q.id, explanation: q.explanation, commands: q.commands };
    }
    if (action === 'question-close') {
      const q = w.questions?.find(q => q.id === args.id && q.state === 'pending');
      if (!q) throw Error('Question is no longer pending.');
      const reason = String(args.reason ?? '').trim();
      if (!reason) throw Error('Record why the question is obsolete or already answered.');
      q.state = 'closed'; q.closedReason = reason;
      for (const notice of w.requests?.filter(r => r.id === `question:${q.id}` || r.id === q.explanationRequestId) ?? []) notice.state = 'completed';
      this.event(w, 'question-closed', { id: q.id, reason });
      await this.uiAction('questions-list');
      return { id: q.id, state: q.state, reason };
    }
    if(action==='chat-submit'){
      if(w.mode!=='internal')throw Error('Switch to built-in coordination to send a message here.');
      const body=String(args.body??'').trim();if(!body||body.length>16000)throw Error('Enter a message of up to 16,000 characters.');
      w.chatOutbox??=[];const existing=w.chatOutbox.find(m=>m.id===args.id);if(existing)return existing;
      const message:ChatDraft={id:typeof args.id==='string'?args.id:randomUUID(),body,steer:args.steer===true,state:'queued',createdAt:new Date().toISOString()};
      if(message.steer)w.chatOutbox.unshift(message);else w.chatOutbox.push(message);this.event(w,'chat-message-queued',{id:message.id,steer:message.steer});
      if(message.steer){const chat=w.conversationId?await this.h()['chat:get']({conversationId:w.conversationId}):null;if(chat?.activeRun)await this.context!.supervisor.stop(chat.activeRun.id);}
      return message;
    }
    if(action==='chat-steer-queued'){
      if(w.mode!=='internal'||(w.handoff&&w.handoff.state!=='completed'))throw Error('Finish the handoff before steering');
      const m=w.chatOutbox?.find(m=>m.id===args.id&&m.state==='queued');if(!m)throw Error('Message is no longer queued');m.steer=true;w.chatOutbox=[m,...w.chatOutbox!.filter(x=>x.id!==m.id)];this.event(w,'chat-steering-requested',{id:m.id});
      const chat=w.conversationId?await this.h()['chat:get']({conversationId:w.conversationId}):null;if(chat?.activeRun)await this.context!.supervisor.stop(chat.activeRun.id);return this.ui();
    }
    if(action==='chat-cancel-queued'||action==='chat-edit-queued'){
      const message=w.chatOutbox?.find(m=>m.id===args.id&&m.state==='queued');if(!message)throw Error('This message has already started delivery.');
      if(action==='chat-cancel-queued')w.chatOutbox=w.chatOutbox!.filter(m=>m.id!==args.id);else{const body=String(args.body??'').trim();if(!body||body.length>16000)throw Error('Enter a message of up to 16,000 characters.');message.body=body;}
      this.event(w,'chat-queue-updated',{id:args.id});return this.ui();
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
        if(internal){const w=this.state.workspaces.find(w=>w.id===internal.workspaceId);const client=internal.clientId?this.state.clients.find(c=>c.id===internal.clientId):null;if(!w||internal.expires<Date.now()||(internal.clientId&&client?.status!=='approved')||w.epoch!==internal.epoch)throw Error('Coordinator session expired or revoked.');actor=internal.actor;scope=internal.workspaceId;}
        else{const c=this.state.clients.find(c=>c.tokenHash===hash(token));if(!c||req.url!=='/session')throw Error('Pairing not recognized.');c.lastSeen=new Date().toISOString();this.save();if(c.status!=='approved')throw Error(`Pairing ${c.code}: ${c.status}. Approve in KanBorg Coordinators.`);actor=c.role==='observer'?`observer:${c.id}`:c.id;scope=c.workspaceId;
          const sessionToken=randomBytes(32).toString('hex');this.internalTokens.set(hash(sessionToken),{workspaceId:scope,actor,epoch:this.resolve(scope).epoch,expires:Date.now()+15*60000,clientId:c.id});for(const [key,value] of this.internalTokens)if(value.expires<Date.now())this.internalTokens.delete(key);
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
    if(name==='getCapabilities')return {version:app.getVersion(),authority:'active-coordinator',guide:COORDINATOR_GUIDE,scope,tools:COORDINATOR_TOOLS.map(t=>t.name),releaseActions:['merge','draft-pr'],hosted:false};
    if(name==='listWorkspaces')return this.state.workspaces.filter(w=>w.id===scope).map(w=>({workspaceId:w.id,name:basename(w.path),open:this.context?.repoPath===w.path}));
    if(args.workspaceId!==scope)throw Error('This connection is not permitted for that workspace');const w=this.resolve(scope);
    if(w.path!==this.context?.repoPath&&!['getChanges','waitForChanges','getCoordinatorRequests','getApplicationUpdate','acknowledgeCoordinatorRequest','renewCoordinator','getCoordinationSession','openScopedWorkspace','listOwnerActionRequests','getControlCoverage'].includes(name))throw Error('Workspace is not open. Update notices remain available through getCoordinatorRequests.');
    if(name==='getControlCoverage')return {operations:APP_CONTROLS.map(c=>({tool:c.tool.name,scope:'workspace',access:c.write?'controller':'read',channel:c.channel??null,action:c.action??null,startsWork:!!c.startsWork})),coordinatorTools:COORDINATOR_TOOLS.map(t=>t.name),equivalents:APP_CONTROL_EQUIVALENTS,ownerMediated:{tool:'requestOwnerAction',actions:['approve-client','revoke-client','approve-binding','revoke-binding','approve-release','share-chat','add-repo','add-folder','remove-worktree','configure-provider','remove-provider-credential','open-project','vault-initialize','vault-activate','vault-revoke','vault-backup','vault-restore']},localOnly:['Native file-picker dialogs are represented by typed path inputs; ownership-sensitive paths require owner approval.'],remaining:[],contract:'Direct operations use shared handlers. Legacy execution/release actions use the coordinator contract. Owner-mediated controls remain pending until the owner acts; they cannot be self-approved by a coordinator.'};
    if(name==='getOutboundEvents')return {epoch:w.epoch,adapterIds:[...this.adapters.keys()],bindings:this.outbound(w).bindings.filter(b=>b.clientId===actor),events:this.outbound(w).events.filter(e=>e.clientId===actor).slice(-50)};
    if(name==='proposeHostBinding'){
      const client=this.state.clients.find(c=>c.id===actor&&c.workspaceId===scope&&c.status==='approved');if(!client)throw Error('An approved external connection is required');const out=this.outbound(w);
      const existing=out.bindings.find(b=>b.clientId===actor&&b.hostId===args.hostId&&b.chatId===args.chatId&&b.adapterId===args.adapterId&&b.state!=='revoked');if(existing)return existing;
      const binding={id:randomUUID(),clientId:actor,hostId:args.hostId,chatId:args.chatId,adapterId:args.adapterId,state:'pending' as const,createdAt:Date.now()};out.bindings.push(binding);this.event(w,'binding-proposed',{id:binding.id});return binding;
    }
    if(name==='acknowledgeWake'){if(args.state==='acted'&&!args.summary?.trim())throw Error('Record a compact action outcome');const event=acknowledgeWake(this.outbound(w),actor,args.id,args.epoch,args.state,e=>this.wakeValid(w,e));if(args.summary)event.actionSummary=args.summary;this.save();return event;}
    if(name==='confirmHandoffReconciled'){if(w.controller!==actor||w.epoch!==args.epoch||w.handoff?.id!==args.handoffId||!w.handoff||w.handoff.state!=='completed')throw Error('Handoff authority changed');w.handoff.receivedBy=actor;this.save();return {accepted:true,epoch:w.epoch};}
    if(name==='renewCoordinator'){if(w.controller!==actor||w.mode==='off')throw Error('Control belongs elsewhere');w.leaseUntil=Date.now()+30*60000;this.save();return w.path===this.context?.repoPath?this.session(w):{workspaceId:w.id,revision:w.revision,controller:w.controller,leaseUntil:w.leaseUntil,open:false};}
    // A former controller may confirm only its own already-recorded schedule was paused.
    // This cannot change task state, ownership, authority or another harness's schedule.
    if(name==='updateCoordinationSession'&&w.controller!==actor&&args.schedule?.status==='paused'&&args.objective===undefined&&args.summary===undefined&&w.schedules?.[actor]&&args.schedule.id===w.schedules[actor]!.id){
      w.schedules[actor]={...w.schedules[actor]!,status:'paused',confirmedAt:new Date().toISOString()};this.save();return {revision:w.revision,data:{schedule:w.schedules[actor]}};
    }
    const isWrite=(COORDINATOR_TOOLS.find(t=>t.name===name)!.inputSchema.required as string[]).includes('requestId');
    // Reading state is not reconciliation acknowledgement.
    if(w.controller===actor&&w.mode!=='off'){w.leaseUntil=Date.now()+30*60000;this.save();}
    if(!isWrite){const result=await this.read(w,name,args);if(['getWorkspaceSummary','getCoordinationSession','openScopedWorkspace','listOwnerActionRequests','getControlCoverage'].includes(name)&&w.handoff?.from===actor&&w.handoff.state!=='requested')return {...result,coordinatorInstruction:pauseCheckins};return result;}
    if(w.handoff&&w.handoff.state!=='completed'&&!['updateCoordinationSession','completeHandoff','cancelCoordinatorHandoff','finishCoordinatorHandoff','retryCoordinatorHandoff'].includes(name))throw Error('Handoff requested. Stop new work and call completeHandoff with a current summary.');
    this.assertControl(w,actor);
    if(this.updater?.pending()&&['dispatchTask','followUpRun','runQA','executeRelease','prepareExternalCoordinator'].includes(name))throw Error('An application update is waiting. Existing runs can finish; new work resumes after restart.');
    const key=actor+':'+args.requestId;const digest=hash(JSON.stringify({name,args}));const existing=w.receipts[key];
    if(existing){if(existing.digest!==digest)throw Error('Request ID was already used with different arguments');const running=this.inFlight.get(key);if(running)return running;if(existing.state==='done')return this.receiptResult(w,existing);throw Error(existing.error??'Request outcome is uncertain. Inspect workspace and run history; do not blindly repeat.');}
    if(args.revision!==w.revision)throw Error(`Stale revision. Current revision is ${w.revision}; refresh session.`);
    // Reserve synchronously before any await. Unknown outcomes are never replayed.
    w.receipts[key]={digest,state:'pending'};w.revision++;w.leaseUntil=Date.now()+30*60000;this.save();
    const promise=(async()=>{try{const data=await this.mutate(w,name,args);const result={revision:w.revision,data};w.receipts[key]={digest,state:'done',result};this.event(w,name,{actor,requestId:args.requestId});return result;}catch(e){w.receipts[key]={digest,state:'failed',error:clip(e instanceof Error?e.message:'Action failed',1000)};this.save();throw e;}finally{this.inFlight.delete(key);}})();this.inFlight.set(key,promise);return promise;
  }
  private async appControl(w:Workspace,name:string,a:any):Promise<any>{
    const control=APP_CONTROLS.find(c=>c.tool.name===name);if(!control)throw Error('Unknown app control');
    if(w.path!==this.context?.repoPath&&!['openScopedWorkspace','listOwnerActionRequests'].includes(name))throw Error('Workspace is not open');
    if(control.startsWork&&(this.updater?.pending()||w.updateDrain))throw Error('Update wind-down is active. Reconnect after restart.');
    const {workspaceId,requestId,revision,...input}=a;
    if(input.runId!==undefined&&!control.action?.startsWith('saved-chat:'))this.run(input.runId);
    if(control.action?.startsWith('host:')){if(!this.appRuntime)throw Error('Desktop control unavailable');return this.appRuntime(control.action.slice(5),input,w.path);}
    if(control.action?.startsWith('saved-chat:')){
      if(!this.appRuntime)throw Error('Saved chats unavailable');
      const action=control.action;
      if(action==='saved-chat:list')return this.appRuntime(action,{ids:w.sharedChats??[]},w.path);
      if(action!=='saved-chat:create'&&!(w.sharedChats??[]).includes(input.conversationId))throw Error('Chat is not shared with this workspace. Request owner action share-chat first.');
      const result=await this.appRuntime(action,input,w.path);
      if(action==='saved-chat:create'){w.sharedChats??=[];w.sharedChats.push(result.conversation.id);this.save();}
      if(action==='saved-chat:delete')w.sharedChats=(w.sharedChats??[]).filter(id=>id!==input.conversationId);
      return result;
    }
    if(control.action==='attachment-upload'){if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.base64))throw Error('Invalid base64 attachment');return this.h()['attachments:upload']({contentType:input.contentType,data:Buffer.from(input.base64,'base64')});}
    if(control.action==='vault-entry-request'){const vault=await (await import('./vault-runtime.js')).vaultAction('status',{},w.id);const request={id:randomUUID(),action:'vault-entry',target:input.name,reason:input.reason,epoch:w.epoch,state:'pending',entry:{name:input.name,consumer:input.consumer,previousIds:vault.items.map((item:any)=>item.id)}};w.ownerActions??=[];w.ownerActions.push(request);this.event(w,'owner-action-requested',{id:request.id});return request;}
    if(control.action==='vault-status')return (await import('./vault-runtime.js')).vaultAction('status',{},w.id);
    if(control.action==='owner-actions')return w.ownerActions??[];
    if(control.action==='owner-action-request'){const request={id:randomUUID(),action:input.action,target:input.target,reason:input.reason,epoch:w.epoch,state:'pending'};w.ownerActions??=[];w.ownerActions.push(request);this.event(w,'owner-action-requested',{id:request.id});return request;}
    if(control.action==='queue-get')return w.queue??[];
    if(control.action==='queue-cancel'||control.action==='queue-update'){const queued=w.queue?.find(q=>q.id===input.id);if(!queued)throw Error('Assignment already started or does not exist');if(control.action==='queue-cancel'){w.queue=w.queue!.filter(q=>q.id!==input.id);return {cancelled:input.id};}Object.assign(queued,input);return queued;}
    if(control.action==='issue-labels'){const current=(await this.h()['issues:get']({number:input.number})).issue;const patch:any={};if(input.labels){const stage=(labels:string[])=>labels.filter(l=>l.startsWith('status:')).sort().join(',');if(stage(input.labels)!==stage(current.labels))throw Error('Use updateWorkflowCard to change stages');patch.labels=input.labels;}if(input.assignees)patch.assignees=input.assignees;return this.h()['issues:patch']({number:input.number,patch});}
    if(control.action==='api-metadata'){
      const handlers=getProviderHandlers();const settings=await handlers['providers:get']();const current=settings.apiConnections?.find(c=>c.id===input.connectionId);if(!current)throw Error('API connection does not exist');
      const {balanceUpdatedAt,organizationId,workspaceId,keyPreview,models,checkedAt,status,reportedSpend,spendCheckedAt,billingStatus,...editable}=current;
      return handlers['providers:save']({id:input.id,connection:{...editable,...input.changes}});
    }
    if(control.action==='routing-get')return routingState();
    if(control.action==='routing-save'){const result=saveRouting(input.config);invalidateCapacity();return result;}
    if(control.action==='capacity-refresh')return (await collectCapacity(false,true)).snapshot;
    if(control.action==='connections-list')return this.state.clients.filter(c=>c.workspaceId===w.id).map(({tokenHash,...c})=>c);
    if(control.action==='handoff-status')return {epoch:w.epoch,controller:w.controller,handoff:w.handoff??null,schedules:w.schedules??{}};
    if(control.action==='templates-list')return Object.values(this.state.templates??{});
    if(control.action==='template-remove'){const template=this.state.templates?.[input.id];if(!template)throw Error('Template not found');delete this.state.templates![input.id];this.event(w,'workflow-template-removed',{id:input.id,previous:template});return {removed:input.id};}
    if(control.action==='persona-restore'){const library=this.personaLibrary(w);const previous=library.history.find(h=>h.id===input.id&&h.previous?.version===input.version)?.previous;if(!previous)throw Error('Historical persona version not found');return editPersonaLibrary(library,'upsert',{persona:previous,reason:input.reason},w.controller!,w.autopilot?.personas.map(p=>p.id)??[]);}
    if(control.action==='question-explain')return this.uiAction('question-reply',{...input,explain:true});
    if(control.action==='chat-get')return {conversation:await this.uiAction('chat-get'),queue:w.chatOutbox??[]};
    if(control.action){const result=await this.uiAction(control.action,input,true);if(result?.workspaces&&result?.clients)return {...result,workspaces:result.workspaces.filter((x:any)=>x.id===w.id),clients:result.clients.filter((x:any)=>x.workspaceId===w.id)};return result;}
    const handler=(control.channel?.startsWith('providers:')?getProviderHandlers() as Partial<Handlers>:this.h())[control.channel as keyof Handlers];if(!handler)throw Error('App control unavailable');
    return (handler as (input:any)=>Promise<any>)(input);
  }
  private async read(w:Workspace,name:string,a:any):Promise<any>{
    if(name==='listPersonas')return this.personaLibrary(w);
    if(name==='getChanges'||name==='waitForChanges'){const start=Date.now();const wait=name==='waitForChanges'?(a.timeoutMs??20000):0;while(w.nextCursor-1<=(a.cursor??0)&&Date.now()-start<wait)await new Promise(r=>setTimeout(r,250));const events=w.events.filter(e=>e.cursor>(a.cursor??0)).slice(0,50);return {workflowVersion:w.workflow?.version??1,control:{controller:w.controller,mode:w.mode,leaseUntil:w.leaseUntil},handoff:w.handoff?{id:w.handoff.id,state:w.handoff.state,from:w.handoff.from,to:w.handoff.to}:null,pendingRequestIds:(w.requests??[]).filter(r=>r.state!=='completed').map(r=>r.id),checkIn:this.checkinPolicy(w,true),events,cursor:events.at(-1)?.cursor??a.cursor??0,resetRequired:(a.cursor??0)<(w.events[0]?.cursor??0)-1,revision:w.revision};}
    if(w.path!==this.context?.repoPath){if(name==='getCoordinatorRequests')return (w.requests??[]).filter(r=>r.state!=='completed');if(name==='getApplicationUpdate')return {...await this.updater?.check(),coordination:this.updateCoordination()};if(name==='getCoordinationSession')return {workspaceId:w.id,revision:w.revision,epoch:w.epoch,mode:w.mode,controller:w.controller,open:false,requests:(w.requests??[]).filter(r=>r.state!=='completed'),updateDrain:w.updateDrain,summary:w.summary};}
    const control=APP_CONTROLS.find(c=>c.tool.name===name);
    if(control&&!control.write)return this.appControl(w,name,a);
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
      case 'getRunResult': {
        const run = this.run(a.runId);
        const job = w.jobs.find(candidate => candidate.runId === run.id || candidate.reviewRunId === run.id);
        const events = this.context!.store.events.list(run.id);
        const text = events.filter(event => ['text', 'result'].includes(event.type))
          .map(event => clip(event.payload, 3000)).slice(-3).join('\n');
        let sha = null;
        try { sha = await this.revision(run.id); } catch { /* Active and uncommitted runs have no release revision. */ }
        return {
          ...this.compactRun(run.id), summary: clip(text, 4000), commit: sha, qa: job ?? null,
          assignment: job ? { role: job.reviewRunId === run.id ? 'reviewer' : job.role, readOnly: job.reviewRunId === run.id || job.readOnly === true || job.role === 'discovery',
            lastChange: job.reviewRunId === run.id ? null : job.assignmentHistory?.at(-1) ?? null } : null,
          checks: await h['agent-runs:checks:list']({ runId: run.id }),
          evidence: { logs: { tool: 'readRunLog', runId: run.id }, diff: { tool: 'getDiffSummary', runId: run.id } },
          waitingForInput: run.status === 'awaiting_input',
          nextAction: job?.state === 'review-checkpointed'
            ? 'Independent review is checkpointed, not failed. Read qa.reviewCheckpoint; resume the SAME reviewer run with followUpRun only after its next trigger is met.'
            : job?.state === 'checkpointed'
            ? 'Worker checkpointed with unfinished work. Read qa.checkpoint and its next trigger; the current coordinator decides when to continue the same run.'
            : runNextAction(run.status),
        };
      }
      case 'readRunLog':{this.run(a.runId);const rows=this.context!.store.events.list(a.runId).filter(e=>e.seq>(a.offset??-1));const items=rows.slice(0,a.limit??10).map(e=>({seq:e.seq,type:e.type,content:clip(e.payload,2000)}));return {items,nextCursor:items.at(-1)?.seq??a.offset??0,hasMore:rows.length>items.length};}
      case 'getDiffSummary':{const d=await h['agent-runs:diff']({runId:a.runId});if(a.file){const f=d.files.find(f=>f.path===a.file);return {file:a.file,patch:f?.patch.slice(a.offset??0,(a.offset??0)+8000),truncated:(f?.patch.length??0)>(a.offset??0)+8000};}return {files:d.files.map(f=>({path:f.path,status:f.status}))};}

      case 'getCapacity':return (await collectCapacity()).snapshot;
      case 'listDecisions': {
        const pending = await h['decisions:pending']();
        for (const proposal of w.decisions.filter(d => d.state === 'pending')) {
          if (!pending.some(d => d.cardId === proposal.cardId && d.options.some(o => o.value === proposal.value))) {
            proposal.state = 'superseded';
            this.event(w, 'decision-proposal-superseded', { id: proposal.id, cardId: proposal.cardId });
          }
        }
        return { pending, proposed: w.decisions.filter(d => d.state === 'pending'), authority: 'Active coordinator answers directly with answerDecision' };
      }
      case 'getReleaseStatus':return w.releases;
      default:throw Error('Unsupported read');
    }
  }
  private async mutate(w:Workspace,name:string,a:any):Promise<any>{
    if(name==='acknowledgeCoordinatorRequest'){const r=w.requests?.find(r=>r.id===a.id);if(!r)throw Error('Request not found.');if(r.state!=='completed'){r.state=a.state;r.receivedBy=w.controller!;}return r;}
    const control=APP_CONTROLS.find(c=>c.tool.name===name);if(control?.write)return this.appControl(w,name,a);
    const h=this.h();
    switch(name){
      case 'recordWorkflowEvent':if(!a.evidence.trim())throw Error('Record the exact revision and supporting evidence.');await this.workflowSignal(w,a.number,a.event,a.evidence,a.requestId);return workflowGuidance(w.workflow!,a.number);
      case 'upsertPersona':return editPersonaLibrary(this.personaLibrary(w),'upsert',a,w.controller!,[...(w.autopilot?.personas.map((p:any)=>p.id)??[]),...(w.workflow?.config.stages.flatMap(s=>s.personaId?[s.personaId]:[])??[])]);
      case 'removePersona':return editPersonaLibrary(this.personaLibrary(w),'remove',a,w.controller!,[...(w.autopilot?.personas.map((p:any)=>p.id)??[]),...(w.workflow?.config.stages.flatMap(s=>s.personaId?[s.personaId]:[])??[])]);
      case 'manageAutopilot':return this.manageAutopilot(w,a);
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
      case 'reconcileDispatch':{const pending=w.dispatchReservations?.[a.number];if(!pending||pending.id!==a.reservationId)throw Error('Dispatch reservation changed; refresh session');if(pending.state!=='uncertain')throw Error('Dispatch is still in progress');if(pending.threadId!==undefined){const runs=this.context!.store.agentRuns.listByThread(pending.threadId).filter(r=>!pending.priorRunIds?.includes(r.id));if(runs.length>1)throw Error('Multiple possible workers; inspect run history before reconciliation');if(runs.length===1){if(!pending.job)throw Error('Dispatch assignment missing');const run=runs[0]!;if(!w.jobs.some(j=>j.runId===run.id))w.jobs.push({...pending.job,runId:run.id});delete w.dispatchReservations![a.number];this.event(w,'dispatch-reconciled',{number:a.number,runId:run.id,evidence:a.evidence});return {number:a.number,runId:run.id,status:'adopted'};}}delete w.dispatchReservations![a.number];for(const stage of Object.values(w.stageAssignments??{}))if(stage.number===a.number&&['starting','blocked'].includes(stage.state)){stage.state='queued';delete stage.error;}this.event(w,'dispatch-reconciled',{number:a.number,status:'no-worker-created',evidence:a.evidence});return {number:a.number,status:'no-worker-created'};}
      case 'dispatchTask':if(a.origin!=='manual'&&w.autopilot&&w.autopilot.status!=='active')throw Error('Autopilot is Off. Resume it before assigning new work; review and release remain available.');return this.dispatch(w,a.number,a.budgetUsd??w.budgetUsd,a.qa??w.qaDefault,a.maxReworks??w.maxReworks,a.readOnly===true,false,a.origin!=='manual'&&!!w.autopilot);
      case 'setWorkerAssignment': {
        const job = w.jobs.find(candidate => candidate.runId === a.runId);
        if (!job) throw Error('Run is not a delegated worker assignment');
        const run = this.run(job.runId);
        const thread = this.context!.store.threads.findById(run.threadId);
        if (!thread || thread.issueNumber !== job.number) throw Error('Worker task identity does not match its assignment.');
        if (run.status === 'starting' || run.status === 'running') {
          throw Error('Wait for this worker to stop or await input before changing its assignment.');
        }
        if (job.reviewRunId && active(this.run(job.reviewRunId).status)) {
          throw Error('An independent reviewer is still active for this assignment.');
        }
        const previous = { role: job.role, readOnly: job.readOnly === true || job.role === 'discovery' };
        if (previous.role !== a.expectedRole || previous.readOnly !== a.expectedReadOnly) {
          throw Error('Worker assignment changed. Read getRunResult and use its current role and read-only state.');
        }
        const reason = a.reason.trim();
        const evidence = a.evidence.trim();
        if (!reason || !evidence) throw Error('Record the reason and explicit authorization evidence.');
        const next = { role: a.role as 'discovery'|'implementation', readOnly: a.role === 'discovery' };
        if (previous.role === next.role && previous.readOnly === next.readOnly) {
          return { changed: false, runId: run.id, number: job.number, assignment: next };
        }
        const change: AssignmentChange = {
          at: new Date().toISOString(), actor: w.controller!, requestId: a.requestId,
          from: previous, to: next, reason, evidence,
        };
        job.role = next.role;
        job.readOnly = next.readOnly;
        job.assignmentHistory ??= [];
        job.assignmentHistory.push(change);
        this.event(w, 'worker-assignment-changed', { runId: run.id, number: job.number, change });
        return { changed: true, runId: run.id, number: job.number, assignment: next, change };
      }
      case 'followUpRun': {
        const j = w.jobs.find(job => job.runId === a.runId || job.reviewRunId === a.runId);
        if (!j) throw Error('Run is not a delegated worker');
        if (a.origin !== 'manual' && j.autopilot && w.autopilot?.status !== 'active') {
          throw Error('Autopilot is Off. Resume it before continuing implementation.');
        }
        const run = this.run(a.runId);
        if (active(run.status) && run.status !== 'awaiting_input') {
          throw Error('Wait for this worker or stop it before following up.');
        }
        if (j.reviewRunId === a.runId) {
          if (!j.sha || await this.revision(j.runId) !== j.sha || await this.revision(run.id) !== j.sha) {
            throw Error('Review revision changed. Reconcile implementation and QA before continuing this review.');
          }
          const {control,result:resumed} = await resumeWithCheckpoint(this.root,j.reviewControlId,control=>this.context!.supervisor.resume({runId:run.id,appendSystemPrompt:control.prompt,
            prompt:control.prompt+a.message+'\n'+INDEPENDENT_REVIEW_AUTHORITY+'\nContinue the SAME independent review. Do not edit product files or author implementation commits. Preserve completed review evidence and inspect only the remaining authorized scope. End with KANBOTS_QA_PASS or KANBOTS_QA_FAIL only after a completed assessment; an external wait must return a pending checkpoint instead.\nImplementation commit: '+j.sha+'\nPrior review checkpoint: '+JSON.stringify(j.reviewCheckpoint??null),
            costBudgetUsd:j.budgetUsd}));
          j.reviewControlId=control.id;j.state='reviewing';delete j.error;
          this.event(w,'review-resumed',{runId:j.runId,reviewRunId:run.id,controlId:control.id});
          return {runId:run.id,implementationRunId:j.runId,state:j.state,status:resumed.status};
        }
        if (a.phase !== undefined) {
          if (!['implementation', 'testing'].includes(a.phase)) throw Error('Invalid continuation phase');
          if (j.readOnly === true || j.role === 'discovery') {
            const change: AssignmentChange = {
              at: new Date().toISOString(), actor: w.controller!, requestId: a.requestId,
              from: {role:j.role,readOnly:true}, to:{role:'implementation',readOnly:false},
              reason:`Coordinator advanced assignment to ${a.phase}`,
              evidence:a.message,
            };
            j.role='implementation';j.readOnly=false;
            (j.assignmentHistory??=[]).push(change);
            this.event(w,'worker-assignment-changed',{runId:j.runId,number:j.number,change});
            this.save();
          }
        }
        const freshContext = j.phaseContextPending === true;
        const assignmentChange = j.assignmentHistory?.at(-1);
        const assignmentContext = assignmentChange
          ? '\nExplicit saved assignment transition: ' + JSON.stringify(assignmentChange)
            + '\nUse this current assignment in place of earlier autogenerated role restrictions. The coordinator has superseded the earlier autogenerated inspection-only restriction; do not ask the owner to lift it again. Implement or test within the current authorized scope, including necessary reversible test fixtures. Preserve separately explicit owner holds, credentials, destructive-action permissions and release authority.\n'
          : '';
        const background = freshContext
          ? 'Phase checkpoint (historical evidence; current request follows):\n' + JSON.stringify(j.phaseCheckpoint) + '\n'
          : '';
        const {control,result:resumed} = await resumeWithCheckpoint(this.root,j.controlId,control=>this.context!.supervisor.resume({
          freshContext,
          appendSystemPrompt: control.prompt,
          runId: a.runId,
          prompt: control.prompt + background + a.message + assignmentContext
            + '\nWorkflow: ' + JSON.stringify(workflowGuidance(w.workflow ?? newWorkflow(), j.number))
            + '\n' + workerDeliveryInstructions(j.readOnly === true || j.role === 'discovery',!!j.stageAssignment&&w.workflow?.config.stages.find(s=>s.id===j.stageAssignment!.stageId)?.actor==='reviewer'),
          costBudgetUsd: j.budgetUsd,
        }));
        j.controlId = control.id;
        j.state = 'implementing';
        delete j.sha;
        delete j.checkIds;
        delete j.reviewRunId;
        delete j.error;
        j.phaseContextPending = false;
        j.workflowStartPending = control.id;
        this.save();
        try {
          await this.workflowSignal(w, j.number, 'worker-started', `Worker run ${run.id} resumed`, control.id);
          delete j.workflowStartPending;
          this.save();
        } catch (error) {
          this.event(w, 'worker-workflow-sync-pending', {
            runId: run.id, error: clip(error instanceof Error ? error.message : 'Workflow synchronization failed'),
          });
        }
        return resumed;
      }
      case 'stopRun':{const j=w.jobs.find(j=>j.runId===a.runId||j.reviewRunId===a.runId);if(j){j.state='interrupted';j.error='Interrupted—recovery needed';this.save();}return h['agent-runs:stop']({runId:a.runId});}
      case 'answerDecision':{const pending=await h['decisions:pending']();const original=pending.find(d=>d.cardId===a.cardId&&d.options.some(o=>o.value===a.value));if(!original)throw Error('Pending decision/option not found');const d={id:randomUUID(),cardId:a.cardId,value:a.value,question:original.question,label:original.options.find(o=>o.value===a.value)!.label,state:'executing'};w.decisions.push(d);this.save();try{const result=await h['cards:resolve']({cardId:a.cardId,value:a.value});d.state='answered';return {...d,result};}catch(e){d.state='failed';throw e;}}
      case 'configureWorkflow':return this.uiAction('settings',{parallelism:a.parallelism??w.parallelism,releaseParallelism:a.releaseParallelism??w.releaseParallelism??4,budgetUsd:a.budgetUsd??w.budgetUsd,qaDefault:a.qaDefault??w.qaDefault,maxReworks:a.maxReworks??w.maxReworks});
      case 'runQA':{let j=w.jobs.find(j=>j.runId===a.runId);if(!j){const r=this.run(a.runId);const t=this.context!.store.threads.findById(r.threadId);if(!t)throw Error('Task not found');j={runId:r.id,number:t.issueNumber,role:'implementation',qa:true,maxReworks:0,reworks:0,budgetUsd:a.budgetUsd??w.budgetUsd,state:'implementing'};w.jobs.push(j);}j.qa=true;j.manualQA=true;await this.startQA(w,j);return j;}
      case 'prepareRelease':{const sha=await this.revision(a.runId);const qaPassed=w.jobs.some(j=>j.runId===a.runId&&j.state==='qa-passed'&&j.sha===sha);if(!/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(a.targetBranch)||a.targetBranch.includes('..'))throw Error('Invalid target branch');const targetSha=await this.git(w.path,['rev-parse',`refs/heads/${a.targetBranch}`]);const r:Release={id:randomUUID(),runId:a.runId,sha,targetBranch:a.targetBranch,targetSha,action:a.action,state:'ready',...(a.title?{title:a.title}:{}),...(a.body?{body:a.body}:{})};w.releases.push(r);return {...r,warnings:qaPassed?[]:['Passing QA is not recorded for this revision. The coordinator decides whether to proceed.'],nextAction:'Call executeRelease when you decide to release this revision.'};}
      case 'reconcileRelease':{const r=w.releases.find(r=>r.id===a.releaseId);if(!r)throw Error('Release not found');if(this.releaseInFlight.has(r.id))throw Error('Release is still executing');if(r.state==='completed')return r;if(!['executing','failed','uncertain'].includes(r.state))throw Error('Release has no uncertain execution to reconcile');if(r.action==='merge'){const line=(await this.git(w.path,['rev-list','--parents','-n','1',`refs/heads/${r.targetBranch}`])).trim().split(/\s+/);if(line.length!==3||line[1]!==r.targetSha||line[2]!==r.sha)throw Error('Exact merge outcome is not proven; preserve this plan and inspect target history');r.result={merged:true,commit:line[0],target:r.targetBranch,reconciled:true};}else{const branch=`kanbots-release/${r.id}`,source=this.context!.source;if(!source.findOpenPullForBranch)throw Error('PR lookup unavailable');const pr=await source.findOpenPullForBranch(branch);if(!pr||pr.head!==branch||pr.base!==r.targetBranch)throw Error('Matching PR not found; do not repeat publication blindly');const remote=(await this.git(w.path,['ls-remote','origin',`refs/heads/${branch}`])).trim().split(/\s+/)[0];if(remote!==r.sha)throw Error('Published branch revision does not match release');r.result=pr;}r.state='completed';this.event(w,'release-reconciled',{id:r.id,result:r.result,evidence:a.evidence});return r;}
      case 'executeRelease':if(w.workflow?.config.releaseOwner==='user'&&!w.releases.some(r=>r.id===a.releaseId&&r.state==='approved'))throw Error('This workflow reserves releases for the user. Ask for the owner decision or an explicitly requested policy change.');return this.executeRelease(w,String(a.releaseId));
      default:throw Error('Unsupported action');
    }
  }
  private async manageAutopilot(w:Workspace,a:any){
    if(a.releaseParallelism!==undefined&&(!Number.isSafeInteger(a.releaseParallelism)||a.releaseParallelism<1))throw Error('Choose a positive whole number of release workers.');
    this.reconcileUpdateWindDown();
    if(a.action==='start'){
      if(!a.personas?.length)throw Error('Choose at least one perspective.');
      if(w.autopilot?.status==='active')throw Error('An autopilot assignment is already active. Update or pause it through your coordinator.');
      const legacy=await this.h()['autopilot:list-active']();
      for(const loop of legacy)await this.h()['autopilot:stop']({sessionId:loop.id,stopChildren:false});
      if(w.mode==='off')await this.uiAction('handoff',{mode:'internal'});
      w.autopilot={status:'active',personas:a.personas,effort:a.effort??'medium',parallelism:a.parallelism??1,objective:a.objective??'Continuously discover and deliver useful improvements within the project scope.',updatedAt:new Date().toISOString(),legacyWork:legacy.flatMap((loop:any)=>loop.children??[])};
    }else{
      if(!w.autopilot)throw Error('No autopilot assignment exists for this project.');
      if(a.action==='pause'||a.action==='expedite'){w.autopilot.status='paused';if(w.updateDrain)w.updateDrain.priorStatus='paused';}if(a.action==='expedite'){w.expediting=true;this.save();for(const j of w.jobs.filter(j=>j.autopilot||w.updateDrain)){for(const id of [j.controlId,j.reviewControlId])if(id)requestCheckpoint(this.root,id);}}
      if(a.action==='resume'){if(w.updateDrain)throw Error('An update is winding down. Cancel the update before turning On.');if(w.mode==='off')await this.uiAction('handoff',{mode:'internal'});w.autopilot.status='active';w.expediting=false;}
      if(a.action==='complete')w.autopilot.status='completed';
      if(a.personas)w.autopilot.personas=a.personas;if(a.effort)w.autopilot.effort=a.effort;if(a.parallelism)w.autopilot.parallelism=a.parallelism;if(a.objective!==undefined)w.autopilot.objective=a.objective;w.autopilot.updatedAt=new Date().toISOString();
    }
    w.releaseParallelism=a.releaseParallelism??w.releaseParallelism??4;
    const plan=w.autopilot!;w.parallelism=plan.parallelism;
    for(const r of w.requests??[])if(r.kind==='autopilot'&&r.state!=='completed')r.state='completed';
    w.requests??=[];w.requests.push({id:randomUUID(),kind:'autopilot',state:'queued',createdAt:new Date().toISOString(),prompt:`Autopilot ${a.action}: ${JSON.stringify(plan)}. The current implementation lane target is ${plan.parallelism}, with ${w.releaseParallelism??4} separate reviewer/release lanes. These saved settings supersede numerical concurrency targets in older summaries. A prior worker checkpoint is task-scoped, not a workspace-wide publication hold. ${INDEPENDENT_REVIEW_AUTHORITY} You are the sole coordinator and user-facing contact. Read current session, workflow, requests, active workers and decisions. ${plan.status==='active'?'Create or update a parent objective card and link discovered work. Delegate read-only discovery using the selected perspectives through dispatchTask; deduplicate against existing work, prioritize and dispatch implementation and independent QA using the shared automatic routing and funding policies. Maintain the requested number of active workers, replenishing completed work with distinct authorized assignments. Queue approved work ahead so vacant slots refill immediately. If useful work cannot fill the target, record the concrete blocker and next action. Continue the authorized objective after results arrive; report meaningful results and blockers through this same coordinator.':'Do not create new autopilot assignments. Existing workers are preserved; observe their outcomes and report through this same coordinator.'} Do not start the legacy independent autopilot loop or pin a stale model. Adopt the listed legacy workers without restarting or duplicating them. Pause/resume/update/complete this assignment with manageAutopilot; do not claim a change before saving it. Follow the project workflow and existing release authority. Ownership follows coordinator handoffs; no separate harness or reminder is needed.`});
    w.revision++;this.event(w,'autopilot-updated',{status:plan.status,actor:w.controller});if(plan.status==='active')await this.refillReadyWork(w);return this.ui();
  }
  private async workflowAction(w:Workspace,action:string,a:any,actor:string):Promise<any>{
    const issues=await this.h()['issues:list']({state:'all'});w.workflow??=newWorkflow();const flow=w.workflow;const countBefore=Object.keys(flow.cards).length;materialize(flow,issues);
    const view=()=>({version:flow.version,config:flow.config,cards:flow.cards,stageOrder:flow.stageOrder??{},history:flow.history,templates:Object.values(this.state.templates??{}),issues:issues.map(i=>({...i,running:!!i.activeRun})),undo:flow.history.length?undoWorkflowChange(flow,'Undo last workflow change'):null});
    if(action==='get'){if(Object.keys(flow.cards).length!==countBefore)this.save();return view();}
    const toolName=({preview:'previewWorkflowChange',apply:'applyWorkflowChange',undo:'undoWorkflowChange',card:'updateWorkflowCard',template:'saveWorkflowTemplate'} as Record<string,string>)[action];
    if(!toolName)throw Error('Unknown workflow action.');
    if(actor==='user')validateCoordinatorArgs(toolName,{workspaceId:w.id,...(action==='preview'?{}:{requestId:'app-workflow-edit',revision:w.revision}),...a});
    if(['preview','apply'].includes(action)&&a.config){const known=new Set(this.personaLibrary(w).items.map(p=>p.id));for(const stage of a.config.stages)if(stage.personaId&&!known.has(stage.personaId))throw Error(`${stage.name}: assigned persona no longer exists. Choose a workspace persona.`);}
    if(action==='preview')return previewWorkflow(flow,a,issues);
    if(action==='template'){if(!/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(a.id)||!a.name?.trim())throw Error('Choose a template name and identity.');this.state.templates??={};const old=this.state.templates[a.id];const saved={id:a.id,name:a.name,version:(old?.version??0)+1,config:structuredClone(flow.config),updatedAt:new Date().toISOString(),actor};this.state.templates[a.id]=saved;this.event(w,'workflow-template-saved',{id:a.id,version:saved.version,actor});return view();}
    if(action==='card'){
      if(a.priorityStage!==undefined || a.beforeNumber!==undefined){
        if(typeof a.priorityStage!=='string'||!(a.beforeNumber===null||Number.isInteger(a.beforeNumber))||a.to!==undefined)throw Error('Provide priorityStage and beforeNumber together without a stage move.');
        reorderWorkflowCard(flow,a.number,a.priorityStage,a.beforeNumber,new Set([...issues.filter(i=>i.activeRun).map(i=>i.number),...w.jobs.filter(j=>active(this.run(j.runId).status)||(j.reviewRunId&&active(this.run(j.reviewRunId).status))).map(j=>j.number)]),actor);
        w.revision++;this.event(w,'workflow-changed',{number:a.number,stageId:a.priorityStage,reason:'Waiting-work priority changed',actor});return view();
      }
      const previous=flow.cards[a.number]?.stageId;const data=moveWorkflowCard(flow,a,actor);if(previous!==data.stageId)this.queueStageAssignment(w,a.number);const job=[...w.jobs].reverse().find(j=>j.number===a.number);if(job&&previous!==data.stageId)await this.phaseContext(w,job,'Stage: '+data.stageId,a.reason+'\n'+a.evidence);w.revision++;this.event(w,'workflow-card-updated',{number:a.number,stageId:data.stageId,workflowVersion:flow.version,actor});return view();
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
    this.queueStageAssignment(w,number);
    if(event!=='worker-started'&&!flow.config.stages.find(s=>s.id===flow.cards[number]?.stageId)?.personaId){w.requests??=[];w.requests.push({id:'workflow-event:'+identity,kind:'workflow-action',state:'queued',createdAt:new Date().toISOString(),prompt:`Card #${number}: ${event}. ${evidence}. Read getIssue and its current workflow guidance, then take the next authorized action. Preserve completed evidence; do not rerun QA without a reason.`});}
    const job=[...w.jobs].reverse().find(j=>j.number===number);if(job&&['worker-completed','qa-passed','merged'].includes(event))await this.phaseContext(w,job,event,card.nextAction??evidence);
    this.event(w,'workflow-event',{number,event,workflowVersion:flow.version,evidence});
  }
  private queueStageAssignment(w:Workspace,number:number,persist=true){
    const card=w.workflow?.cards[number],stage=w.workflow?.config.stages.find(s=>s.id===card?.stageId);
    if(!card||!stage?.personaId||stage.category==='done')return;
    const entry=stage.id+':'+card.history.length+':'+card.enteredAt;
    const key=number+':'+entry;w.stageAssignments??={};
    w.stageAssignments[key]??={number,stageId:stage.id,entry,state:'queued'};
    card.owner=stage.personaId;card.nextAction='Assigned to '+(this.personaLibrary(w).items.find(p=>p.id===stage.personaId)?.name??stage.personaId);
    if(persist)this.save();
  }
  private async finishStageAssignment(w:Workspace,j:Job){
    const a=j.stageAssignment!,flow=w.workflow!,card=flow.cards[j.number];
    const receipt=readStageDisposition(this.root,j.controlId!);
    if(!receipt){j.state='awaiting-review';j.error='Stage worker finished without a saved disposition. Record acceptance or corrections before handoff.';this.event(w,'stage-disposition-needed',{runId:j.runId,number:j.number});return;}
    const from=flow.config.stages.find(s=>s.id===a.stageId);
    if(!card||receipt.entry!==a.entry||receipt.workflowVersion!==flow.version||a.workflowVersion!==flow.version||card.stageId!==a.stageId||a.entry!==card.stageId+':'+card.history.length+':'+card.enteredAt||from?.personaId!==a.personaId)throw Error('Stage disposition is stale; reconcile the current assignment before handoff');
    if(card.waiting?.owner==='user')throw Error('Stage handoff is waiting for the recorded owner decision: '+card.waiting.trigger);
    if(!flow.config.transitions.some(t=>t.from===from.id&&t.to===receipt.to&&t.actor===from.actor&&!['coordinator','user'].includes(t.actor)))throw Error('Stage worker is not authorized for this transition');
    const target=flow.config.stages.find(s=>s.id===receipt.to);
    if(!target||receipt.to===from.id)throw Error('Choose a distinct configured target stage');
    if(flow.config.releaseOwner==='user'&&target.category==='done'&&['implementation','release'].includes(card.taskType))throw Error('Owner-reserved release completion requires the owner decision');
    moveWorkflowCard(flow,{number:j.number,to:receipt.to,reason:receipt.reason,evidence:receipt.evidence,checks:receipt.checks},'persona:'+a.personaId+' / run:'+j.runId);
    j.state='completed';delete j.error;this.queueStageAssignment(w,j.number);this.event(w,'stage-disposition-applied',{number:j.number,runId:j.runId,from:from.id,to:receipt.to,evidence:receipt.evidence});this.save();
  }
  private async readRequiredPullRequestChecks(runId:number) {
    const run=this.run(runId);
    if(!run.worktreePath||!run.branchName)throw Error('PR lookup requires the implementation worktree and branch.');
    const options={cwd:run.worktreePath,timeout:30000,maxBuffer:2e6};
    const read=async()=>JSON.parse((await exec('gh',['pr','view',run.branchName!,'--json','number,url,headRefOid,state,isDraft'],options)).stdout);
    const pr=await read();
    if(pr.state!=='OPEN'||pr.isDraft)throw Error('Independent review requires an open, ready PR.');
    let output:string;let policy:'required'|'all-reported'='required';
    const args=['pr','checks',String(pr.number),'--json','name,bucket,state,link,completedAt'];
    try {output=(await exec('gh',[...args,'--required'],options)).stdout;}
    catch(error){
      const e=error as {code?:number;stdout?:string;stderr?:string};
      if((e.code===1||e.code===8)&&e.stdout?.trim().startsWith('['))output=e.stdout;
      else if(e.code===1&&/no required checks reported/i.test((e.stderr??'')+(e.stdout??''))){
        policy='all-reported';
        try{output=(await exec('gh',args,options)).stdout;}catch(failure){const result=failure as {code?:number;stdout?:string};if((result.code===1||result.code===8)&&result.stdout?.trim().startsWith('['))output=result.stdout;else throw failure;}
      }else throw error;
    }
    const reported=JSON.parse(output) as Array<{name:string;bucket:string;link:string}>;
    // Conditional jobs are not required when the repository has no required-check
    // policy. Keep them in evidence, but demand a real successful check as well.
    const checks=policy==='required'?reported:reported.filter(c=>c.bucket!=='skipping');
    if((await read()).headRefOid!==pr.headRefOid)throw Error('PR head changed while checking CI; retrying the new head.');
    return {head:pr.headRefOid as string,url:pr.url as string,checks,reported,policy};
  }
  private async reconcileCheckpointCI(w:Workspace,j:Job) {
    if(j.stageAssignment||j.role!=='implementation'||j.readOnly||!['checkpointed','awaiting-review'].includes(j.state))return;
    if(active(this.run(j.runId).status)||w.jobs.some(other=>other!==j&&other.number===j.number&&other.runId>j.runId))return;
    const card=w.workflow?.cards[j.number],flow=w.workflow;
    const current=flow?.config.stages.find(s=>s.id===card?.stageId);
    if(!flow||!card||!current||!['inProgress','review'].includes(current.category))return;
    const unanswered=w.questions?.find(q=>q.runId===j.runId&&(q.state==='pending'||(q.state==='answered'&&q.answerRequestId&&w.requests?.find(r=>r.id===q.answerRequestId)?.state!=='completed')));
    if(unanswered){j.error=unanswered.state==='pending'?'Question '+unanswered.id+' still needs an answer.':'Answer '+unanswered.id+' is saved; coordinator reconciliation is pending.';card.nextAction=j.error;this.save();return;}
    if(Date.now()-(j.ciCheckedAt??0)<60000)return;
    j.ciCheckedAt=Date.now();
    if(card.waiting&&(card.waiting.owner==='user'||card.waiting.reason!=='CI')){j.error='Waiting for '+card.waiting.owner+': '+card.waiting.trigger;card.nextAction=j.error;this.save();return;}
    try{
      const ci=await this.readRequiredPullRequestChecks(j.runId);
      if(!ci.checks.length)throw Error('Required GitHub checks could not be established; configure or verify the PR required checks.');
      const incomplete=ci.checks.filter(c=>c.bucket!=='pass');
      if(incomplete.length)throw Error('Required GitHub CI: '+incomplete.map(c=>c.name+' ('+c.bucket+')').join(', '));
      if(await this.revision(j.runId)!==ci.head)throw Error('Local implementation revision differs from the current PR head; reconcile the saved worktree before review.');
      const target=current.id==='review'||current.actor==='reviewer'?current:flow.config.stages.find(s=>s.category==='review'&&(s.actor==='reviewer'||s.id==='review'));
      if(!target?.personaId)throw Error('Review stage has no assigned reviewer persona.');
      const evidence=JSON.stringify({source:'GitHub required CI',...ci,implementationRunId:j.runId});
      if(current.id!==target.id&&!flow.config.transitions.some(t=>t.from===current.id&&t.to===target.id&&t.automatic))throw Error('Workflow has no automatic transition from '+current.name+' to '+target.name+'.');
      moveWorkflowCard(flow,{number:j.number,to:target.id,reason:'Required CI passed on current PR head',evidence,checks:[{id:'deliverable',outcome:'pass',evidence}],clearWaiting:card.waiting?.reason==='CI'},'system:github-ci');
      j.sha=ci.head;j.ciReview={...ci,checkedAt:new Date().toISOString()};j.state='review-queued';delete j.error;
      this.queueStageAssignment(w,j.number,false);
      this.event(w,'ci-review-ready',{number:j.number,implementationRunId:j.runId,head:ci.head,url:ci.url,stageId:target.id,personaId:target.personaId});
    }catch(error){const reason=clip(error instanceof Error?error.message:'CI reconciliation failed',1500);j.error=reason;card.nextAction=reason;this.save();}
  }
  private async dispatchStageAssignments(w:Workspace){
    if(w.mode==='off'||w.updateDrain||this.updater?.pending()||(w.handoff&&w.handoff.state!=='completed'))return;
    for(const assignment of Object.values(w.stageAssignments??{})){
      if(['starting','blocked'].includes(assignment.state)){
        const existing=w.jobs.find(j=>j.number===assignment.number&&j.stageAssignment?.entry===assignment.entry);
        if(existing){assignment.runId=existing.runId;assignment.state='dispatched';delete assignment.error;this.save();}
        else if(assignment.state==='starting'&&!w.dispatchReservations?.[assignment.number]){assignment.state='queued';this.save();}
      }
      if(assignment.state!=='queued')continue;
      const card=w.workflow?.cards[assignment.number],stage=w.workflow?.config.stages.find(s=>s.id===assignment.stageId);
      if(!card||card.stageId!==assignment.stageId||assignment.entry!==stage?.id+':'+card.history.length+':'+card.enteredAt||!stage?.personaId){assignment.state='superseded';continue;}
      if(card.waiting){assignment.error='Waiting for '+card.waiting.owner+': '+card.waiting.trigger;card.nextAction=assignment.error;this.save();continue;}
      if(w.jobs.some(j=>j.number===assignment.number && (active(this.run(j.runId).status) || (j.reviewRunId && active(this.run(j.reviewRunId).status)) || ['implementing','checks','reviewing'].includes(j.state))))continue;
      const implementation=[...w.jobs].reverse().find(j=>j.number===assignment.number&&!j.stageAssignment&&j.role==='implementation');
      if(implementation&&['checkpointed','awaiting-review'].includes(implementation.state)){
        assignment.error=implementation.error??'Checkpointed implementation is awaiting exact-head CI evidence.';
        card.nextAction=assignment.error;this.save();continue;
      }
      if(implementation?.ciReview){
        try{
          const ci=await this.readRequiredPullRequestChecks(implementation.runId);
          if(ci.head!==implementation.ciReview.head||!ci.checks.length||ci.checks.some(c=>c.bucket!=='pass')){
            implementation.state='checkpointed';implementation.ciCheckedAt=0;delete implementation.ciReview;
            throw Error('PR head or required CI changed before reviewer dispatch; rechecking current revision.');
          }
        }catch(error){assignment.error=clip(error instanceof Error?error.message:'CI verification unavailable');card.nextAction=assignment.error;this.save();continue;}
      }
      if(this.releaseStage(w,stage.id)&&this.laneUsage(w).release>=(w.releaseParallelism??4)){assignment.error='Waiting for a release lane ('+(w.releaseParallelism??4)+' configured)';card.nextAction=assignment.error;this.save();continue;}
      const persona=this.personaLibrary(w).items.find(p=>p.id===stage.personaId);
      if(!persona){assignment.state='blocked';assignment.error='Assigned persona is missing';continue;}
      assignment.state='starting';this.save();
      try{const result=await this.dispatch(w,assignment.number,w.budgetUsd,false,0,false,true,false,{workflowVersion:w.workflow!.version,stageId:stage.id,entry:assignment.entry,personaId:persona.id,personaVersion:persona.version,prompt:persona.prompt});if(result.runId===undefined)throw Error('Stage dispatch did not create a run');assignment.runId=result.runId;assignment.state='dispatched';this.event(w,'stage-persona-dispatched',{...assignment,personaId:persona.id,personaVersion:persona.version});}
      catch(e){assignment.state='blocked';assignment.error=e instanceof Error?e.message:'Stage dispatch failed';card.nextAction=assignment.error;this.event(w,'stage-persona-blocked',{...assignment});}
      this.save();
    }
  }
  private async dispatch(w:Workspace,number:number,budgetUsd:number,qa:boolean,maxReworks:number,readOnly=false,fromQueue=false,autopilot=!!w.autopilot,stageAssignment?:StageAssignment){
    if(w.dispatchReservations?.[number])throw Error('This task has an unresolved dispatch reservation. Reconcile its existing worker before assigning it again.');
    if(w.jobs.some(j=>j.number===number&&['implementing','checks','reviewing'].includes(j.state)))throw Error('This task already has an active pipeline.');
    const releaseLane=this.releaseStage(w,stageAssignment?.stageId);
    if(releaseLane&&this.laneUsage(w).release>=(w.releaseParallelism??4))throw Error('Waiting for an available release lane');
    const waiting=!releaseLane&&autopilot&&this.laneUsage(w).implementation>=(w.autopilot?.parallelism??w.parallelism);
    if(waiting&&!fromQueue){w.queue??=[];let queued=w.queue.find(q=>q.number===number);if(!queued){queued={autopilot,id:randomUUID(),number,budgetUsd,qa,maxReworks,readOnly};w.queue.push(queued);this.event(w,'task-queued',queued);}return {queueId:queued.id,number,status:'queued',nextAction:'Waiting for worker capacity; adjust configureWorkflow to change parallelism'};}
    if(waiting)throw Error('Task is still waiting for worker capacity');
    w.dispatchReservations??={};const reservation:NonNullable<Workspace['dispatchReservations']>[string]={lane:releaseLane?'release':'implementation',autopilot,id:randomUUID(),at:new Date().toISOString(),state:'preparing'};w.dispatchReservations[number]=reservation;this.save();
    try{
    const issue=(await this.h()['issues:get']({number})).issue;const thread=this.context!.store.threads.getOrCreate({repoOwner:(await this.h()['config:get']()).owner,repoName:(await this.h()['config:get']()).repo,issueNumber:number});
    w.workflow??=newWorkflow();materialize(w.workflow,[issue]);
    const guidance='\nWorkflow contract: '+JSON.stringify(workflowGuidance(w.workflow,number))+(autopilot&&w.autopilot?`\nAutopilot effort: ${w.autopilot.effort}. Objective: ${w.autopilot.objective}. Stay within this task and its acceptance criteria.\n`:'');
    if((autopilot&&w.autopilot?.status!=='active')||w.updateDrain||this.updater?.pending())throw Error('New assignments are paused.');
    const prior=stageAssignment?[...w.jobs].reverse().find(j=>j.number===number):undefined;
    const stageBase=prior?await this.revision(prior.runId):undefined;
    const stageEvidence=stageAssignment?'\nPrior stage evidence: '+JSON.stringify({runId:prior?.runId,revision:stageBase,checkpoint:prior?.phaseCheckpoint??prior?.checkpoint,card:w.workflow.cards[number],instruction:'Read the referenced run result and exact diff. Preserve prior evidence; do not repeat completed work.'}):'';
    const control=createCheckpoint(this.root);
    reservation.threadId=thread.id;reservation.priorRunIds=this.context!.store.agentRuns.listByThread(thread.id).map(r=>r.id);reservation.job={...(stageAssignment?{stageAssignment:{...stageAssignment,...(stageBase?{baseRevision:stageBase}:{})}}:{}),readOnly,controlId:control.id,autopilot,number,role:readOnly?'discovery':'implementation',qa:readOnly?false:qa,maxReworks,reworks:0,budgetUsd,state:'implementing'};
    reservation.state='starting';this.save();
    const run=await this.context!.supervisor.start({appendSystemPrompt:control.prompt,threadId:thread.id,issueNumber:number,...(stageBase?{baseRef:stageBase}:{}),prompt:(stageAssignment?stageDispositionPrompt(this.root,control.id,stageAssignment.entry,w.workflow!.version)+stageAssignment.prompt+'\nStage assignment: '+stageAssignment.stageId+'. Follow existing tool and release permissions; stage ownership grants no additional authority.\n':'')+stageEvidence+guidance+workerDeliveryInstructions(readOnly,!!stageAssignment&&w.workflow!.config.stages.find(s=>s.id===stageAssignment.stageId)?.actor==='reviewer')+'\n\n'+issue.title+'\n'+(issue.body??''),costBudgetUsd:budgetUsd,provider:'claude-code',personaId:stageAssignment?.personaId??'implementation'});
    const j:Job={...(stageAssignment?{stageAssignment:{...stageAssignment,...(stageBase?{baseRevision:stageBase}:{})}}:{}),readOnly,controlId:control.id,autopilot,runId:run.id,number,role:readOnly?'discovery':'implementation',qa:readOnly?false:qa,maxReworks,reworks:0,budgetUsd,state:'implementing'};w.jobs.push(j);delete w.dispatchReservations[number];this.save();if(!stageAssignment)await this.workflowSignal(w,number,'worker-started',`Worker run ${run.id} started`,String(run.id));this.save();return {runId:run.id,number,status:run.status,qa,prerequisites:w.dependencies[number]??[],nextAction:'Use waitForChanges'};
    }catch(error){if(w.dispatchReservations[number]){if(reservation.state==='preparing')delete w.dispatchReservations[number];else{reservation.state='uncertain';(reservation as any).error='Worker start outcome is uncertain. Inspect run history before clearing this reservation.';}this.save();}throw error;}
  }
  private async phaseContext(w:Workspace,j:Job,phase:string,nextAction:string){
    const issue=(await this.h()['issues:get']({number:j.number})).issue;
    const checkpoint={phase,at:new Date().toISOString(),workflowVersion:w.workflow?.version??1,
      task:{number:j.number,title:issue.title,objective:clip(issue.body??'',6000),objectiveTruncated:(issue.body??'').length>6000},
      evidence:{implementationRun:j.runId,commit:j.sha??null,checkIds:j.checkIds??[],reviewRun:j.reviewRunId??null},
      guidance:workflowGuidance(w.workflow??newWorkflow(),j.number),nextAction:clip(nextAction,6000),workerCheckpoint:j.checkpoint??null,
      decisionReferences:{tool:'listDecisions',instruction:'Read pending decisions and current owner constraints before taking action; do not treat omitted history as authorization.'},
      references:{task:'getIssue',implementation:'getRunResult',checks:'getRunResult',workflow:'getWorkflow'},
      constraints:'Same task and worktree. Preserve existing work and exact evidence. Inspect referenced records for omitted detail. Gate passage does not authorize merge/deployment or prove later phases complete.'};
    j.phaseCheckpoint=checkpoint;j.phaseContextPending=true;this.event(w,'context-checkpoint',{number:j.number,runId:j.runId,checkpoint});
    return 'Phase handoff (full histories retained in run records):\n'+JSON.stringify(checkpoint);
  }
  private async startQA(w:Workspace,j:Job){j.sha=await this.revision(j.runId);const checks=await this.h()['agent-runs:checks:run']({runId:j.runId});j.checkIds=checks.map(c=>c.id);j.state='checks';delete j.error;this.event(w,'qa-started',{runId:j.runId,sha:j.sha});}
  private async repair(w:Workspace,j:Job,reason:string){
    if (j.readOnly === true || j.role === 'discovery') {
      j.state = 'needs-changes';
      j.error = reason;
      await this.workflowSignal(w, j.number, 'worker-failed', reason, `${j.controlId??j.runId}:readonly-review`);
      this.event(w, 'read-only-findings', { runId: j.runId, reason });
      return;
    }
    if(j.autopilot&&w.autopilot?.status!=='active'){j.state='needs-changes';j.error=reason;this.event(w,'wind-down-checkpoint',{runId:j.runId,remaining:reason});return;}
    if(j.reworks>=j.maxReworks){j.state='needs-changes';j.error=reason;await this.workflowSignal(w,j.number,'worker-failed',reason,`${j.controlId??j.runId}:${j.reworks}`);this.event(w,'needs-changes',{runId:j.runId,reason});return;}
    const checkpoint=await this.phaseContext(w,j,'QA correction',reason);const control=createCheckpoint(this.root);j.controlId=control.id;j.reworks++;j.state='implementing';delete j.reviewRunId;delete j.sha;this.save();await this.context!.supervisor.resume({freshContext:true,appendSystemPrompt:control.prompt,runId:j.runId,prompt:checkpoint+'\nFix only the reported findings, rerun relevant checks, and commit locally.\n'+workerDeliveryInstructions(false),costBudgetUsd:j.budgetUsd});j.phaseContextPending=false;this.event(w,'rework-started',{runId:j.runId,attempt:j.reworks});
  }
  private recordWorkerCheckpoint(w:Workspace,j:Job,runId:number,controlId:string,checkpoint:NonNullable<ReturnType<typeof readCheckpoint>>,review=false){
    if(review)j.reviewCheckpoint=checkpoint;else j.checkpoint=checkpoint;
    j.state=review?'review-checkpointed':'checkpointed';
    j.error=review?'Independent review checkpoint saved; assessment remains pending.':'Checkpoint saved; implementation or validation remains. Coordinator review required.';
    if(checkpoint.waiting){
      const id=`worker-wait:${runId}:${controlId}`;w.requests??=[];
      if(!w.requests.some(r=>r.id===id))w.requests.push({id,kind:'workflow-action',state:'queued',createdAt:new Date().toISOString(),
        prompt:`${review?'Independent reviewer':'Worker'} run ${runId} / implementation ${j.runId} / task ${j.number} returned an external-wait checkpoint, not task completion or QA failure. ${JSON.stringify(checkpoint.waiting)}. Read getRunResult and preserve exact evidence. You own the next bounded check and any eligible followUpRun continuation of the SAME ${review?'reviewer':'worker'} run. Do not start a replacement watcher, repeat completed tests, infer success from missing status, turn Autopilot On, or install an update just because this worker is idle.`});
    }
    this.event(w,'worker-checkpointed',{runId,implementationRunId:j.runId,review,checkpoint});
  }
  private async deliverHandoff(w:Workspace){
    const h=w.handoff;if(!h||h.state!=='requested'||w.mode!=='internal'||!w.conversationId)return;
    if(h.delivery==='sending'||h.delivery==='failed')return;
    const chat=await this.h()['chat:get']({conversationId:w.conversationId});
    const working=chat.activeRun&&chat.activeRun.status!=='awaiting_input';
    if(h.delivery==='sent'){
      if(!working){h.delivery='failed';h.deliveryError='The coordinator finished without saving a handoff. Retry wrap-up or switch using saved progress.';this.save();}return;
    }
    if(working){h.delivery='waiting';this.save();return;}
    h.delivery='sending';this.save();
    try{const result=await this.uiAction('chat-send',{body:`The user requested a coordinator change. Stop new assignments. Save a compact handoff of the objective, completed work, active workers, pending decisions and next actions. Call completeHandoff with handoffId ${h.id}. Do not merely describe the handoff: save it through the tool. Keep your reply concise.`});if(result?.dispatchError)throw Error(result.dispatchError);h.delivery='sent';h.deliveryRunId=result?.activeRun?.id??result?.latestRun?.id;this.event(w,'handoff-wrap-up-delivered',{id:h.id});}
    catch(e){h.delivery='failed';h.deliveryError=clip(e instanceof Error?e.message:'Could not deliver wrap-up');this.event(w,'handoff-wrap-up-failed',{id:h.id});}
  }
  async tick(){this.reconcileUpdateWindDown();if(this.polling||this.closing||this.inFlight.size||!this.context)return;this.polling=true;try{if(this.updater?.pending()){
      for(const workspace of this.state.workspaces)await deliverWake(this.outbound(workspace),this.adapters,()=>this.save(),e=>this.wakeValid(workspace,e));
      const workspace=this.current();const notice=workspace.requests?.find(r=>r.id===workspace.updateDrain?.requestId&&r.state==='queued'&&!r.error);
      if(workspace.mode==='internal'&&workspace.conversationId&&notice){const chat=await this.h()['chat:get']({conversationId:workspace.conversationId});if(!chat.activeRun){notice.state='received';notice.receivedBy=workspace.controller!;this.save();try{const result=await this.uiAction('chat-send',{body:notice.prompt});if(result?.dispatchError)throw Error(result.dispatchError);}catch(e){notice.state='queued';delete notice.receivedBy;notice.error=clip(e instanceof Error?e.message:'Update notice delivery failed');this.save();}}}
      return;
    }const w=this.current();await this.deliverHandoff(w);await deliverWake(this.outbound(w),this.adapters,()=>this.save(),e=>this.wakeValid(w,e));if((this.context.store as any).cards?.listAllPending)await this.uiAction('questions-list');
    if(w.mode==='internal'&&w.conversationId&&(!w.handoff||w.handoff.state==='completed')){
      const message=w.chatOutbox?.find(m=>m.state==='queued');
      if(message){const chat=await this.h()['chat:get']({conversationId:w.conversationId});if(!chat.activeRun){message.state='sending';this.save();try{const result=await this.uiAction('chat-send',{body:(message.steer?'Steering update from the user. Follow this direction using existing work and evidence; do not duplicate worker assignments.\n\n':'')+message.body});if(result?.dispatchError)throw Error(result.dispatchError);message.state='sent';this.event(w,'chat-message-sent',{id:message.id});}catch(e){message.state='failed';message.error=clip(e instanceof Error?e.message:'Delivery failed');this.event(w,'chat-message-failed',{id:message.id,error:message.error});}return;}}
    }
    if(w.mode==='internal'&&w.conversationId&&(!w.handoff||w.handoff.state==='completed')){const pending=w.requests?.find(r=>r.state==='queued'&&!r.error);if(pending){const chat=await this.h()['chat:get']({conversationId:w.conversationId});if(!chat.activeRun||chat.activeRun.status==='awaiting_input'){pending.state='received';pending.receivedBy=w.controller!;this.save();try{const result=await this.uiAction('chat-send',{body:pending.prompt});if(result?.dispatchError)throw Error(result.dispatchError);this.event(w,'coordinator-request-received',{id:pending.id});}catch(e){pending.state='queued';delete pending.receivedBy;pending.error=clip(e instanceof Error?e.message:'Could not start request');this.event(w,'coordinator-request-blocked',{id:pending.id,error:pending.error});}}}}
    for(const q of prioritizeWorkflowQueue([...(w.handoff&&w.handoff.state!=='completed'?[]:w.queue??[])],w.workflow)){
      if(w.mode==='off'||(q.autopilot&&w.autopilot?.status!=='active')||w.updateDrain)continue;
      const slots=this.laneUsage(w).implementation;
      if(q.autopilot&&slots>=(w.autopilot?.parallelism??w.parallelism))continue;

      // Persist intent before dispatch; uncertain failures are surfaced, not replayed.
      w.queue=w.queue!.filter(x=>x.id!==q.id);this.save();try{await this.dispatch(w,q.number,q.budgetUsd,q.qa,q.maxReworks,q.readOnly,true,q.autopilot===true);}catch(e){this.event(w,'queued-task-blocked',{number:q.number,error:clip(e instanceof Error?e.message:'Dispatch failed')});}
    }
    const state=w.jobs.map(j=>({run:this.compactRun(j.runId),review:j.reviewRunId?this.compactRun(j.reviewRunId):null}));const snap=JSON.stringify(state);if(w.snapshot!==snap){w.snapshot=snap;this.event(w,'runs-changed',state);}
    for(const j of w.jobs){try{
      if (j.workflowStartPending) {
        try {
          await this.workflowSignal(w, j.number, 'worker-started', `Worker run ${j.runId} resumed`, j.workflowStartPending);
          delete j.workflowStartPending;
          this.save();
        } catch { /* Resume is durable; retry workflow synchronization on the next tick. */ }
      }
      const checkpoint=j.controlId?readCheckpoint(this.root,j.controlId):null;
      if(j.state==='implementing'&&checkpoint?.state==='checkpointed'&&!active(this.run(j.runId).status)){
        this.recordWorkerCheckpoint(w,j,j.runId,j.controlId!,checkpoint);continue;
      }
      const reviewCheckpoint=j.reviewControlId?readCheckpoint(this.root,j.reviewControlId):null;
      if(j.state==='reviewing'&&j.reviewRunId&&reviewCheckpoint?.state==='checkpointed'&&!active(this.run(j.reviewRunId).status)){
        this.recordWorkerCheckpoint(w,j,j.reviewRunId,j.reviewControlId!,reviewCheckpoint,true);continue;
      }

      if(j.state==='implementing'){const r=this.run(j.runId);if(active(r.status))continue;if(r.status!=='complete'){j.state='blocked';j.error=r.exitReason??r.status;this.event(w,'blocked',{runId:r.id,reason:j.error});await this.workflowSignal(w,j.number,'worker-failed',`Run ${r.id}: ${j.error}`,j.controlId??String(r.id));continue;}if(j.autopilot&&w.autopilot?.status!=='active'){j.state='awaiting-review';j.error=j.qa?'Implementation finished; QA remains pending.':'Coordinator review remains pending.';this.event(w,'wind-down-checkpoint',{runId:r.id,remaining:j.error??'Coordinator review'});continue;}if(j.stageAssignment){await this.finishStageAssignment(w,j);continue;}if(!j.qa||j.readOnly===true||j.role==='discovery'){j.state='completed';this.event(w,'implementation-completed',{runId:r.id});await this.workflowSignal(w,j.number,'worker-completed',`Deliverable from run ${r.id}; inspect getRunResult for evidence and limitations`,String(r.id));continue;}await this.startQA(w,j);}
      if(j.state==='checks'){
        const checks=(await this.h()['agent-runs:checks:list']({runId:j.runId})).filter(c=>j.checkIds?.includes(c.id));if(!checks.length||checks.some(c=>!['pass','fail'].includes(c.status)))continue;
        if(await this.revision(j.runId)!==j.sha)throw Error('Implementation changed during QA. Run QA again.');
        const infrastructureFailures = checks.filter(c => c.status === 'fail' && /stale trace map/i.test(c.summary ?? ''));
        if (infrastructureFailures.length) {
          j.state='blocked';j.error='QA infrastructure blocker: '+infrastructureFailures.map(c=>clip(c.summary)).join('\n');
          this.event(w,'qa-infrastructure-blocked',{runId:j.runId,number:j.number,sha:j.sha,checkIds:infrastructureFailures.map(c=>c.id),reason:j.error});
          await this.workflowSignal(w,j.number,'worker-failed',j.error,'qa-infrastructure:'+j.runId+':'+infrastructureFailures.map(c=>c.id).join(','));
          continue;
        }
        if(checks.some(c=>c.status==='fail')){await this.repair(w,j,checks.filter(c=>c.status==='fail').map(c=>clip(c.summary)).join('\n'));continue;}
        if(j.autopilot&&!j.manualQA&&w.autopilot?.status!=='active'){j.state='awaiting-review';j.error='Checks finished; independent review remains pending.';this.event(w,'wind-down-checkpoint',{runId:j.runId,remaining:j.error});continue;}
        const reviewStage=w.workflow?.config.stages.find(stage=>stage.id==='review'&&stage.personaId);
        if(reviewStage&&w.workflow){
          const existing=w.jobs.find(other=>other!==j&&other.number===j.number&&other.stageAssignment?.stageId===reviewStage.id&&other.stageAssignment.baseRevision===j.sha);
          if(existing){j.reviewRunId=existing.runId;j.state='review-delegated';this.event(w,'review-reused',{runId:j.runId,reviewRunId:existing.runId,sha:j.sha});continue;}
          const current=w.workflow.cards[j.number];
          if(current?.stageId!==reviewStage.id&&w.workflow.config.stages.find(stage=>stage.id===current?.stageId)?.category!=='inProgress')throw Error('Review stage has already advanced; reconcile existing review evidence before requesting another review.');
          const evidence='Local QA checks passed for '+j.sha+'; implementation run '+j.runId+'; checks '+j.checkIds?.join(', ');
          moveWorkflowCard(w.workflow,{number:j.number,to:reviewStage.id,reason:'Implementation QA passed; assigned independent reviewer acts next',evidence,checks:[{id:'deliverable',outcome:'pass',evidence}]},'system:local-qa');
          j.state='review-queued';this.queueStageAssignment(w,j.number,false);this.event(w,'local-qa-review-ready',{runId:j.runId,number:j.number,sha:j.sha,personaId:reviewStage.personaId});continue;
        }
        if(this.laneUsage(w).release>=(w.releaseParallelism??4)){j.error='Waiting for an available independent review/release lane';this.save();continue;}
        const original=this.run(j.runId);const issue=(await this.h()['issues:get']({number:j.number})).issue;const phase=await this.phaseContext(w,j,'Independent review','Mechanical checks passed for the recorded commit. Review independently; do not treat check success as review approval.');
        const reviewControl=createCheckpoint(this.root);j.reviewControlId=reviewControl.id;const reviewer=await this.context!.supervisor.start({appendSystemPrompt:reviewControl.prompt,threadId:original.threadId,issueNumber:j.number,baseRef:j.sha!,provider:'claude-code',costBudgetUsd:j.budgetUsd,personaId:'reviewer',prompt:phase+'\n'+INDEPENDENT_REVIEW_AUTHORITY+'\nWorkflow: '+JSON.stringify(workflowGuidance(w.workflow??newWorkflow(),j.number))+'\n'+`Independently review this committed implementation against the task. Do not edit product files or author implementation commits. Inspect the actual diff against the project target and identify defects or unmet criteria. Your final answer MUST end with exactly KANBOTS_QA_PASS or KANBOTS_QA_FAIL. Include concise evidence.\nImplementation commit: ${j.sha}\nTask: ${issue.title}\n${issue.body??''}`});j.reviewRunId=reviewer.id;j.state='reviewing';this.event(w,'review-started',{runId:j.runId,reviewRunId:reviewer.id});
      }
      if(j.state==='reviewing'&&j.reviewRunId){const r=this.run(j.reviewRunId);if(active(r.status))continue;
        const events=this.context!.store.events.list(r.id);const texts=events.filter(e=>e.type==='text').map(e=>{const p=e.payload as any;return p.text??p.result??'';}).join('\n');
        if(r.status==='complete'&&/KANBOTS_QA_PASS\s*$/.test(texts)&&await this.revision(r.id)===j.sha&&await this.revision(j.runId)===j.sha){j.state='qa-passed';this.event(w,'qa-passed',{runId:j.runId,sha:j.sha,reviewRunId:r.id});await this.workflowSignal(w,j.number,'qa-passed',`Independent review ${r.id} passed for ${j.sha}`,String(r.id));}else await this.repair(w,j,clip(texts||r.exitReason||'Review did not pass',6000));
      }
    }catch(e){j.state='blocked';j.error=clip(e instanceof Error?e.message:'Pipeline blocked',1000);this.event(w,'blocked',{runId:j.runId,reason:j.error});await this.workflowSignal(w,j.number,'worker-failed',j.error,j.controlId??String(j.runId));}}
    for(const job of w.jobs)await this.reconcileCheckpointCI(w,job);
    await this.dispatchStageAssignments(w);
    await this.refillReadyWork(w);
    this.maintainAutopilot(w);
  }finally{this.polling=false;}}
  private async assertRelease(w:Workspace,r:Release){if(await this.revision(r.runId)!==r.sha)throw Error('Release revision changed. Prepare a new release.');if(await this.git(w.path,['rev-parse',`refs/heads/${r.targetBranch}`])!==r.targetSha)throw Error('Target branch changed. Prepare a new release.');}
  private async executeRelease(w:Workspace,id:string){const r=w.releases.find(r=>r.id===id);if(!r)throw Error('Release not found');if(r.state==='completed')return r;if(!['pending','ready','approved'].includes(r.state))throw Error('Release already attempted. Inspect its result and prepare a new plan if needed.');if(w.releases.some(other=>other.id!==id&&['validating','executing','uncertain'].includes(other.state)))throw Error('Another release is in progress. Reconcile it before starting another.');
    this.releaseInFlight.add(r.id);const previousState=r.state;r.validationPriorState=previousState;r.state='validating';this.save();
    try{await this.assertRelease(w,r);}catch(error){r.state=previousState;delete r.validationPriorState;this.releaseInFlight.delete(r.id);this.save();throw error;}
    delete r.validationPriorState;r.state='executing';this.save();
    let attempted=false;try{const run=this.run(r.runId);if(r.action==='merge'){
      const listing=await this.git(w.path,['worktree','list','--porcelain']);const target=listing.split('\n\n').find(block=>block.split('\n').includes(`branch refs/heads/${r.targetBranch}`))?.split('\n').find(line=>line.startsWith('worktree '))?.slice(9);if(!target)throw Error('Target must be checked out in a worktree.');if(await this.git(target,['status','--porcelain']))throw Error('Target worktree has uncommitted changes.');
      attempted=true;try{await this.git(target,['merge','--no-ff','--no-edit',r.sha]);}catch(e){await this.git(target,['merge','--abort']).catch(()=>{});throw e;}r.result={merged:true,commit:await this.git(target,['rev-parse','HEAD']),target:r.targetBranch};
    }else{
      const source=this.context!.source;
      if(!source.openDraftPR)throw Error('Draft PR requires a GitHub-backed workspace.');
      const branch=`kanbots-release/${r.id}`;
      attempted=true;await this.git(w.path,['push','origin',`${r.sha}:refs/heads/${branch}`]);
      r.result=await source.openDraftPR({head:branch,base:r.targetBranch,title:r.title??`Implementation ${r.sha.slice(0,8)}`,body:r.body??'Release directed by the KanBorg coordinator.',draft:true});
    }r.state='completed';const job=w.jobs.find(j=>j.runId===r.runId);if(job&&r.action==='merge')await this.workflowSignal(w,job.number,'merged',JSON.stringify(r.result),r.id);this.event(w,'release-completed',{id:r.id,result:r.result});return r;}catch(e){r.state=attempted?'uncertain':'failed';r.result={error:clip(e instanceof Error?e.message:'Release failed',1000)};this.event(w,'release-failed',{id:r.id,result:r.result});throw e;}finally{this.releaseInFlight.delete(r.id);}
  }
}
