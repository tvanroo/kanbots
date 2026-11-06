import type { WorkflowConfig, WorkflowState, WorkflowCard, WorkflowStage, WorkflowCheck } from '@kanborg/core';
export type BoardItem = { number: number; status?: string | null; state?: string; title: string; labels?: string[]; activeRun?: unknown };
const copy = <T>(v: T): T => structuredClone(v);
const check = (id: string, label: string): WorkflowCheck => ({ id, label, mode: 'required' });
export function defaultWorkflow(): WorkflowConfig {
  const specs = [
    ['backlog','Backlog','Recorded, not selected','Scope and priority are understood','Select an authorized objective','coordinator'],
    ['todo','Ready','Authorized and ready for assignment','Scope and acceptance criteria are clear','One worker starts','coordinator'],
    ['inProgress','In Progress','Work is actively executing','Owner and assignment recorded','Deliverable and evidence submitted','worker'],
    ['review','Review','A deliverable needs explicit assessment','Deliverable and evidence are available','Accept or return concrete corrections','reviewer'],
    ['delivery','Release / Verification','Accepted work awaits delivery','Review accepted','Required destination and runtime criteria verified','coordinator'],
    ['done','Done','This card’s criteria are satisfied','Task-specific completion evidence recorded','Preserve evidence and update parent','coordinator'],
  ];
  const stages: WorkflowStage[] = specs.map(([id,name,purpose,entry,exit,actor]) => ({id:id!,name:name!,purpose:purpose!,entry:entry!,exit:exit!,actor:actor as WorkflowStage['actor'],category:(id==='delivery'?'review':id) as WorkflowStage['category'],coordinatorGuidance:id==='review'?'Assess evidence against this card’s criteria. Accept supporting tasks as complete; otherwise name delivery work. Do not repeat completed checks without a reason.':id==='delivery'?'Track exact revisions through delivery. A merge or successful CI job does not prove deployment.':'Advance the next authorized action; preserve ownership and evidence.',workerGuidance:'Work within the card’s scope. Return concise evidence, artifacts, failures and limitations.',checks:id==='review'?[check('deliverable','Deliverable and evidence available')]:id==='done'?[check('accepted','Acceptance criteria satisfied')]:[]}));
  const transitions = stages.flatMap(from => stages.filter(to=>to.id!==from.id&&from.id!=='done').map(to=>({from:from.id,to:to.id,actor:'coordinator' as const,automatic:false,event:'manual' as const})));
  transitions.push({from:'inProgress',to:'review',actor:'coordinator',automatic:true,event:'worker-completed'} as any);
  transitions.push({from:'inProgress',to:'review',actor:'coordinator',automatic:true,event:'qa-passed'} as any);
  return {name:'Product delivery',stages,transitions,completion:[
    {taskType:'research',guidance:'Questions answered; findings, evidence and limitations delivered. Update the parent.',checks:[check('findings','Findings delivered')]},
    {taskType:'qa',guidance:'Agreed checks performed and findings handed to the owner. Defects may remain on separate implementation cards.',checks:[check('qa-findings','QA findings delivered')]},
    {taskType:'implementation',guidance:'Reviewed change delivered to the agreed destination with tests and release evidence.',checks:[check('delivery','Agreed delivery verified')]},
    {taskType:'release',guidance:'Exact revision and agreed runtime acceptance verified.',checks:[check('runtime','Runtime revision and acceptance verified')]},
    {taskType:'incident',guidance:'Recovery verified against incident criteria and remaining risks recorded.',checks:[check('recovery','Recovery verified')]},
    {taskType:'objective',guidance:'Required child outcomes complete or explicitly deferred; overall acceptance assessed.',checks:[check('children','Required child outcomes resolved')]},
  ],waitingReasons:['User decision','Dependency','CI','Deployment','Review','Worker recovery'],notifications:'meaningful',cadence:{working:5,idle:15},releaseOwner:'coordinator'};
}
export function newWorkflow(): WorkflowState { return {version:1,config:defaultWorkflow(),cards:{},history:[]}; }
export function materialize(state:WorkflowState,issues:BoardItem[]) {
  for(const issue of issues) if(!state.cards[issue.number]) {
    const category=issue.status??issue.labels?.find(l=>l.startsWith('status:'))?.slice(7).replace('in-progress','inProgress')??(issue.state==='closed'?'done':'backlog');
    const stage=state.config.stages.find(s=>s.id===category)??state.config.stages.find(s=>s.category===category)??state.config.stages[0]!;
    state.cards[issue.number]={number:issue.number,stageId:stage.id,taskType:'implementation',version:state.version,enteredAt:new Date().toISOString(),checks:{},evidence:'',nextAction:stage.exit,owner:stage.actor,history:[]};
  }
}
export function validateWorkflow(config:WorkflowConfig): { errors:string[]; warnings:string[] } {
  const errors:string[]=[],warnings:string[]=[];
  if(!config||!Array.isArray(config.stages)||!Array.isArray(config.transitions)||!Array.isArray(config.completion)) return {errors:['Provide stages, transitions and task completion rules.'],warnings};
  if(!config.stages.length||config.stages.length>30)errors.push('Use between 1 and 30 stages.');
  const ids=new Set<string>();
  for(const s of config.stages){if(!/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(s.id)||ids.has(s.id))errors.push('Stage identities must be unique and stable.');ids.add(s.id);if(!s.name?.trim())errors.push('Every stage needs a name.');if(!['coordinator','worker','reviewer','user'].includes(s.actor))errors.push(`${s.name}: choose who acts next.`);if(!['backlog','todo','inProgress','review','done'].includes(s.category))errors.push(`${s.name}: invalid stage category.`);}
  const validateChecks=(checks:WorkflowCheck[],label:string)=>{const seen=new Map<string,string>();if(!Array.isArray(checks)){errors.push(`${label}: checks must be a list.`);return;}for(const c of checks){if(!c.id||!c.label?.trim()||!['required','advisory','not-applicable'].includes(c.mode))errors.push(`${label}: invalid check.`);if(seen.has(c.id))errors.push(`${label}: duplicate or contradictory check ${c.id}.`);seen.set(c.id,c.mode);}};
  for(const s of config.stages)validateChecks(s.checks,s.name);
  for(const rule of config.completion)validateChecks(rule.checks,rule.taskType);
  for(const t of config.transitions){if(!ids.has(t.from)||!ids.has(t.to))errors.push('A transition references a missing stage.');if(!['coordinator','worker','reviewer','user'].includes(t.actor))errors.push('Every transition needs a responsible actor.');if(t.automatic&&t.event==='manual')errors.push('An automatic transition needs a triggering event.');}
  for(const n of [config.cadence?.working,config.cadence?.idle])if(!Number.isInteger(n)||n<1||n>1440)errors.push('Reminder intervals must be 1–1440 minutes.');
  if(!['coordinator','user'].includes(config.releaseOwner))errors.push('Choose a release decision owner.');
  if(!['meaningful','all-transitions','decisions-only'].includes(config.notifications))errors.push('Choose a notification policy.');
  const done=config.stages.filter(s=>s.category==='done').map(s=>s.id);if(!done.length)errors.push('Add a completion stage.');
  const walk=(start:string)=>{const reached=new Set([start]);let changed=true;while(changed){changed=false;for(const t of config.transitions)if(reached.has(t.from)&&!reached.has(t.to)){reached.add(t.to);changed=true;}}return reached;};
  if(config.stages[0]){const reachable=walk(config.stages[0].id);for(const s of config.stages){if(!reachable.has(s.id))warnings.push(`${s.name} is unreachable from the first stage.`);if(!done.some(d=>walk(s.id).has(d)))warnings.push(`${s.name} has no path to completion.`);}}
  for(const s of config.stages.filter(s=>s.category==='done'))for(const rule of config.completion)for(const c of rule.checks){const stageCheck=s.checks.find(x=>x.id===c.id);if(stageCheck&&stageCheck.mode!==c.mode)errors.push(`${rule.taskType}: ${c.id} contradicts the completion-stage check.`);}
  return {errors,warnings};
}
export type WorkflowChange = { expectedVersion:number; config:WorkflowConfig; reason:string; migrations?:Array<{from:string;to:string}>; moves?:Array<{number:number;to:string;evidence:string}> };
export function previewWorkflow(state:WorkflowState,change:WorkflowChange,issues:BoardItem[]) {
  materialize(state,issues);const result=validateWorkflow(change.config);if(change.expectedVersion!==state.version)result.errors.push('Workflow changed. Reload and preview again.');if(!change.reason?.trim())result.errors.push('Describe why the workflow is changing.');
  const moves=new Map<number,{number:number;from:string;to:string;evidence:string}>();
  for(const card of Object.values(state.cards))if(!change.config.stages.some(s=>s.id===card.stageId)){
    const target=change.moves?.find(m=>m.number===card.number)?.to ?? change.migrations?.find(m=>m.from===card.stageId)?.to;
    if(!target||!change.config.stages.some(s=>s.id===target))result.errors.push(`Stage ${card.stageId} contains #${card.number}; choose a destination.`);
    else moves.set(card.number,{number:card.number,from:card.stageId,to:target,evidence:'Stage removed; cards explicitly reassigned'});
  }
  for(const move of change.moves??[]){const card=state.cards[move.number];if(!card||!change.config.stages.some(s=>s.id===move.to)||!move.evidence?.trim())result.errors.push(`Card #${move.number}: choose an existing destination and record evidence.`);else moves.set(move.number,{number:move.number,from:card.stageId,to:move.to,evidence:move.evidence});}
  const affected=Object.values(state.cards).filter(c=>{const before=state.config.stages.find(s=>s.id===c.stageId),after=change.config.stages.find(s=>s.id===c.stageId);return JSON.stringify(before)!==JSON.stringify(after)||JSON.stringify(state.config.completion)!==JSON.stringify(change.config.completion)||moves.has(c.number);}).map(c=>({number:c.number,title:issues.find(i=>i.number===c.number)?.title??`#${c.number}`,completed:state.config.stages.find(s=>s.id===c.stageId)?.category==='done',running:!!issues.find(i=>i.number===c.number)?.activeRun,from:c.stageId,to:moves.get(c.number)?.to??c.stageId}));
  for(const move of moves.values()){const old=state.config.stages.find(s=>s.id===move.from);const next=change.config.stages.find(s=>s.id===move.to);if(next?.category==='done'&&old?.category!=='done')result.errors.push(`Complete #${move.number} separately with task evidence, not as a configuration migration.`);}
  return {...result,version:state.version,affected,moves:[...moves.values()],scheduleChanged:JSON.stringify(state.config.cadence)!==JSON.stringify(change.config.cadence)};
}
export function applyWorkflow(state:WorkflowState,change:WorkflowChange,issues:BoardItem[],actor:string){
  const preview=previewWorkflow(state,change,issues);if(preview.errors.length)throw Error(preview.errors.join('\n'));
  state.history.push({version:state.version,at:new Date().toISOString(),actor,reason:change.reason,config:copy(state.config),moves:preview.moves.map(({number,from,to})=>({number,from,to}))});
  state.version++;state.config=copy(change.config);
  for(const m of preview.moves){const c=state.cards[m.number]!;c.history.push({at:new Date().toISOString(),actor,version:state.version,from:m.from,to:m.to,reason:change.reason,evidence:m.evidence});c.stageId=m.to;c.version=state.version;c.enteredAt=new Date().toISOString();}
  return preview;
}
export function undoWorkflowChange(state:WorkflowState,reason:string):WorkflowChange{
  const previous=state.history.at(-1);if(!previous)throw Error('No workflow change to undo.');
  return {expectedVersion:state.version,config:copy(previous.config),reason,moves:previous.moves.filter(m=>state.cards[m.number]?.stageId===m.to).map(m=>({number:m.number,to:m.from,evidence:'Undo configuration migration'}))};
}
export function moveWorkflowCard(state:WorkflowState,args:{number:number;to?:string;taskType?:WorkflowCard['taskType'];owner?:string;nextAction?:string;evidence:string;reason:string;checks?:Array<{id:string;outcome:'pass'|'fail'|'not-applicable';evidence:string}>;waiting?:WorkflowCard['waiting'];clearWaiting?:boolean},actor:string){
  const original=state.cards[args.number];if(!original)throw Error('Card not found.');const card=copy(original);const stage=state.config.stages.find(s=>s.id===(args.to??card.stageId));if(!stage)throw Error('Stage not found.');
  if(args.taskType)card.taskType=args.taskType;
  for(const c of args.checks??[]){if(!c.evidence.trim())throw Error('Every check result needs evidence.');card.checks[c.id]={outcome:c.outcome,evidence:c.evidence,at:new Date().toISOString(),actor,version:state.version};}
  if(args.to&&args.to!==card.stageId){
    if(!state.config.transitions.some(t=>t.from===card.stageId&&t.to===args.to))throw Error('This transition is not configured. Edit the workflow to allow it.');
    const required=[...stage.checks,...(stage.category==='done'?state.config.completion.find(r=>r.taskType===card.taskType)?.checks??[]:[])].filter(c=>c.mode==='required');
    const missing=required.filter(c=>card.checks[c.id]?.outcome!=='pass');if(missing.length)throw Error('Record evidence for: '+missing.map(c=>c.label).join(', '));
    if(!args.evidence.trim()||!args.reason.trim())throw Error('Record the reason and evidence for this move.');
    card.history.push({at:new Date().toISOString(),actor,version:state.version,from:card.stageId,to:args.to,reason:args.reason,evidence:args.evidence});card.stageId=args.to;card.enteredAt=new Date().toISOString();card.version=state.version;
  }
  card.evidence=args.evidence||card.evidence;card.owner=args.owner??card.owner;card.nextAction=args.nextAction??stage.exit;
  if(args.waiting){if(!args.waiting.owner||!args.waiting.trigger||!state.config.waitingReasons.includes(args.waiting.reason))throw Error('Choose a waiting reason, responsible party and next trigger.');card.waiting=args.waiting;}if(args.clearWaiting)delete card.waiting;
  state.cards[args.number]=card;return card;
}
export function workflowGuidance(state:WorkflowState,number?:number){const card=number?state.cards[number]:undefined;const stage=state.config.stages.find(s=>s.id===card?.stageId);return {version:state.version,stage,card,completion:state.config.completion.find(r=>r.taskType===card?.taskType),releaseOwner:state.config.releaseOwner,notifications:state.config.notifications,authority:'Workflow rules do not grant tool permissions, credentials or destructive-action authorization.'};}
