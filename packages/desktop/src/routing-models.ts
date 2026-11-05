import { app } from 'electron';
import { readFileSync,writeFileSync,renameSync } from 'node:fs';
import { join } from 'node:path';
import type { ApiConnection } from '@kanbots/api';
export type PricedModel={id:string; input:number; output:number; context:number; maxOutput:number; released:string};
let pending:Promise<any>|undefined;
export async function modelCatalogue():Promise<any>{
  const file=join(app.getPath('userData'),'routing-model-prices.json');
  let old:any;try{old=JSON.parse(readFileSync(file,'utf8'));}catch{}
  if(old&&Date.now()-old.at<86400000)return old.data;
  if(pending)return pending;
  pending=(async()=>{try{
    const response=await fetch('https://models.dev/api.json',{signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw Error();const data=await response.json() as any;
    if(!data.openai?.models||!data.anthropic?.models)throw Error();
    writeFileSync(file+'.tmp',JSON.stringify({at:Date.now(),data}),{mode:0o600});renameSync(file+'.tmp',file);return data;
  }catch{return old&&Date.now()-old.at<7*86400000?old.data:{};}})().finally(()=>{pending=undefined;});return pending;
}
export function selectApiModel(row:ApiConnection,catalogue:any):PricedModel|null{
  const known=catalogue[row.provider]?.models??{};
  const models:PricedModel[]=row.models.flatMap(m=>{
    const info=known[m.id];
    if(!info?.tool_call||info.status==='deprecated'||!Number.isFinite(info.cost?.input)||!Number.isFinite(info.cost?.output)||info.cost.input<=0||info.cost.output<=0)return [];
    if(row.provider==='openai'&&!/^gpt-/.test(m.id))return [];
    if(/audio|realtime|image|search|deep-research/.test(m.id))return [];
    return [{id:m.id,input:info.cost.input,output:info.cost.output,context:info.limit?.context??32000,maxOutput:info.limit?.output??4096,released:info.release_date??''}];
  });
  if(row.defaultModel)return models.find(m=>m.id===row.defaultModel)??null;
  const balanced=models.filter(m=>row.provider==='anthropic'?/sonnet/.test(m.id):/sol|terra|gpt-5/.test(m.id));
  return (balanced.length?balanced:models).sort((a,b)=>b.released.localeCompare(a.released)||a.output-b.output)[0]??null;
}
