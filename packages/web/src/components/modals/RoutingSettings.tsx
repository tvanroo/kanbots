import { useEffect,useState } from 'react';
import type { RoutingState,RoutingConfig } from '@kanborg/api';
import { getBridge } from '../../desktop-bridge.js';
export function RoutingSettings(){
  const [state,setState]=useState<RoutingState|null>(null);const [form,setForm]=useState<RoutingConfig|null>(null);const [message,setMessage]=useState('');const [busy,setBusy]=useState(false);
  useEffect(()=>{void getBridge()?.routingState?.().then(s=>{setState(s);setForm(s.config);});},[]);
  if(!state||!form)return null;
  const dirty=JSON.stringify(form)!==JSON.stringify(state.config);
  return <div className="kb-api-card"><div className="kb-api-heading"><h4>Automatic capacity routing</h4><span>{form.enabled?'On':'Off'}</span></div>
    <p className="kb-provider-desc">OpenAI + Anthropic · expiring grants, then included subscriptions, then allowed pay-go. Applies to new task turns; other providers keep manual routing.</p>
    <label className="kb-api-toggle"><input type="checkbox" checked={form.enabled} onChange={e=>setForm({...form,enabled:e.target.checked})}/>Choose provider and payment source automatically</label>
    <details className="kb-api-manual"><summary>Spending &amp; reset controls</summary>
      <div className="kb-api-field"><label htmlFor="routing-budget">Maximum API spend per task turn (USD)</label><input id="routing-budget" type="number" min="0.01" max="1000" step="0.01" value={form.maxRunUsd} onChange={e=>setForm({...form,maxRunUsd:Number(e.target.value)})}/></div>
      <p className="kb-provider-desc">Estimated prices and delayed provider balances cannot guarantee a provider-side spending cap. Set a hard limit with your provider when required. Subscription extra-usage settings remain provider-controlled.</p>
      <label className="kb-api-toggle"><input type="checkbox" checked={form.autoResets} onChange={e=>setForm({...form,autoResets:e.target.checked})}/>Manage available ChatGPT reset credits automatically</label>
      <p className="kb-provider-desc">Redeem near expiry, or when quota is nearly exhausted with work ready and the natural reset is over 6 hours away. Runs while KanBorg is open.</p>
      <div className="kb-api-field"><label htmlFor="claude-reset-expiry">Claude reset offer expires (optional, local time)</label><input id="claude-reset-expiry" type="datetime-local" value={form.claudeResetExpiresAt?localDate(form.claudeResetExpiresAt):''} onChange={e=>setForm({...form,claudeResetExpiresAt:e.target.value?new Date(e.target.value).toISOString():null})}/></div>
      <p className="kb-provider-desc">Claude does not expose reset redemption through its CLI. Enter an offer’s expiry to prioritize useful Claude work beforehand; redeem in Claude Usage, then clear this date. <a href="https://claude.ai/settings/usage" target="_blank" rel="noreferrer">Open Claude Usage</a></p>
      {state.lastReset?<p className="kb-provider-desc">{state.lastReset}</p>:null}
    </details>
    {state.lastDecision?<p className="kb-provider-desc">{state.lastDecision}</p>:null}
    <button className="kb-btn primary" disabled={!dirty||busy||!Number.isFinite(form.maxRunUsd)||form.maxRunUsd<=0} onClick={()=>{setBusy(true);void getBridge()?.saveRouting?.(form).then(s=>{setState(s);setMessage('Saved');}).catch(()=>setMessage('Could not save. Check the fields.')).finally(()=>setBusy(false));}}>Save</button>
    {message?<span role="status"> {message}</span>:null}
  </div>;
}
function localDate(iso:string){const d=new Date(iso);return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);}
