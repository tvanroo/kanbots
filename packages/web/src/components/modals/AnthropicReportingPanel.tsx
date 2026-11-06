import { useEffect, useRef, useState } from 'react';
import { api } from '../../api.js';
import type { ApiConnection, AnthropicReporting, ProvidersPayload } from '../../types.js';

export function AnthropicReportingPanel({ report, onChanged, organizationId, connectionNames }: { organizationId?: string; connectionNames?: string[]; report: AnthropicReporting | undefined; onChanged: (payload: ProvidersPayload) => void }) {
  const [installing, setInstalling] = useState(false);
  const [manual, setManual] = useState(false);
  const [setup, setSetup] = useState(false);
  const denied = report?.eligibility === 'denied';
  const supported = report?.eligibility === 'supported';
  const missing = report?.prerequisite === 'missing';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  const checkPending = useRef(false);
  async function check() {
    if (checkPending.current) return;
    checkPending.current = true; setChecking(true); setError('');
    try { onChanged(await api.saveProvider({ id: 'claude-code', reportingAction: 'refresh', ...(organizationId ? { reportingOrganizationId: organizationId } : {}) })); }
    catch { setError('Could not check connection. Try again.'); }
    finally { checkPending.current = false; setChecking(false); }
  }
  useEffect(() => {
    if (!busy || installing) return;
    const timer = window.setInterval(() => void check(), 10000);
    const focus = () => void check();
    window.addEventListener('focus', focus);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', focus); };
  }, [busy, installing]);
  useEffect(() => { if (report?.connected) setBusy(false); }, [report?.connected]);
  async function act(action: 'connect' | 'refresh', approveInstall = false, switchAccount = false) {
    setManual(false); setInstalling(approveInstall);
    setBusy(true); setError('');
    try { onChanged(await api.saveProvider({ id: 'claude-code', reportingAction: action, approveReportingInstall: approveInstall, reportingSwitchAccount: switchAccount, ...(organizationId ? { reportingOrganizationId: organizationId } : {}) })); }
    catch { setError('Could not complete reporting setup. Try again.'); }
    finally { setBusy(false); setInstalling(false); }
  }
  return <div className="kb-api-card">
    <div className="kb-api-card-head"><div className="kb-api-identity"><strong>Organization usage & costs</strong><span>{report?.organizationName ?? (organizationId ? 'API organization' : 'Optional · API organization reporting')}<span>{connectionNames?.length ? `Covers keys: ${connectionNames.join(', ')}` : ''}</span></span></div><span className={`kb-api-status${report?.connected ? ' connected' : ''}`}>{denied ? 'Unavailable for this account' : supported ? (report?.connected ? 'Connected' : 'Check needed') : 'Optional'}</span></div>
    <div className="kb-api-reporting-body">
      <p className="kb-provider-desc">{denied ? 'Organization reporting is unavailable with this account’s current permissions. This does not affect Claude subscription access; no reporting setup is needed.' : report?.status ?? 'Personal Pro/Max subscriptions do not include organization reporting. If you also administer a Claude Console organization, you can check its eligibility here.'}</p>
      {!denied && report?.checkedAt ? <div className="kb-api-summary"><span>Month-to-date tokens: {report.tokens == null ? 'Unknown' : report.tokens.toLocaleString()}</span><span>Cost before credits: {report.costUsd == null ? 'Unknown' : `$${report.costUsd.toFixed(2)} USD`}</span><span>Usage as of: {report.usageAsOf ? new Date(report.usageAsOf).toLocaleString() : 'Unknown'}</span><span>Costs as of: {report.costAsOf ? new Date(report.costAsOf).toLocaleString() : 'Unknown'}</span></div> : null}
      {denied ? <><p className="kb-provider-desc">This can mean an individual account or missing organization permissions. We do not infer your account type from an access denial.</p><button className="kb-btn ghost" disabled={checking || installing} onClick={() => void check()}>{checking ? 'Checking access…' : 'Recheck after permissions change'}</button>{organizationId ? <button className="kb-btn ghost" disabled={busy} onClick={() => void act('connect', false, true)}>{busy ? 'Waiting for admin authorization…' : 'Use an organization admin account'}</button> : null}<p className="kb-provider-desc"><a href="https://platform.claude.com/docs/en/manage-claude/admin-api" target="_blank" rel="noreferrer">Supported accounts & permissions</a></p></> : null}
      {!denied && !supported && !organizationId ? <p className="kb-provider-desc">Personal Pro/Max subscriptions do not include this reporting API. Only continue if you also administer a Claude Console organization.</p> : null}
      {!denied && !supported && !setup && !organizationId ? <button className="kb-btn ghost" onClick={() => setSetup(true)}>I also manage a Console organization</button> : null}
      {!denied && (supported || setup || organizationId) ? <>
      <details className="kb-api-manual"><summary>Authorization and account requirements</summary><p className="kb-provider-desc">Claude Console requires an organization owner/admin and the org:admin OAuth scope. That scope grants organization-wide administrative access; KanBorg uses it only to read organization details, usage, and costs. This does not authorize subscription quota or credit-grant balance access. Individual Console accounts may not qualify.</p><p className="kb-provider-desc">Uses the official Anthropic ant CLI with an isolated KanBorg profile. <a href="https://platform.claude.com/docs/en/cli-sdks-libraries/cli/quickstart" target="_blank" rel="noreferrer">Installation guide</a>. Your existing Claude Code subscription sign-in stays separate.</p></details>
      {!report?.connected ? <p className="kb-provider-desc">We first check for the Anthropic helper and existing authorization. If needed, we ask before installing it or open authorization to check your organization’s eligibility. KanBorg only reads reports.</p> : null}
      {missing && !manual ? <div className="kb-api-manual" role="group" aria-label="Install Anthropic helper">
        <strong>Install the Anthropic helper?</strong>
        <p className="kb-provider-desc">KanBorg will install the official ant CLI using Homebrew, then check authorization and organization access. This does not change your Claude subscription. Homebrew must already be installed.</p>
        <div className="kb-provider-actions"><button className="kb-btn primary" disabled={busy} onClick={() => void act('connect', true)}>{installing ? 'Installing helper…' : 'Install & continue'}</button><button className="kb-btn ghost" disabled={busy} onClick={() => { setManual(true); setSetup(false); }}>I’ll install it myself</button></div>
        <a href="https://platform.claude.com/docs/en/cli-sdks-libraries/cli/quickstart" target="_blank" rel="noreferrer">Installation guide</a>
      </div> : null}
      {!missing || manual ? <div className="kb-provider-actions"><button className="kb-btn" disabled={busy} onClick={() => void act('connect')}>{busy ? 'Checking access / waiting for authorization…' : supported ? 'Refresh usage & costs' : 'Check organization eligibility'}</button><button className="kb-btn ghost" disabled={checking || installing} onClick={() => void check()}>{checking ? 'Checking connection…' : 'Check connection'}</button></div> : null}
      </> : null}
      {manual ? <p className="kb-provider-desc">Setup paused. <a href="https://platform.claude.com/docs/en/cli-sdks-libraries/cli/quickstart" target="_blank" rel="noreferrer">Follow the installation guide</a>, then return here to check organization eligibility. No authorization flow was started.</p> : null}
      {error ? <p role="alert" className="kb-api-field-error">{error}</p> : null}
    </div>
  </div>;
}


