export interface WorkspaceCostMeterProps {
  /** Sum of `totalCostUsd` across runs that started since midnight (local).
   *  Pass null while the first fetch is in flight so the meter renders an
   *  unobtrusive placeholder rather than flashing "$0.00". */
  totalUsd: number | null;
  /** Optional click handler — wires the meter to "Stats & cost" so users
   *  can drill into a breakdown. Omit to render a static, non-clickable
   *  meter (e.g. in a read-only context). */
  onClick?: (() => void) | undefined;
}

/**
 * Compact workspace-wide cost rollup that lives in the board toolbar
 * next to the Autopilot / New task buttons. Reads from the existing
 * `cost:today` data source (sum of `total_cost_usd` across every agent
 * run since midnight), so it doesn't introduce a new schema or polling
 * cadence — the parent Board page already refreshes the value.
 *
 * When `totalUsd` is exactly zero the meter is dimmed so the toolbar
 * doesn't shout at the user before they've burned any spend; once any
 * cost has accumulated the value lights up in the clay accent.
 */
export function WorkspaceCostMeter({ totalUsd, onClick }: WorkspaceCostMeterProps) {
  const empty = totalUsd === null;
  const zero = totalUsd === 0;
  const display = 'Usage';
  const title = 'Subscription quota and API funding';
  const className =
    `kb-cost-meter${empty ? ' is-empty' : zero ? ' is-zero' : ''}` +
    (onClick ? ' is-clickable' : '');
  if (onClick) {
    return (
      <button
        type="button"
        className={className}
        onClick={onClick}
        title={title}
        aria-label={title}
      >
        <span className="kb-cost-meter-amount">{display}</span>
        
      </button>
    );
  }
  return (
    <div className={className} title={title} aria-label={title}>
      <span className="kb-cost-meter-amount">{display}</span>
      
    </div>
  );
}
