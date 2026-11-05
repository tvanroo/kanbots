import { useEffect,useRef,useState } from 'react';
import { createPortal } from 'react-dom';
import type { CapacitySnapshot } from '@kanbots/api';
import { getBridge } from '../../desktop-bridge.js';
export function CapacityOverview(){
  const [data,setData]=useState<CapacitySnapshot|null>(null);const [open,setOpen]=useState(false);const [position,setPosition]=useState({top:0,left:0});const ref=useRef<HTMLButtonElement>(null);const closeTimer=useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(()=>{let active=true;let pending=false;const update=async()=>{if(pending||document.visibilityState!=='visible')return;pending=true;try{const next=await getBridge()?.capacity?.();if(active&&next)setData(next);}catch{}finally{pending=false;}};void update();const id=setInterval(()=>void update(),60000);return()=>{active=false;clearInterval(id);};},[]);
  const show=()=>{clearTimeout(closeTimer.current);const rect=ref.current?.getBoundingClientRect();if(rect)setPosition({top:Math.min(rect.bottom+8,window.innerHeight-360),left:Math.max(12,Math.min(rect.right-460,window.innerWidth-472))});setOpen(true);};
  const hide=()=>{closeTimer.current=setTimeout(()=>setOpen(false),150);};
  const rows=data?.rows??[];const included=rows.filter(r=>r.kind==='subscription'||r.kind==='grant');const ready=included.filter(r=>r.available).length;
  return <div className="kb-usage-row"><button ref={ref} className="kb-capacity-trigger" aria-expanded={open} aria-label="Capacity across providers" onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide} onClick={()=>open?setOpen(false):show()} onKeyDown={e=>{if(e.key==='Escape')setOpen(false);}}>
    <span>Capacity</span><span className="kb-capacity-blend">{(included.length?included:[null]).map((row,i)=><span key={row?.id??i} className="kb-capacity-segment" title={row?.label??'Loading'}><i style={{width:`${row?.usedPercent??0}%`,background:row?.usedPercent===null?'var(--text-muted)':(row?.usedPercent??0)>=90?'#e56c63':(row?.usedPercent??0)>=70?'#e9b350':'#68b880'}}/></span>)}</span><span>{data?`${ready} included sources ready`:'Checking capacity…'}</span>
  </button>{open?createPortal(<div className="kb-capacity-popover" role="dialog" aria-label="Provider capacity" style={position} onMouseEnter={()=>clearTimeout(closeTimer.current)} onMouseLeave={hide}>
    <strong>Provider capacity</strong><p className="kb-provider-desc">Routing tiers · sources in a tier share priority; the preferred source can change with quota, resets and cost.</p>
    {!rows.length?<p>No capacity reported yet.</p>:rows.map(row=><div key={row.id} className="kb-capacity-detail"><div><strong>{row.label}</strong><span>{row.kind==='paygo'?`$${(row.spent??0).toFixed(2)} spent`:row.remaining===null?'Balance unknown':row.kind==='subscription'?`${Math.max(0,row.remaining).toFixed(0)}% remaining`:`${row.id.startsWith('codex-credit')?'':'$'}${row.remaining.toFixed(2)} ${row.id.startsWith('codex-credit')?'credits':'remaining'}`}</span></div>
      <p className="kb-routing-tier">{row.preferredNow?'Preferred now · ':''}{row.routingTier??'Capacity'}{row.routingReason?` — ${row.routingReason}`:''}</p>
      <div className="kb-capacity-track" role={row.usedPercent!==null?'meter':undefined} aria-label={row.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={row.usedPercent??undefined}><i style={{width:`${row.usedPercent??0}%`,background:(row.usedPercent??0)>=90?'#e56c63':(row.usedPercent??0)>=70?'#e9b350':'#68b880'}}/></div>
      <small>{row.usedPercent===null?(row.kind==='paygo'?'No budget percentage available':'Percentage unavailable'):`${Math.round(row.usedPercent)}% ${row.kind==='paygo'?'of budget spent':'quota used'}`}</small><p>{row.detail}</p>
    </div>)}
    {data?.routing.lastReset?<p>{data.routing.lastReset}</p>:null}
    <button className="kb-btn ghost" onClick={()=>setOpen(false)}>Close</button>
  </div>,document.body):null}</div>;
}
