import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ account: undefined as string | undefined, token: 'synthetic-a', expiresAt: undefined as number | undefined, keychain: vi.fn(), file: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: (...args: unknown[]) => {
  fixture.keychain(args[1]);
  (args[3] as (error: null, value: string) => void)(null, JSON.stringify({ claudeAiOauth: { accessToken: fixture.token, expiresAt: fixture.expiresAt } }));
} }));
vi.mock('node:fs/promises', () => ({ readFile: async (path: string) => { if (path.endsWith('.claude.json')) return JSON.stringify({oauthAccount:{accountUuid:fixture.account}}); fixture.file(); return JSON.stringify({ claudeAiOauth: { accessToken: fixture.token, expiresAt: fixture.expiresAt } }); } }));

beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); vi.stubEnv('CLAUDE_CONFIG_DIR', ''); fixture.account = undefined; fixture.token = 'synthetic-a'; fixture.expiresAt = undefined; });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const response = () => new Response(JSON.stringify({ five_hour: null, seven_day: { utilization: 88, resets_at: '2026-11-06T16:00:00Z' } }));
describe('Claude subscription usage', () => {
  it('reads existing credentials, preserves missing windows, and returns no token', async () => {
    const fetch = vi.fn().mockResolvedValue(response()); vi.stubGlobal('fetch', fetch);
    const { readClaudeSubscriptionUsage } = await import('../../src/handlers/cost.js');
    const result = await readClaudeSubscriptionUsage();
    expect(result.sevenDay?.pct).toBe(0.88); expect(result.fiveHour).toBeNull();
    expect(result.checkedAt).toBeDefined(); expect(result.stale).toBe(false);
    expect(JSON.stringify(result)).not.toContain(fixture.token);
    if (process.platform === 'darwin') { expect(fixture.keychain).toHaveBeenCalled(); expect(fixture.file).not.toHaveBeenCalled(); }
  });
  it('coalesces reads and caches quota without running inference', async () => {
    const fetch = vi.fn().mockResolvedValue(response()); vi.stubGlobal('fetch', fetch);
    const { readClaudeSubscriptionUsage } = await import('../../src/handlers/cost.js');
    await Promise.all([readClaudeSubscriptionUsage(), readClaudeSubscriptionUsage()]);
    await readClaudeSubscriptionUsage();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe('https://api.anthropic.com/api/oauth/usage');
  });
  it('retains explicitly stale data on failure but never carries it across credentials', async () => {
    let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fetch = vi.fn().mockResolvedValueOnce(response()).mockRejectedValue(new Error('offline')); vi.stubGlobal('fetch', fetch);
    const { readClaudeSubscriptionUsage } = await import('../../src/handlers/cost.js');
    await readClaudeSubscriptionUsage(); now += 301000;
    const stale = await readClaudeSubscriptionUsage(); expect(stale.stale).toBe(true); expect(stale.sevenDay?.pct).toBe(0.88);
    fixture.token = 'synthetic-b';
    const switched = await readClaudeSubscriptionUsage(); expect(switched.sevenDay).toBeNull(); expect(switched.stale).toBe(false);
  });
  it('does not interpret extra usage or invalid numbers as included quota', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ seven_day: { utilization: '88' }, extra_usage: { utilization: 12 }, seven_day_sonnet: { utilization: 50, resets_at: 'invalid' } }))));
    const { readClaudeSubscriptionUsage } = await import('../../src/handlers/cost.js');
    const result = await readClaudeSubscriptionUsage(); expect(result.sevenDay).toBeNull(); expect(result.windows).toHaveLength(1); expect(result.windows?.[0]?.resetsAt).toBeNull();
  });
});

it('persists last good quota and rate-limit deadline across restart without storing secrets', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kanborg-quota-')); const path = join(root, 'quota.json');
  let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now);
  const fetch = vi.fn().mockResolvedValueOnce(response()).mockResolvedValue(new Response('{}', {status:429, headers:{'retry-after':'2574'}})); vi.stubGlobal('fetch',fetch);
  try {
    let api = await import('../../src/handlers/cost.js'); api.configureClaudeUsageSnapshot(path);
    await api.readClaudeSubscriptionUsage(); now += 301000;
    const limited = await api.readClaudeSubscriptionUsage();
    expect(limited.sevenDay?.pct).toBe(.88); expect(limited.stale).toBe(true);
    expect(Date.parse(limited.retryAt!) - now).toBe(2574000);
    expect(readFileSync(path,'utf8')).not.toContain(fixture.token);
    vi.resetModules(); api = await import('../../src/handlers/cost.js'); api.configureClaudeUsageSnapshot(path);
    await api.readClaudeSubscriptionUsage(); expect(fetch).toHaveBeenCalledTimes(2);
    now += 2574001; await api.readClaudeSubscriptionUsage(); expect(fetch).toHaveBeenCalledTimes(3);
  } finally { rmSync(root,{recursive:true,force:true}); }
});
it('an empty response cannot replace a previous valid quota with unknown values', async () => {
  let now=Date.now(); vi.spyOn(Date,'now').mockImplementation(()=>now);
  vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(response()).mockResolvedValue(new Response('{}')));
  const api=await import('../../src/handlers/cost.js'); await api.readClaudeSubscriptionUsage(); now+=301000;
  const result=await api.readClaudeSubscriptionUsage(); expect(result.sevenDay?.pct).toBe(.88); expect(result.stale).toBe(true);
});

