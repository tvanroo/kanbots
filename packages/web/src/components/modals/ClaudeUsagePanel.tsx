import { QuotaMeter } from '../usage/QuotaMeter.js';
import { useEffect, useState } from 'react';
import type { CostUsageResult, CostUsageWindow } from '@kanbots/api';
import { getBridge } from '../../desktop-bridge.js';

export function ClaudeUsagePanel() {
  const [usage, setUsage] = useState<CostUsageResult>();
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    let active = true;
    let pending = false;
    async function refresh() {
      if (pending || document.hidden) return;
      pending = true;
      try {
        const value = await getBridge()?.claudeSubscriptionUsage?.();
        if (active && value) { setUsage(value); setClock(Date.now()); }
      } catch { if (active) setUsage(previous => ({ ...(previous ?? { fiveHour: null, sevenDay: null }), source: 'unavailable', stale: true, message: 'Usage could not be refreshed. Retrying automatically.' })); }
      finally { pending = false; }
    }
    void refresh();
    const interval = window.setInterval(() => void refresh(), 60000);
    const focus = () => void refresh();
    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', focus);
    return () => { active = false; window.clearInterval(interval); window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', focus); };
  }, []);
  const windows = [
    { id: 'five_hour', label: '5-hour quota', value: usage?.fiveHour },
    { id: 'seven_day', label: 'Weekly quota', value: usage?.sevenDay },
    ...(usage?.windows ?? []).filter(w => !['five_hour', 'seven_day'].includes(w.id)).map(w => ({ id: w.id, label: w.label, value: w })),
  ];
  return <div className="kb-api-reported" aria-label="Claude subscription capacity">
    <strong>Claude subscription capacity</strong>
    <p className="kb-provider-desc">Read automatically from your existing Claude Code connection.</p>
    {windows.map(window => <QuotaWindow key={window.id} label={window.label} value={window.value} now={clock} stale={usage?.stale ?? false} />)}
    <p className="kb-provider-desc" role="status">{!usage ? 'Checking quota…' : usage.message ?? 'Provider-reported subscription limits. Overlapping windows are not added together.'}{usage?.checkedAt ? ` Last checked ${new Date(usage.checkedAt).toLocaleString()}.` : ''}</p>
    <p className="kb-provider-desc">API grants and paid API usage are tracked separately through your API connections.</p>
  </div>;
}
function QuotaWindow({ label, value, now, stale }: { label: string; value: CostUsageWindow | null | undefined; now: number; stale: boolean }) {
  const resetPassed = value?.resetsAt ? Date.parse(value.resetsAt) <= now : false;
  const remaining = value ? Math.max(0, 100 - value.pct * 100) : null;
  return <div className="kb-api-summary">
    <strong>{label}</strong>
    {remaining === null ? <span>Not reported</span> : resetPassed ? <span>Awaiting updated quota</span> : <><QuotaMeter label={label} usedPercent={100 - remaining} />{stale ? <span>Last known reading</span> : null}</>}
    <span>{value?.resetsAt ? `${resetPassed ? 'Last reset' : 'Resets'} ${new Date(value.resetsAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })}` : 'Reset time not reported'}</span>
  </div>;
}
