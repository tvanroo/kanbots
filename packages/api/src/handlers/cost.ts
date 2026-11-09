import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import type { CostTodayResult, CostUsageResult, CostUsageWindow, CostBreakdownItem } from '../bridge.js';
import type { HandlerDeps } from './types.js';

function startOfTodayIso(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

export async function today(deps: HandlerDeps): Promise<CostTodayResult> {
  const since = startOfTodayIso();
  const totalUsd = deps.store.agentRuns.sumCostSince(since);
  return { totalUsd, since };
}

export async function breakdown(deps: HandlerDeps): Promise<CostBreakdownItem[]> {
  return deps.store.agentRuns.sumCostByWorkspaceAndProvider();
}

// Claude Code's existing OAuth usage endpoint. This is a best-effort integration:
// do not turn a missing window or failed request into a full allowance.
const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
interface Credential { accessToken: string; expiresAt?: number; account?: string | undefined }
let cache: { identity: string; account?: string | undefined; until: number; payload: CostUsageResult; lastGood?: CostUsageResult; failures?: number; rateLimitUntil?: number } | undefined;
let snapshotPath: string | undefined;
/** Persist quota metadata only; never persist the OAuth token. */
export function configureClaudeUsageSnapshot(path: string): void {
  snapshotPath = path;
  try {
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof saved.identity === 'string' && Number.isFinite(saved.until) && saved.payload && ['oauth','unavailable','unauthorized'].includes(saved.payload.source)) cache = saved;
  } catch { /* First launch or unreadable snapshot: fetch normally. */ }
}
function persistSnapshot(): void {
  if (!snapshotPath || !cache) return;
  try { writeFileSync(snapshotPath + '.tmp', JSON.stringify(cache), { mode: 0o600 }); renameSync(snapshotPath + '.tmp', snapshotPath); }
  catch { /* Reporting must still work if snapshot storage is unavailable. */ }
}
let pending: { identity: string; promise: Promise<CostUsageResult> } | undefined;
let currentIdentity: string | undefined;

