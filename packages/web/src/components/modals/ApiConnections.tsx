import { useState } from 'react';
import { api } from '../../api.js';
import type { ApiConnection, ApiConnectionInput, ProvidersPayload } from '../../types.js';

type Props = { provider: 'openai' | 'anthropic'; connections: ApiConnection[]; onChanged: (value: ProvidersPayload) => void };
export function ApiConnections({ provider, connections, onChanged }: Props) {
  const [adding, setAdding] = useState(false);
  const rows = connections.filter(row => row.provider === provider);
  return <div style={{ padding: '0 14px 14px' }}>
    <h4>API connections</h4>
    <p className="kb-provider-desc">Separate from your subscription. Keys are encrypted on this Mac. Connections are listed by priority (1 first). Automatic task routing and budget enforcement are not enabled yet.</p>
    {rows.map(row => <ConnectionEditor key={row.id} initial={row} provider={provider} onChanged={onChanged} />)}
    {adding ? <ConnectionEditor provider={provider} onChanged={value => { onChanged(value); setAdding(false); }} onCancel={() => setAdding(false)} /> : <button className="kb-btn" onClick={() => setAdding(true)}>Add API key</button>}
  </div>;
}
function ConnectionEditor({ provider, initial, onChanged, onCancel }: { provider: Props['provider']; initial?: ApiConnection; onChanged: Props['onChanged']; onCancel?: () => void }) {
  const [form, setForm] = useState<ApiConnectionInput>(() => ({
    id: initial?.id ?? crypto.randomUUID(), provider, name: initial?.name ?? '', enabled: initial?.enabled ?? true,
    priority: initial?.priority ?? 1, funding: initial?.funding ?? 'paid', budget: initial?.budget ?? null,
    remaining: initial?.remaining ?? null, expiresAt: initial?.expiresAt ?? null, renewal: initial?.renewal ?? 'none',
    renewsAt: initial?.renewsAt ?? null, expired: initial?.expired ?? false, pool: initial?.pool ?? '', defaultModel: initial?.defaultModel ?? null,
  }));
  const [savedForm, setSavedForm] = useState(form);
  const [key, setKey] = useState('');
  const dirty = JSON.stringify(form) !== JSON.stringify(savedForm) || key.trim().length > 0;
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const change = <K extends keyof ApiConnectionInput>(field: K, value: ApiConnectionInput[K]) => setForm(old => ({ ...old, [field]: value }));
  async function save(refresh = false) {
    if (busy || (!dirty && !refresh)) return;
    setBusy(true); setMessage('');
    try {
      const providerId = provider === 'openai' ? 'codex-cli' : 'claude-code';
      if (dirty) {
        const saved = { ...form, name: form.name.trim() };
        const next = await api.saveProvider({ id: providerId, connection: { ...saved, ...(key.trim() ? { apiKey: key.trim() } : {}) } });
        setForm(saved); setSavedForm(saved); setKey('');
        onChanged(next);
      }
      if (refresh) onChanged(await api.saveProvider({ id: providerId, refreshConnectionId: form.id }));
      setMessage(refresh ? 'Refreshed' : 'Saved');
    } catch { setMessage('Could not save or refresh. Check the fields, encrypted storage, and connection.'); }
    finally { setBusy(false); }
  }
  const inputStyle = { width: '100%', minWidth: 0 };
  return <fieldset disabled={busy} style={{ border: '1px solid var(--border, #39332b)', borderRadius: 8, padding: 14, marginBottom: 12 }}>
    <legend>{initial?.name ?? 'New API connection'}</legend>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
      <label>Name<input style={inputStyle} value={form.name} onChange={e => change('name', e.target.value)} placeholder="Personal grant" /></label>
      <label>Priority (1 first)<input style={inputStyle} type="number" min="0" max="999" value={form.priority} onChange={e => change('priority', Number(e.target.value))} /></label>
      <label style={{ gridColumn: '1 / -1' }}>API key {initial?.keyPreview ? <code>{initial.keyPreview}</code> : null}<input style={inputStyle} type="password" autoComplete="off" value={key} onChange={e => setKey(e.target.value)} placeholder={initial ? 'Paste only to replace saved key' : 'Paste API key'} /></label>
      <label><input type="checkbox" checked={form.enabled} onChange={e => change('enabled', e.target.checked)} /> Enabled</label>
      <label><input type="checkbox" checked={form.expired} onChange={e => change('expired', e.target.checked)} /> Mark expired</label>
      <label>Funding<select style={inputStyle} value={form.funding} onChange={e => change('funding', e.target.value as ApiConnectionInput['funding'])}><option value="paid">Paid budget</option><option value="grant">Grant / promotional credit</option><option value="subscription-credit">API credit included with subscription</option></select></label>
      <label>Shared billing pool<input style={inputStyle} value={form.pool} onChange={e => change('pool', e.target.value)} placeholder="Organization or workspace" /></label>
      <label>Budget / grant amount (USD)<input style={inputStyle} type="number" min="0" step="0.01" value={form.budget ?? ''} onChange={e => change('budget', e.target.value === '' ? null : Number(e.target.value))} /></label>
      <label>Remaining balance (USD)<input style={inputStyle} type="number" min="0" step="0.01" value={form.remaining ?? ''} onChange={e => change('remaining', e.target.value === '' ? null : Number(e.target.value))} /></label>
      <label>Expires at (local time)<input style={inputStyle} type="datetime-local" value={localDate(form.expiresAt)} onChange={e => change('expiresAt', e.target.value ? new Date(e.target.value).toISOString() : null)} /></label>
      <label>Renews<select style={inputStyle} value={form.renewal} onChange={e => change('renewal', e.target.value as ApiConnectionInput['renewal'])}><option value="none">Does not renew</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="yearly">Yearly</option></select></label>
      <label>Next renewal (local time)<input style={inputStyle} type="datetime-local" value={localDate(form.renewsAt)} onChange={e => change('renewsAt', e.target.value ? new Date(e.target.value).toISOString() : null)} /></label>
      <label>Preferred API model<select style={inputStyle} value={form.defaultModel ?? ''} onChange={e => change('defaultModel', e.target.value || null)}><option value="">Choose after refresh</option>{form.defaultModel && !initial?.models.some(m => m.id === form.defaultModel) ? <option value={form.defaultModel}>{form.defaultModel} (saved)</option> : null}{initial?.models.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}</select></label>
    </div>
    <p className="kb-provider-desc">Budget, balance, expiry, renewal, and shared pool are user-entered. Leave unknown amounts or dates empty. Keys in the same organization may share one balance; they are not extra capacity.</p>
    {form.expired || (form.expiresAt && Date.parse(form.expiresAt) <= Date.now()) ? <p className="kb-sentry-warn">Expired</p> : null}
    {initial ? <><p>{initial.status}{initial.checkedAt ? ` · ${new Date(initial.checkedAt).toLocaleString()}` : ''}</p><p className="kb-provider-desc">{initial.billingStatus}</p>{initial.reportedSpend !== null ? <p>Reported organization spend: ${initial.reportedSpend.toFixed(2)} USD · checked {initial.spendCheckedAt ? new Date(initial.spendCheckedAt).toLocaleString() : 'unknown'}</p> : null}</> : null}
    <div className="kb-provider-actions"><button className="kb-btn primary" disabled={!dirty || busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button><button className="kb-btn" disabled={busy || (!initial && !dirty)} onClick={() => void save(true)}>{busy ? 'Working…' : dirty ? 'Save & refresh models / costs' : 'Refresh models / costs'}</button>{onCancel ? <button className="kb-btn" onClick={onCancel}>Cancel</button> : null}</div>
    {message ? <p role="status">{message}</p> : null}
  </fieldset>;
}
function localDate(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
