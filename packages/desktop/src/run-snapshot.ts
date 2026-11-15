// The coordinator publishes a 'runs-changed' event whenever the compact state of
// its jobs changes. Publishing every job each time made each event as large as
// the whole job list (~370 KB at ~1,250 jobs), and because every event is kept
// in coordinators.json and the file is rewritten on each save, the registry grew
// past 100 MB and saves alone saturated the main thread. Events now carry only
// the entries that changed since the previous snapshot.

type Entry = { run?: { runId?: number } | null } & Record<string, unknown>;
type StoredEvent = { type: string; data: unknown };

const entryKey = (entry: Entry, index: number) =>
  typeof entry?.run?.runId === 'number' ? 'run:' + entry.run.runId : 'index:' + index;

function index(entries: Entry[]) {
  const out = new Map<string, string>();
  entries.forEach((entry, i) => out.set(entryKey(entry, i), JSON.stringify(entry)));
  return out;
}

/** Entries of `next` that differ from (or are missing in) the previous serialized snapshot. */
export function changedRunEntries<T extends Entry>(previousSnapshot: string | undefined, next: T[]): T[] {
  let previous: Entry[] | null = null;
  if (previousSnapshot) {
    try {
      const parsed = JSON.parse(previousSnapshot);
      if (Array.isArray(parsed)) previous = parsed;
    } catch { /* An unreadable snapshot publishes the full state once. */ }
  }
  if (!previous) return next;
  const before = index(previous);
  return next.filter((entry, i) => before.get(entryKey(entry, i)) !== JSON.stringify(entry));
}

/**
 * Rewrites stored full-snapshot 'runs-changed' events into deltas, in place.
 * The oldest retained event keeps its full list as the baseline. Returns true if
 * anything changed. Callers mark the workspace so this runs once.
 */
export function compactRunsChangedEvents(events: StoredEvent[]): boolean {
  let baseline: Map<string, string> | null = null;
  let changed = false;
  for (const event of events) {
    if (event.type !== 'runs-changed' || !Array.isArray(event.data)) continue;
    const entries = event.data as Entry[];
    const current = index(entries);
    if (baseline) {
      const seen = baseline;
      const delta = entries.filter((entry, i) => seen.get(entryKey(entry, i)) !== JSON.stringify(entry));
      if (delta.length !== entries.length) { event.data = delta; changed = true; }
      for (const [key, value] of current) seen.set(key, value);
    } else baseline = current;
  }
  return changed;
}
