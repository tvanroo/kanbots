import { app, safeStorage } from 'electron';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { ApiConnection, ApiConnectionInput } from '@kanborg/api';

type StoredConnection = ApiConnection & { encryptedKey: string };
const file = () => join(app.getPath('userData'), 'api-connections.json');
function read(): StoredConnection[] {
  if (!existsSync(file())) return [];
  try { return JSON.parse(readFileSync(file(), 'utf8')) as StoredConnection[]; }
  catch { throw new Error('Could not read saved API connections. The existing file has been preserved.'); }
}
function write(rows: StoredConnection[]): void {
  writeFileSync(file() + '.tmp', JSON.stringify(rows), { mode: 0o600 });
  renameSync(file() + '.tmp', file());
}
export function listApiConnections(): ApiConnection[] {
  return read().map(({ encryptedKey: _key, ...metadata }) => metadata);
}
export async function saveApiConnection(input: ApiConnectionInput): Promise<void> {
  const rows = read();
  const previous = rows.find(row => row.id === input.id);
  if (previous && previous.provider !== input.provider) throw new Error('A connection cannot change provider.');
  const { apiKey, confirmBalance, ...metadata } = input;
  if(metadata.vaultReference===undefined)metadata.vaultReference=apiKey?null:previous?.vaultReference??null;
  if(apiKey&&metadata.vaultReference)throw new Error('Choose a vault entry or a pasted key, not both.');
  if(metadata.vaultReference){const {vaultAction}=await import('./vault-runtime.js');const status=await vaultAction('status',{},metadata.vaultReference.project);if(!status.items.some((entry:any)=>entry.id===metadata.vaultReference!.id&&entry.state==='active'&&entry.consumer===`api:${input.provider}`))throw new Error('Select an active vault entry authorized for this API provider.');}
  if(previous?.vaultReference&&!metadata.vaultReference&&!apiKey)throw new Error('Paste a replacement key before disconnecting the vault entry.');
  if (!previous && !apiKey && !metadata.vaultReference) throw new Error('Paste an API key to create this connection.');
  if (apiKey && !safeStorage.isEncryptionAvailable()) throw new Error('Encrypted storage is unavailable. The API key was not saved.');
  const row: StoredConnection = {
    models: [], checkedAt: null, status: 'Not checked', reportedSpend: null, spendCheckedAt: null,
    billingStatus: 'Not reported. Budget and credit fields are user-entered.',
    encryptedKey: '', keyPreview: '', ...previous, ...metadata,
    ...(confirmBalance || !previous || previous.remaining !== metadata.remaining ? { balanceUpdatedAt: new Date().toISOString() } : {}),
    name: metadata.name.trim() || `${input.provider === 'openai' ? 'OpenAI' : 'Anthropic'} API`,
    expirationMode: metadata.expirationMode ?? (metadata.expiresAt ? 'date' : 'unknown'),
    expiresAt: metadata.expirationMode && metadata.expirationMode !== 'date' ? null : metadata.expiresAt,
    keyExpirationMode: metadata.keyExpirationMode ?? 'unknown',
    keyExpiresAt: metadata.keyExpirationMode === 'date' ? (metadata.keyExpiresAt ?? null) : null,
  };
  if(metadata.vaultReference){row.encryptedKey='';row.keyPreview='Local vault';}
  if (apiKey) {
    row.encryptedKey = safeStorage.encryptString(apiKey).toString('base64');
    row.keyPreview = `${apiKey.slice(0, 5)}••••••${apiKey.slice(-5)}`;
    row.organizationId = null; row.workspaceId = null;
    row.models = []; row.checkedAt = null; row.status = 'Not checked';
    row.reportedSpend = null; row.spendCheckedAt = null;
    row.billingStatus = 'Not reported. Budget and credit fields are user-entered.';
  }
  if(JSON.stringify(previous?.vaultReference??null)!==JSON.stringify(row.vaultReference??null)){row.organizationId=null;row.workspaceId=null;row.models=[];row.checkedAt=null;row.status='Not checked';row.reportedSpend=null;row.spendCheckedAt=null;}
  const latest=read();if(JSON.stringify(latest.find(item=>item.id===row.id))!==JSON.stringify(previous))throw new Error('Connection changed while verifying its vault entry. Reload provider settings and retry.');
  write([...latest.filter(item => item.id !== row.id), row]);
}
export async function refreshApiConnection(id: string): Promise<void> {
  const row = read().find(item => item.id === id);
  if (!row) throw new Error('Connection not found.');
  const encryptedKey = row.encryptedKey;
  let key: string;
  try { key = await unlockApiConnection(id,false); }
  catch { throw new Error(row.vaultReference?'The selected vault credential is unavailable. Check its active version and authorized consumer in Settings.':'The saved key could not be unlocked on this Mac. Paste it again to replace it.'); }
  const headers: Record<string, string> = row.provider === 'openai'
    ? { Authorization: `Bearer ${key}` }
    : { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
  const base = row.provider === 'openai' ? 'https://api.openai.com' : 'https://api.anthropic.com';
  const result: Partial<StoredConnection> = { checkedAt: new Date().toISOString() };
  try {
    const models: ApiConnection['models'] = [];
    let after: string | undefined;const modelPages=new Set<string>();
    do {
      if(modelPages.size>=100||modelPages.has(after??''))throw new Error('Repeated or excessive model pages');
      modelPages.add(after??'');
      const response = await fetch(`${base}/v1/models${after ? `?after_id=${encodeURIComponent(after)}` : ''}`, { headers, signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (row.provider === 'openai') result.organizationId = response.headers.get('openai-organization') ?? row.organizationId ?? null;
      if (row.provider === 'anthropic') {
        // Only authenticated, provider-reported IDs may associate a key with reporting.
        result.organizationId = response.headers.get('anthropic-organization-id') ?? row.organizationId ?? null;
        result.workspaceId = response.headers.get('anthropic-workspace-id') ?? row.workspaceId ?? null;
      }
      const data = await response.json() as { data: Array<{ id: string; display_name?: string }>; has_more?: boolean; last_id?: string };
      for (const model of data.data) models.push({ id: model.id, label: model.display_name ?? model.id });
      if(data.has_more&&(typeof data.last_id!=='string'||!data.last_id))throw new Error('Missing model page cursor');
      after = data.has_more ? data.last_id : undefined;
    } while (after);
    result.models = models;
    result.status = 'Connected — models refreshed';
  } catch {
    result.status = 'Could not refresh models. Check the key and network connection. Saved models may be stale.';
  }
  // Billing privileges are separate from inference access. Never imply that
  // historical spend is a credit balance, or overwrite user-entered grants.
  try {
    const start = new Date(); start.setUTCDate(1); start.setUTCHours(0, 0, 0, 0);
    let total = 0;
    let refreshedAt: string | null = null;
    let next: string | undefined;const costPages=new Set<string>();
    do {
      if(costPages.size>=100||costPages.has(next??''))throw new Error('Repeated or excessive cost pages');
      costPages.add(next??'');
      const path = row.provider === 'openai'
        ? `/v1/organization/costs?start_time=${Math.floor(start.getTime() / 1000)}&limit=31${next ? `&page=${encodeURIComponent(next)}` : ''}`
        : `/v1/organizations/analytics/cost?starting_at=${encodeURIComponent(start.toISOString())}&limit=31${next ? `&page=${encodeURIComponent(next)}` : ''}`;
      const response = await fetch(base + path, { headers: row.provider === 'anthropic' ? { ...headers, 'anthropic-version': '2026-10-21', 'anthropic-beta': 'analytics-usage-cost-2026-08-24' } : headers, signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error('Billing access unavailable');
      const data = await response.json() as any;
      if (!Array.isArray(data.data)) throw new Error('Invalid cost response');
      if (row.provider === 'anthropic') refreshedAt = typeof data.data_refreshed_at === 'string' ? data.data_refreshed_at : null;
      const items = row.provider === 'anthropic' ? data.data.map((entry: any) => entry.cost) : data.data.flatMap((bucket: any) => bucket.results ?? []);
      for (const item of items) {
        const currency = row.provider === 'openai' ? item.amount?.currency : item.currency;
        const amount = Number(row.provider === 'openai' ? item.amount?.value : item.amount);
        if (String(currency).toLowerCase() !== 'usd' || !Number.isFinite(amount)) throw new Error('Unknown billing units');
        total += row.provider === 'anthropic' ? amount / 100 : amount;
      }
      if(data.has_more&&(typeof data.next_page!=='string'||!data.next_page))throw new Error('Missing cost page cursor');
      next = data.has_more ? data.next_page : undefined;
    } while (next);
    result.reportedSpend = row.provider === 'anthropic' && !refreshedAt ? null : total;
    result.spendCheckedAt = new Date().toISOString();
    result.billingStatus = 'Provider-reported organization spend this UTC calendar month, before credits; not a remaining balance.' + (row.provider === 'anthropic' ? ` Data as of ${refreshedAt ?? 'unknown'}; may lag up to 24 hours.` : '');
  } catch {
    result.billingStatus = 'Organization costs could not be retrieved. This usually requires billing/admin permissions; model access is checked separately. Optional manual details are available below.';
  }
  const rows = read();
  // A slow refresh must not overwrite a newly replaced key or edited settings.
  write(rows.map(item => item.id === id && item.encryptedKey === encryptedKey && JSON.stringify(item.vaultReference)===JSON.stringify(row.vaultReference) ? { ...item, ...result } : item));
}

export function subscriptionPriorities(): Record<string, number> {
  const path = join(app.getPath('userData'), 'subscription-priorities.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
}
export function saveSubscriptionPriority(id: string, priority: number): void {
  writeFileSync(join(app.getPath('userData'), 'subscription-priorities.json'), JSON.stringify({ ...subscriptionPriorities(), [id]: priority }), { mode: 0o600 });
}

/** Main-process only. Never return this value over IPC or put it in a child environment. */
export async function unlockApiConnection(id: string, requireEnabled=true): Promise<string> {
  const row=read().find(item=>item.id===id);
  if(!row||(requireEnabled&&!row.enabled))throw Error('API connection unavailable.');
  if(row.vaultReference){const {withVaultSecret}=await import('./vault-runtime.js');return withVaultSecret(row.vaultReference.id,row.vaultReference.project,`api:${row.provider}`,async value=>value.toString('utf8'));}
  return safeStorage.decryptString(Buffer.from(row.encryptedKey,'base64'));
}
