---
name: kanborg-handoff
description: Checkpoint and reconcile a coordinator handoff between KanBorg and an existing Claude chat (or between Claude and a ChatGPT/Codex chat) without duplicating work or falsely claiming delivery.
---

# Coordinator handoff

Read current capabilities, workspace/session state, pending requests and current workflow before acting. Preserve the user's intended existing chat. Do not create a replacement chat or a dedicated session without explicit authorization.

Owner policy: the plugin works from any chat, in Claude or in ChatGPT/Codex through its sibling plugin. Handoffs can go KanBorg ↔ Claude, and Claude ↔ ChatGPT/Codex through KanBorg. Use supported chat registration and coordinator-transfer operations under the persistent initial pairing. Routine changes requested in chat should not require local approve → handover → switch steps. Where an older build still enforces them, report a capability gap and do not fabricate a successful transfer. Separate project ownership from progress subscriptions, and keep other projects running while transferring this one.

## Outgoing coordinator

- Verify a current handoff request and its identity, source and destination. Stop new dispatch while it is pending; preserve authorized running workers.
- Save `completeHandoff` with the current handoffId, revision and requestId. Include objective and scope, completed work/evidence, active task/run IDs and owners, pending decision IDs, review/release status with exact revisions, waiting triggers, next actions and event cursor. Exclude credentials, full transcripts and standing harness instructions.
- Verify the returned checkpoint state. `ready` is not a completed ownership transfer. The current app contract may require the owner to finish the switch.
- Pause only this workspace's outgoing schedule through supported host tools (for Claude Desktop, its scheduled task for this workspace) and verify the result. Record its actual receipt where permitted. If another host owns it and it cannot be paused, report retirement pending.

## Incoming coordinator

- Read the fresh assignment and saved summary; do not inherit authority from the outgoing prose. Verify ownership has actually changed before writing.
- Reconcile workers, decisions, exact revision evidence, waiting triggers and pending requests without redispatching existing work. Call `confirmHandoffReconciled` when published, and save durable progress through the available tools.
- If monitoring was authorized, adopt the current `checkIn` policy and retire the superseded schedule. Keep exactly one schedule for the workspace. Do not claim an old schedule is stopped without host confirmation.

## Delivery boundary

Track these states separately: queued request, accepted delivery, receiver acknowledgement, saved handoff, transferred ownership, incoming reconciliation. A queued request or MCP event does not prove an idle chat has awakened.

KanBorg's verified existing-chat adapter (`codex-cli-queue-v1`) targets Codex desktop chats only. No adapter that wakes an idle Claude Desktop chat has been verified. Never propose a Codex adapter binding for a Claude chat, invent a Claude adapter ID, or automate sending through hidden desktop internals. If no verified, approved adapter is configured for this chat, offer manual continuation or one explicitly authorized Claude scheduled task as a polling fallback. Do not call the transfer complete on the strength of a queued event.

Read [Receiver compatibility](../../references/receiver-protocol.md) for capability-gated acknowledgements and `confirmHandoffReconciled`.
