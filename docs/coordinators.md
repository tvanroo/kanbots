# KanBorg coordinators (1.2.5)

Open a project. When an external coordinator is not active, the board shows **Your built-in coordinator**, a message box, and guided action buttons. **Populate board from repository** starts the discovery prompt in the built-in chat without a separate mode-selection step. **Connect external coordinator** starts a setup conversation; the coordinator can prepare or reuse a named connection and guide pairing. The **Coordinators** control opens full progress and connection settings.

## Start with the defaults

Use the inline message box to describe an objective, or open **Coordinators** to continue its chat. For an external harness, the guided chat prepares a connection; alternatively add a named external harness, copy its MCP configuration into that harness, connect, approve its matching pairing code in KanBorg, and choose **Use coordinator**. DeepSeek Harness has a dedicated configuration copy button; the standard MCP configuration is also available. The connection uses local stdio and requires KanBorg to be running with that project open. A remote-only MCP client needs a future transport integration.

One coordinator controls a workspace at a time. Switching preserves tasks, summaries and workers. Stop an independent Autopilot session before handing control to a coordinator. The default workflow allows two workers, a $5 per-run budget setting, repository checks, an independent review and one correction attempt. Subscription usage is not a dollar charge; run budgets use the existing execution accounting. Change workflow settings as you learn what suits your project.

## Discover existing work

The setup offers a comprehensive prompt for new projects and empty boards. Run it through the internal coordinator or copy it to the external harness. It delegates a read-only inventory of repository instructions, plans, TODOs, branches, recent changes and accessible issue/PR evidence. Source references identify cards across repeat reconciliation. Human edits and conflicting status require reconciliation rather than silent overwriting. Unavailable conversations, remote systems and deployment evidence remain explicitly unknown.

The coordinator records the inventory, dependencies, status evidence and a durable handoff summary. It asks for the next objective instead of treating every discovered item as authorization to implement it. The same operating prompt requires ongoing board updates after meaningful work, reconnects and handoffs. This is an agent workflow contract, not a background crawler of every external service.

## Conversation and navigation

The coordinator opens immediately in a persistent chat view. During external setup, the current action stays above the transcript: copy the request, approve a detected connection, then hand over. Earlier conversation is collapsible; questions remain visible above it. Reopening an active setup shows its progress rather than an error. The welcome message explains its role, progress stays visible during work, and connection setup actions and pending questions appear alongside the conversation. Connections and workflow controls have their own tab. Click **Chats → Project coordinator** to reopen it. Coordinator activity and decision links route to this conversation rather than an unrelated issue number. Refreshing an empty board preserves the open chat.

## Delegation and release

Tasks run in worker worktrees using KanBorg provider routing. Dependencies and worker limits queue dispatch. QA runs configured repository checks, then a separate reviewer at the exact implementation commit. A failed review can return to implementation within the correction limit. Results expose compact summaries, bounded logs, diffs, checks and change cursors.

Human decisions and release approvals remain in KanBorg. Release preparation requires QA on the exact committed revision. Supported release actions are a local merge into a clean checked-out target, or a draft GitHub PR in a GitHub-backed project. Publishing, production deployment and app-store release are not included. New commits invalidate previous QA/release approval. Failed or uncertain release attempts are surfaced rather than automatically replayed.

## Connection and recovery

Pairings are named, project-scoped and revocable. Configurations contain a client identifier, not provider credentials. Pairing credentials stay in protected local app storage; each connection exchanges them for short-lived sessions. This protects the bridge from unpaired clients, not from malicious software running as the same macOS user. The stable launcher is regenerated when KanBorg starts after an update; the harness does not need a separately installed Node runtime.

MCP writes require the current session revision and an idempotency request ID. Retry the same ID after transport failure. Reconnecting reads the current local endpoint and durable summary. Ambiguous operations are not replayed. Long-running worker execution still depends on the Mac staying awake. Stop all work from the coordinator panel when needed.

## Capacity display

The popup groups sources into shared routing tiers and marks the current preferred candidate with its reason. Grants and time-sensitive capacity precede ordinary included capacity; stored credits can remain in reserve, and pay-as-you-go remains separate. Task capability and live eligibility can change the choice within a tier. Missing expiry information stays unknown.

## Validation boundary

Automated checks cover coordinator schemas, pairing/reconnect/revocation, project scope, idempotency, QA/release approval and inventory reconciliation. UI layout was checked using a preview. Live provider inference, real merges/PRs and actual DeepSeek/Claude/ChatGPT desktop pairing are left for the owner acceptance run.

## Change coordinator

Use **Change coordinator** in the chat header. Choose **Return to built-in**, or choose a harness and **Copy prompt for new coordinator**. The prompt includes standard JSON MCP config, ChatGPT desktop/Codex-host TOML, and DSH fields; use only the format supported by that harness. Existing unrelated connections must be preserved. KanBorg does not silently install configuration into other applications.

