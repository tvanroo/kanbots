// Retention for coordinator state that otherwise grows without bound and is
// walked on every 3 s tick and rewritten on every save.
//
// - Coordinator requests that a coordinator acknowledged ("received") but never
//   completed are completed after REQUEST_EXPIRY_MS. Their prompt text, the bulk
//   of each entry, is dropped; the entry, id and state remain, so anything that
//   looks a request up by id still sees it as completed.
// - Jobs whose card is fully finished move to an append-only archive file once
//   their runs ended more than JOB_ARCHIVE_AGE_MS ago. The coordinator restores
//   an archived job when a tool or the UI asks about one of its runs.

export const REQUEST_EXPIRY_MS = 24 * 60 * 60 * 1000;
export const JOB_ARCHIVE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const EXPIRED_REQUEST_NOTE =
  'Completed automatically: received more than 24 hours earlier and never marked completed.';

/** Job states the coordinator already treats as finished (Autopilot does not continue them). */
const FINISHED_JOB_STATES = new Set(['qa-passed', 'review-delegated', 'completed']);
const SETTLED_RELEASE_STATES = new Set(['completed', 'failed', 'declined', 'cancelled', 'superseded']);
/** Stage-assignment states that still need the card's jobs. */
const OPEN_ASSIGNMENT_STATES = new Set(['queued', 'starting', 'blocked']);

type RequestLike = { state: string; createdAt: string; prompt: string; error?: string; expiredAt?: string };

/** Completes stale "received" requests in place. Returns how many changed. */
export function expireStaleRequests(requests: RequestLike[] | undefined, now = Date.now()): number {
  let expired = 0;
  for (const request of requests ?? []) {
    if (request.state !== 'received') continue;
    const created = Date.parse(request.createdAt);
    if (!Number.isFinite(created) || now - created < REQUEST_EXPIRY_MS) continue;
    request.state = 'completed';
    request.prompt = '';
    request.error = EXPIRED_REQUEST_NOTE;
    request.expiredAt = new Date(now).toISOString();
    expired++;
  }
  return expired;
}

type JobLike = { runId: number; reviewRunId?: number; number: number; state: string };
type WorkspaceLike<J extends JobLike> = {
  jobs: J[];
  queue?: Array<{ number: number }>;
  releases?: Array<{ runId: number; state: string }>;
  questions?: Array<{ runId: number; state: string }>;
  stageAssignments?: Record<string, { number: number; state: string }>;
  dispatchReservations?: Record<string, unknown>;
};

/**
 * Jobs that can leave the live registry: every job for the card is finished,
 * all of their runs ended before the cutoff, and nothing open (queue, release,
 * question, stage assignment or dispatch reservation) refers to the card or its
 * runs. `runEndedAt` returns a run's end time in ms, or null while it is active
 * or unknown.
 */
export function selectArchivableJobs<J extends JobLike>(
  w: WorkspaceLike<J>,
  runEndedAt: (runId: number) => number | null,
  now = Date.now(),
): J[] {
  const cutoff = now - JOB_ARCHIVE_AGE_MS;
  const busyCards = new Set<number>();
  const busyRuns = new Set<number>();
  for (const q of w.queue ?? []) busyCards.add(q.number);
  for (const r of w.releases ?? []) if (!SETTLED_RELEASE_STATES.has(r.state)) busyRuns.add(r.runId);
  for (const q of w.questions ?? []) if (q.state === 'pending' || q.state === 'sending') busyRuns.add(q.runId);
  for (const a of Object.values(w.stageAssignments ?? {})) if (OPEN_ASSIGNMENT_STATES.has(a.state)) busyCards.add(a.number);
  for (const number of Object.keys(w.dispatchReservations ?? {})) busyCards.add(Number(number));
  const ready = (j: J) =>
    FINISHED_JOB_STATES.has(j.state) &&
    [j.runId, ...(j.reviewRunId === undefined ? [] : [j.reviewRunId])].every((id) => {
      if (busyRuns.has(id)) return false;
      const ended = runEndedAt(id);
      return ended !== null && ended <= cutoff;
    });
  const byCard = new Map<number, J[]>();
  for (const j of w.jobs) byCard.set(j.number, [...(byCard.get(j.number) ?? []), j]);
  const out: J[] = [];
  for (const [number, jobs] of byCard) {
    if (busyCards.has(number) || !jobs.every(ready)) continue;
    out.push(...jobs);
  }
  return out;
}
