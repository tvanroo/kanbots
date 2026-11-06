import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { getBridge } from '../desktop-bridge.js';
import { api } from '../api.js';
import { Logo } from './Logo.js';
import type {
  CostBreakdownItem,
  CostTimeSeriesPoint,
  PersonaModelRollupRow,
} from '@kanborg/api';

export interface StatsProps {
  onClose?: () => void;
}

interface StatsData {
  capacity?: import('@kanborg/api').CapacitySnapshot | undefined;
  todayUsd: number;
  breakdown: CostBreakdownItem[];
  series: CostTimeSeriesPoint[];
  rollup: PersonaModelRollupRow[];
}

function providerShortLabel(provider: string): string {
  switch (provider) {
    case 'claude-code':
      return 'Claude';
    case 'codex-cli':
      return 'Codex';
    case 'gemini-cli':
      return 'Gemini';
    case 'amp-cli':
      return 'Amp';
    case 'cursor-cli':
      return 'Cursor';
    case 'copilot-cli':
      return 'Copilot';
    case 'opencode-cli':
      return 'OpenCode';
    case 'droid-cli':
      return 'Droid';
    case 'ccr-cli':
      return 'CCR';
    case 'qwen-cli':
      return 'Qwen';
    case 'acp':
      return 'ACP';
    default:
      return provider;
  }
}

