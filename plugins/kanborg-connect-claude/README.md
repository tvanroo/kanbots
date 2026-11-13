# KanBorg Connect for Claude 0.3.0

Claude Desktop (and Claude Code) edition of the `kanborg-connect` companion plugin. It gives Claude the same KanBorg workflows as the Codex/ChatGPT plugin, so the KanBorg app on your Mac can be operated from either harness through the same paired local MCP connection.

The KanBorg tools come from KanBorg's own local MCP server (`kanborg-mcp`), which the app installs and pairs. The plugin adds the workflows plus `kanborg-wake`, a local Claude channel that lets KanBorg start a turn in an existing Claude session. No KanBorg credentials are bundled.

## Install

1. Add the marketplace and install the plugin:
   - Claude Desktop: Settings → Plugins (or Customize → Plugins) → add marketplace `tvanroo/kanbots`, then install **kanborg-connect**.
   - Claude Code: `/plugin marketplace add tvanroo/kanbots` then `/plugin install kanborg-connect@kanborg`.
   - Before this branch merges, use a local checkout: `/plugin marketplace add /path/to/kanbots`.
2. Connect KanBorg once. In KanBorg → Coordinators, add a connection named "Claude Desktop" and copy its **Claude Desktop and generic JSON MCP clients** configuration into `~/Library/Application Support/Claude/claude_desktop_config.json` (Claude Desktop → Settings → Developer → Edit Config). Keep your other servers. Restart Claude Desktop and approve the pairing in KanBorg. The `kanborg-setup` skill walks through this and checks the connection.
3. To let KanBorg wake a session, set the plugin's `kanborg_connection_id` to the same connection ID and start Claude Code with the channel: `claude --dangerously-load-development-channels plugin:kanborg-connect@kanborg`. Then ask Claude to watch the project. See the `kanborg-wake` skill.
4. Ask Claude: "Connect to my KanBorg app, show its projects and supported operations, and help me manage my work from this chat."

## Parity with the Codex/ChatGPT plugin

| Codex `kanborg-connect` 0.2.0 | Claude `kanborg-connect` 0.2.0 | Differences |
| --- | --- | --- |
| `kanborg-coordinate` | `kanborg-coordinate` | Same discovery, ownership, acknowledgement, dispatch, evidence and monitoring rules. Recurring monitors use Claude Desktop scheduled tasks (or Claude Code `/loop`) instead of Codex heartbeats. |
| `kanborg-handoff` | `kanborg-handoff` | Same outgoing/incoming checkpoint protocol. Covers Claude ↔ KanBorg and Claude ↔ ChatGPT/Codex transfers. KanBorg's verified wake adapter is Codex-only, so idle Claude chats use manual continuation or one scheduled check. |
| `kanborg-mobile` (ChatGPT iOS → Mac) | `kanborg-mobile` (Claude iOS → Mac) | Uses Claude's Mac-hosted phone route (Claude Desktop tasks from the phone, or Claude Code Remote Control) instead of ChatGPT Remote. |
| `kanborg-projects` | `kanborg-projects` | Same any-chat project selection, multi-project, settings and capability-gap rules. |
| Wake via `codex-cli-queue-v1` (app side) | `kanborg-wake` skill + `kanborg-wake` channel | Watch mode wakes the session today; push mode pairs with KanBorg's `claude-channel-v1` adapter ([app handoff](../../docs/kanborg-claude-wake-handoff.md)). Needs a Claude Code session started with the channel enabled. |
| Relies on separately configured MCP | `kanborg-setup` | New: pairing steps for Claude Desktop/Claude Code, using the config KanBorg already generates, plus troubleshooting for the launcher's errors. |
| `references/receiver-protocol.md` | `references/receiver-protocol.md` | Same receiver steps; adds which adapters can and cannot reach Claude. |
| `references/chat-project-control-contract.md` | same file | Unchanged copy of the owner contract. |
| `references/two-way-design.md` | not included | Codex-specific history of the CLI queue investigation. |
| KanBorg icon | `assets/kanborg-icon.png` | Same asset. |

Both plugins can be installed at once. Each harness pairs as its own KanBorg connection, and KanBorg's single-controller rules decide which one coordinates a workspace at a time.

## Delivery status

- Implemented here: six skills with capability checks, single-controller handoff rules, delivery-state distinctions, mobile, setup and wake guidance; the `kanborg-wake` channel server (watch and push inbox).
- Depends on: an owner-paired KanBorg MCP connection on the Mac (KanBorg 1.2.24 or later for the receiver tools).
- Needs the app change: push wakes with durable receipts (`claude-channel-v1` adapter; candidate module in `integration/claude-channel/`).
- Host limit: channels are a Claude Code research preview; ordinary Claude Desktop/Cowork chats are not documented to load them, so they cannot be woken.
- Not implemented: full application tool coverage or automatic pairing. These are app features.
- Not verified yet: a live wake on the owner's Mac (acceptance tests in the app handoff), a live `getCapabilities` round trip from Claude, coordinator transfer between Claude and Codex, and phone acceptance.

## Tests

```sh
node --test plugins/kanborg-connect-claude/tests/*.test.mjs
node --experimental-strip-types --test integration/claude-channel/coordinator-claude-channel.test.mjs
# Also check tool names against a KanBorg source checkout:
KANBORG_MCP_SOURCE=/path/to/kanbots/packages/mcp/src node --test plugins/kanborg-connect-claude/tests/*.test.mjs
```
