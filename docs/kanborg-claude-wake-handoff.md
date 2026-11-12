# Handoff: let KanBorg wake an existing Claude chat

Audience: the developer working on the KanBorg desktop app (`packages/desktop`).
Status: plugin side shipped in `plugins/kanborg-connect-claude` 0.3.0. The app side is an isolated, tested candidate module in `integration/claude-channel/` that has **not** been wired into the app.

## Goal

When KanBorg has a coordinator request, handoff, decision or other event for a workspace whose controller is a Claude chat, that same Claude chat should start a new turn, read state over KanBorg MCP, `acknowledgeWake` received, act, and `acknowledgeWake` acted. This is the same loop that `codex-cli-queue-v1` provides for Codex.

## How the wake works

Claude Code supports **channels**: a plugin's stdio MCP server can declare `capabilities.experimental['claude/channel']` and push `notifications/claude/channel` messages into the session that spawned it. The plugin ships one of these, `kanborg-wake` (`wake/server.mjs`). It does two things:

1. **Push inbox (needs this app change).** On start, it binds a private Unix socket and writes a 0600 registry file:
   `~/.kanborg-connect/claude/sessions/<chatId>.json` → `{v:1, adapterId:"claude-channel-v1", hostId:"local", chatId, socket, token, pid, cwd, startedAt}`.
   `chatId` is the Claude Code session ID when available, so the binding survives `claude --resume`. The socket is at `~/.kanborg-connect/claude/s/<chatId>.sock`.
2. **Watch mode (works today, no app change).** If the user sets the plugin's `kanborg_connection_id`, the channel runs KanBorg's own `kanborg-mcp` launcher as an MCP client. It polls `getChanges` every 15 seconds for workspaces the chat opted into (`kanborgWakeWatch`) and wakes the chat on new, non-routine events. This is a local poll and does not spend model tokens. It cannot `acknowledgeWake`, because there is no wake event ID.

### Inbox protocol (one JSON line in, one JSON line out)

| Request | Reply |
| --- | --- |
| `{v:1, token, chatId, type:"ping"}` | `{v:1, state:"available", chatId, observedAt}` |
| `{v:1, token, chatId, type:"wake", signal:{id, workspaceId, clientId, epoch, kind, cursor, handoffId?}}` | `{v:1, state:"accepted", receipt:"claude-channel:<chatId>:<eventId>"}`. A repeated event ID returns the same receipt with `duplicate:true` and does **not** wake the chat again. |
| `{v:1, token, chatId, type:"reconcile", eventId}` | `{v:1, state:"accepted", receipt}` or `{v:1, state:"unknown"}` |
| bad token, wrong chat, malformed signal | `{v:1, state:"not-delivered", error}` |

`accepted` means the channel emitted the notification into the session's MCP stream. It does not mean Claude has read the wake or acted on it. Receiver evidence still comes only from `acknowledgeWake`.

## Required app changes

1. **Register the adapter.** Copy `integration/claude-channel/coordinator-claude-channel.ts` into `packages/desktop/src/`, then after the Codex registration in `main.ts` add:
   ```ts
   coordinators.registerHostAdapter(createClaudeChannelAdapter());
   ```
   No executable, endpoint or prompt is taken from MCP or the renderer. The adapter only reads the registry directory and talks to sockets inside `~/.kanborg-connect/claude/s/`. It rejects registry files readable by other users or owned by another uid.
2. **Binding from chat.** The Claude chat calls `kanborgWakeStatus` to get `{adapterId:"claude-channel-v1", hostId:"local", chatId}` and then calls `proposeHostBinding` with those values. Today `approve-binding` requires an owner click in KanBorg.
   - The minimum change is nothing: the owner approves once per chat.
   - To meet the chat-control contract (no per-chat approvals after pairing), auto-approve a `claude-channel-v1` proposal when:
     - the connection is already owner-approved, and
     - the registry file for that `chatId` exists and its ping succeeds, and
     - the proposing client matches the connection.
   - Keep revoke in the UI and over MCP.
