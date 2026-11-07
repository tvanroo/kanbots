import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { CodexSubscriptionUsage } from '@kanborg/api';
import { spawn } from 'node:child_process';

export interface CodexDetails {
  accountIdentity?: string;
  resetOutcome?: string;
  subscriptionUsage?: CodexSubscriptionUsage;
  subscriptionUsageError?: string;
  hasKey: boolean;
  authenticationLabel: string;
  models: Array<{ id: string; label: string }>;
  catalogueError?: string;
}

let snapshotPath: string | undefined;
let lastUsage: { identity: string; usage: CodexSubscriptionUsage } | undefined;
export function configureCodexUsageSnapshot(path: string) {
  snapshotPath = path;
  try { const saved = JSON.parse(readFileSync(path, 'utf8')); if (typeof saved.identity === 'string' && Array.isArray(saved.usage?.windows) && saved.usage?.checkedAt) lastUsage = saved; } catch { /* First run. */ }
}
function saveUsage(identity: string, usage: CodexSubscriptionUsage) {
  lastUsage = { identity, usage };
  if (snapshotPath) try { writeFileSync(snapshotPath + '.tmp', JSON.stringify(lastUsage), { mode: 0o600 }); renameSync(snapshotPath + '.tmp', snapshotPath); } catch { /* Keep in-memory snapshot. */ }
}

// Use the same CLI and account as task execution. Never forward account details,
// raw protocol errors, or credential material to the renderer.
export async function getCodexDetails(redemption?: { accountIdentity: string; creditId: string; idempotencyKey: string }): Promise<CodexDetails> {
  const child = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] });
  let sequence = 0;
  let buffer = '';
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  let unavailable = false;
  const fail = () => {
    unavailable = true;
    for (const request of pending.values()) request.reject(new Error('Codex unavailable'));
    pending.clear();
  };
  child.on('error', fail);
  child.on('exit', fail);
  child.stdin.on('error', fail);
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        const message = JSON.parse(line);
        const request = pending.get(message.id);
        if (!request) continue;
        pending.delete(message.id);
        if (message.error) request.reject(new Error('Codex request failed'));
        else request.resolve(message.result);
      } catch { /* Ignore non-protocol output. */ }
    }
  });
  const timer = setTimeout(() => { fail(); child.kill(); }, 15000);
  const call = (method: string, params: unknown): Promise<any> => new Promise((resolve, reject) => {
    if (unavailable) { reject(new Error('Codex unavailable')); return; }
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  const details: CodexDetails = { hasKey: false, authenticationLabel: 'Authentication could not be checked', models: [] };
  try {
    await call('initialize', { clientInfo: { name: 'kanbots_local', version: '1.1.2' }, capabilities: null });
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    const { account } = await call('account/read', { refreshToken: false });
    details.hasKey = account != null;
    if(account?.type === 'chatgpt' && (typeof account.id === 'string' || typeof account.email === 'string')) details.accountIdentity = createHash('sha256').update(JSON.stringify([account.id ?? null, account.email ?? null])).digest('hex');
    if(redemption) {
      if(account?.type !== 'chatgpt' || details.accountIdentity !== redemption.accountIdentity) throw Error('Account changed');
      const result=await call('account/rateLimitResetCredit/consume',{ creditId:redemption.creditId, idempotencyKey:redemption.idempotencyKey });
      details.resetOutcome=typeof result.outcome === 'string' ? result.outcome : 'unknown';
    }
    details.authenticationLabel = account?.type === 'chatgpt'
      ? 'ChatGPT subscription'
      : account?.type === 'apiKey' ? 'OpenAI API billing'
      : account ? 'Other Codex authentication' : 'Signed out of Codex';
    try {
    let cursor: string | null = null;
    const cursors = new Set<string>();
    do {
      const page = await call('model/list', { cursor, includeHidden: false });
      for (const model of page.data) {
        if (typeof model.model === 'string' && typeof model.displayName === 'string') {
          details.models.push({ id: model.model, label: model.displayName });
        }
      }
      cursor = page.nextCursor ?? null;
      if (cursor && cursors.has(cursor)) throw new Error('Repeated catalogue page');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    } catch { details.catalogueError = 'Model catalogue unavailable; usage is checked separately.'; }
    if (account?.type === 'chatgpt') {
      try {
        const usage = await call('account/rateLimits/read', {});
        const snapshots = usage.rateLimitsByLimitId ? Object.values(usage.rateLimitsByLimitId) : [usage.rateLimits];
        const windows: CodexSubscriptionUsage['windows'] = [];
        const credits: CodexSubscriptionUsage['credits'] = [];
        for (const snapshot of snapshots as any[]) {
          if (!snapshot) continue;
          const name = typeof snapshot.limitName === 'string' ? snapshot.limitName : typeof snapshot.limitId === 'string' ? snapshot.limitId : 'Codex';
          for (const window of [snapshot.primary, snapshot.secondary]) if (window && typeof window.usedPercent === 'number' && Number.isFinite(window.usedPercent)) {
            windows.push({ name, usedPercent: window.usedPercent, windowMinutes: typeof window.windowDurationMins === 'number' ? window.windowDurationMins : null, resetsAt: typeof window.resetsAt === 'number' ? window.resetsAt : null });
          }
          if (snapshot.credits) credits.push({ name, balance: typeof snapshot.credits.balance === 'string' ? snapshot.credits.balance : null, unlimited: snapshot.credits.unlimited === true });
        }
        const reset = usage.rateLimitResetCredits;
        const resetCredits = reset && Number.isInteger(reset.availableCount) && reset.availableCount >= 0 ? {
          availableCount: reset.availableCount,
          credits: Array.isArray(reset.credits) ? reset.credits.filter((c: any)=>typeof c.id==='string' && c.status==='available' && c.resetType==='codexRateLimits' && (c.expiresAt===null || (typeof c.expiresAt==='number' && Number.isFinite(c.expiresAt)))).map((c: any)=>({id:c.id,expiresAt:c.expiresAt,status:c.status,resetType:c.resetType})) : [],
        } : undefined;
        details.subscriptionUsage = { ...(resetCredits ? {resetCredits} : {}), checkedAt: new Date().toISOString(), ordinaryUsageAllowed: typeof usage.ordinaryUsageAllowed === 'boolean' ? usage.ordinaryUsageAllowed : null, windows, credits };
        if (details.accountIdentity && windows.length) saveUsage(details.accountIdentity, details.subscriptionUsage);
      } catch { details.subscriptionUsageError = 'Subscription usage could not be read from Codex. Try Refresh again.'; }
    }
  } catch {
    details.catalogueError = 'Could not load models from Codex. Check that the CLI is up to date and signed in, then refresh.';
  } finally {
    clearTimeout(timer);
    child.stdin.end();
    child.kill();
  }
  if (!details.subscriptionUsage && details.accountIdentity && lastUsage?.identity === details.accountIdentity) {
    details.subscriptionUsage = lastUsage.usage;
    details.subscriptionUsageError = 'Last reported usage; retrying automatically. Figures may have changed.';
  }
  return details;
}
