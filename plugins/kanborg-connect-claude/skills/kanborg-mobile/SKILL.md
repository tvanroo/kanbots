---
name: kanborg-mobile
description: Set up and verify Claude on iPhone access to KanBorg through the user's Mac running Claude Desktop (or Claude Code) and its existing paired KanBorg MCP connection.
---

# Claude on iPhone to KanBorg on Mac

Use a supported Mac-hosted route, so the phone reaches the Mac's local tools: Claude iOS → a Claude session running on the Mac (Claude Desktop/Cowork tasks sent from the phone, or a Claude Code Remote Control session) → the existing paired KanBorg MCP → KanBorg.

Feature names, labels and availability vary by plan and rollout. Check Claude's current help documentation (support.claude.com, code.claude.com/docs) for the phone-to-desktop and Remote Control features before giving steps, and say so if a label differs.

1. Verify KanBorg is running with the intended workspace and that the Mac session can read `getCapabilities` and the selected workspace. Do not use an unrelated open workspace for writes.
2. Guide the owner to enable the Mac-hosted route in Claude Desktop (or start a Claude Code Remote Control session in a folder on the Mac) and sign in to the same Claude account on the phone. Let the owner approve any device or folder access prompts. Never extract or reproduce pairing or session credentials.
3. In the Claude iOS app, choose the Mac-hosted session or task route. The Mac must remain awake, online and running Claude Desktop (or the Claude Code session) and KanBorg.
4. Ask the owner to send a harmless status request from the phone. Read the selected KanBorg workspace and return its current status. Record phone-to-host acceptance only after the owner confirms receipt on the phone.
5. Exercise a reversible board action only within the user's authorized scope and verify its receipt. Report exactly which controls were tested. MCP availability does not imply every UI-only setting is exposed.

The Mac host supplies its local tools, plugins and permissions. This workflow does not require publishing the loopback KanBorg bridge to the internet, a new hosted MCP server, or a separate iOS app. Ordinary cloud-only Claude chats (claude.ai web or mobile without a Mac-hosted route) do not have the Mac's local KanBorg tools; do not assume they do.

Phone access and desktop-chat wakeup are separate features. Successful mobile access does not prove KanBorg can initiate a Claude turn. Use `kanborg-handoff` for ownership transfers and report unsupported wakeup explicitly.
