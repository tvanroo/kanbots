import {connect} from 'node:net';
import {readFile, lstat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join, dirname, isAbsolute, resolve} from 'node:path';

// KanBorg HostAdapter for existing Claude Code sessions running the
// kanborg-connect plugin's wake channel (plugins/kanborg-connect-claude/wake).
// Structural match for packages/desktop/src/coordinator-outbound.ts HostAdapter.
//
// The plugin's channel server, started inside the bound Claude session, binds
// a private Unix socket and writes a 0600 registry file
//   <registryDir>/<chatId>.json = {v,adapterId,hostId,chatId,socket,token,pid,...}
// This adapter reads that file, connects to the socket and sends the compact
// wake signal. The channel turns it into a `notifications/claude/channel`
// message, which starts a turn in that same session. No renderer- or
// MCP-supplied path, endpoint, command or prompt text is accepted.

type Binding = Readonly<{id:string;clientId:string;hostId:string;chatId:string;adapterId:string;state:string}>;
type Signal = Readonly<{id:string;workspaceId:string;clientId:string;epoch:number;kind:string;cursor:number;handoffId?:string}>;
type Delivery = {state:'accepted'|'not-delivered'|'unknown';receipt?:string};
type Reach = {state:'available'|'busy'|'offline'|'revoked'|'unsupported'|'unknown';observedAt:number};
type Registry = {v:number;adapterId:string;hostId:string;chatId:string;socket:string;token:string};
type Exchange = (socket:string,line:string,timeoutMs:number)=>Promise<string>;

export const CLAUDE_CHANNEL_ADAPTER_ID = 'claude-channel-v1';
export const CLAUDE_HOST_ID = 'local';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/;

export function defaultRegistryDir(){return join(homedir(),'.kanborg-connect','claude','sessions');}

// One request line, one reply line. Rejects with code 'SENT' once the request
// has been written, so callers can tell "maybe delivered" from "never sent".
const exchange:Exchange=(socket,line,timeoutMs)=>new Promise((resolveReply,reject)=>{
  let buf='',sent=false;
  const s=connect(socket);
  const fail=(e:Error)=>{s.destroy();reject(Object.assign(e,{sent}));};
  s.setTimeout(timeoutMs,()=>fail(Error('timeout')));
  s.on('connect',()=>{s.write(line+'\n',()=>{sent=true;});});
  s.on('data',c=>{buf+=c;if(buf.length>65536)fail(Error('reply too large'));const i=buf.indexOf('\n');if(i>=0){s.end();resolveReply(buf.slice(0,i));}});
  s.on('error',e=>fail(e));
  s.on('end',()=>{if(!buf.includes('\n'))fail(Error('no reply'));});
});

function validBinding(b:Binding){
  return b.state==='approved'&&b.adapterId===CLAUDE_CHANNEL_ADAPTER_ID&&b.hostId===CLAUDE_HOST_ID&&
    UUID.test(b.chatId)&&IDENTIFIER.test(b.id)&&IDENTIFIER.test(b.clientId);
}
function validSignal(s:Signal,b:Binding){
  return UUID.test(s.id)&&IDENTIFIER.test(s.workspaceId)&&s.clientId===b.clientId&&
    Number.isSafeInteger(s.epoch)&&s.epoch>=0&&Number.isSafeInteger(s.cursor)&&s.cursor>=0&&
    IDENTIFIER.test(s.kind)&&(!s.handoffId||IDENTIFIER.test(s.handoffId));
}
function validReceipt(receipt:string|undefined,chatId:string,eventId:string):receipt is string{
  return receipt===`claude-channel:${chatId.toLowerCase()}:${eventId.toLowerCase()}`;
}

