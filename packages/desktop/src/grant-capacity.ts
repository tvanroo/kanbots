import type { ApiConnection, AnthropicReporting } from '@kanborg/api';
import { grantCycle, grantUseBy } from './grant-estimate.js';
type Estimate = NonNullable<AnthropicReporting['grantEstimates']>[number];
/** Display historical values independently from permission to spend against them. */
export function grantCapacity(row: ApiConnection, estimate: Estimate | undefined, now: number) {
  const cycle = row.grantBillingDay ? grantCycle(new Date(now), row.grantBillingDay) : null;
  const expiry = row.expiresAt ?? (!row.rollover ? row.renewsAt : null);
  let useBy = expiry ? Date.parse(expiry) - 6 * 3600000 : cycle && !row.rollover ? Date.parse(grantUseBy(cycle.end)) : Infinity;
  let amount = row.remaining;
  let since = row.balanceUpdatedAt ? Date.parse(row.balanceUpdatedAt) : 0;
  if (!Number.isFinite(since) || since < 0) since = 0;
  let usable = true;
  let detail = 'Saved balance';
  if (estimate?.remaining !== null && estimate?.remaining !== undefined && !(amount !== null && since > Date.parse(estimate.asOf ?? '1970-01-01'))) {
    amount = estimate.remaining;
    since = estimate.asOf ? Date.parse(estimate.asOf) : 0;
    useBy = Date.parse(estimate.useBy ?? estimate.cycleEnd);
    usable = !estimate.stale && !!estimate.asOf && now - Date.parse(estimate.asOf) < 24 * 3600000 && Date.parse(estimate.cycleEnd) > now;
    detail = `${usable ? 'Estimated balance' : 'Last estimated balance · awaiting reporting recovery'}${estimate.asOf ? ` · as of ${new Date(estimate.asOf).toLocaleString()}` : ''}`;
  } else {
    if (cycle && !row.rollover && since < cycle.start.getTime() || row.renewsAt && Date.parse(row.renewsAt) <= now) usable = false;
    detail = amount !== null
      ? `Saved balance${since > 0 ? ` · entered ${new Date(since).toLocaleString()}` : ''}${!usable ? ' · confirm current balance in provider settings' : row.grantBillingDay ? ' · organization estimate unavailable' : ''}`
      : 'No balance available · enter a balance in provider settings or connect organization reporting';
  }
  return { amount, since, useBy, usable, detail };
}