export function AnthropicReportingSetup({ payload, onChanged }: { payload: ProvidersPayload; onChanged: (payload: ProvidersPayload) => void }) {
  const [scanError, setScanError] = useState('');
  const [scanning, setScanning] = useState(false);
  const scanned = useRef(new Set<string>());
  const connections = (payload.apiConnections ?? []).filter(row => row.provider === 'anthropic');
  const accounts = payload.anthropicReportingAccounts ?? [];
  async function identify(rows: ApiConnection[]) {
    setScanning(true); setScanError('');
    try {
      for (const row of rows) {
        scanned.current.add(row.id);
        onChanged(await api.saveProvider({ id: 'claude-code', refreshConnectionId: row.id }));
      }
    } catch { setScanError('Could not identify every account. Check connections to retry.'); }
    finally { setScanning(false); }
  }
  useEffect(() => {
    const unchecked = connections.filter(row => row.organizationId === undefined && !scanned.current.has(row.id));
    if (unchecked.length && !scanning) void identify(unchecked);
  }, [payload.apiConnections]);
  const unknown = connections.filter(row => !row.organizationId);
  return <>
    {scanning ? <p role="status" className="kb-provider-desc">Identifying the accounts behind your API keys…</p> : null}
    {accounts.map(account => <AnthropicReportingPanel key={account.organizationId} organizationId={account.organizationId} connectionNames={account.connectionNames} report={account.report} onChanged={onChanged} />)}
    {!accounts.length ? <AnthropicReportingPanel report={payload.anthropicReporting} onChanged={onChanged} /> : null}
    {unknown.length ? <div className="kb-api-card"><strong>Account identification needed</strong><p className="kb-provider-desc">{unknown.map(row => row.name).join(', ')}: organization identity has not been confirmed. These keys are not assigned to another account’s reports or balance.</p><button className="kb-btn ghost" disabled={scanning} onClick={() => void identify(unknown)}>Check API connections</button></div> : null}
    {scanError ? <p role="alert" className="kb-api-field-error">{scanError}</p> : null}
  </>;
}