export async function usage(_deps: HandlerDeps): Promise<CostUsageResult> {
  return readClaudeSubscriptionUsage();
}
export async function readClaudeSubscriptionUsage(): Promise<CostUsageResult> {
  const credential = await readCredential();
  const empty: CostUsageResult = { fiveHour: null, sevenDay: null, stale: false, source: 'unavailable', message: 'Subscription usage is not available from the existing Claude Code sign-in.' };
  if (!credential) return { ...(cache?.lastGood ?? empty), stale: Boolean(cache?.lastGood), source: 'unavailable', message: 'Claude Code credentials could not be read. Saved quota is historical only; checking again automatically.' };
  const identity = createHash('sha256').update(credential.accessToken).digest('hex');
  currentIdentity = identity;
  // A token change must not bypass a provider cooldown or expose another account's quota.
  const cooldown = cache?.rateLimitUntil;
  if (cache && cache.identity !== identity && credential.account && cache.account === credential.account) {
    // Token renewal preserves account-scoped history, but immediately retries auth failures.
    cache = { ...cache, identity, until: cooldown && cooldown > Date.now() ? cooldown : 0 };
  }
  if (cache?.identity !== identity) cache = cooldown && cooldown > Date.now() ? { identity, until: cooldown, rateLimitUntil: cooldown, payload: { ...empty, retryAt: new Date(cooldown).toISOString(), message: 'Claude usage checks are cooling down after a rate limit. Checking again automatically.' } } : undefined;
  if (cache && cache.until > Date.now()) return cache.payload;
  if (pending?.identity === identity) return pending.promise;
  const promise = loadUsage(credential, identity, empty);
  pending = { identity, promise };
  try { return await promise; } finally { if (pending?.promise === promise) pending = undefined; }
}
async function loadUsage(credential: Credential, identity: string, empty: CostUsageResult): Promise<CostUsageResult> {
  const lastGood = cache?.identity === identity ? cache.lastGood : undefined;
  const failures = (cache?.identity === identity ? cache.failures ?? 0 : 0) + 1;
  let delay = Math.min(15 * 60000, 60000 * 2 ** Math.min(failures - 1, 4));
  let rateLimited = false;
  try {
    // Never hammer the usage service with an access token known to be expired.
    if (credential.expiresAt && credential.expiresAt <= Date.now()) throw new Error('unauthorized');
    const response = await fetch(USAGE_ENDPOINT, {
      headers: { Authorization: `Bearer ${credential.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      if (response.status === 429) {
        rateLimited = true;
        const header = response.headers.get('retry-after');
        const retry = header && /^\d+(\.\d+)?$/.test(header) ? Number(header) * 1000 : Date.parse(header ?? '') - Date.now();
        if (Number.isFinite(retry) && retry > 0) delay = Math.max(delay, retry);
      }
      throw new Error(response.status === 401 ? 'unauthorized' : 'unavailable');
    }
    const data = await response.json() as Record<string, unknown>;
    if (!data || typeof data !== 'object') throw new Error('unavailable');
    const windows: NonNullable<CostUsageResult['windows']> = [];
    for (const [id, raw] of Object.entries(data)) {
      if (!/^(five_hour|seven_day)(_|$)/.test(id)) continue;
      const window = toWindow(raw);
      if (window) windows.push({ ...window, id, label: id === 'five_hour' ? '5-hour quota' : id === 'seven_day' ? 'Weekly quota' : id.replaceAll('_', ' ') });
    }
    if (!windows.length) throw new Error('unavailable');
    const payload: CostUsageResult = { fiveHour: toWindow(data.five_hour), sevenDay: toWindow(data.seven_day), windows, source: 'oauth', checkedAt: new Date().toISOString(), stale: false };
    // A read begun under an old sign-in must not overwrite a newer account's snapshot.
    if (currentIdentity === identity) {
      cache = { identity, account: credential.account, until: Date.now() + 5 * 60000, payload, lastGood: payload, failures: 0 };
      persistSnapshot();
    }
    return payload;
  } catch (error) {
    const unauthorized = error instanceof Error && error.message === 'unauthorized';
    const payload: CostUsageResult = { ...(lastGood ?? empty), source: unauthorized ? 'unauthorized' : 'unavailable', stale: Boolean(lastGood), retryAt: new Date(Date.now() + delay).toISOString(), message: unauthorized ? 'Claude usage authorization needs renewal. Saved quota is retained; this does not mean your subscription is exhausted or your CLI is signed out.' : rateLimited ? 'Claude has paused usage checks (rate limit). Retrying automatically after its requested delay.' : 'Claude usage is temporarily unavailable. Retrying automatically; previous readings may be stale.' };
    if (currentIdentity === identity) {
      cache = { identity, account: credential.account, until: Date.now() + delay, payload, failures, ...(rateLimited ? { rateLimitUntil: Date.now() + delay } : {}), ...(lastGood ? { lastGood } : {}) };
      persistSnapshot();
    }
    return payload;
  }
}
function toWindow(raw: unknown): CostUsageWindow | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as { utilization?: unknown; resets_at?: unknown };
  if (typeof value.utilization !== 'number' || !Number.isFinite(value.utilization) || value.utilization < 0) return null;
  const reset = typeof value.resets_at === 'string' && Number.isFinite(Date.parse(value.resets_at)) ? value.resets_at : null;
  return { pct: Math.max(0, Math.min(1, value.utilization / 100)), resetsAt: reset };
}
async function readCredential(): Promise<Credential | null> {
  const directory = (process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')).normalize('NFC');
  const secureOverride = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  const secureDirectory = (secureOverride !== undefined ? secureOverride || join(homedir(), '.claude') : directory).normalize('NFC');
  const customStore = secureOverride !== undefined ? !!secureOverride : !!process.env.CLAUDE_CONFIG_DIR;
  const suffix = customStore ? '-' + createHash('sha256').update(secureDirectory).digest('hex').slice(0, 8) : '';
  let account: string | undefined;
  try {
    const config = JSON.parse(await readFile(process.env.CLAUDE_CONFIG_DIR ? join(directory, '.claude.json') : join(homedir(), '.claude.json'), 'utf8'));
    if (typeof config.oauthAccount?.accountUuid === 'string') account = createHash('sha256').update(secureDirectory + ':' + config.oauthAccount.accountUuid).digest('hex');
  } catch { /* Without verified account metadata, never reuse another token's quota. */ }
  const withAccount = (value: Credential | null) => value ? { ...value, account } : null;
  if (process.platform === 'darwin') {
    let username = process.env.USER;
    if (!username) { try { username = userInfo().username; } catch { username = 'claude-code-user'; } }
    // Match Claude Code's account AND service. An unscoped query can return an
    // obsolete credential belonging to an earlier installation on the same Mac.
    const raw = await new Promise<string | null>(resolve => execFile('/usr/bin/security', ['find-generic-password', '-a', username!, '-s', 'Claude Code-credentials' + suffix, '-w'], { timeout: 10000, maxBuffer: 1024 * 1024 }, (error, stdout) => resolve(error ? null : stdout)));
    const credential = parseCredential(raw);
    if (credential) return withAccount(credential);
  }
  try { return withAccount(parseCredential(await readFile(join(secureDirectory, '.credentials.json'), 'utf8'))); }
  catch { return null; }
}
function parseCredential(raw: string | null): Credential | null {
  try {
    const oauth = JSON.parse(raw ?? '{}').claudeAiOauth;
    return typeof oauth?.accessToken === 'string' && oauth.accessToken.length > 0 ? { accessToken: oauth.accessToken, expiresAt: oauth.expiresAt } : null;
  } catch { return null; }
}

/** Metadata only; used to avoid treating expired credentials as a successful login. */
export async function claudeSignInNeedsRefresh(): Promise<boolean> {
  const credential = await readCredential();
  return !credential || Boolean(credential.expiresAt && credential.expiresAt <= Date.now()) || (cache?.identity === createHash('sha256').update(credential.accessToken).digest('hex') && cache?.payload.source === 'unauthorized');
}
