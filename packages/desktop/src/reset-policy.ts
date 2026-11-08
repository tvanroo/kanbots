import type { CodexDetails } from './codex-catalogue.js';
/** Preserve reserve credits. Automatic redemption is only an expiry rescue, never a response to local demand. */
export function resetToRedeem(details: CodexDetails, _hasWork: boolean, now=Date.now()): string | null {
  const usage=details.subscriptionUsage;
  if(!details.accountIdentity||!usage)return null;
  const age=now-Date.parse(usage.checkedAt);
  if(!Number.isFinite(age)||age<0||age>60000)return null;
  const credits=[...(usage.resetCredits?.credits??[])].filter(c=>c.status==='available' && c.resetType==='codexRateLimits' && (c.expiresAt===null||c.expiresAt*1000>now)).sort((a,b)=>(a.expiresAt??Infinity)-(b.expiresAt??Infinity));
  const expiring=credits.find(c=>c.expiresAt!==null&&c.expiresAt*1000-now<=30*60000);
  if(expiring)return expiring.id;
  // No automatic early spending: depletion of one provider says nothing about
  // usable capacity elsewhere. Unknown/unreachable alternatives are not exhaustion.
  return null;
}
