import { useEffect,useState } from 'react';
import { getBridge } from '../desktop-bridge.js';
// Issue changes arrive in bursts while workers run (one per database write the
// watcher sees), so reads are debounced, and a change that lands while a read
// is in flight queues exactly one follow-up read instead of being dropped.
const REFRESH_DEBOUNCE_MS=150;
export function useWorkflow(workspaceKey?:string){
 const [data,setData]=useState<any>(null);
 useEffect(()=>{let alive=true;let busy=false;let again=false;let timer:ReturnType<typeof setTimeout>|null=null;
  const refresh=async()=>{if(busy){again=true;return;}busy=true;again=false;try{const next=await getBridge()?.coordinatorAction?.('workflow:board');if(alive&&next)setData(next);}catch{/* Cloud or no workspace: keep the normal board. */}finally{busy=false;if(again&&alive)schedule();}};
  const schedule=()=>{if(timer!==null)return;timer=setTimeout(()=>{timer=null;void refresh();},REFRESH_DEBOUNCE_MS);};
  setData(null);void refresh();const unsub=getBridge()?.subscribe('workflow:changed',schedule);const issues=getBridge()?.subscribe('issues:changed',schedule);const t=setInterval(()=>{if(!document.hidden)void refresh();},10000);return()=>{alive=false;if(timer!==null)clearTimeout(timer);unsub?.();issues?.();clearInterval(t);};
 },[workspaceKey]);return data;
}
