import { useEffect,useState } from 'react';
import { getBridge } from '../desktop-bridge.js';
export function useWorkflow(workspaceKey?:string){
 const [data,setData]=useState<any>(null);
 useEffect(()=>{let alive=true;let busy=false;const refresh=async()=>{if(busy)return;busy=true;try{const next=await getBridge()?.coordinatorAction?.('workflow:get');if(alive&&next)setData(next);}catch{/* Cloud or no workspace: keep the normal board. */}finally{busy=false;}};
  setData(null);void refresh();const unsub=getBridge()?.subscribe('workflow:changed',()=>void refresh());const issues=getBridge()?.subscribe('issues:changed',()=>void refresh());const t=setInterval(()=>{if(!document.hidden)void refresh();},10000);return()=>{alive=false;unsub?.();issues?.();clearInterval(t);};
 },[workspaceKey]);return data;
}
