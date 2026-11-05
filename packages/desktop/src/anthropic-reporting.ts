import { app } from 'electron';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AnthropicReporting } from '@kanbots/api';
const snapshotPath = () => join(app.getPath('userData'), 'anthropic-reporting.json');
export function getAnthropicReporting(): AnthropicReporting {
  if (!existsSync(snapshotPath())) return { connected: false, status: 'Usage and cost access not connected.' };
  try {
    const report: AnthropicReporting = JSON.parse(readFileSync(snapshotPath(), 'utf8'));
    if (!report.eligibility && report.status.startsWith('Organization access was denied.')) report.eligibility = 'denied';
    return report;
  }
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
let installation: Promise<void> | undefined;
async function prepareCli(approved: boolean): Promise<boolean> {
  try { await ant(['--version'], 10000); return true; }
  catch (error) {
    if (!(error instanceof Error) || error.message !== 'missing-cli') {
      store({ ...getAnthropicReporting(), prerequisite: 'manual', status: 'The Anthropic helper is installed but could not start. Check the installation guide before retrying.' });
      return false;
    }
  }
  if (!approved) {
    store({ ...getAnthropicReporting(), prerequisite: 'missing', status: 'The Anthropic helper is needed to check organization access. Nothing has been installed yet.' });
    return false;
  }
  const brew = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'].find(existsSync);
  if (process.platform !== 'darwin' || !brew) {
    store({ ...getAnthropicReporting(), prerequisite: 'manual', status: 'Automatic installation requires Homebrew on this Mac. Use the installation guide, then check again.' });
    return false;
  }
  try {
    installation ??= new Promise<void>((resolve, reject) => {
      execFile(brew, ['install', 'anthropics/tap/ant'], {
        timeout: 300000, maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_ENV_HINTS: '1' },
      }, error => error ? reject(new Error('install-failed')) : resolve());
    }).finally(() => { installation = undefined; });
    await installation;
    await ant(['--version'], 10000);
    store({ ...getAnthropicReporting(), prerequisite: 'ready', status: 'Anthropic helper installed. Checking organization access…' });
    return true;
  } catch {
    store({ ...getAnthropicReporting(), prerequisite: 'missing', status: 'Installation did not finish. Retry or use the installation guide; authorization has not started.' });
    return false;
  }
}
let loginPending: Promise<string> | undefined;
let refreshPending: Promise<void> | undefined;
const credentials = () => ant(['auth', 'print-credentials', '--profile', 'kanbots-local-analytics', '--access-token'], 15000);
export async function updateAnthropicReporting(action: 'connect' | 'refresh', approveInstall = false): Promise<void> {
  // Refresh remains available while the browser login process is still waiting.
  if (action === 'connect') {
    if (getAnthropicReporting().eligibility === 'denied') { await updateAnthropicReporting('refresh'); return; }
    if (!await prepareCli(approveInstall)) return;
    try {
      const token = await credentials();
      if (!token || /\s/.test(token)) throw new Error('authorization-failed');
      const response = await fetch('https://api.anthropic.com/v1/organizations/me', {
        headers: { Authorization: `Bearer ${token}`, 'anthropic-version': '2026-10-21' }, signal: AbortSignal.timeout(15000),
      });
      if (response.status === 401) throw new Error('authorization-failed');
      // Permission and service errors need a useful report, not another browser login.
    } catch (error) {
      if (!(error instanceof Error) || !['authorization-failed', 'missing-cli'].includes(error.message)) {
        await updateAnthropicReporting('refresh');
        return;
      }
      if (error instanceof Error && error.message === 'missing-cli') {
        store({ ...getAnthropicReporting(), connected: false, status: 'Install the official Anthropic ant CLI, then connect usage and costs.' });
        return;
      }
      loginPending ??= ant(['auth', 'login', '--profile', 'kanbots-local-analytics', '--scope', 'org:admin'], 300000).finally(() => { loginPending = undefined; });
      try { await loginPending; } catch { /* Recheck credentials even if the browser callback failed. */ }
    }
  }
  refreshPending ??= refreshReports().finally(() => { refreshPending = undefined; });
  await refreshPending;
}
async function refreshReports(): Promise<void> {
  let authenticated = false;
  try {
    // The official CLI owns OAuth storage and refresh. Token stays in main-process memory.
    const token = await credentials();
    if (!token || /\s/.test(token)) throw new Error('authorization-failed');
    const headers = { Authorization: `Bearer ${token}`, 'anthropic-version': '2026-10-21', 'anthropic-beta': 'analytics-usage-cost-2026-08-24' };
    const get = async (path: string) => {
      const response = await fetch(`https://api.anthropic.com${path}`, { headers, signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(response.status === 401 ? 'authorization-failed' : response.status === 403 ? 'permission-denied' : 'report-unavailable');
      return response.json() as Promise<any>;
    };
    const organization = await get('/v1/organizations/me');
    if (typeof organization.id !== 'string' || typeof organization.name !== 'string') throw new Error('report-unavailable');
    authenticated = true;
    store({ ...getAnthropicReporting(), connected: true, status: 'Organization authorized. Loading usage and costs…', organizationId: organization.id, organizationName: organization.name });
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
    store({ eligibility: 'supported', prerequisite: 'ready', connected: true, status: 'Usage and costs connected. Reports may lag by up to 24 hours; credits and balances are separate.', organizationId: organization.id, organizationName: organization.name, checkedAt: new Date().toISOString(), tokens: usage.amount, costUsd: cost.amount, usageAsOf: usage.refreshedAt, costAsOf: cost.refreshedAt });
  } catch (error) {
    const reason = error instanceof Error ? error.message : '';
    store({ ...getAnthropicReporting(), eligibility: reason === 'permission-denied' ? 'denied' : reason === 'authorization-failed' ? 'unknown' : getAnthropicReporting().eligibility ?? 'unknown', prerequisite: reason === 'missing-cli' ? 'missing' : 'ready', connected: authenticated && reason !== 'authorization-failed', status: reason === 'missing-cli'
      ? 'Install the official Anthropic ant CLI, then check connection.'
      : reason === 'authorization-failed' ? 'No active organization authorization found. Connect usage & costs to sign in.'
      : reason === 'permission-denied' ? 'Organization reporting is not available with this account’s current access. Personal Pro/Max subscriptions do not include this API; Console organizations require admin reporting permissions. Your subscription can still be used.'
      : authenticated ? 'Organization authorized, but reports are currently unavailable. Check connection to retry. Previous readings are stale.'
      : 'Could not check organization access. Check your connection and retry before signing in again.' });
  }
}
