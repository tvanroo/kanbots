import {mkdirSync,writeFileSync,readFileSync,existsSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
export function checkpointDirectory(root:string,id:string){return join('/private/tmp','kanborg-worker-controls-'+createHash('sha256').update(root).digest('hex').slice(0,20),id);}
export function createCheckpoint(root:string){
 const id=randomUUID(),dir=checkpointDirectory(root,id);mkdirSync(dir,{recursive:true,mode:0o700});
 const request=join(dir,'request.json'),response=join(dir,'response.json');writeFileSync(request,JSON.stringify({id,action:'continue'}),{mode:0o600});
 return {id,prompt:`\nCooperative stop contract: before each new bounded implementation or validation step, read ${JSON.stringify(request)}. If action is checkpoint, write ${JSON.stringify(response)} as JSON with id ${JSON.stringify(id)}, state "acknowledged", then finish only your current bounded step. Save work without starting further implementation or broad validation. Write state "checkpointed" with a compact summary, artifact paths and remaining validation, then end your turn. Never claim tests passed unless run. This checkpoint is not task completion. Do not change request.json. Check this control file again before each new step.\n`};
}
export function requestCheckpoint(root:string,id:string){const path=join(checkpointDirectory(root,id),'request.json');writeFileSync(path+'.tmp',JSON.stringify({id,action:'checkpoint'}),{mode:0o600});renameSync(path+'.tmp',path);}
export function readCheckpoint(root:string,id:string){try{const p=join(checkpointDirectory(root,id),'response.json');if(!existsSync(p))return null;const text=readFileSync(p,'utf8');if(text.length>16000)return null;const r=JSON.parse(text);if(r.id!==id||!['acknowledged','checkpointed'].includes(r.state))return null;return {state:r.state as string,summary:String(r.summary??'').slice(0,4000),remainingValidation:String(r.remainingValidation??'').slice(0,2000),artifacts:Array.isArray(r.artifacts)?r.artifacts.slice(0,20).map(String):[]};}catch{return null;}}
