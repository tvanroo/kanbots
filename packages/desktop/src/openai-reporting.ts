import { app, safeStorage } from 'electron';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { OpenAIReporting } from '@kanborg/api';
type Stored = OpenAIReporting & { encryptedKey?: string };
const path = () => join(app.getPath('userData'), 'openai-reporting.json');
function read(): Stored {
  if (!existsSync(path())) return { connected: false, status: 'Organization reporting not connected.' };
  try { return JSON.parse(readFileSync(path(), 'utf8')); }
  catch { throw new Error('Could not read reporting settings. The original file has been preserved.'); }
}
function write(value: Stored) {
  writeFileSync(path() + '.tmp', JSON.stringify(value), { mode: 0o600 });
  renameSync(path() + '.tmp', path());
}
export function getOpenAIReporting(): OpenAIReporting {
  const { encryptedKey: _key, ...report } = read();
  return report;
}
let busy = false;
export async function updateOpenAIReporting(action: 'connect' | 'refresh', apiKey?: string): Promise<void> {
  if (busy) throw new Error('Reporting refresh is already in progress.');
  busy = true;
  try {
    let stored = read();
    if (action === 'connect' && apiKey) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('Encrypted storage is unavailable. The key was not saved.');
      stored = { connected: false, status: 'Reporting key saved; checking access.', keyPreview: `${apiKey.slice(0, 5)}••••••${apiKey.slice(-5)}`, encryptedKey: safeStorage.encryptString(apiKey).toString('base64') };
      write(stored);
    }
    if (!stored.encryptedKey) throw new Error('Paste an OpenAI Admin API key to connect reporting.');
    let key: string;
    try { key = safeStorage.decryptString(Buffer.from(stored.encryptedKey, 'base64')); }
    catch { throw new Error('The reporting key could not be unlocked. Replace it on this Mac.'); }
    const start = new Date(); start.setUTCDate(1); start.setUTCHours(0, 0, 0, 0);
    const end = Math.floor(Date.now() / 1000);
    const headers = { Authorization: `Bearer ${key}` };
    const report = async (kind: 'usage' | 'costs') => {
      let page: string | undefined;
      let input = 0, output = 0, requests = 0, cost = 0;
      const seen = new Set<string>();
      let organizationId: string | null = null;
      do {
        const endpoint = kind === 'usage' ? 'usage/completions' : 'costs';
        const response = await fetch(`https://api.openai.com/v1/organization/${endpoint}?start_time=${Math.floor(start.getTime() / 1000)}&end_time=${end}&bucket_width=1d&limit=31${page ? `&page=${encodeURIComponent(page)}` : ''}`, { headers, signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'permission' : 'unavailable');
        const responseOrganization = response.headers.get('openai-organization');
        if (organizationId && responseOrganization && organizationId !== responseOrganization) throw new Error('organization-mismatch');
        organizationId = responseOrganization ?? organizationId;
        const data = await response.json() as any;
        if (!Array.isArray(data.data)) throw new Error('schema');
        for (const bucket of data.data) {
          if (!Array.isArray(bucket.results)) throw new Error('schema');
          for (const item of bucket.results) {
            if (kind === 'usage') {
              if (![item.input_tokens, item.output_tokens, item.num_model_requests].every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0)) throw new Error('schema');
              // Cached and audio token counts are subsets, not additional tokens.
              input += item.input_tokens; output += item.output_tokens; requests += item.num_model_requests;
            } else {
              if (item.amount?.currency !== 'usd' || item.amount?.value == null || !Number.isFinite(Number(item.amount.value))) throw new Error('schema');
              cost += Number(item.amount.value);
            }
          }
        }
        if (data.has_more && (typeof data.next_page !== 'string' || seen.has(data.next_page))) throw new Error('pagination');
        page = data.has_more ? data.next_page : undefined;
        if (page) seen.add(page);
      } while (page);
      return { input, output, requests, cost, organizationId };
    };
    const [usage, costs] = await Promise.allSettled([report('usage'), report('costs')]);
    const checkedAt = new Date().toISOString();
    const result: Stored = { ...stored, organizationId: (usage.status === 'fulfilled' ? usage.value.organizationId : null) ?? (costs.status === 'fulfilled' ? costs.value.organizationId : null), connected: usage.status === 'fulfilled' && costs.status === 'fulfilled', checkedAt,
      usageAvailable: usage.status === 'fulfilled', costsAvailable: costs.status === 'fulfilled',
      status: usage.status === 'fulfilled' && costs.status === 'fulfilled'
        ? 'Organization usage and costs connected. Reports may lag; these are not credit balances.'
        : 'Some reports are unavailable. Check that this is an Admin API key with organization reporting access. Previous readings keep their retrieval time.',
    };
    if (usage.status === 'fulfilled') Object.assign(result, { inputTokens: usage.value.input, outputTokens: usage.value.output, requests: usage.value.requests, usageRetrievedAt: checkedAt, periodStart: start.toISOString() });
    if (costs.status === 'fulfilled') Object.assign(result, { costUsd: costs.value.cost, costsRetrievedAt: checkedAt, costPeriodStart: start.toISOString() });
    write(result);
  } finally { busy = false; }
}
