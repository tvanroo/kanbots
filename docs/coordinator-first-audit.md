# Coordinator-first audit — 1.2.20

## Principle

Preserve useful product features. The active coordinator owns prioritization, assignments, ordinary decisions and reporting. KanBorg executes and records. The owner can still act directly; those actions must be attributed, reconciled and reported so the coordinator never repeats or contradicts them. Host permissions and owner-reserved release actions remain separate.

This is a source audit of the local desktop paths. It does not claim live external-harness acceptance or that all findings have been fixed.

## Implemented in 1.2.20

Local Autopilot launches create durable coordinator assignments rather than an independent discovery/dispatch loop. Perspectives, effort, parallelism, objective and status live in the workspace coordination state. Discovery, implementation and QA are delegated through normal routed workers. A missing coordinator uses the built-in one; an external coordinator receives the request at its next check-in. Pause/resume/end controls preserve running workers. Assignment state follows handoff. Starting the new flow stops legacy loops from making further assignments and includes their existing children in the coordinator handoff, without stopping those workers.

Coordinator-led QA is available from the same launch surface. The active coordinator creates/tracks cards, assesses evidence, and reports findings. This is not a new hardcoded testing engine.

Run metadata now clears a previous model when the selected provider reports no model. Historic Claude-model/Codex combinations are labeled unrecorded rather than presented as real model execution. Old records are not rewritten or guessed.

## Remaining findings, in priority order

### P1 — Direct worker actions bypass assignment accounting

TaskCreateModal starts a worker directly; Board bulk dispatch and issue chat/agent handlers have independent start/resume paths. wrapNotifyingSupervisor broadcasts UI refreshes but does not adopt these runs into CoordinatorService.jobs. getWorkspaceSummary and the coordinator's concurrency count principally use that delegated-job list. A user-started worker can therefore be omitted from the coordinator's planning view, and followUpRun refuses a run that is not a delegated implementation.

Keep the controls. Route ordinary requests through the coordinator, and support an explicit owner-directed start/stop path that atomically records/adopts the run and emits a durable event. Count all active work when planning capacity. Preserve direct emergency stop.

Sources: packages/web/src/components/modals/TaskCreateModal.tsx; packages/web/src/pages/Board.tsx; packages/api/src/handlers/issues.ts; packages/api/src/handlers/agent-actions.ts; packages/desktop/src/main.ts wrapNotifyingSupervisor; packages/desktop/src/coordinator.ts dispatch/getWorkspaceSummary/followUpRun.

### P1 — Two release execution paths

Card's Ship action calls shipMerge and may offer to commit changes. handlers/ship.ts performs its own branch checks and merge without going through coordinator release plans and their recorded evidence. CoordinatorService.executeRelease is a different path. A direct user action may be authorized, but it should update the same release record and notify the coordinator.

Keep Ship/PR tools. Use one release service with actor/source attribution, exact revision and target, workflow policy, authorization checks and a durable completion event. Do not add redundant owner approval for already-authorized routine releases.

Sources: packages/web/src/components/Card.tsx; packages/api/src/handlers/ship.ts; packages/desktop/src/coordinator.ts prepareRelease/executeRelease.

### P1 — Delivery acknowledgement can outrun delivery

Built-in tick marks a request received before chat-send succeeds. On dispatchError it records a blocked event but leaves the request received, so the queued-request picker does not retry it. This can stall Autopilot, discovery or update recovery even though the assignment remains saved.

Add delivery states and a durable attempt receipt. Requeue only a confirmed pre-execution failure with bounded backoff; reconcile ambiguous outcomes before retrying. Show a clear retry action for unresolved delivery. Do not blindly resend an accepted message.

Source: packages/desktop/src/coordinator.ts tick.

### P1 — Workflow/card projections can disagree

Custom stage assignments live in the workflow registry; listIssues also returns the source issue's original status/state/labels. The board overlays workflow categories, but older consumers or detail actions can read the original status. workflow-card-updated emits an event without the same durable action request used for worker results.

Publish a single effective stage/status projection and preserve source status separately for audit. Route direct card edits to a coordinator event/request according to notification policy, without reversing the owner's edit. Completed evidence must remain stable.

Sources: packages/desktop/src/coordinator.ts listIssues/workflowAction; packages/web/src/pages/Board.tsx workflowIssues; packages/web/src/components/modals/TaskDetailModal.tsx.

### P2 — Legacy model helpers remain outside routing

