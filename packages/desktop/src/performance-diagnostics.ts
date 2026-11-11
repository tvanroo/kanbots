import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { app, ipcMain } from 'electron';

/** Bounded numeric aggregates only. Never record arguments, responses or error text. */
export class PerformanceCounters {
  private rows = new Map<string, { count: number; totalMs: number; maxMs: number; slow: number; failures: number }>();
  record(name: string, ms: number, failed = false) {
    if (!Number.isFinite(ms) || ms < 0) return;
    if (!this.rows.has(name) && this.rows.size >= 256) name = 'other';
    const row = this.rows.get(name) ?? { count: 0, totalMs: 0, maxMs: 0, slow: 0, failures: 0 };
    row.count++; row.totalMs += ms; row.maxMs = Math.max(row.maxMs, ms);
    if (ms >= 100) row.slow++; if (failed) row.failures++;
    this.rows.set(name, row);
  }
  drain() { const rows = Object.fromEntries(this.rows); this.rows.clear(); return rows; }
}

let activeCounters: PerformanceCounters | undefined;
export function recordPerformanceTiming(name: string, ms: number) { activeCounters?.record(name, ms); }

export function startPerformanceDiagnostics() {
  const directory = join(app.getPath('userData'), 'diagnostics');
  const file = join(directory, 'performance.jsonl');
  const counters = new PerformanceCounters(); activeCounters = counters;
  const lag = monitorEventLoopDelay({ resolution: 20 }); lag.enable();
  const original = ipcMain.handle.bind(ipcMain);
  let inFlight = 0, peak = 0, writing = false;
  ipcMain.handle = (channel, listener) => original(channel, async (event, ...args) => {
    const start = performance.now(); inFlight++; peak = Math.max(peak, inFlight);
    let failed = false;
    try { return await listener(event, ...args); }
    catch (error) { failed = true; throw error; }
    finally { inFlight--; counters.record(channel, performance.now() - start, failed); }
  });
  const allowed = new Set(['renderer-long-task', 'renderer-input-delay', 'renderer-timer-delay']);
  const lastReport = new Map<number, number>();
  ipcMain.on('kanborg:performance', (event, values) => {
    const now = Date.now(); const id = event.sender.id;
    if (now - (lastReport.get(id) ?? 0) < 5000 || !Array.isArray(values)) return;
    if (!lastReport.has(id)) event.sender.once('destroyed', () => lastReport.delete(id));
    lastReport.set(id, now);
    for (const entry of values.slice(0, 3)) {
      if (entry && allowed.has(entry.name) && typeof entry.ms === 'number' && entry.ms <= 60000) counters.record(entry.name, entry.ms);
    }
  });
  const timer = setInterval(() => {
    if (writing) return;
    writing = true;
    const sample = { at: new Date().toISOString(), version: app.getVersion(), pid: process.pid,
      mainLagP99Ms: lag.percentile(99) / 1e6, mainLagMaxMs: lag.max / 1e6,
      mainRssBytes: process.memoryUsage().rss, inFlight, peakInFlight: peak, timings: counters.drain() };
    lag.reset(); peak = inFlight;
    void (async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      if ((await stat(file).catch(() => null))?.size! > 2 * 1024 * 1024) {
        await rename(file, file + '.previous');
      }
      await appendFile(file, JSON.stringify(sample) + '\n', { mode: 0o600 });
    })().catch(() => { /* Diagnostics must never break app operation. */ }).finally(() => { writing = false; });
  }, 10000);
  timer.unref();
  app.once('will-quit', () => { clearInterval(timer); lag.disable(); });
  return directory;
}
