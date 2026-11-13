---
name: kanborg-projects
description: Manage KanBorg projects, boards and settings interactively from any Claude chat using the paired local app's published capabilities and operation catalog.
---

# Projects and app controls from chat

Use the existing paired installation from any Claude chat on its Mac, including phone access through a Mac-hosted session (`kanborg-mobile`). Do not create a new chat or bind the plugin permanently to this conversation. Initial pairing is persistent; do not ask the owner to re-pair merely because a chat, project, transport session or app process changed.

## Discover before acting

Read live `getCapabilities` and callable tool schemas. Discover the server's published operation catalog/guide through its actual tool/resource support. Do not guess new tool names from this skill. Use `listWorkspaces` and `getControlCoverage` when those are the available interfaces. Cache the catalog version and fetch relevant sections; refresh after upgrades or declared capability changes.

Match the user's project name to a stable project ID. Maintain selected project and delivery registration per chat, while allowing explicit operations against multiple projects. Clarify only genuine ambiguity, missing creation details or conflicting instructions. UI focus is not an authorization or execution boundary.

## Project operations

Carry out authorized create, list, open, select, rename and archive operations through typed tools. Use supported operations for selecting an existing repository, creating a local project/repository, and configuring its board. A project switch must preserve other projects' runtimes, workers, queues and cursors. Never stop another project merely to view one.

When several projects are active, label outcomes with their project, keep IDs separate and use each operation's actual revision/idempotency requirements. Keep coordination ownership separate from which chat receives progress. Register this chat for the requested project's relevant events through supported APIs without per-chat approval prompts when the app supports the installation's standing authorization. Never broadcast events to arbitrary chats.

## Interactive configuration

Use the published settings schema to read allowed values, defaults, validation, scope and restart effects. Make requested changes and read back their receipts. Explain material tradeoffs in plain language. Cover project/board/workflow (`getWorkflow`, `previewWorkflowChange`, `applyWorkflowChange`), routing/provider preferences, budgets, notifications, concurrency, worker controls (`manageAutopilot`, `setWorkerAssignment`), personas, coordinator handoffs, evidence/release and application updates (`getApplicationUpdate`, `updateApplication`) through the appropriate typed operations, when published.

Credentials use protected secret references or the supported non-logging secret-store setup flow. Never request secret values in chat or return keys from settings. The owner can configure integrations from chat without receiving those values.

## Capability gaps

The owner requires all app controls to have chat equivalents, with local KanBorg interaction only for initial pairing. If the installed app lacks one, identify the specific missing operation and record/route the implementation gap; do not claim completion, invent a tool, or silently redirect the owner to app settings as the normal workflow. An app update or host feature can still require its actual supported setup steps; distinguish those from unnecessary plugin approvals.

Single-workspace wake/receipt/restart has been verified on an earlier build. That does not establish app-wide pairing, concurrent project runtimes or complete settings coverage. Follow live schemas rather than assuming this policy text installed those features. See [the product contract](../../references/chat-project-control-contract.md).
