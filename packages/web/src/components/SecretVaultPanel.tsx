import {useEffect,useState} from 'react';
import './secret-vault.css';
import {getBridge} from '../desktop-bridge.js';
export function SecretVaultPanel({requested}:{requested?:{name:string;consumer:string}}){
 const [state,setState]=useState<any>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const [name,setName]=useState(requested?.name??''),[selected,setSelected]=useState<string[]>([]),[value,setValue]=useState('');
 const [options,setOptions]=useState<Array<{label:string;scope:any}>>([]),[filter,setFilter]=useState('');
 const action=async(kind:string,args:Record<string,unknown>={})=>{setBusy(true);setError('');try{const bridge=getBridge();if(!bridge?.coordinatorAction)throw Error('Desktop connection required');const result=await bridge.coordinatorAction('vault-'+kind,args) as any;setState(result);const available=await bridge.coordinatorAction('vault-options',{}) as Array<{label:string;scope:any}>;setOptions(available);if(requested)setSelected(current=>current.length?current:available.filter(o=>o.scope.kind==='consumer'&&o.scope.projectId===result.project&&o.scope.consumer===requested.consumer).map(o=>JSON.stringify(o.scope)));if(kind==='stage'){setValue('');setName(requested?.name??'');if(!requested)setSelected([]);}}catch(e){setError(e instanceof Error?e.message:'Vault operation failed');}finally{setBusy(false);}};
 useEffect(()=>{void action('status');},[]);
 return <section aria-label="Local secret vault" className="kb-vault"><h2>Local secret vault</h2><p>Store passwords and API keys encrypted on this Mac. No Bitwarden account is required. Secret values are write-only; coordinators can inspect names and status, never the values.</p>
 <button className="kb-btn" disabled={busy} onClick={()=>void action('restore')}>Restore encrypted recovery package</button> <button className="kb-btn" disabled={busy} onClick={()=>void action('status')}>Refresh</button>{error?<p role="alert">{error}</p>:null}
 {!state?<button className="kb-btn" disabled={busy} onClick={()=>void action('status')}>Refresh vault</button>:!state.initialized?<><p>Initialize once using this Mac’s protected key storage, or an externally configured vault key. Keep that key when restoring a backup.</p><button className="kb-btn" disabled={busy} onClick={()=>void action('initialize')}>Initialize encrypted vault</button></>:<>
 <form onSubmit={e=>{e.preventDefault();void action('stage',{name,authorizedScopes:selected.map(s=>JSON.parse(s)),value});}}>
 <label>Name<input readOnly={!!requested} required maxLength={200} value={name} onChange={e=>setName(e.target.value)} autoComplete="off"/></label>
 <div className="kb-vault-consumers"><span id="vault-consumer-label">Authorized consumers</span>
 <details className="kb-vault-picker" onKeyDown={e=>{if(e.key==='Escape'){e.currentTarget.open=false;e.currentTarget.querySelector('summary')?.focus();}}}>
 <summary aria-labelledby="vault-consumer-label vault-consumer-selection"><span id="vault-consumer-selection">{selected.length?`${selected.length} authorization scope${selected.length===1?'':'s'} selected`:'Select consumers or projects'}</span></summary>
 <div className="kb-vault-options"><input aria-label="Find consumers or projects" placeholder="Find a consumer or project…" value={filter} onChange={e=>setFilter(e.target.value)}/>
 <div role="group" aria-label="Authorization scopes">{options.filter(o=>o.label.toLowerCase().includes(filter.toLowerCase())).map(o=>{const id=JSON.stringify(o.scope);return <label key={id}><input type="checkbox" disabled={busy} checked={selected.includes(id)} onChange={e=>setSelected(old=>e.target.checked?[...old,id]:old.filter(s=>s!==id))}/><span>{o.label}</span></label>;})}</div>
 {!options.some(o=>o.label.toLowerCase().includes(filter.toLowerCase()))?<p>No matching consumers or projects.</p>:null}</div></details>
 <small>Project access includes current and future KanBorg consumers in that repository. All includes every repository. These choices apply when this version is activated.</small>
 {selected.length?<ul className="kb-vault-selections">{selected.map(id=><li key={id}>{options.find(o=>JSON.stringify(o.scope)===id)?.label??'Unavailable selection'}<button type="button" className="kb-btn" disabled={busy} aria-label={`Remove ${options.find(o=>JSON.stringify(o.scope)===id)?.label??'selection'}`} onClick={()=>setSelected(old=>old.filter(s=>s!==id))}>×</button></li>)}</ul>:null}
 </div>
 <label>Password or API key<input required type="password" maxLength={65536} autoComplete="new-password" value={value} onChange={e=>setValue(e.target.value)}/></label>
 <button className="kb-btn primary" disabled={busy||!value||!name||!selected.length} type="submit">Save staged version</button>
 </form><p>Saving a new version keeps the current version active. Activate only when its consumer is ready. Retired versions remain available for rollback. Existing provider connections are not migrated automatically.</p>
 <ul>{state.items.map((s:any)=><li key={s.id}><strong>{s.name}</strong> · {(s.authorizedScopes??[]).map((scope:any)=>options.find(o=>JSON.stringify(o.scope)===JSON.stringify(scope))?.label??(scope.kind==='consumer'?scope.consumer:scope.kind==='all'?'All KanBorg consumers':`Project ${scope.projectId}`)).join(', ')||s.consumer} · version {s.version} · {s.state}{['staged','retired'].includes(s.state)?<button className="kb-btn" disabled={busy} onClick={()=>void action('activate',{id:s.id})}>{s.state==='retired'?'Restore this version':'Activate version'}</button>:null}{s.state!=='revoked'?<button className="kb-btn" disabled={busy} onClick={()=>{if(window.confirm(`Revoke ${s.name} version ${s.version}? Consumers will lose access to this version.`))void action('revoke',{id:s.id});}}>Revoke</button>:null}</li>)}</ul>
 <button className="kb-btn" disabled={busy} onClick={()=>void action('backup')}>Save verified recovery package</button>{state.recovery?<p role="status">Recovery package verified: {state.recovery.path}. {state.recovery.note}</p>:null}<details><summary>Recent vault activity</summary><ul>{state.audit.map((e:any)=><li key={e.seq}>{e.at} · {e.action} · {e.actor}</li>)}</ul></details>
 </>}
 </section>;
}