it('expired credentials require recovery without sending doomed usage requests', async () => {
  fixture.expiresAt=Date.now()-1000;
  const fetch=vi.fn(); vi.stubGlobal('fetch',fetch);
  const api=await import('../../src/handlers/cost.js');
  const result=await api.readClaudeSubscriptionUsage();
  expect(result.source).toBe('unauthorized'); expect(fetch).not.toHaveBeenCalled();
  expect(await api.claudeSignInNeedsRefresh()).toBe(true);
  fixture.token='renewed'; fixture.expiresAt=Date.now()+3600000;
  fetch.mockResolvedValue(response());
  expect((await api.readClaudeSubscriptionUsage()).source).toBe('oauth');
  expect(await api.claudeSignInNeedsRefresh()).toBe(false);
});
it('credential changes cannot bypass a provider rate-limit cooldown', async () => {
  const fetch=vi.fn().mockResolvedValue(new Response('{}',{status:429,headers:{'retry-after':'3600'}}));vi.stubGlobal('fetch',fetch);
  const api=await import('../../src/handlers/cost.js');
  await api.readClaudeSubscriptionUsage(); fixture.token='rotated';
  const result=await api.readClaudeSubscriptionUsage();
  expect(fetch).toHaveBeenCalledTimes(1);expect(result.retryAt).toBeDefined();expect(result.sevenDay).toBeNull();
});

it('a late response from the previous sign-in cannot replace the new snapshot', async () => {
  let finishFirst!: (value: Response) => void;
  const fetch=vi.fn().mockImplementationOnce(()=>new Promise<Response>(resolve=>{finishFirst=resolve;})).mockResolvedValue(response());
  vi.stubGlobal('fetch',fetch);
  const api=await import('../../src/handlers/cost.js');
  const first=api.readClaudeSubscriptionUsage();
  await vi.waitFor(()=>expect(fetch).toHaveBeenCalledTimes(1));
  fixture.token='new-account'; await api.readClaudeSubscriptionUsage();
  finishFirst(new Response(JSON.stringify({seven_day:{utilization:12}}))); await first;
  expect((await api.readClaudeSubscriptionUsage()).sevenDay?.pct).toBe(.88);
  expect(fetch).toHaveBeenCalledTimes(2);
});
it('negative utilization does not become a fresh unused allowance', async () => {
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({seven_day:{utilization:-1}}))));
  const api=await import('../../src/handlers/cost.js');
  expect((await api.readClaudeSubscriptionUsage()).source).toBe('unavailable');
});

it('uses the exact CLI Keychain account and preserves quota through same-account token renewal', async () => {
  fixture.account='account-a';
  const fetch=vi.fn().mockResolvedValueOnce(response()).mockRejectedValue(new Error('offline')); vi.stubGlobal('fetch',fetch);
  const api=await import('../../src/handlers/cost.js');
  await api.readClaudeSubscriptionUsage(); fixture.token='renewed-token';
  const result=await api.readClaudeSubscriptionUsage();
  expect(result.sevenDay?.pct).toBe(.88); expect(result.stale).toBe(true);
  if(process.platform==='darwin') expect(fixture.keychain.mock.calls[0]![0]).toEqual(expect.arrayContaining(['-a',process.env.USER,'-s','Claude Code-credentials']));
  fixture.account='account-b'; fixture.token='different-account-token';
  expect((await api.readClaudeSubscriptionUsage()).sevenDay).toBeNull();
});
it('matches a custom CLI Keychain service rather than silently selecting the default account', async () => {
  vi.stubEnv('CLAUDE_CONFIG_DIR','/tmp/synthetic-claude-profile');
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response()));
  const api=await import('../../src/handlers/cost.js'); await api.readClaudeSubscriptionUsage();
  if(process.platform==='darwin') expect(fixture.keychain.mock.calls[0]![0].join(' ')).toMatch(/Claude Code-credentials-[a-f0-9]{8}/);
});

it('retains account quota across both restart and token rotation during an outage', async()=>{
 const root=mkdtempSync(join(tmpdir(),'kanborg-renewal-')); fixture.account='same-account';
 try {
  const path=join(root,'quota.json'); vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(response()).mockRejectedValue(new Error('offline')));
  let api=await import('../../src/handlers/cost.js'); api.configureClaudeUsageSnapshot(path); await api.readClaudeSubscriptionUsage();
  fixture.token='new-after-restart'; vi.resetModules(); api=await import('../../src/handlers/cost.js'); api.configureClaudeUsageSnapshot(path);
  const result=await api.readClaudeSubscriptionUsage();expect(result.sevenDay?.pct).toBe(.88);expect(result.stale).toBe(true);
  expect(readFileSync(path,'utf8')).not.toContain(fixture.token);
 }finally{rmSync(root,{recursive:true,force:true});}
});
