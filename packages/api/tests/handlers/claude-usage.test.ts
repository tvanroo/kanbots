import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ token: 'synthetic-a', keychain: vi.fn(), file: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: (...args: unknown[]) => {
  fixture.keychain();
  (args[3] as (error: null, value: string) => void)(null, JSON.stringify({ claudeAiOauth: { accessToken: fixture.token } }));
} }));
vi.mock('node:fs/promises', () => ({ readFile: async () => { fixture.file(); return JSON.stringify({ claudeAiOauth: { accessToken: fixture.token } }); } }));

beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); vi.stubEnv('CLAUDE_CONFIG_DIR', ''); fixture.token = 'synthetic-a'; });
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
    await readClaudeSubscriptionUsage(); now += 61000;
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
