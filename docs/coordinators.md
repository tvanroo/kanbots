# Kanbots Local coordinators (1.2.4)

Open a project. When an external coordinator is not active, the board shows **Your built-in coordinator**, a message box, and guided action buttons. **Populate board from repository** starts the discovery prompt in the built-in chat without a separate mode-selection step. **Connect external coordinator** starts a setup conversation; the coordinator can prepare or reuse a named connection and guide pairing. The **Coordinators** control opens full progress and connection settings.

## Start with the defaults

Use the inline message box to describe an objective, or open **Coordinators** to continue its chat. For an external harness, the guided chat prepares a connection; alternatively add a named external harness, copy its MCP configuration into that harness, connect, approve its matching pairing code in Kanbots, and choose **Use coordinator**. DeepSeek Harness has a dedicated configuration copy button; the standard MCP configuration is also available. The connection uses local stdio and requires Kanbots Local to be running with that project open. A remote-only MCP client needs a future transport integration.

One coordinator controls a workspace at a time. Switching preserves tasks, summaries and workers. Stop an independent Autopilot session before handing control to a coordinator. The default workflow allows two workers, a $5 per-run budget setting, repository checks, an independent review and one correction attempt. Subscription usage is not a dollar charge; run budgets use the existing execution accounting. Change workflow settings as you learn what suits your project.

## Discover existing work

The setup offers a comprehensive prompt for new projects and empty boards. Run it through the internal coordinator or copy it to the external harness. It delegates a read-only inventory of repository instructions, plans, TODOs, branches, recent changes and accessible issue/PR evidence. Source references identify cards across repeat reconciliation. Human edits and conflicting status require reconciliation rather than silent overwriting. Unavailable conversations, remote systems and deployment evidence remain explicitly unknown.

The coordinator records the inventory, dependencies, status evidence and a durable handoff summary. It asks for the next objective instead of treating every discovered item as authorization to implement it. The same operating prompt requires ongoing board updates after meaningful work, reconnects and handoffs. This is an agent workflow contract, not a background crawler of every external service.

## Conversation and navigation

The coordinator opens immediately in a persistent chat view. During external setup, the current action stays above the transcript: copy the request, approve a detected connection, then hand over. Earlier conversation is collapsible; questions remain visible above it. Reopening an active setup shows its progress rather than an error. The welcome message explains its role, progress stays visible during work, and connection setup actions and pending questions appear alongside the conversation. Connections and workflow controls have their own tab. Click **Chats → Project coordinator** to reopen it. Coordinator activity and decision links route to this conversation rather than an unrelated issue number. Refreshing an empty board preserves the open chat.

## Delegation and release

Tasks run in worker worktrees using Kanbots provider routing. Dependencies and worker limits queue dispatch. QA runs configured repository checks, then a separate reviewer at the exact implementation commit. A failed review can return to implementation within the correction limit. Results expose compact summaries, bounded logs, diffs, checks and change cursors.

Human decisions and release approvals remain in Kanbots. Release preparation requires QA on the exact committed revision. Supported release actions are a local merge into a clean checked-out target, or a draft GitHub PR in a GitHub-backed project. Publishing, production deployment and app-store release are not included. New commits invalidate previous QA/release approval. Failed or uncertain release attempts are surfaced rather than automatically replayed.

## Connection and recovery

Pairings are named, project-scoped and revocable. Configurations contain a client identifier, not provider credentials. Pairing credentials stay in protected local app storage; each connection exchanges them for short-lived sessions. This protects the bridge from unpaired clients, not from malicious software running as the same macOS user. The stable launcher is regenerated when Kanbots starts after an update; the harness does not need a separately installed Node runtime.

MCP writes require the current session revision and an idempotency request ID. Retry the same ID after transport failure. Reconnecting reads the current local endpoint and durable summary. Ambiguous operations are not replayed. Long-running worker execution still depends on the Mac staying awake. Stop all work from the coordinator panel when needed.

## Capacity display

The popup groups sources into shared routing tiers and marks the current preferred candidate with its reason. Grants and time-sensitive capacity precede ordinary included capacity; stored credits can remain in reserve, and pay-as-you-go remains separate. Task capability and live eligibility can change the choice within a tier. Missing expiry information stays unknown.

## Validation boundary

Automated checks cover coordinator schemas, pairing/reconnect/revocation, project scope, idempotency, QA/release approval and inventory reconciliation. UI layout was checked using a preview. Live provider inference, real merges/PRs and actual DeepSeek/Claude/ChatGPT desktop pairing are left for the owner acceptance run.
