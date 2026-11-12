---
name: kanborg-setup
description: Connect Claude Desktop (or Claude Code) to the KanBorg app on this Mac through KanBorg's paired local MCP server, and verify the connection. Use when KanBorg tools are missing, pairing is requested, or the connection fails.
---

# Connect Claude to KanBorg

The KanBorg tools come from KanBorg's own local stdio MCP server, which the KanBorg app installs and pairs. This plugin adds workflows plus one local server of its own, `kanborg-wake`, that only wakes this session (see `kanborg-wake`). It bundles no KanBorg credentials.

## Check first

1. Look for KanBorg tools in this chat (for example `getCapabilities`, `listWorkspaces`). If they are present, call `getCapabilities` and report the app version and integration contract. Stop here: the connection already works. Do not re-pair.
2. If the tools are absent, the Mac's Claude Desktop has no `kanborg` MCP server configured, or it failed to start. Continue below.

## Pair once (owner action in KanBorg)

Pairing is installation-level and persists across app, Claude and Mac restarts. The owner approves it in KanBorg; never approve your own pairing or fabricate an approval.

1. Ask the owner to open KanBorg → **Coordinators**, add a connection for this harness (name it, for example, "Claude Desktop"), and select the workspace.
2. In that connection's configuration, the app shows **Claude Desktop and generic JSON MCP clients** — a block shaped like:

   ```json
   {
     "mcpServers": {
       "kanborg": {
         "command": "/Users/<you>/Library/Application Support/Kanbots Local/kanborg-mcp",
         "args": [],
         "env": { "KANBORG_COORDINATOR_CLIENT": "<connection id>" }
       }
     }
   }
   ```

   Use the app's copy, not this example. The launcher path and connection ID come from KanBorg. The connection ID is a non-secret client identifier; the pairing token stays in KanBorg's local data directory and is loaded by the launcher. Never read, print or copy files from `coordinator-clients/`.

3. Add the `kanborg` entry to Claude Desktop's config, preserving every other server:
   - macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
   - Or Claude Desktop → Settings → Developer → Edit Config.
   - For Claude Code: `claude mcp add-json kanborg '<the kanborg object>' --scope user`.
   If you have file tools on the Mac and the owner asked you to configure it, merge the entry yourself; otherwise give these steps concisely. Do not overwrite unrelated servers.
4. Restart Claude Desktop (quit fully, reopen). MCP servers load at startup.
5. Approve the pending pairing in KanBorg if it asks. Call `getCapabilities` and report the app version and the connection's scope before claiming success.

## Troubleshooting

| Symptom | Meaning | Action |
| --- | --- | --- |
| `Pair in KanBorg Coordinators` | Connection not approved, revoked, or wrong ID | Approve or recreate the connection in KanBorg; copy fresh configuration |
| `Open KanBorg and check coordinator pairing.` / `Invalid local endpoint` | App not running or endpoint not published | Start KanBorg; retry once |
| `Invalid paired client` | `KANBORG_COORDINATOR_CLIENT` is not the app's UUID | Recopy the configuration |
| Tools missing after config edit | Claude Desktop not restarted, or JSON invalid | Validate the JSON, restart Claude Desktop |
| Only legacy tools (`listIssues`, `dispatchAgent`…) | Server started without a coordinator client | Use the Coordinators configuration, not an old bridge URL/token snippet |

Remote-only connector screens (claude.ai web "custom connectors") cannot run this local command. Do not expose KanBorg's loopback port publicly to work around that; use Claude on the Mac, or the Mac-hosted phone route in `kanborg-mobile`.

To let KanBorg wake chats, also put the same connection ID in the plugin's `kanborg_connection_id` setting and start Claude Code with the channel enabled; see `kanborg-wake`.

Once connected, use `kanborg-projects` for projects/settings, `kanborg-coordinate` for running work, `kanborg-handoff` for coordinator transfers and `kanborg-mobile` for phone access.
