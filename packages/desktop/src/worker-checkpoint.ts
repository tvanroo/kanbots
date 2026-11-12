import {mkdirSync,writeFileSync,readFileSync,existsSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
export function checkpointDirectory(root:string,id:string){return join('/private/tmp','kanborg-worker-controls-'+createHash('sha256').update(root).digest('hex').slice(0,20),id);}
export function createCheckpoint(root:string){
 const id=randomUUID(),dir=checkpointDirectory(root,id);mkdirSync(dir,{recursive:true,mode:0o700});
 const request=join(dir,'request.json'),response=join(dir,'response.json');writeFileSync(request,JSON.stringify({id,action:'continue'}),{mode:0o600});
 return {id,prompt:`\nCooperative stop contract: before each new bounded implementation or validation step, read ${JSON.stringify(request)}. If action is checkpoint, write ${JSON.stringify(response)} as JSON with id ${JSON.stringify(id)}, state "acknowledged", then finish only your current bounded step. Save work without starting further implementation or broad validation. Write state "checkpointed" with a compact summary, artifact paths and remaining validation, then end your turn. Never claim tests passed unless run. This checkpoint is not task completion. Do not change request.json. Check this control file again before each new step, including before every status poll or wait.\nExternal wait contract: do not keep this worker alive with long shell sleeps, background polling loops, gh run watch, or private recurring reminders. Make one immediate status check with a maximum 20-second timeout. A missing status, failed query, cancelled job or failed job is not evidence that it is still running: record that outcome and return it to the coordinator. If an external job or dependency is still pending, write the response JSON with this id, state "checkpointed", a compact summary, remainingValidation, artifact references and waiting: {kind:"external",reason:"what remains pending",nextTrigger:"specific event or status to recheck",checkedAt:"ISO timestamp",references:["exact job or artifact references"]}. Then end your turn without starting a watcher. Preserve existing work; this is a pending checkpoint, not task completion or permission to release. The current coordinator owns subsequent checks and any continuation of this same run.\n`};
}
export function requestCheckpoint(root:string,id:string){const dir=checkpointDirectory(root,id);mkdirSync(dir,{recursive:true,mode:0o700});const path=join(dir,'request.json');writeFileSync(path+'.tmp',JSON.stringify({id,action:'checkpoint'}),{mode:0o600});renameSync(path+'.tmp',path);}
export type ExternalWait = {
  kind: 'external'; reason: string; nextTrigger: string; checkedAt: string; references: string[];
};
export function readCheckpoint(root: string, id: string) {
  try {
    const path = join(checkpointDirectory(root, id), 'response.json');
    if (!existsSync(path)) return null;
    const text = readFileSync(path, 'utf8');
    if (text.length > 16000) return null;
    const response = JSON.parse(text);
    if (response.id !== id || !['acknowledged', 'checkpointed'].includes(response.state)) return null;
    let waiting: ExternalWait | undefined;
    const value = response.waiting;
    if (response.state === 'checkpointed' && value?.kind === 'external'
      && typeof value.reason === 'string' && value.reason.trim()
      && typeof value.nextTrigger === 'string' && value.nextTrigger.trim()
      && typeof value.checkedAt === 'string' && Number.isFinite(Date.parse(value.checkedAt))
      && Array.isArray(value.references) && value.references.every((ref: unknown) => typeof ref === 'string')) {
      waiting = { kind: 'external', reason: value.reason.slice(0, 2000), nextTrigger: value.nextTrigger.slice(0, 2000),
        checkedAt: value.checkedAt, references: value.references.slice(0, 20).map((ref: string) => ref.slice(0, 2000)) };
    }
    return { state: response.state as string, summary: String(response.summary ?? '').slice(0, 4000),
      remainingValidation: String(response.remainingValidation ?? '').slice(0, 2000),
      artifacts: Array.isArray(response.artifacts) ? response.artifacts.slice(0, 20).map(String) : [],
      ...(waiting ? { waiting } : {}) };
  } catch { return null; }
}

export function stageDispositionPrompt(root:string,id:string,entry:string,workflowVersion:number){
 return `\nStage handoff contract: when this assigned stage is complete, write ${JSON.stringify(join(checkpointDirectory(root,id),'stage-disposition.json'))} atomically with JSON {id:${JSON.stringify(id)},entry:${JSON.stringify(entry)},workflowVersion:${workflowVersion},to:"configured target stage ID",reason:"acceptance or concrete corrections",evidence:"exact reviewed revision/artifact and decision",checks:[{id:"configured check ID",outcome:"pass or fail or not-applicable",evidence:"exact supporting evidence"}]}. Use only a transition assigned to this stage's worker/reviewer role. Never invent a pass or use completion as release permission. The app validates the current assignment, allowed transition and required checks before handing off. If a decision is pending, use the checkpoint contract instead. Do not change another worker's files.\n`;
}
export function readStageDisposition(root:string,id:string){
 try{
  const raw=readFileSync(join(checkpointDirectory(root,id),'stage-disposition.json'),'utf8');if(raw.length>16000)return null;
  const v=JSON.parse(raw);
  if(v.id!==id||!Number.isSafeInteger(v.workflowVersion)||!['entry','to','reason','evidence'].every(k=>typeof v[k]==='string'&&v[k].trim()&&v[k].length<=4000)||!Array.isArray(v.checks)||v.checks.length>30)return null;
  if(v.checks.some((c:any)=>!c||typeof c.id!=='string'||!c.id.trim()||!['pass','fail','not-applicable'].includes(c.outcome)||typeof c.evidence!=='string'||!c.evidence.trim()||c.evidence.length>4000))return null;
  return v as {id:string;entry:string;workflowVersion:number;to:string;reason:string;evidence:string;checks:Array<{id:string;outcome:'pass'|'fail'|'not-applicable';evidence:string}>};
 }catch{return null;}
}
