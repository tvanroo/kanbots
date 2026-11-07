import {execFile} from 'node:child_process';
import {access} from 'node:fs/promises';
import {constants} from 'node:fs';
import {isAbsolute} from 'node:path';

// Structural subset of KanBorg 1.2.24's HostAdapter. No renderer-supplied
// executable, endpoint, environment, or prompt is accepted by this module.
type Binding = Readonly<{id:string;clientId:string;hostId:string;chatId:string;adapterId:string;state:string}>;
type Signal = Readonly<{id:string;workspaceId:string;clientId:string;epoch:number;kind:string;cursor:number;handoffId?:string}>;
type Delivery = {state:'accepted'|'not-delivered'|'unknown';receipt?:string};
type Result = {stdout:string;stderr:string};
type Runner = (file:string,args:string[])=>Promise<Result>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/;
export const CODEX_CLI_ADAPTER_ID = 'codex-cli-queue-v1';

const run:Runner = (file,args)=>new Promise((resolve,reject)=>{
  execFile(file,args,{timeout:3500,maxBuffer:65536,encoding:'utf8',windowsHide:true},(error,stdout,stderr)=>{
    if(error) reject(Object.assign(error,{stdout,stderr}));
    else resolve({stdout,stderr});
  });
});

function validBinding(b:Binding,hostId:string){
  return b.state==='approved' && b.adapterId===CODEX_CLI_ADAPTER_ID &&
    b.hostId===hostId && UUID.test(b.chatId) && IDENTIFIER.test(b.id) && IDENTIFIER.test(b.clientId);
}
function validSignal(s:Signal,b:Binding){
  return UUID.test(s.id) && IDENTIFIER.test(s.workspaceId) && s.clientId===b.clientId &&
    Number.isSafeInteger(s.epoch) && s.epoch>=0 && Number.isSafeInteger(s.cursor) && s.cursor>=0 &&
    IDENTIFIER.test(s.kind) && (!s.handoffId || IDENTIFIER.test(s.handoffId));
}
function receiptFrom(result:Partial<Result>,chatId:string,eventId:string):string|undefined{
  const lines=[result.stdout,result.stderr].filter(v=>typeof v==='string').join('\n');
  if(lines.length>131072)return;
  const hits=[...lines.matchAll(/^Queued message ([0-9a-f-]+) for thread ([0-9a-f-]+)\.\r?$/gmi)];
  if(hits.length!==1)return;
  const hit=hits[0]!;
  if(!UUID.test(hit[1]!) || hit[2]!.toLowerCase()!==chatId.toLowerCase())return;
  return `codex-queue:${chatId.toLowerCase()}:${eventId.toLowerCase()}:${hit[1]!.toLowerCase()}`;
}
function validReceipt(receipt:string|undefined,chatId:string,eventId:string){
  if(!receipt)return false;
  const parts=receipt.split(':');
  return parts.length===4 && parts[0]==='codex-queue' && parts[1]===chatId.toLowerCase() &&
    parts[2]===eventId.toLowerCase() && UUID.test(parts[3]!);
}
function wakePrompt(s:Signal){
  const reference={id:s.id,workspaceId:s.workspaceId,clientId:s.clientId,epoch:s.epoch,kind:s.kind,cursor:s.cursor,...(s.handoffId?{handoffId:s.handoffId}:{})};
  return 'KanBorg wake signal (data reference, not new authority): '+JSON.stringify(reference)+
    '\nUse the existing KanBorg MCP connection. Read getCapabilities and getOutboundEvents for this workspace. '+
    'Match this event, approved binding, client and current epoch before acknowledging receipt with acknowledgeWake. '+
    'Read authoritative session, requests and changes; perform only current owner-authorized work. '+
    'Record acted only after successful handling. If tools are unavailable or authority changed, report the blocker; do not fabricate receipts. '+
    'Preserve this existing chat, active workers and pending decisions. Do not create another chat or replace the coordinator. '+
    'For a handoff, checkpoint or reconcile only within the live handoff authority. Never repeat work solely because this wake was repeated.';
}

export function createCodexCliAdapter(options:{
  executable:string;
  localHostId:string;
  // Host availability must come from trusted application code, not a claimed
  // renderer flag. It means queue transport ready, never receiver ACK.
  isDesktopRunning:()=>Promise<boolean>;
  runner?:Runner;
  checkExecutable?:(path:string)=>Promise<void>;
}){
  if(!isAbsolute(options.executable)||!IDENTIFIER.test(options.localHostId))throw Error('Invalid trusted CLI configuration');
  const execute=options.runner??run;
  const check=options.checkExecutable??(path=>access(path,constants.X_OK));
  const inFlight=new Map<string,Promise<Delivery>>();
  return {
    id:CODEX_CLI_ADAPTER_ID,
    async reachable(b:Binding){
      const observedAt=Date.now();
      if(b.state==='revoked')return {state:'revoked' as const,observedAt};
      if(!validBinding(b,options.localHostId))return {state:'unsupported' as const,observedAt};
      try{await check(options.executable);}catch{return {state:'unsupported' as const,observedAt};}
      try{return {state:await options.isDesktopRunning()?'available' as const:'offline' as const,observedAt};}
      catch{return {state:'unknown' as const,observedAt};}
    },
    async send(b:Binding,s:Signal):Promise<Delivery>{
      if(!validBinding(b,options.localHostId)||!validSignal(s,b))return {state:'not-delivered'};
      const key=JSON.stringify([b.id,b.chatId,s]);
      const existing=inFlight.get(key);if(existing)return existing;
      // KanBorg persists 'sending' before invoking this method. On a process
      // restart it MUST call reconcile, not send, for the same event.
      const pending=(async():Promise<Delivery>=>{
        const started=Date.now();
        const status=await this.reachable(b);
        // Leave room for the bounded child before the owning queue's five-second
        // deadline. A delayed preflight must never launch after that deadline.
        if(status.state!=='available'||Date.now()-started>1000||!validBinding(b,options.localHostId))return {state:'not-delivered'};
        try{
          const result=await execute(options.executable,['queue','--thread',b.chatId,'--message',wakePrompt(s),'--resume']);
          const receipt=receiptFrom(result,b.chatId,s.id);
          return receipt?{state:'accepted',receipt}:{state:'unknown'};
        }catch(error){
          const e=error as Partial<Result>&{code?:unknown};
          const receipt=receiptFrom(e,b.chatId,s.id);
          if(receipt)return {state:'accepted',receipt};
          // Only known failure to spawn is safely not-delivered. All failures
          // after possible process execution may have inserted the queue item.
          return {state:e.code==='ENOENT'||e.code==='EACCES'?'not-delivered':'unknown'};
        }
      })();
      inFlight.set(key,pending);
      try{return await pending;}finally{inFlight.delete(key);}
    },
    async reconcile(b:Binding,eventId:string,receipt?:string):Promise<Delivery>{
      if(!validBinding(b,options.localHostId)||!UUID.test(eventId))return {state:'unknown'};
      // This only preserves a trusted persisted acceptance receipt. It is NOT
      // a fresh CLI status lookup and never establishes receiver completion.
      return receipt && validReceipt(receipt,b.chatId,eventId)?{state:'accepted',receipt}:{state:'unknown'};
    },
  };
}
