# Independent review and lane maintenance

Owner direction, 2026-11-12:

A separate KanBorg reviewer run is the approved second opinion. The same harness,
provider, model and GitHub account are allowed. The assigned independent reviewer
may review and merge any PR from KanBorg or coordinator workers, including a
coordinator-authored PR, after exact-current-head review, required CI and applicable
release gates. No different-harness requirement, exclusive release-manager approval,
or routine coordinator relay is required. An implementation author cannot self-review.
Record reviewer run identity and exact head evidence, recheck the head before merge,
and preserve explicit unrelated holds. Serialize shared deployment operations;
merge, deployment and functional acceptance remain separate receipts.

The implementation lane setting is a target while Autopilot is On. KanBorg starts
eligible authorized Ready cards directly and checks again on each scheduler tick.
It preserves stage priority, dependency holds, existing assignment ownership and
durable dispatch reservations. A terminal prior assignment can have a new Ready
iteration; a live or checkpointed assignment must be continued or reconciled rather
than duplicated. Missing eligible work is reported explicitly and also sent to the
coordinator for discovery or reconciliation. Turning Off, handoff and update drain
suspend automatic refill.

Review and release workers have a separate persisted `releaseParallelism` limit,
default 4, available in Autopilot, coordinator settings and MCP configureWorkflow /
manageAutopilot. Both assigned stage reviewers and legacy QA reviewers use it.
Implementation workers cannot use these reserved lanes. A waiting worker without
an attached process frees its execution slot while retaining its task and checkpoint.
A live attached wait still occupies a slot. Uncertain starts retain reservations
until reconciled. Review concurrency does not permit concurrent production applies.

Both board summaries use the same filtered-card scope and shared calculation:
running workers, workers awaiting input, and cards waiting on workflow conditions.
A card's dependency/CI wait is not an executing worker.

Signed-in Claude may attempt work when quota reporting is stale or absent. The UI
retains the reading and its uncertainty; it does not infer replenishment. Actual
provider refusal determines the runtime fallback. Model-specific limits remain
separate from the shared subscription pool.

## Goal / reminder text to paste

Continue the authorized KanBorg and CardBox work through implementation, independent
review, merge, deployment and agreed outcome verification. A separate KanBorg
reviewer run is sufficient even using the same harness/model; that reviewer may
review and merge any KanBorg or coordinator worker PR after exact-head review,
required CI and release gates, without coordinator relay or a different-harness
requirement. Never self-review implementation. Honor the current saved implementation
lane target and separate release-worker limit (default 4); old numerical targets
and checkpoint-specific publication restrictions do not become global holds.
Autopilot is currently owner-enabled with target 11. Preserve existing workers,
checkpoints, question 98 and explicit unrelated holds. Keep one production deployment
at a time and distinguish merge, deployment and functional acceptance. Do not
fabricate fresh quota or treat stale Claude telemetry alone as exhaustion. Use
actual provider responses. Preserve the current controller; separately paused
harness schedules are not implicitly resumed by enabling Autopilot.
