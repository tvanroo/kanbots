import {randomUUID} from 'node:crypto';
export type Binding={id:string;clientId:string;hostId:string;chatId:string;adapterId:string;state:'pending'|'approved'|'revoked';createdAt:number};
export type Wake={id:string;workspaceId:string;clientId:string;epoch:number;bindingId:string;kind:string;cursor:number;createdAt:number;updatedAt:number;attempts:number;nextAttemptAt:number;state:'queued'|'sending'|'uncertain'|'accepted'|'received'|'acted'|'failed'|'cancelled';receipt?:string;error?:string;reachability?:string;actionSummary?:string;handoffId?:string};
export type Outbound={bindings:Binding[];events:Wake[]};
export type Delivery={state:'accepted'|'not-delivered'|'unknown';receipt?:string};
// Implement only against a supported host interface. The adapter must bind the
// exact existing chat and must never create a replacement session.
export interface HostAdapter {
 id:string;
 reachable(binding:Readonly<Binding>):Promise<{state:'available'|'busy'|'offline'|'revoked'|'unsupported'|'unknown';observedAt:number}>;
 send(binding:Readonly<Binding>,signal:Readonly<Pick<Wake,'id'|'workspaceId'|'clientId'|'epoch'|'kind'|'cursor'|'handoffId'>>):Promise<Delivery>;
 reconcile(binding:Readonly<Binding>,eventId:string,receipt?:string):Promise<Delivery>;
}
export function enqueueWake(out:Outbound,scope:{workspaceId:string;clientId:string;epoch:number;kind:string;cursor:number;handoffId?:string},now=Date.now()){
 const b=out.bindings.find(b=>b.clientId===scope.clientId&&b.state==='approved');if(!b)return;
 const duplicate=out.events.find(e=>e.bindingId===b.id&&e.epoch===scope.epoch&&e.cursor===scope.cursor&&e.kind===scope.kind);if(duplicate)return duplicate;
 const routine=scope.kind==='changes'?out.events.find(e=>e.bindingId===b.id&&e.epoch===scope.epoch&&e.kind==='changes'&&e.state==='queued'):undefined;
 if(routine){routine.cursor=scope.cursor;routine.updatedAt=now;return routine;}
 const e:Wake={...scope,id:randomUUID(),bindingId:b.id,createdAt:now,updatedAt:now,attempts:0,nextAttemptAt:now,state:'queued'};out.events.push(e);return e;
}
const terminal=new Set(['acted','failed','cancelled']);
export function reconcileAuthority(out:Outbound,valid:(e:Wake)=>boolean){for(const e of out.events)if(!terminal.has(e.state)&&(!valid(e)||!out.bindings.some(b=>b.id===e.bindingId&&b.state==='approved'))){e.state='cancelled';e.error='Binding or controller authority changed';e.updatedAt=Date.now();}}
export function acknowledgeWake(out:Outbound,actor:string,id:string,epoch:number,state:'received'|'acted',valid:(e:Wake)=>boolean){const e=out.events.find(e=>e.id===id&&e.clientId===actor&&e.epoch===epoch);if(!e||!valid(e)||e.state==='cancelled')throw Error('Wake target or authority is no longer current');if(!['sending','uncertain','accepted','received','acted'].includes(e.state))throw Error('Wake has not been delivered');if(e.state==='acted'||e.state===state)return e;if(state==='acted'&&e.state!=='received')throw Error('Acknowledge receipt before recording action');e.state=state;e.updatedAt=Date.now();return e;}
async function bounded<T>(task:Promise<T>):Promise<T>{let timer:ReturnType<typeof setTimeout>;try{return await Promise.race([task,new Promise<T>((_,reject)=>{timer=setTimeout(()=>reject(Error('Delivery timeout')),5000);})]);}finally{clearTimeout(timer!);}}
export async function deliverWake(out:Outbound,adapters:Map<string,HostAdapter>,save:()=>void,valid:(e:Wake)=>boolean,now=Date.now()){
 reconcileAuthority(out,valid);save();
 const e=out.events.find(e=>['queued','sending','uncertain'].includes(e.state)&&e.nextAttemptAt<=now&&adapters.has(out.bindings.find(b=>b.id===e.bindingId)?.adapterId??''));if(!e)return;
 const b=out.bindings.find(b=>b.id===e.bindingId&&b.state==='approved')!;const adapter=adapters.get(b.adapterId);if(!adapter)return; // Unsupported is not delivered.
 const uncertain=e.state==='sending'||e.state==='uncertain';
 if(e.attempts>=6){e.state='failed';e.error='Delivery requires attention after six attempts';save();return;}
 e.attempts++;e.updatedAt=now;e.nextAttemptAt=now+Math.min(300000,5000*2**(e.attempts-1));save();
 try{
  const reach=await bounded(adapter.reachable(b));e.reachability=reach.state;if(reach.state==='offline'){e.attempts--;e.nextAttemptAt=now+30000;delete e.error;return;}if(reach.state==='revoked'){b.state='revoked';e.state='cancelled';return;}if(reach.state!=='available')return;
  if(!valid(e)||b.state!=='approved'){e.state='cancelled';save();return;}
  if(!uncertain){e.state='sending';save();}
  const result=await bounded(uncertain?adapter.reconcile(b,e.id,e.receipt):adapter.send(b,{id:e.id,workspaceId:e.workspaceId,clientId:e.clientId,epoch:e.epoch,kind:e.kind,cursor:e.cursor,...(e.handoffId?{handoffId:e.handoffId}:{})}));
  // A receiver can acknowledge while transport completion is in flight.
  if(['received','acted','cancelled'].includes(e.state))return;
  if(!valid(e)||b.state!=='approved'){e.state='cancelled';return;}
  if(result.receipt)e.receipt=result.receipt;e.state=result.state==='accepted'?'accepted':result.state==='not-delivered'?'queued':'uncertain';delete e.error;
 }catch{if(!['received','acted','cancelled'].includes(e.state)){e.state=e.state==='sending'||uncertain?'uncertain':'queued';e.error='Host adapter unavailable or delivery outcome uncertain';}}
 finally{e.updatedAt=Date.now();save();}
}
