import type { CodexDetails } from './codex-catalogue.js';
/** Redeem expiring credits even without queued work. Otherwise protect imminent natural resets. */
export function resetToRedeem(details: CodexDetails, hasWork: boolean, now=Date.now()): string | null {
  const usage=details.subscriptionUsage;
  if(!details.accountIdentity||!usage||now-Date.parse(usage.checkedAt)>60000)return null;
  const credits=[...(usage.resetCredits?.credits??[])].filter(c=>c.status==='available' && c.resetType==='codexRateLimits' && (c.expiresAt===null||c.expiresAt*1000>now)).sort((a,b)=>(a.expiresAt??Infinity)-(b.expiresAt??Infinity));
  const expiring=credits.find(c=>c.expiresAt!==null&&c.expiresAt*1000-now<=30*60000);
  if(expiring)return expiring.id;
  const depleted=usage.windows.filter(w=>w.usedPercent>=95);
  if(hasWork && depleted.length && depleted.every(w=>w.resetsAt!==null&&w.resetsAt*1000-now>6*3600000))return credits[0]?.id??null;
  return null;
}
