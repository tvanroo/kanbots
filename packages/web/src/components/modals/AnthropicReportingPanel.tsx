import { useEffect, useRef, useState } from 'react';
import { api } from '../../api.js';
import type { AnthropicReporting, ProvidersPayload } from '../../types.js';

export function AnthropicReportingPanel({ report, onChanged }: { report: AnthropicReporting | undefined; onChanged: (payload: ProvidersPayload) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  const checkPending = useRef(false);
  async function check() {
    if (checkPending.current) return;
    checkPending.current = true; setChecking(true); setError('');
    try { onChanged(await api.saveProvider({ id: 'claude-code', reportingAction: 'refresh' })); }
    catch { setError('Could not check connection. Try again.'); }
    finally { checkPending.current = false; setChecking(false); }
  }
  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => void check(), 10000);
    const focus = () => void check();
    window.addEventListener('focus', focus);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', focus); };
  }, [busy]);
  useEffect(() => { if (report?.connected) setBusy(false); }, [report?.connected]);
  async function act(action: 'connect' | 'refresh') {
    setBusy(true); setError('');
    try { onChanged(await api.saveProvider({ id: 'claude-code', reportingAction: action })); }
    catch { setError('Could not complete reporting setup. Try again.'); }
    finally { setBusy(false); }
  }
  return <div className="kb-api-card">
    <div className="kb-api-card-head"><div className="kb-api-identity"><strong>Organization usage & costs</strong><span>{report?.organizationName ?? 'Optional · connect alongside your subscription'}</span></div><span className={`kb-api-status${report?.connected ? ' connected' : ''}`}>{report?.connected ? 'Connected' : 'Not connected'}</span></div>
    <div className="kb-api-reporting-body">
      <p className="kb-provider-desc">{report?.status ?? 'Connect your Claude Console organization to import token usage and costs.'}</p>
      {report?.checkedAt ? <div className="kb-api-summary"><span>Month-to-date tokens: {report.tokens == null ? 'Unknown' : report.tokens.toLocaleString()}</span><span>Cost before credits: {report.costUsd == null ? 'Unknown' : `$${report.costUsd.toFixed(2)} USD`}</span><span>Usage as of: {report.usageAsOf ? new Date(report.usageAsOf).toLocaleString() : 'Unknown'}</span><span>Costs as of: {report.costAsOf ? new Date(report.costAsOf).toLocaleString() : 'Unknown'}</span></div> : null}
      <details className="kb-api-manual"><summary>Authorization and account requirements</summary><p className="kb-provider-desc">Claude Console requires an organization owner/admin and the org:admin OAuth scope. That scope grants organization-wide administrative access; Kanbots uses it only to read organization details, usage, and costs. This does not authorize subscription quota or credit-grant balance access. Individual Console accounts may not qualify.</p><p className="kb-provider-desc">Uses the official Anthropic ant CLI with an isolated Kanbots profile. <a href="https://platform.claude.com/docs/en/cli-sdks-libraries/cli/quickstart" target="_blank" rel="noreferrer">Install the CLI</a>. Your existing Claude Code subscription sign-in stays separate.</p></details>
      {!report?.connected ? <p className="kb-provider-desc">Connecting opens Anthropic authorization for organization-wide admin scope. Kanbots only reads reports.</p> : null}
      <div className="kb-provider-actions"><button className="kb-btn" disabled={busy} onClick={() => void act('connect')}>{busy ? 'Waiting for authorization / reports…' : report?.connected ? 'Check authorization & refresh' : 'Connect usage & costs'}</button><button className="kb-btn ghost" disabled={checking} onClick={() => void check()}>{checking ? 'Checking connection…' : 'Check connection'}</button></div>
      {error ? <p role="alert" className="kb-api-field-error">{error}</p> : null}
    </div>
  </div>;
}
