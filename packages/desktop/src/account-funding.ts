import { app } from 'electron';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { FundingAccount, FundingAccountInput, FundingPool } from '@kanbots/api';
import { listApiConnections } from './api-connections.js';
type Saved = FundingAccountInput & { updatedAt: string };
const file = () => join(app.getPath('userData'), 'account-funding.json');
function read(): Saved[] {
  if (!existsSync(file())) return [];
  try { return JSON.parse(readFileSync(file(), 'utf8')); }
  catch { throw new Error('Could not read account balances. Existing details have been preserved.'); }
}
export function getFundingAccounts(): FundingAccount[] {
  const saved = read();
  const groups = new Map<string, ReturnType<typeof listApiConnections>>();
  for (const row of listApiConnections()) {
    if (!row.organizationId) continue;
    const key = `${row.provider}:${row.organizationId}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.values()].map(rows => {
    const first = rows[0]!;
    const previous = saved.find(a => a.provider === first.provider && a.organizationId === first.organizationId);
    const pools = previous?.pools ?? [];
    const legacy: FundingAccount['legacy'] = [];
    for (const row of rows) {
      if (row.budget === null && row.remaining === null && !row.expiresAt && !row.renewsAt && row.funding === 'unknown') continue;
      if (pools.some(p => p.id === row.id || p.importedConnectionIds?.includes(row.id))) continue;
      const pool: FundingPool = { id: row.id, importedConnectionIds: [row.id], name: row.name, kind: row.funding === 'subscription-credit' ? 'subscription-credit' : row.funding === 'grant' ? 'grant' : row.funding === 'paid' ? 'budget' : 'unknown', enabled: row.enabled,
        amount: row.budget, remaining: row.remaining, acquiredAt: null, expirationMode: row.expirationMode ?? (row.expiresAt ? 'date' : 'unknown'), expiresAt: row.expiresAt,
        renewal: row.renewal, renewsAt: row.renewsAt };
      // Offer identical legacy notes once. Import requires an explicit user action.
      const match = legacy.find(item => JSON.stringify({ ...item.pool, id: '', name: '', importedConnectionIds: [] }) === JSON.stringify({ ...pool, id: '', name: '', importedConnectionIds: [] }));
      if (match) { match.connectionNames.push(row.name); match.pool.importedConnectionIds!.push(row.id); }
      else legacy.push({ connectionId: row.id, connectionNames: [row.name], pool });
    }
    return { provider: first.provider, organizationId: first.organizationId!, connectionNames: rows.map(r => r.name), pools, updatedAt: previous?.updatedAt ?? null, legacy, balanceSource: 'manual' };
  });
}
export async function saveFundingAccount(input: FundingAccountInput): Promise<void> {
  if (!listApiConnections().some(row => row.provider === input.provider && row.organizationId === input.organizationId)) throw new Error('Identify this API account before saving its balances.');
  const rows = read();
  const next = [...rows.filter(a => a.provider !== input.provider || a.organizationId !== input.organizationId), { ...input, updatedAt: new Date().toISOString() }];
  writeFileSync(file() + '.tmp', JSON.stringify(next), { mode: 0o600 });
  renameSync(file() + '.tmp', file());
}
