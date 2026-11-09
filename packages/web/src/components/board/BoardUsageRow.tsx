import { useEffect,useState } from 'react';
import { createPortal } from 'react-dom';
import { CoordinatorsModal } from '../modals/CoordinatorsModal.js';
import { CapacityOverview } from './CapacityOverview.js';
import { getBridge } from '../../desktop-bridge.js';
import { QuotaMeter } from '../usage/QuotaMeter.js';
export interface UsageWindow {
  pct: number;
  resetsAt: string | null;
}

export interface BoardUsageRowProps {
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  stale?: boolean;
  issueCount?: number;
  workspaceId?: string;
}

/**
 * Two stacked usage meters (5h + 7d windows) rendered identically in both
 * local and cloud modes. Pass `null` for either window to show a placeholder
 * — used in cloud mode until the cost-today endpoint lands (phase 2).
 */
export function BoardUsageRow({ fiveHour, sevenDay, stale, issueCount=0, workspaceId }: BoardUsageRowProps) {
  const [coordinators,setCoordinators]=useState(false);
  const [setup,setSetup]=useState(false);
  const [discover,setDiscover]=useState(false);
  const [request,setRequest]=useState<any>(null);
  const [mode,setMode]=useState('off');
  const [message,setMessage]=useState('');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const bridge=getBridge();
  useEffect(()=>{const open=()=>{setSetup(false);setCoordinators(true);};window.addEventListener('kanbots:open-coordinator-modal',open);return()=>window.removeEventListener('kanbots:open-coordinator-modal',open);},[]);
  const refresh=async()=>{const state=await bridge?.coordinatorState?.();setMode(state?.workspace?.mode??'off');setRequest(state?.workspace?.requests?.find((r:any)=>r.kind==='discovery')??null);const status=await bridge?.coordinatorAction?.('onboarding-status');setDiscover(!!status?.needed);};
  useEffect(()=>{setError('');setNotice('');setMessage('');void refresh().catch(()=>{});},[workspaceId,issueCount,coordinators]);
  useEffect(()=>{const t=setInterval(()=>void bridge?.coordinatorState?.().then(s=>{setMode(s?.workspace?.mode??'off');setRequest(s?.workspace?.requests?.find((r:any)=>r.kind==='discovery')??null);}).catch(()=>{}),3000);return()=>clearInterval(t);},[workspaceId]);
  async function startDiscovery(){setBusy(true);setError('');try{
    const result=await bridge?.coordinatorAction?.('request-discovery');setRequest(result);setNotice('Discovery request queued for your coordinator.');if(mode!=='external'){setSetup(false);setCoordinators(true);}
  }catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}
  async function setupExternal(){setBusy(true);setError('');try{if(mode==='external'){setSetup(true);setCoordinators(true);return;}setSetup(false);setCoordinators(true);const result=await bridge?.coordinatorAction?.('external-setup-start');if(result?.dispatchError)throw Error(result.dispatchError);setSetup(false);setCoordinators(true);}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}
  async function send(){setBusy(true);setError('');try{setSetup(false);setCoordinators(true);if(mode!=='internal')await bridge?.coordinatorAction?.('handoff',{mode:'internal'});const result=await bridge?.coordinatorAction?.('chat-send',{body:message});if(result?.dispatchError)throw Error(result.dispatchError);setMessage('');setSetup(false);setCoordinators(true);}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}
  if(bridge?.capacity)return <>
    <div className="kb-coordinator-strip"><div className="kb-coordinator-actions"><button className="kb-btn ghost" onClick={()=>{setSetup(mode==='external');setCoordinators(true);}}>{mode==='external'?'Change coordinator':'Coordinators'}</button>{mode==='external'?<><button className="kb-btn" disabled={busy||!!request} onClick={()=>void startDiscovery()}>Discover repository</button>{request?<span role="status">{request.state==='queued'?'Queued — waiting for coordinator':'Received by coordinator'}</span>:null}{request?.state==='queued'?<button className="kb-btn ghost" onClick={()=>void navigator.clipboard.writeText('KanBorg has a queued discovery request. Call getWorkspaceSummary, then getCoordinatorRequests. Acknowledge the request as received, follow its prompt, and mark it completed when finished. Keep checking waitForChanges while coordinating.')}>Copy wake-up prompt</button>:null}</>:null}</div><CapacityOverview /></div>
    {mode!=='external'?<section className="kb-board-onboarding" aria-label="Project coordinator">
      <div className="kb-board-onboarding-main">
        <span className="kb-board-onboarding-label">{mode==='external'?'Repository discovery':'Your built-in coordinator'}</span>
        <h2>{issueCount===0?'Bring your project onto the board':mode==='external'?'Discover existing work':'What would you like to work on?'}</h2>
        <p>{issueCount===0?'Find features, bugs and ongoing work in this repository. Your coordinator will organize the board with evidence and current status.':'Ask your coordinator to plan work, delegate tasks and keep the board up to date.'}</p>
        {(discover||issueCount===0)?<div className="kb-coordinator-actions"><button className="kb-btn primary" disabled={busy} onClick={()=>void startDiscovery()}>{busy?'Starting…':mode==='external'?'Copy repository discovery request':'Populate board from repository'}</button><span className="kb-provider-desc">Reads the repository and updates cards. Does not start feature development.</span></div>:null}
        {mode!=='external'?<form onSubmit={e=>{e.preventDefault();void send();}}><label htmlFor="board-coordinator-message">Or tell your coordinator what you need</label><div className="kb-board-coordinator-compose"><textarea id="board-coordinator-message" value={message} onChange={e=>setMessage(e.target.value)} placeholder="Find ongoing features and bugs, then help me decide what to do next…" rows={2}/><button className="kb-btn" disabled={busy||!message.trim()} type="submit">Send to coordinator</button></div></form>:null}
        {error?<p role="alert" className="kb-coordinator-error">{error}</p>:null}{notice?<p role="status">{notice}</p>:null}
      </div>
      <aside><h3>Prefer your own harness?</h3><p>Your built-in coordinator can help connect DeepSeek Harness or another local MCP-compatible app, step by step.</p><button className="kb-btn" disabled={busy} onClick={()=>void setupExternal()}>Connect external coordinator</button><p className="kb-provider-desc">Starts a guided setup chat · you approve the handoff</p></aside>
    </section>:null}
    {coordinators?createPortal(<CoordinatorsModal launching={busy} launchError={error} initialSection='chat' initialChange={setup} onClose={()=>setCoordinators(false)}/>,document.body):null}
  </>;
  return (
    <div className="kb-usage-row">
      <span className="kb-usage-label">Claude{stale ? ' · stale' : ''}</span>
      <UsageMeter label="5h" usage={fiveHour} />
      <UsageMeter label="7d" usage={sevenDay} />
    </div>
  );
}