3. **Don't burn attempts while offline.** `deliverWake` increments `attempts` before `reachable()`, so a Claude session that is simply closed reaches `failed` after six tries, about five minutes. For `offline` reachability, keep the event `queued` and do not count the attempt. Coalesce `changes` events as `enqueueWake` already does, and deliver when the session comes back. Keep the existing six-attempt cap for `unknown` and `uncertain` results.
4. **Expose reachability.** Show `offline` (Claude session not running) separately from `unsupported` in the Coordinators UI and in `getOutboundEvents`, so the chat and the owner can see why a wake is pending.
5. **Optional: re-bind on a new chat ID.** If a session starts without a stable session ID (`sessionIdSource:"generated-per-process"` in `kanborgWakeStatus`), the chat ID changes on restart. The plugin skill tells Claude to re-propose the binding. The app should revoke the old binding for the same client when the new one is approved. `approve-binding` already does this.
6. **Mention Claude in the setup prompt.** In `CoordinatorService.config()`, tell Claude Desktop/Claude Code users to install the `kanborg-connect` plugin from `tvanroo/kanbots` and start sessions with the channel enabled, as described below.

No changes are needed to the MCP tool schemas. `getOutboundEvents`, `proposeHostBinding`, `acknowledgeWake` and `confirmHandoffReconciled` are used as they are.

## Host limits (Claude side)

- Channels are a Claude Code research-preview feature. A session must be started with the channel enabled. For a plugin from this repository's marketplace, which is not on Anthropic's allowlist:
  ```sh
  claude --dangerously-load-development-channels plugin:kanborg-connect@kanborg
  ```
  On Team/Enterprise plans, an admin can instead add it to `allowedChannelPlugins` and enable `channelsEnabled`, after which `claude --channels plugin:kanborg-connect@kanborg` works.
- Documented surfaces: Claude Code CLI sessions. This includes sessions continued from the Claude phone app through Remote Control, which is how a wake can reach the phone. The Claude Desktop Code tab and ordinary Claude Desktop/Cowork chats are **not documented** to load channels. In those surfaces the plugin still provides its skills and tools, but nothing can wake an idle chat. Verify on the Mac before promising it.
- The docs strongly imply that a channel notification starts a turn in an idle session, but do not state it outright. This must be confirmed in acceptance test 1.

## Acceptance tests (owner-run, on the Mac)

1. Start `claude --dangerously-load-development-channels plugin:kanborg-connect@kanborg` in any folder with KanBorg paired. Run `kanborgWakeWatch` on a scratch workspace, leave the session idle, and create a coordinator request in KanBorg. A new turn should start within about 15 seconds.
2. With the app change in place: bind the session (`proposeHostBinding` with the status values), make it the controller, and leave it idle. Trigger a request. Confirm the outbound event goes `accepted` → `received` → `acted` with the `claude-channel:` receipt.
3. Close the session and trigger an event. It should stay queued as `offline` and be delivered after `claude --resume <id>` with the channel flag, without duplication.
4. Kill KanBorg between send and acknowledgement, then restart it. `reconcile` should return the stored receipt, and no second wake should appear.
5. Hand off coordination Codex → Claude → Codex. Each side is woken through its own adapter, and workers and decisions are preserved.
6. Continue the session from the Claude phone app via Remote Control, trigger a request, and confirm the wake turn shows on the phone.

## Files

- Plugin: `plugins/kanborg-connect-claude/wake/server.mjs`, `bin/kanborg-wake`, `.claude-plugin/plugin.json` (`mcpServers`, `channels`, `userConfig`).
- App candidate: `integration/claude-channel/coordinator-claude-channel.ts`.
- Tests:
  ```sh
  node --test plugins/kanborg-connect-claude/tests/*.test.mjs
  node --experimental-strip-types --test integration/claude-channel/coordinator-claude-channel.test.mjs
  ```
  The second command runs the adapter against the real plugin channel.
