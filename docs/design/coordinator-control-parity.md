# Coordinator control parity

Owner direction: every KanBorg action must be remotely accessible to the coordinator. The UI and MCP are clients of the same authoritative services. A UI-only implementation is a capability gap, not the intended product boundary.

## Contract

Each action has a stable typed operation ID, input/output schema, scope, required authority, revision precondition, idempotency receipt, audit record and change event. Reads expose actual saved state. Writes return saved state and effects. UI and MCP call the same service; neither duplicates business rules. Configuration edits do not silently start work. An operation catalog reports implemented, approval-required and unsupported individually; no generic unrestricted IPC/JavaScript proxy counts as coverage.

Owner-reserved operations are remotely requestable and trackable, but the coordinator cannot manufacture owner consent or approve its own pairing. Credentials use protected references, never MCP plaintext values. Existing harness tool authorization remains enforced.

## Inventory and remaining gaps

| Surface | Current supported MCP | Required remaining operation family |
| --- | --- | --- |
| Personas | listPersonas, upsertPersona, removePersona | Restore a historical version, import/export definitions |
| Board | list/get/create/update/upsert work, comments, dependencies | archive/restore, labels, attachment metadata, saved views and board display preferences |
| Workflow | read/preview/apply/undo, templates, card evidence/events | list/delete templates, inspect task-specific preview in catalog |
| Workers | dispatch/follow-up/stop, Autopilot, logs/diff/results/QA | targeted steering, queued-assignment edit/cancel, lifecycle receipts |
| Questions | listDecisions/answerDecision | persistent question list, explain, free-text reply, delivery receipt to originating thread |
| Coordinator chat | requests/session/changes | read/send/queue/edit/cancel/steer/stop with explicit thread identity |
| Handoff/connections | prepare, complete, reconcile, bindings | list/rename/revoke connection; request/cancel/retry transfer; owner approval request/receipt |
| Providers | capacity read | routing preferences, connection metadata, budget/grant policies, refresh, reconnect status and protected credential-reference setup |
| Projects | list scoped workspaces | open/select/close/recent projects without interrupting other projects; explicit scope authorization |
| Updates | check/install/cancel | progress and resume receipts already returned; expose any later UI actions here too |
| Settings | workflow execution defaults | appearance, notifications, shortcuts, house rules, scripts, task templates, error-monitor settings, usage/archive |
| Development | run evidence | files/worktrees, saved chats, review/diff actions using scoped existing handlers |
| App window | none | focus/navigation/window controls where supported; no arbitrary desktop control |

These remaining families are design requirements, not claims of shipped API coverage. getControlCoverage must remain honest until each is implemented and tested.

## Persona library

Per-workspace durable definitions include stable ID, name, tagline, icon, complete working prompt, version and update time. History retains actor, reason and prior definition. CardBox receives five owner-requested specialists. Current Autopilot selections and running prompt snapshots are unchanged by library edits. Deleting a selected persona is rejected with a concrete remediation. App writes and MCP writes share validation and storage. App observes library changes; MCP reads them next interaction.

## Acceptance for every operation

1. UI write -> MCP readback; MCP write -> UI readback.
2. Reject wrong workspace, stale revision, revoked client and lost controller authority.
3. Replay identical request ID without duplicate effect; reject changed payload under same ID.
4. Persist through restart; preserve other projects, active work and exact evidence.
5. Reserved actions produce a pending owner decision and execute only with its matching receipt.
6. Add catalog coverage when a new UI action is added; fail parity checks for unclassified actions.
