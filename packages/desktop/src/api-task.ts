import { execFile } from 'node:child_process';
import { readFile,writeFile,realpath,mkdir } from 'node:fs/promises';
import { resolve,dirname,relative,isAbsolute } from 'node:path';
import { COORDINATOR_TOOLS, KANBOTS_TOOLS } from '@kanborg/mcp';
import type { StartAgentRunOptions,StreamEvent } from '@kanborg/dispatcher';
import { unlockApiConnection, listApiConnections } from './api-connections.js';
import { reserveCharge,settleCharge } from './routing-state.js';
import type { Candidate } from './routing-capacity.js';
export type TranscriptEntry={role:'user'|'assistant';text:string};
export class RouteUnavailable extends Error {}
const fileTools=[
  {name:'read_file',description:'Read a UTF-8 file inside the task workspace.',inputSchema:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false}},
  {name:'write_file',description:'Write UTF-8 content inside the task workspace.',inputSchema:{type:'object',properties:{path:{type:'string'},content:{type:'string'}},required:['path','content'],additionalProperties:false}},
  {name:'run_command',description:'Run a shell command in the task workspace (60-second timeout).',inputSchema:{type:'object',properties:{command:{type:'string'}},required:['command'],additionalProperties:false}},
];
async function safePath(cwd:string,path:string,write=false){
  if(typeof path!=='string')throw Error('Path required');
  const root=await realpath(cwd);const target=resolve(root,path);
  const check=(value:string)=>{const rel=relative(root,value);if(rel==='..'||rel.startsWith('../')||isAbsolute(rel))throw Error('Path is outside this workspace');};
  check(target);
  try{check(await realpath(target));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT'||!write)throw error;check(await realpath(dirname(target)));}
  return target;
}
export async function apiTurn(candidate:Candidate,opts:StartAgentRunOptions,transcript:TranscriptEntry[],signal:AbortSignal,emit:(event:StreamEvent)=>void,runRemaining:number):Promise<{done:boolean;usd:number;input:number;output:number}> {
  const row=candidate.row!;const model=candidate.model!;
  const current=listApiConnections().find(r=>r.id===row.id);
  const policy=(r:typeof row)=>JSON.stringify([r.enabled,r.keyPreview,r.vaultReference,r.funding,r.afterGrant,r.budget,r.remaining,r.expiresAt,r.keyExpiresAt,r.expired,r.renewsAt,r.grantBillingDay,r.rollover]);
  if(!current||policy(current)!==policy(row))throw new RouteUnavailable('Payment settings changed; re-evaluate this connection.');
  if(candidate.deadline!==undefined&&Date.now()>=candidate.deadline)throw new RouteUnavailable('Grant use-by deadline reached.');
  const tools=opts.env?.KANBOTS_COORDINATOR==='1'?[...COORDINATOR_TOOLS]:opts.env?.KANBOTS_TOOL_BRIDGE_URL?[...fileTools,...KANBOTS_TOOLS]:fileTools;
  const prompt=transcript.map(m=>`${m.role.toUpperCase()}:\n${m.text}`).join('\n\n');
  const instructions=`${opts.appendSystemPrompt??''}\nWork only on the user's requested task in ${opts.cwd}. First read relevant AGENTS.md instructions. Use the supplied tools to inspect/edit/test. The transcript includes completed tool results; do not repeat completed side effects. If finished, return a concise final answer. Never read credentials or secret stores. Report failures honestly.`;
  const outputLimit=Math.min(4096,model.maxOutput);
  // Upper-bound text tokens by UTF-8 bytes plus schema/format overhead; avoid long-context pricing tiers.
  const inputBound=Buffer.byteLength(prompt+instructions+JSON.stringify(tools),'utf8')+8192;
  if(inputBound>Math.min(64000,model.context-outputLimit))throw new RouteUnavailable('Task context exceeds this route’s bounded context.');
  const reservation=(inputBound*model.input+outputLimit*model.output)/1e6*1.25;
  if(reservation>runRemaining)throw new RouteUnavailable('Run API spending limit reached.');
  const charge=reserveCharge(candidate.pool!,row.id,reservation,candidate.available!,candidate.since!,candidate.funding);
  if(!charge)throw new RouteUnavailable('This funding pool cannot cover the next request.');
  let key:string;
  try{signal.throwIfAborted();key=await unlockApiConnection(row.id);signal.throwIfAborted();}catch{
    // No request has been attempted. Release the reservation and let routing
    // select another eligible source without implying an uncertain charge.
    settleCharge(charge,0);
    if(signal.aborted)throw Error('Task stopped.');
    throw new RouteUnavailable('API credential could not be unlocked. Reconnect this source in provider settings.');
  }
  let response:Response;
  try{
    const anthropic=row.provider==='anthropic';
    const body=anthropic?{model:model.id,max_tokens:outputLimit,system:instructions,messages:[{role:'user',content:prompt}],tools:tools.map(t=>({name:t.name,description:t.description,input_schema:t.inputSchema}))}
      :{model:model.id,max_output_tokens:outputLimit,instructions,input:[{role:'user',content:prompt}],store:false,tools:tools.map(t=>({type:'function',name:t.name,description:t.description,parameters:t.inputSchema,strict:false}))};
    response=await fetch(anthropic?'https://api.anthropic.com/v1/messages':'https://api.openai.com/v1/responses',{
      method:'POST',headers:anthropic?{'x-api-key':key,'anthropic-version':'2023-06-01','content-type':'application/json'}:{Authorization:`Bearer ${key}`,'content-type':'application/json'},
      body:JSON.stringify(body),signal:AbortSignal.any([signal,AbortSignal.timeout(180000)]),
    });
  }catch{
    // An interrupted/ambiguous request may have been billed. Keep reservation and do not replay it.
    throw Error(signal.aborted?'Task stopped.':'API request outcome is unknown; reservation retained. Resume explicitly to continue.');
  }
  if(!response.ok){
    if([400,401,403,404,429].includes(response.status)){settleCharge(charge,0);throw new RouteUnavailable(`API route unavailable (HTTP ${response.status}).`);}
    throw Error('API request failed with an uncertain billing outcome; reservation retained.');
  }
  const result=await response.json() as any;
  const input=Number(result.usage?.input_tokens);const output=Number(result.usage?.output_tokens);
  if(!Number.isFinite(input)||!Number.isFinite(output)||input<0||output<0)throw Error('API usage was not reported; reservation retained.');
  const cost=(input*model.input+output*model.output)/1e6;
  settleCharge(charge,cost,input,output);
  const calls:Array<{id:string;name:string;args:any}>=[];let text='';
  if(row.provider==='anthropic')for(const block of result.content??[]){
    if(block.type==='text')text+=block.text;
    if(block.type==='tool_use')calls.push({id:block.id,name:block.name,args:block.input});
  }else for(const item of result.output??[]){
    if(item.type==='message')for(const part of item.content??[])if(part.type==='output_text')text+=part.text;
    if(item.type==='function_call')calls.push({id:item.call_id,name:item.name,args:JSON.parse(item.arguments)});
  }
  if(text){transcript.push({role:'assistant',text});emit({kind:'text',text});}
  for(const call of calls){
    signal.throwIfAborted();
    if(!tools.some(t=>t.name===call.name))throw Error('Unknown tool requested.');
    const eventName=call.name==='run_command'?'Bash':call.name==='write_file'?'Write':call.name==='read_file'?'Read':call.name;
    emit({kind:'tool_use',toolUseId:call.id,name:eventName,input:call.name==='write_file'?{file_path:call.args.path,content:call.args.content}:call.args});
    await new Promise(resolve=>setImmediate(resolve));signal.throwIfAborted();
    let content:string;let failed=false;
    try{
      if(call.name==='read_file')content=(await readFile(await safePath(opts.cwd,call.args.path),'utf8')).slice(0,40000);
      else if(call.name==='write_file'){
        if(typeof call.args.content!=='string'||call.args.content.length>200000)throw Error('Invalid file content');
        const target=await safePath(opts.cwd,call.args.path,true);
        await writeFile(target,call.args.content,'utf8');content='File saved.';
        emit({kind:'diff_hunk',toolUseId:call.id,filePath:target,opIndex:0,mode:'write',before:null,after:call.args.content});
      }else if(call.name==='run_command'){
        if(typeof call.args.command!=='string')throw Error('Command required');
        content=await new Promise<string>(resolve=>execFile('/bin/zsh',['-c',call.args.command],{cwd:opts.cwd,timeout:60000,maxBuffer:65536,signal,env:{PATH:process.env.PATH??'/usr/bin:/bin',HOME:process.env.HOME??'',TMPDIR:process.env.TMPDIR??'/tmp'}},(error,stdout,stderr)=>resolve(`${stdout}\n${stderr}\nExit: ${error?String(error.code):'0'}`)));
      }else{
        const base=opts.env?.KANBOTS_TOOL_BRIDGE_URL;const token=opts.env?.KANBOTS_TOOL_BRIDGE_TOKEN;
        if(!base||!/^http:\/\/127\.0\.0\.1:\d+$/.test(base)||!token)throw Error('Workspace tools unavailable');
        const reply=await fetch(`${base}/tool/${encodeURIComponent(call.name)}`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(call.args),signal});
        content=(await reply.text()).slice(0,40000);failed=!reply.ok;
      }
    }catch(error){failed=true;content=error instanceof Error?error.message:'Tool failed';}
    transcript.push({role:'user',text:`Completed tool ${call.name} (${call.id}), arguments ${JSON.stringify(call.args)}:\n${content}`});
    emit({kind:'tool_result',toolUseId:call.id,isError:failed,content});
  }
  if(!calls.length && ((row.provider==='anthropic'&&result.stop_reason==='max_tokens')||result.status==='incomplete'))throw Error('Model output limit reached; resume to continue.');
  return {done:calls.length===0,usd:cost,input,output};
}
