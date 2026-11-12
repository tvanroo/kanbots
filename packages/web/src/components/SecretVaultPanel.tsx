import {useEffect,useState} from 'react';
import './secret-vault.css';
import {getBridge} from '../desktop-bridge.js';
export function SecretVaultPanel({requested}:{requested?:{name:string;consumer:string}}){
 const [state,setState]=useState<any>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const [name,setName]=useState(requested?.name??''),[consumer,setConsumer]=useState(requested?.consumer??''),[value,setValue]=useState('');
 const action=async(kind:string,args:Record<string,unknown>={})=>{setBusy(true);setError('');try{const bridge=getBridge();if(!bridge?.coordinatorAction)throw Error('Desktop connection required');setState(await bridge.coordinatorAction('vault-'+kind,args));if(kind==='stage'){setValue('');setName(requested?.name??'');setConsumer(requested?.consumer??'');}}catch(e){setError(e instanceof Error?e.message:'Vault operation failed');}finally{setBusy(false);}};
 useEffect(()=>{void action('status');},[]);
 return <section aria-label="Local secret vault" className="kb-vault"><h2>Local secret vault</h2><p>Store passwords and API keys encrypted on this Mac. No Bitwarden account is required. Secret values are write-only; coordinators can inspect names and status, never the values.</p>
 <button className="kb-btn" disabled={busy} onClick={()=>void action('restore')}>Restore encrypted recovery package</button> <button className="kb-btn" disabled={busy} onClick={()=>void action('status')}>Refresh</button>{error?<p role="alert">{error}</p>:null}
 {!state?<button className="kb-btn" disabled={busy} onClick={()=>void action('status')}>Refresh vault</button>:!state.initialized?<><p>Initialize once using this Mac’s protected key storage, or an externally configured vault key. Keep that key when restoring a backup.</p><button className="kb-btn" disabled={busy} onClick={()=>void action('initialize')}>Initialize encrypted vault</button></>:<>
 <form onSubmit={e=>{e.preventDefault();void action('stage',{name,consumer,value});}}>
 <label>Name<input readOnly={!!requested} required maxLength={200} value={name} onChange={e=>setName(e.target.value)} autoComplete="off"/></label>
 <label>Authorized consumer<input readOnly={!!requested} required maxLength={200} placeholder="For example: catalog-importer" value={consumer} onChange={e=>setConsumer(e.target.value)} autoComplete="off"/></label>
 <label>Password or API key<input required type="password" maxLength={65536} autoComplete="new-password" value={value} onChange={e=>setValue(e.target.value)}/></label>
 <button className="kb-btn primary" disabled={busy||!value||!name||!consumer} type="submit">Save staged version</button>
 </form><p>Saving a new version keeps the current version active. Activate only when its consumer is ready. Retired versions remain available for rollback. Existing provider connections are not migrated automatically.</p>
 <ul>{state.items.map((s:any)=><li key={s.id}><strong>{s.name}</strong> · {s.consumer} · version {s.version} · {s.state}{['staged','retired'].includes(s.state)?<button className="kb-btn" disabled={busy} onClick={()=>void action('activate',{id:s.id})}>{s.state==='retired'?'Restore this version':'Activate version'}</button>:null}{s.state!=='revoked'?<button className="kb-btn" disabled={busy} onClick={()=>{if(window.confirm(`Revoke ${s.name} version ${s.version}? Consumers will lose access to this version.`))void action('revoke',{id:s.id});}}>Revoke</button>:null}</li>)}</ul>
 <button className="kb-btn" disabled={busy} onClick={()=>void action('backup')}>Save verified recovery package</button>{state.recovery?<p role="status">Recovery package verified: {state.recovery.path}. {state.recovery.note}</p>:null}<details><summary>Recent vault activity</summary><ul>{state.audit.map((e:any)=><li key={e.seq}>{e.at} · {e.action} · {e.actor}</li>)}</ul></details>
 </>}
 </section>;
}