export function Stats({ onClose }: StatsProps) {
  const [data, setData] = useState<StatsData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const since14d = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
        const [today, breakdown, series, rollup, capacity] = await Promise.all([
          api.costToday(),
          api.costBreakdown(),
          api.costTimeSeries({ sinceTs: since14d }),
          api.costRollup(),
          getBridge()?.capacity?.(),
        ]);
        if (cancelled) return;
        setData({
          capacity,
          todayUsd: today.totalUsd,
          breakdown,
          series,
          rollup,
        });
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose?.();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="kb-modal-scrim kb-app"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Stats and cost"
    >
      <div className="kb-modal kb-stats-modal" onClick={(e) => e.stopPropagation()}>
        <div className="kb-modal-head">
          <Logo size={11} withWordmark />
          <span style={{ color: 'var(--ink-4)' }}>·</span>
          <h2>Usage &amp; funding</h2>
          <span className="grow" />
          <button
            type="button"
            className="x-btn"
            onClick={onClose}
            aria-label="Close (Esc)"
            title="Close"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M6 6l12 12M18 6l-12 12" />
            </svg>
          </button>
        </div>

        <div className="kb-stats-body">
          {error ? (
            <div className="kb-stats-error" role="alert">
              {error}
            </div>
          ) : data === null ? (
            <div className="kb-stats-loading">Loading cost data…</div>
          ) : (
            <StatsContent data={data} />
          )}
        </div>

        <div className="kb-modal-foot">
          <span className="kb-stats-foot-hint">
            Reads <code>.kanbots/db.sqlite</code> · all data stays on this machine.
          </span>
          <span className="grow" />
          <button type="button" className="kb-btn ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

function StatsContent({ data }: { data: StatsData }): React.ReactElement {
 const charges=data.capacity?.routing.apiUsage??[];
 const total=(funding:string)=>charges.filter(c=>!c.pending&&c.funding===funding).reduce((n,c)=>n+c.usd,0);
 const unknown=total('unknown');
 const subscriptions=data.capacity?.rows.filter(r=>r.kind==='subscription')??[];
 return <>
  <section className="kb-stats-section"><h3>Subscription usage</h3>
  {subscriptions.length?subscriptions.map(r=><div className="kb-api-card" key={r.id}><strong>{r.label}</strong><p>{r.usedPercent===null?'Quota unavailable':`${Math.round(r.usedPercent)}% quota used`}</p><p className="kb-provider-desc">{r.detail}</p></div>):<p>Subscription quota is unavailable.</p>}
  </section>
  <section className="kb-stats-section"><h3>API usage through KanBorg</h3>
  <div className="kb-stats-summary"><SummaryCard label="Pay-as-you-go" value={data.capacity?fmtUsd(total('paid')):'—'} sub="Recorded paid API usage"/><SummaryCard label="Grant consumption" value={data.capacity?fmtUsd(total('grant')):'—'} sub="Recorded API grant usage"/>{unknown>0?<SummaryCard label="Earlier API usage" value={fmtUsd(unknown)} sub="Funding source was not recorded"/>:null}</div>
  <p className="kb-provider-desc">All recorded API usage on this Mac. Subscription price estimates are excluded. Provider invoices remain authoritative.</p>
  {charges.some(c=>c.pending)?<p>Some API requests are pending; their final usage is not yet known.</p>:null}
  </section>
  {data.rollup.length?<section className="kb-stats-section"><h3>Runs by model</h3><RollupTable rows={[...data.rollup].sort((a,b)=>b.runs-a.runs).slice(0,8)}/></section>:null}
 </>;
}

// ---------------------------------------------------------------------------
// Summary cards
// ---------------------------------------------------------------------------

function SummaryCard({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
}): React.ReactElement {
  return (
    <div className={`kb-stats-summary-card${accent ? ' is-accent' : ''}`}>
      <span className="kb-stats-summary-label">{label}</span>
      <span className="kb-stats-summary-value">{value}</span>
      {sub ? <span className="kb-stats-summary-sub">{sub}</span> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Spark bars
// ---------------------------------------------------------------------------

function SparkBars({ series }: { series: CostTimeSeriesPoint[] }): React.ReactElement {
  const max = Math.max(0.0001, ...series.map((p) => p.totalCostUsd));
  return (
    <>
      <div className="kb-stats-spark" role="img" aria-label="Daily spend over last 14 days">
        {series.map((p) => {
          const pct = (p.totalCostUsd / max) * 100;
          const empty = p.totalCostUsd === 0;
          const date = new Date(p.bucketDate);
          const label = `${date.toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric',
          })}: ${fmtUsd(p.totalCostUsd)} · ${p.runs} run${p.runs === 1 ? '' : 's'}`;
          return (
            <div
              key={p.bucketDate}
              className={`kb-stats-spark-bar${empty ? ' is-empty' : ''}`}
              style={{ height: `${Math.max(pct, empty ? 6 : 8)}%` }}
              title={label}
              aria-label={label}
            />
          );
        })}
      </div>
      <div className="kb-stats-spark-axis">
        <span>{formatShortDate(series[0]?.bucketDate)}</span>
        <span>today</span>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Breakdown rows
// ---------------------------------------------------------------------------

function BreakdownRows({ items }: { items: CostBreakdownItem[] }): React.ReactElement {
  const max = Math.max(0.0001, ...items.map((i) => i.totalUsd));
  return (
    <div className="kb-stats-rows">
      {items.map((item) => {
        const pct = (item.totalUsd / max) * 100;
        return (
          <div className="kb-stats-row" key={`${item.workspace}-${item.provider}`}>
            <div className="kb-stats-row-label">
              <span className="kb-stats-row-label-name" title={item.workspace}>
                {item.workspace}
              </span>
            </div>
            <ProviderChip provider={item.provider} />
            <div className="kb-stats-bar-track" aria-hidden>
              <div className="kb-stats-bar-fill" style={{ width: `${pct}%` }} />
            </div>
            <span className="kb-stats-row-amount">{fmtUsd(item.totalUsd)}</span>
          </div>
        );
      })}
    </div>
  );
}

function ProviderChip({ provider }: { provider: string }): React.ReactElement {
  const cls =
    provider === 'codex-cli'
      ? 'is-codex'
      : provider === 'gemini-cli'
        ? 'is-gemini'
        : provider === 'amp-cli'
          ? 'is-amp'
          : provider === 'cursor-cli'
            ? 'is-cursor'
            : provider === 'copilot-cli'
              ? 'is-copilot'
              : provider === 'opencode-cli'
                ? 'is-opencode'
                : provider === 'droid-cli'
                  ? 'is-droid'
                  : provider === 'ccr-cli'
                    ? 'is-ccr'
                    : provider === 'qwen-cli'
                      ? 'is-qwen'
                      : provider === 'acp'
                        ? 'is-acp'
                        : provider === 'unknown' || provider === ''
                          ? 'is-unknown'
                          : '';
  const label = providerShortLabel(provider) || provider || 'unknown';
  return <span className={`kb-stats-provider-chip ${cls}`}>{label}</span>;
}

// ---------------------------------------------------------------------------
// Rollup table
// ---------------------------------------------------------------------------

function RollupTable({ rows }: { rows: PersonaModelRollupRow[] }): React.ReactElement {
  return (
    <table className="kb-stats-table">
      <thead>
        <tr>
          <th>Persona</th>
          <th>Model</th>
          <th className="num">Runs</th>
          
          
          <th className="num">Success</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const successPct = Math.round(r.successRate * 100);
          const successCls = successPct >= 75 ? '' : successPct >= 40 ? 'is-low' : 'is-warn';
          return (
            <tr key={`${r.personaId}-${r.model ?? '?'}-${r.provider ?? '?'}`}>
              <td className="persona">{personaLabel(r.personaId)}</td>
              <td className="muted">
                {r.provider === 'codex-cli' && r.model?.startsWith('claude-') ? 'Model not recorded (legacy)' : r.model ?? 'Provider default (not reported)'}
                {r.provider ? (
                  <span style={{ marginLeft: 6, color: 'var(--ink-4)' }}>
                    · {providerShortLabel(r.provider)}
                  </span>
                ) : null}
              </td>
              <td className="num">{r.runs}</td>
              
              
              <td className="num">
                <span className={`success-rate ${successCls}`}>
                  <span className="dot" />
                  {successPct}%
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return '$0.00';
  if (n >= 1000) return `$${n.toFixed(0)}`;
  if (n >= 10) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(2)}`;
}

function formatNumber(n: number): string {
  return new Intl.NumberFormat().format(n);
}

function sumLastNDays(series: CostTimeSeriesPoint[], days: number): number {
  return series.slice(-days).reduce((acc, p) => acc + p.totalCostUsd, 0);
}

function fmtRunsHint(series: CostTimeSeriesPoint[], days: number): string {
  const runs = series.slice(-days).reduce((acc, p) => acc + p.runs, 0);
  return `${formatNumber(runs)} run${runs === 1 ? '' : 's'}`;
}

function maxValue(series: CostTimeSeriesPoint[]): number {
  return series.reduce((acc, p) => Math.max(acc, p.totalCostUsd), 0);
}

function paddedSeries(series: CostTimeSeriesPoint[], days: number): CostTimeSeriesPoint[] {
  // The handler only returns days that had runs. Pad backward so the bar
  // chart always shows N days in chronological order, with zero-runs days
  // rendered as empty bars.
  const byDate = new Map(series.map((p) => [p.bucketDate, p]));
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const out: CostTimeSeriesPoint[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    const iso = d.toISOString().slice(0, 10);
    const existing = byDate.get(iso);
    if (existing) {
      out.push(existing);
    } else {
      out.push({ bucketDate: iso, runs: 0, totalCostUsd: 0, successRate: 0 });
    }
  }
  return out;
}

function formatShortDate(iso: string | undefined): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function personaLabel(personaId: string): string {
  if (personaId.startsWith('builtin:')) {
    const name = personaId.slice('builtin:'.length).replace(/-/g, ' ');
    return name.replace(/\b\w/g, (m) => m.toUpperCase());
  }
  if (personaId.startsWith('custom:')) return 'Custom';
  return personaId || '—';
}
