# Project workflows

KanBorg 1.2.18 stores a versioned workflow for each project in its existing local coordinator registry. Use **Workflow** above the board or **Edit workflow** in the coordinator window. The MCP tools read and edit the same state.

## Coordinator tools

- `getWorkflow`: current configuration, card assignments/evidence, history and reusable templates.
- `previewWorkflowChange`: validate a complete proposed configuration, expected version, reason, optional stage migrations and explicit card moves with evidence. Reports affected cards, including running and completed work.
- `applyWorkflowChange`: save that change. Requires the current coordinator's normal workspace revision and request ID; does not require a second owner approval for an already-requested reversible edit.
- `undoWorkflowChange`: restore the preceding configuration and reverse its card migrations when those cards have not subsequently moved. Newly populated removed stages still require destinations.
- `updateWorkflowCard`: record task type, stage, actor, next action, check results, evidence and waiting reason/owner/trigger.
- `recordWorkflowEvent`: report an evidenced merge or deployment performed outside KanBorg, allowing configured automatic transitions to reconcile it.
- `saveWorkflowTemplate`: save a reusable versioned starting point. Loading it creates a project snapshot; later template edits never overwrite project overrides.

For example, read the current workflow, insert a stable `deployment` stage after Review, configure its transitions and coordinator release ownership, and include explicit moves for the verified merged cards. Preview, apply, then read the saved version. Do not move unrelated cards or restart workers.

## Stage contract

Stages have stable identities independent of names/order, a purpose, entry and exit guidance, responsible actor, coordinator/worker guidance and required/advisory/not-applicable checks. Structured checks gate transitions; free-text entry and exit guidance tells the coordinator what evidence to assess. Task-specific completion rules cover research, implementation, QA, release, incident and parent objectives.

The initial stages are Backlog, Ready, In Progress, Review, Release / Verification and Done. Existing completed cards stay completed under their recorded version. Failed workers get a recovery waiting reason instead of being marked review-ready. Worker completion and independent QA events can advance configured transitions and create durable coordinator requests. A merge never constitutes runtime verification by itself.

## Changes, reminders and authority

Configuration changes retain actor, time, reason, previous config and explicit migrations. Card decisions retain their evidence and workflow version. Renaming/reordering preserves identity. Removing a populated stage requires a destination; configuration migration cannot silently complete a card. Adding stricter requirements does not reopen finished cards. Running workers are left intact; current guidance is supplied on subsequent assignments and continuations.

Reminder changes issue a durable instruction to update the existing harness schedule and verify its receipt. KanBorg cannot directly rewrite an arbitrary harness's scheduler. Notification preferences are supplied to the coordinator; event delivery remains durable even when user-facing notifications are suppressed.

Workflow ownership and release preferences never grant credentials, expand tool permissions or bypass the host's approval system. New MCP tools may require a harness reconnect/restart to refresh its tool schema.
