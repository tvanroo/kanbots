# Chat-native KanBorg project control

Owner direction: 2026-11-07. This supersedes the earlier single-chat/single-workspace acceptance scope. It records required behavior, not a claim that existing builds implement it.

## Product behavior

Pair ChatGPT/Codex with the local KanBorg installation once. Retain that pairing across app, harness and Mac restarts and normal updates. A refreshed short-lived transport session must be invisible to the user and must not require re-pairing. Preserve existing pairings during migration.

The same installed plugin works from any chat on the paired host, including ChatGPT iPhone access to that host. Do not hardcode the acceptance chat, workspace, client UUID or profile into production instructions. A chat may work with several projects; several chats may work with one project. Project selection is explicit durable chat state. New chats automatically discover the project list and published operations. An ambiguous project name requires ordinary conversational clarification, not local app interaction.

KanBorg projects/boards are persistent top-level containers, analogous to ChatGPT projects. They own tasks, workflow, worker state, configuration, history and coordinator assignment. The desktop project switcher changes visible focus only. Opening project B must not close project A's store, watchers, workers, subscriptions, tool bridge or coordinator. Global stop/update/shutdown must handle all live project contexts explicitly.

The owner can create a project, choose/create its repository or folder, list/open/select/rename/archive projects, manage tasks/workflows/dependencies, run/pause/stop/recover workers, answer questions, inspect evidence, configure routing/providers/budgets/notifications, manage coordinators and install requested updates through chat. Creation and mutations return durable receipts; project paths and supported filesystem actions are validated. Existing data and identities remain intact.

After initial pairing, normal project selection, chat registration, event subscription, coordinator transfer and settings changes follow the user's chat instruction without further local approval screens. A single instruction such as “use project A here” performs necessary routing/coordination steps and reports the result. No repeated approve → handover → switch sequence. Conflicting control is resolved explicitly without duplicated work or silently interrupting an unrelated owner instruction.

Event subscriptions route project/task events to the relevant participating chat(s), not every chat and not a single hardcoded destination. Coordinator ownership and progress subscriptions are distinct. A routing epoch plus idempotent received/acted receipts prevents duplicate actions after reconnect. Multiple projects have independent cursors, ownership and execution queues.

Secret entry remains a protected non-logging flow through the user's authoritative secret store. Chat config tools accept secret references/status, never return provider keys or ask the user to paste secret values into chat. This is a credential-handling boundary, not a requirement to visit KanBorg settings. Host-enforced restrictions must be reported accurately; local-only operation does not promise control over the ChatGPT host's own policies.

## Published MCP operating interface

Publish a machine-readable operation catalog and concise operating guide through MCP. At minimum: initial connection instructions, project lifecycle, chat selection/registration, multi-project execution, tasks/workers, workflows, questions, coordination/handoffs, events/acknowledgements, settings/providers, capacity, releases, application lifecycle and recovery.

Every operation entry identifies its real callable tool/schema, required inputs, scope (installation/project/chat/task), settings types/defaults/constraints, result/receipt shape, reversibility, supported/unsupported status and recovery guidance. Generate or validate tool references against the shipped tools/list manifest. Never advertise a proposed operation as callable. Include actual input schemas and examples with no credentials. Mark UI controls without chat equivalents as coverage defects to implement.

Support tools-only clients with discovery/help tools as well as MCP resources/prompts for hosts that support them. Publish a catalog version, application version and coverage summary; refresh discovery after relevant version/config changes. Do not require replaying large manuals on every turn.

## Acceptance gates

1. Pair once, reboot/restart both apps, update KanBorg, and reconnect without new owner pairing. Existing project identities/data survive.
2. Start a different existing chat; discover and control a project without another app approval or a new chat. Register event routing conversationally and receive the correct correlated wake.
3. Create projects A and B through chat. Run authorized work in both, switch desktop/chat focus, and verify both remain live with separate state/results.
4. Use two chats and two projects; verify project selection, coordinator transfer, event routing and acknowledgements do not leak or duplicate assignments across them.
5. Exercise each app settings/control surface from chat against the coverage catalog. Unsupported controls remain explicit failures, not silent UI handoffs or shell proxies.
6. Complete a project action from ChatGPT iPhone on the paired host and receive its result; no local KanBorg interaction after initial pairing.
7. Validate offline/busy/restart/uncertain-send recovery, stale revisions/epochs, stop behavior and continuity of existing workers/decisions.

Current known gaps in 1.2.25/1.2.26-cli.1: single active desktop context; workspace-bound client pairing; listWorkspaces filtered to connection scope; non-open workspace requests rejected; UI-only project/provider controls; per-chat binding approval. The earlier successful wake/received/acted/restart test validates that narrow transport baseline only.
