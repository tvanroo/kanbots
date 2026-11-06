import type { ApiConnection, AnthropicReporting } from '@kanborg/api';

/** Plan useful grant-funded work to finish before this safety deadline.
 * This is not provider expiry and does not authorize paid fallback or filler work.
 */
export function grantUseBy(cycleEnd: Date): string {
  return new Date(cycleEnd.getTime() - 6 * 60 * 60 * 1000).toISOString();
}

/** UTC midnight is an estimation convention, not a provider-confirmed cutoff. */
export function grantCycle(now: Date, billingDay: number) {
  if (!Number.isInteger(billingDay) || billingDay < 1 || billingDay > 31) throw new Error('Invalid billing day');
  const at = (year: number, month: number) => {
    const first = new Date(Date.UTC(year, month, 1));
    const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
    return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(billingDay, last)));
  };
  let start = at(now.getUTCFullYear(), now.getUTCMonth());
  if (start > now) start = at(now.getUTCFullYear(), now.getUTCMonth() - 1);
  return { start, end: at(start.getUTCFullYear(), start.getUTCMonth() + 1) };
}
export const grantConfigKey = (row: ApiConnection) => JSON.stringify([row.budget, row.grantBillingDay, row.grantFirstStart ?? null, row.rollover ?? false, row.funding, row.renewal]);
export const canEstimateGrant = (row: ApiConnection) => row.provider === 'anthropic' && ['grant', 'subscription-credit'].includes(row.funding) && row.renewal === 'monthly' && !row.rollover && !!row.grantBillingDay && row.budget !== null && row.budget > 0;

export async function estimateGrants(rows: ApiConnection[], get: (path: string) => Promise<any>, now = new Date()): Promise<NonNullable<AnthropicReporting['grantEstimates']>> {
  const results: NonNullable<AnthropicReporting['grantEstimates']> = [];
  const costs = new Map<string, Promise<{ spend: number | null; asOf: string | null }>>();
  for (const row of rows.filter(canEstimateGrant)) {
    const cycle = grantCycle(now, row.grantBillingDay!);
    // Optional first-grant date prevents counting spending before initial enrollment.
    if (row.grantFirstStart && new Date(row.grantFirstStart) > cycle.start) cycle.start = new Date(row.grantFirstStart);
    if (cycle.start >= now || cycle.start >= cycle.end) continue;
    const start = cycle.start.toISOString();
    if (!costs.has(start)) costs.set(start, (async () => {
      const query = new URLSearchParams({ starting_at: start, ending_at: now.toISOString(), limit: '100' });
      for (const product of ['messages_api', 'message_batches_api', 'claude_console', 'managed_agents_api']) query.append('products[]', product);
      let page: string | undefined;
      let cents = 0;
      let asOf: string | null = null;
      let missing = false;
      const seen = new Set<string>();
      do {
        const report = await get(`/v1/organizations/analytics/cost?${query}${page ? `&page=${encodeURIComponent(page)}` : ''}`);
        if (!Array.isArray(report.data)) throw new Error('report-unavailable');
        const stamp = typeof report.data_refreshed_at === 'string' && Number.isFinite(Date.parse(report.data_refreshed_at)) ? report.data_refreshed_at : null;
        if (!stamp || Date.parse(stamp) < cycle.start.getTime()) missing = true;
        else if (!asOf || stamp < asOf) asOf = stamp;
        for (const entry of report.data) {
          const amount = entry.cost?.amount;
          if (entry.cost?.currency !== 'USD' || typeof amount !== 'string' || !Number.isFinite(Number(amount))) throw new Error('report-unavailable');
          cents += Number(amount);
        }
        page = report.has_more ? report.next_page : undefined;
        if (report.has_more && (typeof page !== 'string' || !page || seen.has(page))) throw new Error('report-unavailable');
        if (page) seen.add(page);
      } while (page);
      return { spend: missing ? null : Math.max(0, cents / 100), asOf: missing ? null : asOf };
    })());
    try {
      const { spend, asOf } = await costs.get(start)!;
      results.push({ connectionId: row.id, configKey: grantConfigKey(row), cycleStart: start, cycleEnd: cycle.end.toISOString(), useBy: grantUseBy(cycle.end), amount: row.budget!, spent: spend, remaining: spend === null ? null : Math.max(0, Number((row.budget! - spend).toFixed(8))), asOf, checkedAt: now.toISOString(), stale: false });
    } catch {
      results.push({ connectionId: row.id, configKey: grantConfigKey(row), cycleStart: start, cycleEnd: cycle.end.toISOString(), useBy: grantUseBy(cycle.end), amount: row.budget!, spent: null, remaining: null, asOf: null, checkedAt: now.toISOString(), stale: true });
    }
  }
  return results;
}
