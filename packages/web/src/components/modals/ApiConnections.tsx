import {getBridge} from '../../desktop-bridge.js';
import { QuotaMeter } from '../usage/QuotaMeter.js';
import { zonedInput, zonedIso } from './connection-time.js';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { api } from '../../api.js';
import type { ApiConnection, ApiConnectionInput, ProvidersPayload, OpenAIReporting } from '../../types.js';

type Props = { provider: 'openai' | 'anthropic'; connections: ApiConnection[]; openaiReport?: OpenAIReporting | undefined; anthropicReports?: ProvidersPayload['anthropicReportingAccounts']; onChanged: (value: ProvidersPayload) => void };
type Errors = Record<string, string>;
type ExpirationMode = 'unknown' | 'never' | 'date';
const providerName = (provider: Props['provider']) => provider === 'openai' ? 'OpenAI' : 'Anthropic';

export function ApiConnections({ provider, connections, onChanged, openaiReport, anthropicReports }: Props) {
  const [adding, setAdding] = useState(false);
  const scanned = useRef(new Set<string>());
  useEffect(() => {
    if (provider !== 'openai') return;
    const rows = connections.filter(row => row.provider === 'openai' && row.organizationId === undefined && !scanned.current.has(row.id));
    for (const row of rows) scanned.current.add(row.id);
    void (async () => { for (const row of rows) {
      try { onChanged(await api.saveProvider({ id: 'codex-cli', refreshConnectionId: row.id })); } catch { /* Existing Refresh button can retry. */ }
    } })();
  }, [connections, provider]);
  const grantOrganizations = [...new Set(connections.filter(row => row.provider === 'anthropic' && row.organizationId && row.grantBillingDay && row.renewal === 'monthly' && row.funding !== 'paid').map(row => row.organizationId!))].sort().join(',');
  useEffect(() => {
    if (provider !== 'anthropic' || !grantOrganizations) return;
    let cancelled = false;
    let pending = false;
    const refresh = async () => {
      if (pending || document.visibilityState !== 'visible') return;
      pending = true;
      try { for (const organizationId of grantOrganizations.split(',')) {
        const next = await api.saveProvider({ id: 'claude-code', reportingAction: 'refresh', reportingOrganizationId: organizationId });
        if (!cancelled) onChanged(next);
      } } catch { /* Existing readings stay visible; manual Refresh can retry. */ }
      finally { pending = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15 * 60 * 1000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [provider, grantOrganizations]);
  return <div className="kb-api-connections">
    <div className="kb-api-heading"><h4>API connections</h4><span>Keys encrypted on this Mac</span></div>
    <p className="kb-provider-desc">Separate from your subscription. Automatic routing respects enabled keys and their funding rules.</p>
    {connections.filter(row => row.provider === provider).map(row => <ConnectionEditor key={row.id} initial={row} provider={provider} openaiReport={openaiReport} anthropicReport={anthropicReports?.find(a => a.organizationId === row.organizationId)?.report} onChanged={onChanged} />)}
    {adding ? <ConnectionEditor provider={provider} onChanged={value => { onChanged(value); setAdding(false); }} onCancel={() => setAdding(false)} /> : <button type="button" className="kb-btn" onClick={() => setAdding(true)}>Add API key</button>}
  </div>;
}
function ConnectionEditor({ provider, initial, onChanged, onCancel, openaiReport, anthropicReport }: { anthropicReport?: ProvidersPayload['anthropicReporting']; openaiReport?: OpenAIReporting | undefined; provider: Props['provider']; initial?: ApiConnection; onChanged: Props['onChanged']; onCancel?: () => void }) {
  const [form, setForm] = useState<ApiConnectionInput>(() => ({
    vaultReference:initial?.vaultReference??null, id: initial?.id ?? crypto.randomUUID(), provider, name: initial?.name ?? '', enabled: initial?.enabled ?? true,
    priority: initial?.priority ?? 1, funding: !initial || initial.funding === 'unknown' ? 'paid' : initial.funding, budget: initial?.budget ?? null,
    grantBillingDay: initial?.grantBillingDay, grantFirstStart: initial?.grantFirstStart ?? null,
    rollover: initial?.rollover ?? false, afterGrant: initial?.afterGrant ?? 'stop',
    remaining: initial?.remaining ?? null, expiresAt: initial?.expiresAt ?? null,
    expirationMode: initial?.expirationMode ?? (initial?.expiresAt ? 'date' : 'unknown'),
    timeZone: initial?.timeZone ?? 'UTC',
    keyExpirationMode: initial?.keyExpirationMode ?? 'unknown', keyExpiresAt: initial?.keyExpiresAt ?? null,
    renewal: initial?.renewal ?? 'monthly', renewsAt: initial?.renewsAt ?? null,
    expired: initial?.expired ?? false, pool: initial?.pool ?? '', defaultModel: initial?.defaultModel ?? null,
  }));
  const [vaultOptions,setVaultOptions]=useState<Array<{id:string;project:string;name:string;version:number}>>([]);
  useEffect(()=>{let mounted=true;void getBridge()?.coordinatorAction?.('vault-status').then((result:any)=>{if(mounted)setVaultOptions((result.items??[]).filter((item:any)=>item.state==='active'&&item.consumer===`api:${provider}`).map((item:any)=>({...item,project:result.project})));}).catch(()=>{});return()=>{mounted=false;};},[provider]);
  const [savedForm, setSavedForm] = useState(form);
  const [key, setKey] = useState('');
  const [expanded, setExpanded] = useState(!initial);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [message, setMessage] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const manual = useRef<HTMLDetailsElement>(null);
  const prefix = useId();
  const dirty = JSON.stringify(form) !== JSON.stringify(savedForm) || key.trim().length > 0;
  const change = <K extends keyof ApiConnectionInput>(field: K, value: ApiConnectionInput[K]) => {
    setForm(old => ({ ...old, [field]: value }));
    setErrors(old => { const next = { ...old }; delete next[field]; return next; });
    setMessage('');
  };
  function showErrors(next: Errors) {
    setErrors(next); setMessage('Check the highlighted fields.');
    if (manual.current) manual.current.open = true;
    const field = Object.keys(next)[0];
    root.current?.querySelector<HTMLElement>(`[data-field="${field}"]`)?.focus();
  }
  function validate(): Errors {
    const next: Errors = { ...errors };
    if (form.name.trim().length > 100) next.name = 'Use 100 characters or fewer.';
    if ((!initial && !key.trim() && !form.vaultReference) || (key.trim() && (key.trim().length < 11 || key.trim().length > 2000 || /\s/.test(key.trim())))) next.apiKey = 'Paste a complete API key without spaces.';
    for (const field of ['budget', 'remaining'] as const) {
      const value = form[field];
      if (value !== null && (!Number.isFinite(value) || value < 0)) next[field] = 'Enter an amount of zero or more, or leave it empty.';
    }
    if (form.funding !== 'paid' && form.renewal === 'monthly') {
      if (form.budget === null || form.budget <= 0) next.budget = 'Enter the monthly grant amount.';
      if (provider === 'anthropic') {
        if (!form.grantBillingDay || !Number.isInteger(form.grantBillingDay) || form.grantBillingDay < 1 || form.grantBillingDay > 31) next.grantBillingDay = 'Enter your subscription billing day (1–31).';
      } else if (!form.renewsAt) next.renewsAt = 'Choose the next monthly reset.';
    }
    if (form.expirationMode === 'date' && !form.expiresAt) next.expiresAt = 'Choose the credit expiration date, or select Unknown.';
    if (form.keyExpirationMode === 'date' && !form.keyExpiresAt) next.keyExpiresAt = 'Choose the key expiration date, or select Unknown.';
    for (const input of root.current?.querySelectorAll<HTMLInputElement>('input[data-field]') ?? []) {
      if (!input.validity.valid && input.dataset.field) next[input.dataset.field] = input.type === 'datetime-local' ? 'Enter a complete date and time.' : 'Check this value.';
    }
    return next;
  }
  async function save(refreshOnly = false) {
    if (busy || (!dirty && !refreshOnly)) return;
    if (!refreshOnly) {
      const invalid = validate();
      if (Object.keys(invalid).length) { showErrors(invalid); return; }
    }
    setBusy(true); setMessage('');
    const providerId = provider === 'openai' ? 'codex-cli' : 'claude-code';
    let savedPayload: ProvidersPayload | undefined;
    try {
      if (!refreshOnly && dirty) {
        const saved = { ...form, name: form.name.trim() || `${providerName(provider)} API` };
        savedPayload = await api.saveProvider({ id: providerId, connection: { ...saved, ...(key.trim() ? { apiKey: key.trim() } : {}) } });
        const clean = { ...saved, confirmBalance: false }; setForm(clean); setSavedForm(clean); setKey(''); setErrors({});
      }
      // Discover immediately after a key is added/replaced; metadata-only edits do not need network access.
      if (refreshOnly || key.trim()) savedPayload = await api.saveProvider({ id: providerId, refreshConnectionId: form.id });
      const current = savedPayload?.apiConnections?.find(row => row.id === form.id) ?? initial;
      if (provider === 'anthropic' && current?.organizationId && form.grantBillingDay && form.renewal === 'monthly' && form.funding !== 'paid') {
        savedPayload = await api.saveProvider({ id: providerId, reportingAction: 'refresh', reportingOrganizationId: current.organizationId });
      }
      if (savedPayload) onChanged(savedPayload);
      if (!refreshOnly) setExpanded(false);
      setMessage(refreshOnly ? 'Details refreshed.' : 'Saved.');
    } catch (error) {
      if (savedPayload) {
        onChanged(savedPayload); setExpanded(false);
        setMessage('Saved. Provider details could not be refreshed; try Refresh again.');
      } else {
        const detail = error as { details?: { fields?: string[] }; message?: string };
        if (detail.details?.fields?.length) showErrors(Object.fromEntries(detail.details.fields.map(field => [field, 'Check this value.'])));
        else if (detail.message?.includes('Encrypted storage is unavailable')) setMessage('Encrypted storage is unavailable on this Mac. Your key was not saved.');
        else setMessage('Could not save this connection. Your changes are still here; try again.');
      }
    } finally { setBusy(false); }
  }
  function cancel() {
    if (onCancel) return onCancel();
    setForm(savedForm); setKey(''); setErrors({}); setMessage(''); setExpanded(false);
  }
  function attributes(field: string) {
    return { id: `${prefix}-${field}`, 'data-field': field, 'aria-invalid': Boolean(errors[field]), 'aria-describedby': errors[field] ? `${prefix}-${field}-error` : undefined };
  }
  function field(name: string, label: string, control: ReactNode, wide = false) {
    return <div className={`kb-api-field${wide ? ' wide' : ''}`}><label htmlFor={`${prefix}-${name}`}>{label}</label>{control}{errors[name] ? <span className="kb-api-field-error" id={`${prefix}-${name}-error`}>{errors[name]}</span> : null}</div>;
  }
  function dateInput(name: 'expiresAt' | 'keyExpiresAt' | 'renewsAt' | 'grantFirstStart', label: string) {
    const display = zonedInput(form[name], form.timeZone ?? 'UTC');
    function update(value: string) {
      const parsed = zonedIso(value, form.timeZone ?? 'UTC');
      change(name, parsed);
      if (value && !parsed) setErrors(old => ({ ...old, [name]: 'This time does not exist in the selected zone. Choose another time.' }));
    }
    return field(name, label, <><div className="kb-api-date-pair"><input {...attributes(name)} type="date" value={display.slice(0, 10)} onChange={e => update(e.target.value ? `${e.target.value}T${display.slice(11) || '00:00'}` : '')} /><input aria-label={`${label} time`} type="time" value={display.slice(11) || '00:00'} onChange={e => update(display ? `${display.slice(0, 10)}T${e.target.value}` : '')} /></div>{form[name] ? <small className="kb-api-date-hint">Local: {new Date(form[name]!).toLocaleString()}</small> : <small className="kb-api-date-hint">Time starts at midnight; match the provider’s exact cutoff.</small>}</>);
  }
  function expiry(kind: 'credit' | 'key') {
    const modeField = kind === 'credit' ? 'expirationMode' : 'keyExpirationMode';
    const dateField = kind === 'credit' ? 'expiresAt' : 'keyExpiresAt';
    return <>
      {field(modeField, `${kind === 'credit' ? 'Credit / grant' : 'API key'} expiration`, <select {...attributes(modeField)} value={form[modeField]} onChange={e => {
        const mode = e.target.value as ExpirationMode;
        setForm(old => ({ ...old, [modeField]: mode, [dateField]: mode === 'date' ? old[dateField] : null }));
        setErrors(old => { const next = { ...old }; delete next[dateField]; return next; });
      }}><option value="unknown">Unknown</option><option value="never">Does not expire</option><option value="date">Expires on a date</option></select>)}
      {form[modeField] === 'date' ? dateInput(dateField, `Expiration date (${form.timeZone ?? 'UTC'})`) : null}
    </>;
  }
  const expired = initial?.expired || (initial?.funding !== 'paid' && initial?.expiresAt && Date.parse(initial.expiresAt) <= Date.now()) || (initial?.keyExpiresAt && Date.parse(initial.keyExpiresAt) <= Date.now());
  const status = !initial ? 'New connection' : !initial.enabled ? 'Disabled' : expired ? 'Expired' : initial.status.startsWith('Connected') ? 'Models connected' : initial.checkedAt ? 'Needs attention' : 'Not checked';
  const coverage = !initial ? null : provider === 'anthropic'
    ? !initial.organizationId ? 'Usage: account not identified yet.'
      : !anthropicReport?.connected ? 'Usage: connect this account’s reporting above.'
      : anthropicReport.costAsOf && anthropicReport.usageAsOf ? 'Usage: account reports connected · shared totals'
      : 'Usage: account connected · reports need attention'
    : !openaiReport?.keyPreview ? 'Usage: connect an OpenAI Admin key above.'
    : !initial.organizationId || !openaiReport.organizationId ? 'Usage: account match unconfirmed · refresh to check'
    : initial.organizationId !== openaiReport.organizationId ? 'Usage: needs this account’s Admin key'
    : openaiReport.usageAvailable && openaiReport.costsAvailable ? 'Usage: account reports connected · shared totals'
    : 'Usage: account matched · reports need attention';
  const estimate = anthropicReport?.grantEstimates?.find(item => item.connectionId === initial?.id && item.configKey === JSON.stringify([initial.budget, initial.grantBillingDay, initial.grantFirstStart ?? null, initial.rollover ?? false, initial.funding, initial.renewal]));
  const previousCycle = estimate ? Date.parse(estimate.cycleEnd) <= Date.now() : false;
  const staleEstimate = estimate ? estimate.stale || !anthropicReport?.connected || !estimate.asOf || Date.now() - Date.parse(estimate.asOf) > 86400000 : false;
  const estimatedGrant = provider === 'anthropic' && initial && initial.funding !== 'paid' && initial.renewal === 'monthly' && !initial.rollover && !!initial.grantBillingDay;
  return <div ref={root} className="kb-api-card">
    <div className="kb-api-card-head">
      <div className="kb-api-identity"><strong>{initial?.name ?? 'New API connection'}</strong>{initial ? <code>{initial.keyPreview}</code> : <span>Paste a key to discover available details.</span>}</div>
      <span className={`kb-api-status${status === 'Models connected' ? ' connected' : ''}`}>{status}</span>
      {initial ? <div className="kb-api-card-actions"><button type="button" className="kb-btn ghost" disabled={busy || dirty} onClick={() => void save(true)}>{busy ? 'Checking…' : 'Refresh'}</button>{!expanded ? <button type="button" className="kb-btn" onClick={() => setExpanded(true)}>Edit</button> : null}</div> : null}
    </div>
    {coverage ? <p className="kb-provider-desc" role="status">{coverage}</p> : null}
    {initial && !expanded ? <div className="kb-api-summary">
      <span>{initial.models.length} models</span>
      <button type="button" className="kb-btn ghost" onClick={() => setExpanded(true)} aria-label="Change payment settings">{['paid', 'unknown'].includes(initial.funding) ? 'Pay-as-you-go' : `${initial.budget === null ? '' : `$${initial.budget} · `}${initial.renewal === 'monthly' ? 'Monthly grant' : 'Grant'} · ${initial.rollover ? 'Rolls over' : 'Use it or lose it'}`}</button>
      {initial.organizationId ? <span>Account identified · {initial.workspaceId ? 'workspace identified' : 'organization scope'}</span> : null}
      {initial.reportedSpend !== null ? <span>Organization spend ${initial.reportedSpend.toFixed(2)} · reported</span> : null}
    </div> : null}
    {initial && !expanded && !estimatedGrant && !['paid', 'unknown'].includes(initial.funding) ? <div className="kb-api-summary"><span>{initial.remaining === null ? 'Balance unknown' : `$${initial.remaining} remaining`}</span><span>{initial.renewsAt ? `Resets ${new Date(initial.renewsAt).toLocaleString()}${Date.parse(initial.renewsAt) <= Date.now() ? ' · confirmation needed' : ''}` : 'Reset not set'}</span><span>{initial.remaining === 0 ? (initial.afterGrant === 'paygo' ? 'Grant exhausted · pay-go next' : 'Grant exhausted · stop selected') : (initial.afterGrant === 'paygo' ? 'Then pay-as-you-go' : 'Then stop')}</span></div> : null}
    {estimatedGrant ? <div className="kb-api-reported">
      <strong>{!previousCycle && estimate?.remaining !== null && estimate?.remaining !== undefined ? `${staleEstimate ? 'Last estimate' : 'Estimated grant remaining'}: $${estimate.remaining.toFixed(2)} / $${estimate.amount.toFixed(2)}` : initial.remaining !== null ? `Saved balance: $${initial.remaining.toFixed(2)} · confirmation available below` : 'Grant balance unavailable'}</strong>
      {!previousCycle && estimate?.spent !== null && estimate?.spent !== undefined ? <p><QuotaMeter usedPercent={estimate.spent / estimate.amount * 100} label="Estimated API grant" /></p> : null}
      <p className="kb-provider-desc">{previousCycle ? 'New billing cycle · refresh to estimate. Credit issuance is not confirmed.' : estimate?.asOf ? `Costs reported through ${new Date(estimate.asOf).toLocaleString()}${staleEstimate ? ' · stale, refresh needed' : ''}.` : anthropicReport?.eligibility === 'denied' ? 'Organization reporting is not permitted. Edit to confirm your current balance; KanBorg tracks its own spending against it.' : initial.organizationId ? 'Refresh organization reports or edit to confirm your current balance.' : 'Refresh this key to identify its organization.'}</p>
      {estimate && !previousCycle ? <p className="kb-provider-desc">Use-by target: {new Date(estimate.useBy ?? Date.parse(estimate.cycleEnd) - 6 * 60 * 60 * 1000).toLocaleString()} · 6 hours before estimated expiry.</p> : null}
      <details><summary>Estimate details</summary><p className="kb-provider-desc">Monthly grant minus covered API costs across this organization’s keys. Reports can lag up to 24 hours. Assumes the grant was issued and no overlapping grants; this is not a confirmed balance.</p>{estimate ? <p className="kb-provider-desc">Cycle: {new Date(estimate.cycleStart).toLocaleDateString(undefined, { timeZone: 'UTC' })} – {new Date(estimate.cycleEnd).toLocaleDateString(undefined, { timeZone: 'UTC' })}. Uses 00:00 UTC; Anthropic does not publish an exact renewal cutoff.</p> : null}<p className="kb-provider-desc">{initial.afterGrant === 'paygo' ? 'After grant: pay-as-you-go selected.' : 'After grant: stop selected.'}</p></details>
    </div> : null}
    {expanded ? <fieldset disabled={busy} className="kb-api-editor">
      <div className="kb-api-grid">
        {field('name', 'Name (optional)', <input {...attributes('name')} type="text" value={form.name} onChange={e => change('name', e.target.value)} placeholder={`${providerName(provider)} API`} />)}
        <label className="kb-api-toggle"><input type="checkbox" checked={form.enabled} onChange={e => change('enabled', e.target.checked)} />Enabled</label>
        <label>Credential source<select value={form.vaultReference?.id??''} onChange={event=>{const entry=vaultOptions.find(v=>v.id===event.target.value);setForm(old=>({...old,vaultReference:entry?{project:entry.project,id:entry.id}:null}));setKey('');}}><option value="">Saved or pasted API key</option>{form.vaultReference&&!vaultOptions.some(v=>v.id===form.vaultReference?.id)?<option value={form.vaultReference.id}>Current vault entry</option>:null}{vaultOptions.map(v=><option key={v.id} value={v.id}>{v.name} · version {v.version}</option>)}</select></label><p>To use the local vault, save and activate a secret in Settings with authorized consumer <code>{`api:${provider}`}</code>. Existing credentials stay unchanged until you save a selection.</p>
        {field('apiKey', initial ? 'Replace API key (optional)' : 'API key', <input {...attributes('apiKey')} type="password" disabled={!!form.vaultReference} autoComplete="off" spellCheck={false} value={key} onChange={e => { setKey(e.target.value); setErrors(old => { const next = { ...old }; delete next.apiKey; return next; }); }} placeholder={initial ? 'Leave empty to keep the saved key' : 'Paste API key'} />, true)}
      </div>
      <p className="kb-provider-desc">Saving a new key automatically checks models and available organization costs. No model request is made.</p>
      <div className="kb-api-grid">
        {field('funding', 'Payment', <select {...attributes('funding')} value={form.funding === 'paid' || form.funding === 'unknown' ? 'paid' : form.renewal === 'monthly' ? 'monthly' : 'grant'} onChange={e => {
          const monthly = e.target.value === 'monthly';
          setForm(old => ({ ...old, funding: e.target.value === 'paid' ? 'paid' : 'grant', renewal: monthly ? 'monthly' : e.target.value === 'grant' ? 'none' : old.renewal, ...(monthly ? { expirationMode: 'unknown', expiresAt: null } : {}) })); setErrors({});
        }}><option value="paid">Pay-as-you-go</option><option value="monthly">Monthly grant</option><option value="grant">Other grant / credit</option></select>)}
        {form.funding !== 'paid' && form.funding !== 'unknown' ? <>
          {field('budget', form.renewal === 'monthly' ? 'Monthly amount (USD)' : 'Grant amount (USD)', <input {...attributes('budget')} type="number" min="0" step="any" value={form.budget ?? ''} onChange={e => change('budget', e.target.value === '' ? null : Number(e.target.value))} placeholder="100" />)}
          {provider === 'anthropic' && form.renewal === 'monthly' ? <>
            {field('grantBillingDay', 'Subscription billing day', <input {...attributes('grantBillingDay')} type="number" min="1" max="31" step="1" value={form.grantBillingDay ?? ''} onChange={e => change('grantBillingDay', e.target.value === '' ? undefined : Number(e.target.value))} placeholder="Day of month, 1–31" />)}
            <p className="kb-provider-desc">Use the day your Claude subscription renews. Short months use their last day. Estimated cutoff: 00:00 UTC.</p>
          </> : dateInput('renewsAt', 'Next reset')}
          {!(provider === 'anthropic' && form.renewal === 'monthly') ? field('timeZone', 'Time zone', <select {...attributes('timeZone')} value={form.timeZone ?? 'UTC'} onChange={e => change('timeZone', e.target.value)}>{Array.from(new Set(['UTC', Intl.DateTimeFormat().resolvedOptions().timeZone, ...Intl.supportedValuesOf('timeZone')])).map(zone => <option key={zone} value={zone}>{zone.replaceAll('_', ' ')}</option>)}</select>) : null}
          {field('rollover', 'Unused grant', <select {...attributes('rollover')} value={form.rollover ? 'yes' : 'no'} onChange={e => change('rollover', e.target.value === 'yes')}><option value="no">Use it or lose it</option><option value="yes">Rolls over</option></select>)}
          {field('afterGrant', 'When the grant runs out', <select {...attributes('afterGrant')} value={form.afterGrant ?? 'stop'} onChange={e => change('afterGrant', e.target.value as 'stop' | 'paygo')}><option value="stop">Stop using this key</option><option value="paygo">Continue as pay-as-you-go</option></select>)}
          {field('remaining', 'Remaining now (USD, if known)', <input {...attributes('remaining')} type="number" min="0" step="any" value={form.remaining ?? ''} onChange={e => { change('remaining', e.target.value === '' ? null : Number(e.target.value)); change('confirmBalance', true); }} placeholder="Unknown" />)}
          <label className="kb-api-toggle"><input type="checkbox" checked={form.confirmBalance ?? false} disabled={form.remaining === null} onChange={e => change('confirmBalance', e.target.checked)} />Confirm this is the balance available now</label>
        </> : null}
      </div>
      <details ref={manual} className="kb-api-manual"><summary>More details</summary>
        {initial?.organizationId ? <p className="kb-provider-desc">Account identified. Keys in this account may draw from the same grant.</p> : null}
        {initial ? <p className="kb-provider-desc">{initial.billingStatus}{initial.reportedSpend !== null ? ` Organization spend this month: $${initial.reportedSpend.toFixed(2)}.` : ''}</p> : null}
        {form.funding === 'paid' ? field('budget', 'Monthly budget target (USD, optional)', <input {...attributes('budget')} type="number" min="0" step="any" value={form.budget ?? ''} onChange={e => change('budget', e.target.value === '' ? null : Number(e.target.value))} />) : null}
        {form.funding !== 'paid' && form.renewal !== 'monthly' ? <div className="kb-api-grid">{expiry('credit')}{field('renewal', 'Renewal', <select value={form.renewal} onChange={e => change('renewal', e.target.value as ApiConnectionInput['renewal'])}><option value="unknown">Unknown</option><option value="none">None</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="yearly">Yearly</option></select>)}</div> : null}
        {provider === 'anthropic' && form.renewal === 'monthly' && form.funding !== 'paid' ? <>
          {dateInput('grantFirstStart', 'First grant received (optional)')}
          <p className="kb-provider-desc">Only needed if enrollment began after this billing cycle started. Rollover balances cannot be estimated from one month of costs.</p>
        </> : null}
        <div className="kb-api-grid">{expiry('key')}</div>
        <label className="kb-api-toggle"><input type="checkbox" checked={form.expired} onChange={e => change('expired', e.target.checked)} />Mark connection expired</label>
        <p className="kb-provider-desc">Routing checks these rules before each API request. Provider reports and prices are estimates; provider-side limits remain authoritative.</p>
      </details>
      {initial?.models.length ? field('defaultModel', 'Preferred API model (optional)', <select {...attributes('defaultModel')} value={form.defaultModel ?? ''} onChange={e => change('defaultModel', e.target.value || null)}><option value="">No preference</option>{form.defaultModel && !initial.models.some(m => m.id === form.defaultModel) ? <option value={form.defaultModel}>{form.defaultModel} (saved)</option> : null}{initial.models.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}</select>) : null}
      <div className="kb-provider-actions"><button type="button" className="kb-btn primary" disabled={!dirty || busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button><button type="button" className="kb-btn ghost" onClick={cancel}>Cancel</button></div>
    </fieldset> : null}
    {message ? <p className="kb-api-message" role={Object.keys(errors).length ? 'alert' : 'status'}>{message}</p> : null}
  </div>;
}