Pair the new harness before requesting handoff. Requesting handoff saves a checkpoint and pauses new dispatch. The outgoing coordinator sees the event through MCP polling and can submit `completeHandoff` with its summary. An idle internal coordinator receives a wrap-up prompt. When ready, the user switches control; existing workers continue. An unresponsive external harness cannot be forced to run by MCP: use **Copy wrap-up request** to wake its chat or explicitly **Switch using saved progress**. Cancelling resumes the previous controller. Returning to built-in starts a context-recovery turn. The incoming external coordinator must read `getWorkspaceSummary`; the UI distinguishes assigned control from that first check-in.

Compatibility references: [ChatGPT local MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), [Claude Desktop local MCP](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop). ChatGPT remote-only connector screens are a different transport; this release does not publish KanBorg to the internet. Actual ChatGPT and Claude Desktop pairing remains owner acceptance testing.

## KanBorg rename compatibility

New MCP connections identify as `kanborg` and use `KANBORG_COORDINATOR_CLIENT`. Existing `kanbots-local` server entries and `KANBOTS_COORDINATOR_CLIENT` remain supported. Both launcher filenames are refreshed when KanBorg starts. The application bundle ID and data directory are intentionally unchanged to retain encrypted keys and paired clients.

### Handoff and reminders (1.2.12)

Setup is generated for the named incoming harness. The outgoing summary is durable state, never the incoming standing prompt. Superseded harness assignments (including retired Cline coordination) are retired; evidence is retained. The session exposes coordination, release and pairing authority separately. Current behavior continues to give the assigned coordinator release authority within the owner's scope, with owner-only pairing.

On initial connection/reconnect, read capabilities, workspace/session and pending requests. On scheduled ticks, use immediate `getChanges(cursor)`: it now includes controller/lease, handoff status, pending request IDs and cadence, so unchanged ticks require no full-state reads or long wait. A lost cursor requires reconciliation. Use `waitForChanges(20000)` only during an active turn.

The session's `checkIn.prompt` is a fresh short reminder. Keep objective, evidence and next steps in the durable summary. Harnesses should update one workspace reminder to 5 minutes during running work, 15 minutes for an idle ongoing objective, and pause when no responsibility remains. One-minute checks require an explicit time-sensitive request. Supported event wakeups are preferred.

Schedules belong to the harness. After actually configuring one, report `schedule: {id, status, cadenceMinutes, cursor}` through `updateCoordinationSession`. These are harness-reported receipts, not proof from KanBorg of an external scheduler's state. Handoffs leave previous active receipts marked `pause-required` until their owner confirms a pause. A former controller may report only its own recorded schedule as paused; it cannot change the objective or other state. Unknown legacy schedules still require harness inspection; KanBorg cannot discover or cancel arbitrary Cline/DSH/Codex schedules. Unrelated schedules must remain untouched.

This change does not replace worker continuation internals or introduce a new cross-chat owner-approval store. The integration contract requests compact continuation assignments and reuse of existing decision IDs; those broader execution changes are separate from schedule handoff.

### Prompt-driven updates (1.2.13)

Ask the built-in or external coordinator to **check for KanBorg updates**, then **install and resume**. `getApplicationUpdate` checks the public GitHub releases in `tvanroo/kanbots`; `updateApplication(action: install)` prepares the published DMG asynchronously and returns immediately. The coordinator UI also provides Check for updates and Install and resume buttons. No GitHub credentials are needed. Installation must follow an owner's request, never just the discovery of a new release.

An installation waits for current local/device/cloud runs and independent Autopilot to finish. Awaiting-input runs must be answered first. Coordinator dispatch, queued work and QA progression wait while the update is prepared; existing processes finish normally. Queued task records, decisions, ownership, keys and configuration remain on disk. The new app reopens the checkpointed repository, refreshes its MCP endpoint, reports an application-updated event and resumes pipelines. A built-in coordinator gets a reconciliation prompt. An external coordinator reconnects using its existing launcher and saved cursor; the app does not create a new external chat or schedule.

Installers are checked against the release SHA-256, expected bundle identity, version and CPU architecture. The detached helper keeps the previous application and restores it if the replacement fails its startup/workspace recovery check. This is binary rollback, not a database rollback. The application must be installed in a writable location (not running from its disk image). This first implementation targets macOS Apple Silicon local releases.

Release procedure: `pnpm --filter @kanborg/desktop release:mac:local` produces the DMG and `kanborg-update.json`. Publish both as assets on a GitHub full release pointing at the exact source commit. The app selects GitHub's latest published full release. Existing builds before 1.2.13 need one manual installation to gain this feature. Explicit local DMGs remain supported through the MCP action with a version and SHA-256.