export function createClaudeChannelAdapter(options:{
  registryDir?:string;
  exchange?:Exchange;
  timeoutMs?:number;
}={}){
  const registryDir=resolve(options.registryDir??defaultRegistryDir());
  if(!isAbsolute(registryDir))throw Error('Invalid trusted registry directory');
  const socketsDir=join(dirname(registryDir),'s');
  const talk=options.exchange??exchange;
  const timeoutMs=Math.min(options.timeoutMs??3500,4500); // below deliverWake's 5s bound
  const inFlight=new Map<string,Promise<Delivery>>();

  async function registry(b:Binding):Promise<Registry|null>{
    const file=join(registryDir,b.chatId.toLowerCase()+'.json');
    let st;try{st=await lstat(file);}catch{return null;} // session not running
    if(!st.isFile()||(st.mode&0o077)!==0||(typeof process.getuid==='function'&&st.uid!==process.getuid()))throw Error('Untrusted registry file');
    const r=JSON.parse(await readFile(file,'utf8')) as Registry;
    const socket=resolve(r.socket??'');
    if(r.v!==1||r.adapterId!==CLAUDE_CHANNEL_ADAPTER_ID||r.hostId!==CLAUDE_HOST_ID||r.chatId!==b.chatId.toLowerCase()||
      typeof r.token!=='string'||!/^[0-9a-f]{64}$/.test(r.token)||dirname(socket)!==socketsDir)throw Error('Invalid registry entry');
    return {...r,socket};
  }
  async function request(r:Registry,body:Record<string,unknown>){
    const raw=await talk(r.socket,JSON.stringify({v:1,token:r.token,chatId:r.chatId,...body}),timeoutMs);
    let reply;try{reply=JSON.parse(raw);if(!reply||reply.v!==1)throw Error('Invalid reply');}catch{throw Object.assign(Error('Invalid reply'),{sent:true});}
    return reply as {state:string;receipt?:string;error?:string};
  }

  return {
    id:CLAUDE_CHANNEL_ADAPTER_ID,
    async reachable(b:Binding):Promise<Reach>{
      const observedAt=Date.now();
      if(b.state==='revoked')return {state:'revoked',observedAt};
      if(!validBinding(b))return {state:'unsupported',observedAt};
      try{
        const r=await registry(b);if(!r)return {state:'offline',observedAt};
        const reply=await request(r,{type:'ping'});
        return {state:reply.state==='available'?'available':'unknown',observedAt};
      }catch(e){
        const code=(e as NodeJS.ErrnoException).code;
        return {state:code==='ENOENT'||code==='ECONNREFUSED'?'offline':'unknown',observedAt};
      }
    },
    send(b:Binding,s:Signal):Promise<Delivery>{
      if(!validBinding(b)||!validSignal(s,b))return Promise.resolve({state:'not-delivered'});
      const key=b.id+':'+s.id;
      const existing=inFlight.get(key);if(existing)return existing;
      const task=(async():Promise<Delivery>=>{
        let r:Registry|null;
        try{r=await registry(b);}catch{return {state:'not-delivered'};}
        if(!r)return {state:'not-delivered'};
        try{
          const signal={id:s.id,workspaceId:s.workspaceId,clientId:s.clientId,epoch:s.epoch,kind:s.kind,cursor:s.cursor,...(s.handoffId?{handoffId:s.handoffId}:{})};
          const reply=await request(r,{type:'wake',signal});
          if(reply.state==='accepted'&&validReceipt(reply.receipt,b.chatId,s.id))return {state:'accepted',receipt:reply.receipt};
          if(reply.state==='not-delivered')return {state:'not-delivered'};
          return {state:'unknown'};
        }catch(e){
          // Connection never opened → safe to retry. After the line was written → unknown, never resend blindly.
          return (e as {sent?:boolean}).sent?{state:'unknown'}:{state:'not-delivered'};
        }
      })().finally(()=>inFlight.delete(key));
      inFlight.set(key,task);return task;
    },
    async reconcile(b:Binding,eventId:string,receipt?:string):Promise<Delivery>{
      if(!validBinding(b)||!UUID.test(eventId))return {state:'unknown'};
      if(validReceipt(receipt,b.chatId,eventId))return {state:'accepted',receipt};
      try{
        const r=await registry(b);if(!r)return {state:'unknown'};
        const reply=await request(r,{type:'reconcile',eventId});
        return reply.state==='accepted'&&validReceipt(reply.receipt,b.chatId,eventId)?{state:'accepted',receipt:reply.receipt}:{state:'unknown'};
      }catch{return {state:'unknown'};}
    },
  };
}
