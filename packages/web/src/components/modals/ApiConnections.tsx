import { zonedInput, zonedIso } from './connection-time.js';
import { useId, useRef, useState, type ReactNode } from 'react';
import { api } from '../../api.js';
import type { ApiConnection, ApiConnectionInput, ProvidersPayload } from '../../types.js';

type Props = { provider: 'openai' | 'anthropic'; connections: ApiConnection[]; onChanged: (value: ProvidersPayload) => void };
type Errors = Record<string, string>;
type ExpirationMode = 'unknown' | 'never' | 'date';
const providerName = (provider: Props['provider']) => provider === 'openai' ? 'OpenAI' : 'Anthropic';

export function ApiConnections({ provider, connections, onChanged }: Props) {
  const [adding, setAdding] = useState(false);
  return <div className="kb-api-connections">
    <div className="kb-api-heading"><h4>API connections</h4><span>Keys encrypted on this Mac</span></div>
    <p className="kb-provider-desc">Separate from your subscription. API task routing and budget enforcement are not enabled yet.</p>
    {connections.filter(row => row.provider === provider).map(row => <ConnectionEditor key={row.id} initial={row} provider={provider} onChanged={onChanged} />)}
    {adding ? <ConnectionEditor provider={provider} onChanged={value => { onChanged(value); setAdding(false); }} onCancel={() => setAdding(false)} /> : <button type="button" className="kb-btn" onClick={() => setAdding(true)}>Add API key</button>}
  </div>;
}
function ConnectionEditor({ provider, initial, onChanged, onCancel }: { provider: Props['provider']; initial?: ApiConnection; onChanged: Props['onChanged']; onCancel?: () => void }) {
  const [form, setForm] = useState<ApiConnectionInput>(() => ({
    id: initial?.id ?? crypto.randomUUID(), provider, name: initial?.name ?? '', enabled: initial?.enabled ?? true,
    priority: initial?.priority ?? 1, funding: initial?.funding ?? 'unknown', budget: initial?.budget ?? null,
    remaining: initial?.remaining ?? null, expiresAt: initial?.expiresAt ?? null,
    expirationMode: initial?.expirationMode ?? (initial?.expiresAt ? 'date' : 'unknown'),
    timeZone: initial?.timeZone ?? 'UTC',
    keyExpirationMode: initial?.keyExpirationMode ?? 'unknown', keyExpiresAt: initial?.keyExpiresAt ?? null,
    renewal: initial?.renewal ?? 'unknown', renewsAt: initial?.renewsAt ?? null,
    expired: initial?.expired ?? false, pool: initial?.pool ?? '', defaultModel: initial?.defaultModel ?? null,
  }));
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
    if ((!initial && !key.trim()) || (key.trim() && (key.trim().length < 11 || key.trim().length > 2000 || /\s/.test(key.trim())))) next.apiKey = 'Paste a complete API key without spaces.';
    for (const field of ['budget', 'remaining'] as const) {
      const value = form[field];
      if (value !== null && (!Number.isFinite(value) || value < 0)) next[field] = 'Enter an amount of zero or more, or leave it empty.';
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
        setForm(saved); setSavedForm(saved); setKey(''); setErrors({});
      }
      // Discover immediately after a key is added/replaced; metadata-only edits do not need network access.
      if (refreshOnly || key.trim()) savedPayload = await api.saveProvider({ id: providerId, refreshConnectionId: form.id });
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
  function dateInput(name: 'expiresAt' | 'keyExpiresAt' | 'renewsAt', label: string) {
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
  const expired = initial?.expired || (initial?.expiresAt && Date.parse(initial.expiresAt) <= Date.now()) || (initial?.keyExpiresAt && Date.parse(initial.keyExpiresAt) <= Date.now());
  const status = !initial ? 'New connection' : !initial.enabled ? 'Disabled' : expired ? 'Expired' : initial.status.startsWith('Connected') ? 'Connected' : initial.checkedAt ? 'Needs attention' : 'Not checked';
  return <div ref={root} className="kb-api-card">
    <div className="kb-api-card-head">
      <div className="kb-api-identity"><strong>{initial?.name ?? 'New API connection'}</strong>{initial ? <code>{initial.keyPreview}</code> : <span>Paste a key to discover available details.</span>}</div>
      <span className={`kb-api-status${status === 'Connected' ? ' connected' : ''}`}>{status}</span>
      {initial ? <div className="kb-api-card-actions"><button type="button" className="kb-btn ghost" disabled={busy || dirty} onClick={() => void save(true)}>{busy ? 'Checking…' : 'Refresh'}</button>{!expanded ? <button type="button" className="kb-btn" onClick={() => setExpanded(true)}>Edit</button> : null}</div> : null}
    </div>
    {initial && !expanded ? <div className="kb-api-summary">
      <span>{initial.models.length} models</span>
      <span>{expirationLabel(initial.expirationMode ?? (initial.expiresAt ? 'date' : 'unknown'), initial.expiresAt, 'Credit')}</span>
      {initial.reportedSpend !== null ? <span>Organization spend ${initial.reportedSpend.toFixed(2)} · reported</span> : null}
    </div> : null}
    {expanded ? <fieldset disabled={busy} className="kb-api-editor">
      <div className="kb-api-grid">
        {field('name', 'Name (optional)', <input {...attributes('name')} type="text" value={form.name} onChange={e => change('name', e.target.value)} placeholder={`${providerName(provider)} API`} />)}
        <label className="kb-api-toggle"><input type="checkbox" checked={form.enabled} onChange={e => change('enabled', e.target.checked)} />Enabled</label>
        {field('apiKey', initial ? 'Replace API key (optional)' : 'API key', <input {...attributes('apiKey')} type="password" autoComplete="off" spellCheck={false} value={key} onChange={e => { setKey(e.target.value); setErrors(old => { const next = { ...old }; delete next.apiKey; return next; }); }} placeholder={initial ? 'Leave empty to keep the saved key' : 'Paste API key'} />, true)}
      </div>
      <p className="kb-provider-desc">Saving a new key automatically checks models and available organization costs. No model request is made.</p>
      {initial ? <div className="kb-api-reported"><strong>Provider-reported details</strong><p>{initial.status}</p><p>{initial.billingStatus}</p>{initial.reportedSpend !== null ? <p>Organization spend this calendar month: ${initial.reportedSpend.toFixed(2)} USD. Last reported {initial.spendCheckedAt ? new Date(initial.spendCheckedAt).toLocaleString() : 'unknown'}.</p> : null}<p>Grant balance, budget, and renewal are not supplied by the standard model API. Key expiration is also unknown unless entered below; Anthropic exposes it separately through its Admin API.</p><a href={provider === 'openai' ? 'https://platform.openai.com/settings/organization/billing/overview' : 'https://platform.claude.com/settings/billing'} target="_blank" rel="noreferrer">Open provider billing</a></div> : null}
      <details ref={manual} className="kb-api-manual">
        <summary>Optional funding and expiration details <span>User-entered</span></summary>
        <p className="kb-provider-desc">Only fill what you know. Unknown is different from zero or no expiration. Credit expiration and key expiration are independent.</p>
        <div className="kb-api-grid">
          {field('funding', 'Funding', <select {...attributes('funding')} value={form.funding} onChange={e => { const funding = e.target.value as ApiConnectionInput['funding']; setForm(old => ({ ...old, funding, renewal: old.renewal === 'unknown' && funding === 'subscription-credit' ? 'monthly' : old.renewal })); }}><option value="unknown">Unknown</option><option value="paid">Paid budget</option><option value="grant">Grant / promotional credit</option><option value="subscription-credit">Credit included with subscription</option></select>)}
          {field('pool', 'Shared billing pool', <input {...attributes('pool')} type="text" maxLength={120} value={form.pool} onChange={e => change('pool', e.target.value)} placeholder="Organization or workspace (optional)" />)}
          {field('budget', 'Budget / grant amount (USD)', <input {...attributes('budget')} type="number" min="0" step="any" value={form.budget ?? ''} onChange={e => change('budget', e.target.value === '' ? null : Number(e.target.value))} placeholder="Unknown" />)}
          {field('remaining', 'Remaining credit (USD)', <input {...attributes('remaining')} type="number" min="0" step="any" value={form.remaining ?? ''} onChange={e => change('remaining', e.target.value === '' ? null : Number(e.target.value))} placeholder="Unknown" />)}
          {field('timeZone', 'Time zone for dates', <select {...attributes('timeZone')} value={form.timeZone ?? 'UTC'} onChange={e => change('timeZone', e.target.value)}>{Array.from(new Set(['UTC', Intl.DateTimeFormat().resolvedOptions().timeZone, ...Intl.supportedValuesOf('timeZone')])).map(zone => <option key={zone} value={zone}>{zone === 'UTC' ? 'UTC — provider timestamps' : zone.replaceAll('_', ' ')}</option>)}</select>, true)}
          {expiry('credit')}{expiry('key')}
          {field('renewal', 'Credit renewal', <select {...attributes('renewal')} value={form.renewal} onChange={e => change('renewal', e.target.value as ApiConnectionInput['renewal'])}><option value="unknown">Unknown</option><option value="none">Does not renew</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="yearly">Yearly</option></select>)}
          {['weekly', 'monthly', 'yearly'].includes(form.renewal) ? dateInput('renewsAt', 'Next credit renewal (optional)') : null}
          <label className="kb-api-toggle"><input type="checkbox" checked={form.expired} onChange={e => change('expired', e.target.checked)} />Mark connection expired</label>
        </div>
        {form.funding === 'subscription-credit' ? <p className="kb-provider-desc">Monthly renewal is suggested for subscription credits. Use the date in your provider’s billing page.{provider === 'openai' ? ' Annually billed Business grants can renew annually; adjust the schedule to match.' : ''}</p> : null}
        <p className="kb-provider-desc">Keys in the same organization may share one balance. These fields describe capacity; they do not enforce a spending limit.</p>
      </details>
      {initial?.models.length ? field('defaultModel', 'Preferred API model (optional)', <select {...attributes('defaultModel')} value={form.defaultModel ?? ''} onChange={e => change('defaultModel', e.target.value || null)}><option value="">No preference</option>{form.defaultModel && !initial.models.some(m => m.id === form.defaultModel) ? <option value={form.defaultModel}>{form.defaultModel} (saved)</option> : null}{initial.models.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}</select>) : null}
      <div className="kb-provider-actions"><button type="button" className="kb-btn primary" disabled={!dirty || busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button><button type="button" className="kb-btn ghost" onClick={cancel}>Cancel</button></div>
    </fieldset> : null}
    {message ? <p className="kb-api-message" role={Object.keys(errors).length ? 'alert' : 'status'}>{message}</p> : null}
  </div>;
}
function expirationLabel(mode: ExpirationMode, date: string | null, label: string): string {
  if (mode === 'never') return `${label} does not expire`;
  if (mode === 'date' && date) return `${label} expires ${new Date(date).toLocaleDateString()}`;
  return `${label} expiration unknown`;
}
