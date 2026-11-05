import { app } from 'electron';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AnthropicReporting } from '@kanbots/api';
const snapshotPath = () => join(app.getPath('userData'), 'anthropic-reporting.json');
export function getAnthropicReporting(): AnthropicReporting {
  if (!existsSync(snapshotPath())) return { connected: false, status: 'Usage and cost access not connected.' };
  try { return JSON.parse(readFileSync(snapshotPath(), 'utf8')); }
  catch { return { connected: false, status: 'Refresh usage and cost access.' }; }
}
function store(value: AnthropicReporting) { writeFileSync(snapshotPath(), JSON.stringify(value), { mode: 0o600 }); }
function ant(args: string[], timeout: number): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env, ANTHROPIC_CONFIG_DIR: join(app.getPath('userData'), 'anthropic-reporting-auth') };
  for (const key of Object.keys(env)) if (key.startsWith('ANTHROPIC_')) delete env[key];
  env.ANTHROPIC_CONFIG_DIR = join(app.getPath('userData'), 'anthropic-reporting-auth');
  return new Promise((resolve, reject) => execFile('ant', args, { env, timeout, maxBuffer: 1024 * 1024 }, (error, stdout) => {
    if (error) reject(new Error((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing-cli' : 'authorization-failed'));
    else resolve(stdout.trim());
  }));
}
let busy = false;
export async function updateAnthropicReporting(action: 'connect' | 'refresh'): Promise<void> {
  if (busy) return;
  busy = true;
  const previous = getAnthropicReporting();
  try {
    if (action === 'connect') await ant(['auth', 'login', '--profile', 'kanbots-local-analytics', '--scope', 'org:admin'], 300000);
    // The official CLI owns OAuth storage and refresh. Token stays in main-process memory.
    const token = await ant(['auth', 'print-credentials', '--profile', 'kanbots-local-analytics', '--access-token'], 15000);
    if (!token || /\s/.test(token)) throw new Error('authorization-failed');
    const headers = { Authorization: `Bearer ${token}`, 'anthropic-version': '2026-10-21', 'anthropic-beta': 'analytics-usage-cost-2026-08-24' };
    const get = async (path: string) => {
      const response = await fetch(`https://api.anthropic.com${path}`, { headers, signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'authorization-failed' : 'report-unavailable');
      return response.json() as Promise<any>;
    };
    const organization = await get('/v1/organizations/me');
    if (typeof organization.id !== 'string' || typeof organization.name !== 'string') throw new Error('report-unavailable');
    const start = new Date(); start.setUTCDate(1); start.setUTCHours(0, 0, 0, 0);
    const readReport = async (kind: 'usage' | 'cost') => {
      let page: string | undefined;
      let amount = 0;
      let refreshedAt: string | null = null;
      do {
        const report = await get(`/v1/organizations/analytics/${kind}?starting_at=${encodeURIComponent(start.toISOString())}&limit=100${page ? `&page=${encodeURIComponent(page)}` : ''}`);
        if (!Array.isArray(report.data)) throw new Error('report-unavailable');
        refreshedAt = typeof report.data_refreshed_at === 'string' ? report.data_refreshed_at : null;
        for (const row of report.data) {
          if (kind === 'cost' && row.cost?.currency !== 'USD') throw new Error('report-unavailable');
          const value = Number(kind === 'cost' ? row.cost?.amount : row.usage?.total_tokens);
          if (!Number.isFinite(value)) throw new Error('report-unavailable');
          amount += kind === 'cost' ? value / 100 : value;
        }
        page = report.has_more ? report.next_page : undefined;
      } while (page);
      return { amount: refreshedAt ? amount : null, refreshedAt };
    };
    const [usage, cost] = await Promise.all([readReport('usage'), readReport('cost')]);
    store({ connected: true, status: 'Usage and costs connected. Reports may lag by up to 24 hours; credits and balances are separate.', organizationId: organization.id, organizationName: organization.name, checkedAt: new Date().toISOString(), tokens: usage.amount, costUsd: cost.amount, usageAsOf: usage.refreshedAt, costAsOf: cost.refreshedAt });
  } catch (error) {
    store({ ...previous, connected: false, status: error instanceof Error && error.message === 'missing-cli'
      ? 'Install the official Anthropic ant CLI, then connect usage and costs.'
      : 'Could not authorize or refresh organization reports. A Console organization owner/admin is required. Previous readings, if shown, are stale.' });
  } finally { busy = false; }
}