function UsageMeter({ label, usage }: { label: string; usage: UsageWindow | null }) {
  if (usage === null) {
    return (
      <div className="kb-usage-meter is-empty" title={`${label} usage unavailable`}>
        <span className="kb-usage-label">{label}</span>
        <span className="kb-usage-bar" aria-hidden>
          <span className="kb-usage-bar-fill" style={{ width: '0%' }} />
        </span>
        <span className="kb-usage-pct">—</span>
      </div>
    );
  }
  if (usage.resetsAt && Date.parse(usage.resetsAt) <= Date.now()) return <div className="kb-usage-meter is-empty"><span className="kb-usage-label">{label}</span><span>Updating quota…</span></div>;
  const pct = Math.max(0, Math.min(1, usage.pct));
  const tone = pct >= 0.9 ? 'danger' : pct >= 0.7 ? 'warn' : 'ok';
  const display = `${Math.round(pct * 100)}% quota used`;
  const reset = usage.resetsAt ? formatResetCountdown(usage.resetsAt) : null;
  const title = usage.resetsAt
    ? `${label} window · ${display} · resets ${new Date(usage.resetsAt).toLocaleString()}`
    : `${label} window · ${display}`;
  return (
    <div className={`kb-usage-meter tone-${tone}`} title={title}>
      <span className="kb-usage-label">{label}</span>
      <QuotaMeter label={`${label} quota`} usedPercent={pct * 100} />
      {reset ? <span className="kb-usage-reset">Resets in {reset}</span> : null}
    </div>
  );
}

// Countdown until the reset boundary, in the user's local frame of
// reference. Examples: "1 hr 55 min", "23 min", "2 d 3 hr", "<1 min".
function formatResetCountdown(iso: string): string {
  const target = new Date(iso).getTime();
  if (!Number.isFinite(target)) return '';
  const ms = target - Date.now();
  if (ms <= 0) return 'now';
  const totalMin = Math.floor(ms / 60_000);
  if (totalMin < 1) return '<1 min';
  if (totalMin < 60) return `${totalMin} min`;
  const totalHr = Math.floor(totalMin / 60);
  const remMin = totalMin % 60;
  if (totalHr < 24) return remMin === 0 ? `${totalHr} hr` : `${totalHr} hr ${remMin} min`;
  const days = Math.floor(totalHr / 24);
  const remHr = totalHr % 24;
  return remHr === 0 ? `${days} d` : `${days} d ${remHr} hr`;
}