Feature suggestions, issue drafting and PR descriptions still use createComposer/createSuggester/createPrDescriptionDrafter. The suggester defaults to Claude when no provider is supplied; this is separate from the shared worker router. The new local Autopilot flow avoids that path, and the perspective picker now queues a one-time review with the coordinator. Issue drafting and PR-description helpers still need the shared routing integration. ModelPicker also retains static defaults for several providers.

Preserve drafting, ideation and persona features. Turn them into routed, bounded assignments with results delivered to the initiating surface and durable coordinator context. Replace stale picker defaults with automatic routing/provider-reported choices. Do not infer the provider/model from a requested preference.

Sources: packages/desktop/src/main.ts createComposer/createSuggester/createPrDescriptionDrafter; packages/dispatcher/src/composer.ts; packages/web/src/components/forms/ModelPicker.tsx; packages/web/src/pages/Board.tsx suggestFeature.

### P2 — Decision attribution and reconciliation are split

Card, tray, task detail and chat resolve cards directly. Coordinator answerDecision adds a separate decision record before invoking the same card handler. The card handler always writes 'User chose', even for a coordinator-originated resolution. A resolution is stored before the worker resume succeeds, leaving retry/receipt semantics unclear on failure.

Keep direct answers. One decision receipt should capture actor (owner/coordinator), source, authorized scope, selected value, and resume delivery state. All surfaces should resolve that same decision, notify the coordinator once and avoid a second question.

Sources: packages/api/src/handlers/cards.ts resolve; packages/desktop/src/coordinator.ts answerDecision; packages/web/src/components/tray/Tray.tsx; packages/web/src/pages/ChatApp.tsx.

### P2 — General chat competes with project coordination

Standalone chat is a useful separate conversation, but it can start tools/work independently and looks similar to the project coordinator. Tool/run state does not automatically become coordinator state. Do not remove general chat: identify it as a working conversation and offer 'Send to coordinator' or 'Delegate through coordinator'. Make the project coordinator the default project-level contact.

Sources: packages/web/src/pages/ChatApp.tsx; packages/api/src/handlers/chat.ts; packages/web/src/components/board/BoardUsageRow.tsx.

### P2 — Schedule and background execution expectations need one visible status

Handoff tracks retired schedules and requires harness confirmation; an MCP server cannot wake an idle arbitrary harness. Autopilot should show queued/received/working/blocked status based on request/run receipts rather than only active assignment intent. Keep a single workspace reminder; do not create a second Autopilot schedule. The built-in coordinator needs reliable delivery before it can claim unattended continuation.

Sources: packages/desktop/src/coordinator.ts checkinPolicy/handoff/tick; packages/web/src/components/modals/AutopilotLaunchModal.tsx.

## Features to retain and align

| Feature | Desired relationship |
| --- | --- |
| Autopilot and personas | Coordinator-owned ongoing assignment; routed discovery and workers |
| Board/task creation | Fast capture; coordinator prioritization; explicit owner overrides recorded |
| Worker start/stop/resume | Unified ownership and receipts; direct emergency control preserved |
| QA and previews | Evidence-producing tools usable by coordinator and owner; results linked to the same card |
| Ship and PR actions | Shared release records and policy; owner action stays possible |
| General chat | Retained working conversations, clearly distinguished from project coordinator |
| Usage/capacity/routing | Execution service chooses eligible funding; coordinator receives rationale and blockers |
| Workflow editor | Same versioned authority in app and MCP; consistent projections everywhere |
| Updates and restart | Preserve assignments, recover workers, deliver one acknowledged coordinator resume request |
| Notifications/reminders | One coordinator-facing event/request stream; meaningful owner updates |

## Recommended implementation sequence

1. Add shared action receipts and coordinator adoption for direct worker actions, decisions and release actions.
2. Repair delivery acknowledgement/recovery and expose authoritative queued/received/working/blocked status.
3. Unify effective workflow status across board, detail and MCP.
4. Move legacy drafting/ideation helpers to routed assignments; clarify general-chat delegation.
5. Verify the same paths with built-in coordination and an external harness, including handoff while work is running.

Keep already-authorized reversible operations fast. These integrations must not turn the coordinator into another approval dialog or remove owner control.

## Inherited hosted product removal

The local desktop no longer registers the parent product's cloud account, hosted workspace, remote run, or billing/account handlers. Startup does not read or refresh its account session. The renderer no longer imports its sign-in prompt, cloud settings or hosted project picker. Existing on-disk records are retained untouched; provider subscriptions, API connections, local projects and update identity are unchanged. Legacy cloud source modules remain disconnected for a separate future cleanup/design, not as active product features.
