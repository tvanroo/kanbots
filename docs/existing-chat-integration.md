# Existing-chat integration (KanBorg 1.2.24)

## CLI adapter integration (unreleased branch)

The desktop now registers `codex-cli-queue-v1` on macOS when the verified ChatGPT-bundled CLI at `/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex` exposes queue/thread/message/resume support. Other installations and remote hosts remain unsupported. Registration does not approve a binding, transfer control or send a message. The owner must approve an exact local-host/existing-chat binding in Activity & settings.

The adapter sends compact allowlisted event references using `execFile` and the documented `codex queue --thread <UUID> --message <text> --resume` interface. No new chat, server, private pipe, user command or endpoint is used. Executable-path process inspection establishes local desktop transport availability; it does not establish receiver readiness or receipt.

A matching queued-message receipt establishes transport acceptance even when resume reports an error. An uncertain result remains unknown; reconciliation never blindly replays it. Stored receipts preserve acceptance but are not live receipt queries. The CLI has no verified caller idempotency-key or status-query option. MCP received/acted acknowledgement remains required. Revocation during preflight prevents spawn, and slow preflight cannot start a child after the queue timeout window.

Evidence: one direct CLI probe previously woke the same idle Codex desktop chat despite a no-daemon resume warning. The integrated branch passes desktop typechecking and 97 desktop tests, including 15 adapter/queue-seam checks. This is not yet a production KanBorg-to-MCP acknowledgement, live handoff or iPhone acceptance result. No live app was restarted or workspace ownership changed by this branch.

Acceptance setup: use a separate test workspace/profile with an owner-approved connection and exact existing plugin chat `01a1b2b3-b96c-7f32-b9aa-77e33d69648d`; keep CardBox untouched. Verify app/runtime compatibility and receiver schemas before an actual event. Test accepted → received → acted, incoming reconciliation and outgoing authority loss, restart/uncertain-send recovery, then continue the same chat from ChatGPT iOS Codex/Remote.

## Implemented interface

The local stdio MCP remains the control channel. `proposeHostBinding` accepts an exact host ID, existing chat ID and adapter ID for the authenticated approved client. The owner approves or revokes it in Activity & settings. Approval is disabled if the adapter is not registered. Binding never transfers control or creates a chat. No arbitrary endpoint, command or private host pipe is accepted.

`CoordinatorService.registerHostAdapter` is the trusted application integration seam. See `coordinator-outbound.ts` for the typed interface. It must be wired by trusted application code against a supported host API; MCP cannot install executable adapter code. Reachability reports available, busy, offline, revoked, unsupported or unknown with an observation timestamp. Send takes only event identity, workspace/client, epoch, kind, cursor and optional handoff reference. No worker text, credentials or transcripts are sent.

`getOutboundEvents` returns the caller's bindings and last 50 events. `acknowledgeWake` records received, then acted with an outcome summary. Acknowledgement does not confer controller authority. `confirmHandoffReconciled` explicitly confirms incoming reconciliation; a summary read no longer marks a handoff accepted. The receiver must read session, workers, decisions and release evidence first.

## Durability and authority

Queue records are persisted in the existing atomically replaced local coordinator registry before transport calls. They include event/target/binding, epoch, cursor, timestamps, attempt count, receipt and status. Routine queued changes coalesce per destination/epoch. Decision and handoff events remain distinct. Delivery attempts use bounded exponential backoff (5 seconds to 5 minutes, six attempts). Adapter calls time out after five seconds. A timeout is uncertain, not undelivered; the next attempt reconciles the SAME event ID before any resend. Only an explicit not-delivered result permits replay. No exactly-once transport claim is made. Receiver mutations retain the existing idempotent request IDs.

Accepted, received and acted remain separate. Unsupported adapters never report successful delivery. An accepted event is retained without repeatedly waking the host; receiver acknowledgement is still required. Uncertain results are held/reconciled and eventually marked failed for attention, never automatically treated as completion.

Controller transfer persists the new owner and increments its epoch. Previously issued local session tokens then expire. Queued stale events cancel; cancelled handoffs invalidate their wrap-up events. Outgoing handoff delivery is checkpoint-only. Schedule-retirement events permit the old controller to confirm only its own previously recorded schedule pause; they confer no dispatch authority. Incoming ownership does not prove the old schedule stopped: retirement remains pending until a harness receipt is recorded.

## Control coverage

`getControlCoverage` exposes the following inventory to plugins:

| Surface | MCP status |
| --- | --- |
| Board/tasks/comments/discovery | Supported via list/get/create/update/upsert/comment and onboarding tools |
| Workflow stages/rules/templates/undo | Supported via versioned workflow tools |
| Workers, QA, Autopilot | Dispatch, follow-up, stop, checks/review and wind-down supported |
| Decisions | Proposed-option resolution supported; free-text owner answers and explanations remain in the app queue |
| Evidence | Run outcomes, logs, diff summaries and exact release revisions supported |
| Releases | Prepare/status/execute supported under current workflow authority |
| App updates | Check/install/cancel supported after owner request |
| Workspace selection | Scoped workspace listing supported; opening another project is owner UI only |
| Pairing/control/binding approvals | Preparation and binding proposal supported; owner approval/revocation/transfer remain app actions |
| Provider settings | Capacity/usage read supported; keys and provider configuration remain owner UI only |
| UI preferences | UI only; no generic shell or UI-automation proxy |
| Existing-chat wake | Queue and adapter seam implemented; no production host adapter registered yet |

These owner-only gaps are intentional boundaries, not full remote app-control coverage. Extending them requires scoped owner authorization interfaces; a plugin cannot use generic automation as an equivalent.

## Acceptance status and alternatives

Unit tests exercise coalescing, persistence/recovery, uncertain-send reconciliation, actor/epoch validation, offline retry limits and revoked bindings. Existing coordinator tests cover handoff authority and worker preservation. These do NOT pass live same-chat wake, host restart, schedule retirement, or iOS acceptance gates.

The host plugin developer is investigating supported delivery. Until it is verified, the UI reports automatic wakeup unavailable. No private bridge is borrowed and no replacement chat is created. The closest alternatives are (a) one scheduled check-in in the same existing chat, with polling delay and verified retirement, or (b) one persistent App Server thread per workspace, reused for event-triggered turns; desktop/iOS visibility of that separate thread is unverified. Never create a new chat for each event.
