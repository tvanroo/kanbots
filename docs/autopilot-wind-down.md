# Autopilot wind-down contract

Owner specification, 2026-11-05. Implemented in 1.2.21; this document does not change a live setting.

## Shared controls

The app and coordinator tools use the same persisted controls. On permits discovery and dispatch within the objective and limits. Off synchronously disables new discovery, assignments and replacement work. Existing work may finish; review, merge and deployment remain available under their existing authorization rules.

Display Off as “Winding down · N tasks remaining” while owned workers are active, then “Off”. Track Autopilot ownership explicitly rather than counting unrelated manual work. Queued work must not start while Off.

Expedite wind-down requests each active worker to finish its current bounded step, save its work and return a compact checkpoint. Track requested, acknowledged and checkpointed states per worker. Do not infer acknowledgment from sending a request. Avoid additional implementation or broad validation; record unfinished validation without weakening tests or release requirements.

Stop now is a separate explicit per-worker action. Preserve artifacts and mark interrupted—recovery needed, never completed. It is not the default consequence of Off or Expedite.

## Updates and recovery

Installing an update enters the same wind-down barrier before restarting. Disable replacement assignments and wait for workers to finish or checkpoint. An unresponsive worker requires the explicit Stop now action rather than a silent timeout kill.

Persist the toggle, drain reason, worker/run identities, pending requests, acknowledgment state and checkpoint references. After restart reconcile existing processes and durable run records before resuming; never duplicate workers. Restore Off as Off. Resume remaining work through coordinator controls, retaining the prior intended setting separately from an update-induced drain.

## Implementation requirements

- Add assignment provenance to dispatch and queued jobs so Off blocks only Autopilot production, including automatic rework/replacement paths.
- Use a shared service for app, MCP and updater transitions, with atomic persisted state before acknowledging Off.
- Keep a stable operation identifier for expedited checkpoint requests and retry delivery without duplicate work.
- Derive remaining count from real worker state. Completion and checkpoint are distinct from successful validation.
- Keep checkpoints compact: current objective, branch/worktree, completed work, evidence, unfinished checks and next bounded step.
- Coordinator chat must save through the tool and read back state before claiming the change.

## Acceptance checks

1. Off during three active tasks immediately prevents new and replacement dispatch, shows three remaining, then decreases to zero as workers finish.
2. Completed work remains reviewable and releasable while Off.
3. Expedite shows actual acknowledgments and checkpoints; interrupted validation remains visible.
4. Stop now preserves work and records recovery needed.
5. Update/restart during wind-down restores identities, settings and checkpoints without duplicate tasks.
6. App and coordinator chat observe identical saved state.

## Delivery and compatibility

Expedite uses a per-worker cooperative control file checked between bounded steps. Only a matching worker response counts as acknowledgment. An in-flight tool or unresponsive worker is not forcibly interrupted by Expedite. Older workers without this protocol show that they must finish normally or be stopped explicitly. Checkpoints are copied into the durable coordination registry before restart. They do not waive remaining validation.
