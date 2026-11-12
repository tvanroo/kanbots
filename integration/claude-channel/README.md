# Claude channel adapter integration candidate

`coordinator-claude-channel.ts` is an isolated `HostAdapter` (`claude-channel-v1`) for the KanBorg desktop app. It delivers wake signals to existing Claude Code sessions running the `kanborg-connect` plugin's wake channel. It is not installed or registered by the plugin.

To integrate it, copy the module into `packages/desktop/src/` and register it with `coordinators.registerHostAdapter(createClaudeChannelAdapter())` after the Codex adapter. The full contract, required app changes and acceptance tests are in [docs/kanborg-claude-wake-handoff.md](../../docs/kanborg-claude-wake-handoff.md).

Verification (no real Claude session needed; runs against the real plugin channel):

```sh
node --experimental-strip-types --test integration/claude-channel/coordinator-claude-channel.test.mjs
```
