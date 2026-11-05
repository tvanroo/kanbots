import { useState } from 'react';
import type { FundingAccount, FundingPool, ProvidersPayload } from '@kanbots/api';
import { api } from '../../api.js';
import { zonedInput, zonedIso } from './connection-time.js';

const names: Record<FundingPool['kind'], string> = { unknown: 'Choose credit or budget type', 'paid-credit': 'Purchased API credits', grant: 'Grant / promotional credit', 'subscription-credit': 'API credits included with subscription', budget: 'Paid spending budget' };
const usd = (value: number | null) => value === null ? 'Unknown' : new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(value);
const billingUrl = (provider: string) => provider === 'openai' ? 'https://platform.openai.com/settings/organization/billing/overview' : 'https://platform.claude.com/settings/billing';

export function AccountFunding({ provider, payload, onChanged }: { provider: 'openai' | 'anthropic'; payload: ProvidersPayload; onChanged: (payload: ProvidersPayload) => void }) {
  return <>{(payload.fundingAccounts ?? []).filter(account => account.provider === provider).map(account => <FundingCard key={`${provider}:${account.organizationId}`} account={account} payload={payload} onChanged={onChanged} />)}</>;
}
function FundingCard({ account, payload, onChanged }: { account: FundingAccount; payload: ProvidersPayload; onChanged: (payload: ProvidersPayload) => void }) {
  const [draft, setDraft] = useState<FundingPool>();
  const [baseline, setBaseline] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [zone, setZone] = useState('UTC');
  const [copied, setCopied] = useState(false);
  const report = account.provider === 'openai' ? (payload.openaiReporting?.organizationId === account.organizationId ? payload.openaiReporting : undefined) : payload.anthropicReportingAccounts?.find(a => a.organizationId === account.organizationId)?.report;
  const periodStart = new Date(); periodStart.setUTCDate(1); periodStart.setUTCHours(0, 0, 0, 0);
  const periodEnd = new Date(periodStart); periodEnd.setUTCMonth(periodEnd.getUTCMonth() + 1);
  const reportDate = report?.checkedAt ? new Date(report.checkedAt) : null;
  const samePeriod = reportDate && reportDate.getUTCFullYear() === periodStart.getUTCFullYear() && reportDate.getUTCMonth() === periodStart.getUTCMonth();
  const reportedCost = report?.connected && samePeriod ? report.costUsd : null;
  const periodLabel = (value: Date) => value.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short' });
  const dirty = draft && JSON.stringify(draft) !== baseline;
  const invalidDate = draft?.kind !== 'budget' && draft?.expirationMode === 'date' && !draft.expiresAt;
  function edit(pool?: FundingPool) {
    const value = pool ?? { id: crypto.randomUUID(), name: '', kind: 'budget', enabled: true, amount: null, remaining: null, acquiredAt: null, expirationMode: 'unknown', expiresAt: null, renewal: 'monthly', renewsAt: null } satisfies FundingPool;
    setDraft(value); setBaseline(pool && account.pools.some(p => p.id === pool.id) ? JSON.stringify(value) : ''); setError('');
  }
  function change<K extends keyof FundingPool>(field: K, value: FundingPool[K]) {
    setDraft(old => old ? { ...old, [field]: value } : old); setError('');
  }
  async function save() {
    if (!draft || !dirty || busy) return;
    if (invalidDate) { setError('Choose the expiration date, or select Unknown.'); return; }
    setBusy(true); setError('');
    try {
      const pool = { ...draft, ...(draft.kind === 'budget' ? { expirationMode: 'unknown' as const, expiresAt: null, remaining: null, renewal: 'monthly' as const, renewsAt: null } : {}), name: draft.name.trim() || (draft.kind === 'unknown' ? 'Account balance' : names[draft.kind]) };
      const next = await api.saveProvider({ id: account.provider === 'openai' ? 'codex-cli' : 'claude-code', fundingAccount: { provider: account.provider, organizationId: account.organizationId, pools: [...account.pools.filter(p => p.id !== pool.id), pool] } });
      onChanged(next); setDraft(undefined); setBaseline('');
    } catch { setError('Could not save these account details. Your previous values have been kept.'); }
    finally { setBusy(false); }
  }
  function date(field: 'expiresAt' | 'renewsAt' | 'acquiredAt', label: string) {
    if (!draft) return null;
    return <label className="kb-api-field"><span>{label}</span><input type="datetime-local" value={zonedInput(draft[field], zone)} aria-invalid={field === 'expiresAt' && Boolean(error && invalidDate)} onChange={event => {
      const iso = event.target.value ? zonedIso(event.target.value, zone) : null;
      if (event.target.value && !iso) { setError('This time does not exist in the selected time zone.'); return; }
      change(field, iso);
    }} /></label>;
  }
  const ruleUrl = account.provider === 'openai' ? 'https://developers.openai.com/api/docs/guides/chatgpt-api-credits' : 'https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers';
  return <div className="kb-api-card">
    <div className="kb-api-card-head"><div className="kb-api-identity"><strong>API usage & budget</strong><span>{account.connectionNames.join(', ')}</span></div><span className="kb-api-status">Shared account</span></div>
    <p className="kb-provider-desc">Pay-as-you-go by default. Usage and budgets apply to this verified account’s {account.connectionNames.length} keys. Add grants only if this account has them.</p>
    <div className="kb-api-summary"><span>Organization spend this month: {reportedCost == null ? 'Not available' : usd(reportedCost)}</span><span>Tracking period: {periodLabel(periodStart)} – {periodLabel(periodEnd)}</span></div>
    <p className="kb-provider-desc">Provider budget cap: not reported by this connection. A positive balance, request-rate limit, and spending cap are different controls. Reported spend covers this organization, including activity outside Kanbots.</p>
    <details className="kb-api-manual"><summary>Optional grants & credit balances</summary>
      <p className="kb-provider-desc">Account identity is provider-reported.{report?.connected ? ' Organization usage and costs are connected.' : ' Organization usage and costs need separate reporting access.'} No credit-ledger endpoint is available in the documented integrations used here for remaining paid balance, grant expiry, or renewal schedule. Only those missing details are entered below. Reported spend is not a credit balance.</p>
      <p className="kb-provider-desc">Subscription credit rules can suggest a schedule after you identify the benefit. They cannot confirm that it is activated or identify your billing date. <a href={ruleUrl} target="_blank" rel="noreferrer">Provider credit rules</a></p>
    </details>
    {account.pools.map(pool => {
      const expired = pool.kind !== 'budget' && pool.expirationMode === 'date' && pool.expiresAt && Date.parse(pool.expiresAt) <= Date.now();
      const renewalDue = pool.kind !== 'budget' && pool.renewsAt && Date.parse(pool.renewsAt) <= Date.now() && !['none', 'unknown'].includes(pool.renewal);
      return <div className="kb-api-reported" key={pool.id}><div className="kb-api-card-head"><strong>{pool.name}</strong><span className="kb-api-status">{!pool.enabled ? 'Excluded' : expired ? 'Expired' : renewalDue ? 'Renewal needs confirmation' : pool.kind === 'budget' ? 'Budget target' : 'Entered balance'}</span><button className="kb-btn ghost" disabled={busy || Boolean(draft)} onClick={() => edit(pool)}>Edit</button></div><div className="kb-api-summary"><span>{pool.kind === 'budget' ? `Monthly budget target: ${usd(pool.amount)}` : `Last entered balance: ${usd(pool.remaining)}`}</span>{pool.kind === 'budget' && pool.amount !== null && reportedCost != null ? <span>Against reported organization spend: {usd(pool.amount - reportedCost)} left · not an enforced cap</span> : null}{pool.kind !== 'budget' ? <><span>{pool.expirationMode === 'never' ? 'Does not expire' : pool.expiresAt ? `Expires ${new Date(pool.expiresAt).toLocaleString()}` : 'Expiry unknown'}</span><span>{pool.renewal === 'none' ? 'Does not renew' : pool.renewal === 'unknown' ? 'Renewal unknown' : `Renews ${pool.renewal}${pool.renewsAt ? ` · next ${new Date(pool.renewsAt).toLocaleString()}` : ''}`}</span></> : <span>Monthly tracking · resets {periodLabel(periodEnd)}</span>}</div>{renewalDue ? <p className="kb-provider-desc">Scheduled renewal has passed. Confirm the new grant; no credit has been added automatically.</p> : null}</div>;
    })}
    {!account.pools.length && !draft ? <p className="kb-provider-desc">No budget target entered. Provider usage reporting works independently; add a target only if you want one.</p> : null}
    {!draft && account.legacy.length ? <details className="kb-api-manual"><summary>Review existing saved funding details</summary><p className="kb-provider-desc">Your earlier per-key entries are preserved. Import each distinct balance once; copies on multiple keys are not extra credit.</p>{account.legacy.map(item => <div className="kb-api-summary" key={item.connectionId}><span>{item.connectionNames.join(', ')} · {item.pool.kind === 'budget' ? `${usd(item.pool.amount)} budget target` : `${usd(item.pool.remaining)} remaining`}</span><button className="kb-btn ghost" onClick={() => edit(item.pool)}>Review & import</button></div>)}</details> : null}
    {!draft ? <button className="kb-btn" onClick={() => edit()}>Add budget target or grant</button> : <fieldset className="kb-api-editor" disabled={busy}>
      <div className="kb-api-grid">
        <label className="kb-api-field"><span>Type</span><select value={draft.kind} onChange={event => {
          const kind = event.target.value as FundingPool['kind'];
          setDraft({ ...draft, kind, renewal: kind === 'subscription-credit' && draft.renewal === 'unknown' ? 'monthly' : kind === 'paid-credit' && draft.renewal === 'unknown' ? 'none' : draft.renewal });
        }}>{Object.entries(names).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="kb-api-field"><span>Name (optional)</span><input value={draft.name} maxLength={100} placeholder={draft.kind === 'unknown' ? 'Personal API balance' : names[draft.kind]} onChange={e => change('name', e.target.value)} /></label>
        {draft.kind === 'budget' ? <label className="kb-api-field"><span>Monthly budget target (USD)</span><input type="number" min="0" step="any" value={draft.amount ?? ''} placeholder="Optional" onChange={e => change('amount', e.target.value === '' ? null : Number(e.target.value))} /></label> : <label className="kb-api-field"><span>Current remaining credit (USD)</span><input type="number" step="any" value={draft.remaining ?? ''} placeholder="Unknown" onChange={e => change('remaining', e.target.value === '' ? null : Number(e.target.value))} /></label>}
        {draft.kind !== 'budget' ? <>
        <label className="kb-api-field"><span>Expiration</span><select value={draft.expirationMode} onChange={e => setDraft({ ...draft, expirationMode: e.target.value as FundingPool['expirationMode'], expiresAt: e.target.value === 'date' ? draft.expiresAt : null })}><option value="unknown">Unknown</option><option value="never">Does not expire</option><option value="date">Expires on a date</option></select></label>
        {draft.expirationMode === 'date' ? date('expiresAt', `Expires at (${zone})`) : null}
        <label className="kb-api-field"><span>Renewal</span><select value={draft.renewal} onChange={e => change('renewal', e.target.value as FundingPool['renewal'])}><option value="unknown">Unknown</option><option value="none">Does not renew</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="yearly">Yearly</option></select></label>
        {!['unknown', 'none'].includes(draft.renewal) ? date('renewsAt', `Next renewal (${zone})`) : null}
        <label className="kb-api-field"><span>Time zone for entered dates</span><select value={zone} onChange={e => setZone(e.target.value)}>{Array.from(new Set(['UTC', Intl.DateTimeFormat().resolvedOptions().timeZone, ...Intl.supportedValuesOf('timeZone')])).map(z => <option key={z} value={z}>{z.replaceAll('_', ' ')}</option>)}</select></label>
        </> : <p className="kb-provider-desc">Calendar-month tracking, starting at 00:00 UTC on the first. This is a comparison target; API task routing and enforcement are not enabled yet.</p>}
      </div>
      {draft.kind === 'subscription-credit' ? <div className="kb-api-reported"><p className="kb-provider-desc">Suggested from provider policy: credits expire at the end of the benefit cycle and do not roll over. {account.provider === 'openai' ? 'Monthly is typical; annually billed Business benefits renew and expire annually.' : 'Benefits renew monthly, including annual plans.'} Confirm the billing date; the provider has not reported your enrollment or schedule.</p>{draft.renewsAt && draft.expiresAt !== draft.renewsAt ? <button type="button" className="kb-btn ghost" onClick={() => setDraft({ ...draft, expirationMode: 'date', expiresAt: draft.renewsAt })}>Use renewal date as credit expiration</button> : null}</div> : null}
      {draft.kind !== 'budget' ? <details className="kb-api-manual"><summary>Optional amount & purchase details</summary><div className="kb-api-grid"><label className="kb-api-field"><span>Original grant / purchase amount (USD)</span><input type="number" min="0" step="any" value={draft.amount ?? ''} onChange={e => change('amount', e.target.value === '' ? null : Number(e.target.value))} /></label>{date('acquiredAt', `Received / purchased at (${zone})`)}</div>
      {draft.kind === 'paid-credit' && draft.acquiredAt ? <><p className="kb-provider-desc">Standard purchased API credits expire one year after purchase. Confirm against your billing page.</p><button type="button" className="kb-btn ghost" onClick={() => { const end = new Date(draft.acquiredAt!); end.setUTCFullYear(end.getUTCFullYear() + 1); setDraft({ ...draft, expirationMode: 'date', expiresAt: end.toISOString() }); }}>Suggest one-year expiration</button></> : null}
      <label className="kb-api-toggle"><input type="checkbox" checked={draft.enabled} onChange={e => change('enabled', e.target.checked)} />Track this balance</label></details> : null}
      {error ? <p role="alert" className="kb-api-field-error">{error}</p> : null}
      <div className="kb-provider-actions"><button className="kb-btn primary" disabled={!dirty || busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button><button className="kb-btn ghost" onClick={() => { setDraft(undefined); setError(''); }}>Cancel</button></div>
    </fieldset>}
    <p className="kb-provider-desc">{account.updatedAt ? `Account details last entered ${new Date(account.updatedAt).toLocaleString()}. ` : ''}No balances are inferred from usage costs, and no credits are added on a predicted renewal.</p>
    <div className="kb-provider-actions"><button className="kb-btn ghost" onClick={() => void navigator.clipboard.writeText(billingUrl(account.provider)).then(() => setCopied(true)).catch(() => setCopied(false))}>{copied ? 'Billing link copied' : 'Copy provider billing link'}</button><a href={billingUrl(account.provider)} target="_blank" rel="noreferrer">Billing reference</a></div>
  </div>;
}
