import { useId, useState } from 'react';
import { api } from '../../api.js';
import type { OpenAIReporting, ProvidersPayload, CodexSubscriptionUsage } from '../../types.js';

export function OpenAIReportingPanel({ report, onChanged }: { report: OpenAIReporting | undefined; onChanged: (payload: ProvidersPayload) => void }) {
  const [key, setKey] = useState('');
  const [editing, setEditing] = useState(!report?.keyPreview);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [invalidKey, setInvalidKey] = useState(false);
  const inputId = useId();
  const dirty = key.trim().length > 0;
  async function act(action: 'connect' | 'refresh') {
    if (busy) return;
    if (action === 'connect' && (key.trim().length < 11 || key.trim().length > 2000 || /\s/.test(key.trim()))) { setInvalidKey(true); setError('Paste a complete Admin API key without spaces.'); document.getElementById(inputId)?.focus(); return; }
    setBusy(true); setError(''); setInvalidKey(false);
    try {
      onChanged(await api.saveProvider({ id: 'codex-cli', reportingAction: action, ...(action === 'connect' ? { reportingKey: key.trim() } : {}) }));
      setKey(''); setEditing(false);
    } catch { setError('Could not save or unlock the reporting key. Your entry is still here; check encrypted storage and try again.'); }
    finally { setBusy(false); }
  }
  return <div className="kb-api-card">
    <div className="kb-api-card-head"><div className="kb-api-identity"><strong>API organization usage & costs</strong><span>Separate from ChatGPT subscription capacity</span>{report?.keyPreview ? <code>{report.keyPreview}</code> : null}</div><span className={`kb-api-status${report?.connected ? ' connected' : ''}`}>{report?.connected ? 'Connected' : report?.keyPreview ? 'Needs attention' : 'Not connected'}</span></div>
    <div className="kb-api-reporting-body">
      <p className="kb-provider-desc">{report?.status ?? 'Connect an OpenAI Admin API key to read organization usage and costs. It is stored encrypted and never used to run models.'}</p>
      {report?.usageRetrievedAt ? <p className="kb-provider-desc">{report.usageAvailable ? 'Reported' : 'Stale'} API token usage since {report.periodStart ? new Date(report.periodStart).toLocaleDateString() : 'unknown'}: {report.inputTokens?.toLocaleString()} input · {report.outputTokens?.toLocaleString()} output · {report.requests?.toLocaleString()} requests. Retrieved {new Date(report.usageRetrievedAt).toLocaleString()}.</p> : null}
      {report?.costsRetrievedAt ? <p className="kb-provider-desc">{report.costsAvailable ? 'Reported' : 'Stale'} organization costs since {report.costPeriodStart ? new Date(report.costPeriodStart).toLocaleDateString() : 'unknown'}: ${report.costUsd?.toFixed(2)} USD. Retrieved {new Date(report.costsRetrievedAt).toLocaleString()}.</p> : null}
      <p className="kb-provider-desc">These reports are not a remaining balance or grant-expiration feed. Usage and cost scopes differ; costs can include services beyond token usage. Retrieval time does not guarantee the provider’s data is current.</p>
      {editing ? <div className="kb-api-field"><label htmlFor={inputId}>{report?.keyPreview ? 'Replace reporting key' : 'OpenAI Admin API key'}</label><input id={inputId} type="password" autoComplete="off" spellCheck={false} disabled={busy} aria-invalid={invalidKey} aria-describedby={error ? `${inputId}-error` : undefined} value={key} onChange={e => { setKey(e.target.value); setError(''); setInvalidKey(false); }} placeholder="Paste reporting key" /><a href="https://platform.openai.com/settings/organization/admin-keys" target="_blank" rel="noreferrer">Open OpenAI Admin keys</a></div> : null}
      <div className="kb-provider-actions">
        {editing ? <><button className="kb-btn primary" disabled={busy || !dirty} onClick={() => void act('connect')}>{busy ? 'Checking access…' : 'Save & connect'}</button>{report?.keyPreview ? <button className="kb-btn ghost" disabled={busy} onClick={() => { setEditing(false); setKey(''); setError(''); }}>Cancel</button> : null}</> : <><button className="kb-btn" disabled={busy} onClick={() => void act('refresh')}>{busy ? 'Refreshing…' : 'Refresh reports'}</button><button className="kb-btn ghost" disabled={busy} onClick={() => setEditing(true)}>Replace key</button></>}
      </div>
      {error ? <p id={`${inputId}-error`} role="alert" className="kb-api-field-error">{error}</p> : null}
    </div>
  </div>;
}

export function CodexUsagePanel({ usage, error }: { usage: CodexSubscriptionUsage | undefined; error: string | undefined }) {
  if (!usage && !error) return null;
  return <details className="kb-api-manual">
    <summary>ChatGPT subscription capacity <span>{usage ? 'Provider-reported' : 'Unavailable'}</span></summary>
    {error ? <p className="kb-provider-desc">{error}</p> : null}
    {usage ? <><p className="kb-provider-desc">Included usage: {usage.ordinaryUsageAllowed === null ? 'permission unknown' : usage.ordinaryUsageAllowed ? 'available' : 'currently unavailable'}. Checked {new Date(usage.checkedAt).toLocaleString()}.</p>
      {usage.windows.map((window, index) => <div className="kb-api-summary" key={`${window.name}-${index}`}><span>{window.name}{window.windowMinutes ? ` · ${window.windowMinutes >= 1440 ? `${window.windowMinutes / 1440} day` : `${window.windowMinutes / 60} hour`} window` : ''}</span><span>{window.usedPercent.toFixed(1)}% used</span><span>Resets {window.resetsAt ? new Date(window.resetsAt * 1000).toLocaleString() : 'unknown'}</span></div>)}
      {usage.credits.map((credit, index) => <p className="kb-provider-desc" key={`${credit.name}-${index}`}>{credit.name} credits: {credit.unlimited ? 'Unlimited (reported)' : credit.balance ?? 'Unknown'}. Expiration not reported.</p>)}
      {!usage.windows.length ? <p className="kb-provider-desc">No quota windows returned.</p> : null}
      <p className="kb-provider-desc">Overlapping windows and shared credits are not added together. These are subscription limits, separate from API organization spending.</p></> : null}
  </details>;
}
