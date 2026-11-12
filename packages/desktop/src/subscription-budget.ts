/** Percentages have different denominators: never add model and total usage. */
export type BudgetWindow = { id: string; pct: number; resetsAt: string | null };
export function subscriptionBudget(windows: BudgetWindow[], modelFamily?: string) {
  const shared = windows.filter(w => w.id === 'five_hour' || w.id === 'seven_day');
  const model = modelFamily ? windows.filter(w => w.id === `five_hour_${modelFamily}` || w.id === `seven_day_${modelFamily}`) : [];
  const valid = (w: BudgetWindow) => Number.isFinite(w.pct) && w.pct >= 0 && w.pct <= 1;
  const applicable = [...shared, ...model];
  return {
    known: shared.length > 0 && applicable.every(valid),
    // All applicable constraints must have room; a model allowance is a subset.
    headroomPercent: shared.length && applicable.every(valid) ? Math.min(...applicable.map(w => (1 - w.pct) * 100)) : null,
    totalUsedPercent: shared.length && shared.every(valid) ? Math.max(...shared.map(w => w.pct * 100)) : null,
    modelUsedPercent: model.length && model.every(valid) ? Math.max(...model.map(w => w.pct * 100)) : null,
    // Scheduling urgency comes only from the shared subscription windows.
    resetAt: shared.map(w => w.resetsAt ? Date.parse(w.resetsAt) : NaN).filter(Number.isFinite).sort((a,b)=>a-b)[0] ?? null,
  };
}
