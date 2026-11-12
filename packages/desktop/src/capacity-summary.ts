import type {CapacitySnapshot} from '@kanborg/api';
/** MCP projection only: never truncate the cached snapshot used by Stats. */
export function compactCapacity(snapshot:CapacitySnapshot,offset?:number,limit=50){
 const usage=snapshot.routing?.apiUsage??[];
 const {apiUsage:_,...routing}=snapshot.routing??{};
 const settled=usage.filter(c=>!c.pending), pending=usage.filter(c=>c.pending);
 const summary={scope:'retained-history',count:usage.length,settledUsd:settled.reduce((n,c)=>n+c.usd,0),pendingUsd:pending.reduce((n,c)=>n+c.usd,0),pendingCount:pending.length};
 return {...snapshot,routing:{...routing,apiUsageSummary:summary,...(offset===undefined?{}:{apiUsage:usage.slice(offset,offset+limit),history:{offset,nextOffset:offset+limit<usage.length?offset+limit:null,total:usage.length}})}};
}
