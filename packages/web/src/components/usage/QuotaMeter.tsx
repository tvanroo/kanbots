/** All quota bars fill left-to-right with consumption: empty = 0% used. */
export function QuotaMeter({ usedPercent, label }: { usedPercent: number; label: string }) {
  const used = Number.isFinite(usedPercent) ? Math.max(0, Math.min(100, usedPercent)) : null;
  if (used === null) return <span>Usage not reported</span>;
  return <span className={`kb-usage-meter tone-${used >= 90 ? 'danger' : used >= 70 ? 'warn' : 'ok'}`}>
    <span className="kb-usage-bar" role="meter" aria-label={`${label} used`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={used} aria-valuetext={`${Number(used.toFixed(1))}% quota used`} title="0% quota used on the left · 100% quota used on the right"><span className="kb-usage-bar-fill" style={{ width: `${used}%`, left: 0, right: 'auto' }} /></span>
    <span className="kb-usage-pct">{Number(used.toFixed(1))}% quota used</span>
  </span>;
}
