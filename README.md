# KanBorg

**Many models. One mission. Any harness.**

KanBorg is a local development coordinator with a kanban board, workers routed across available LLM subscriptions and API capacity, and built-in or external MCP coordination.

Product domain: [kanborg.ai](https://kanborg.ai) (site not deployed by this rename).

## Local development

```sh
pnpm install
pnpm --filter @kanborg/desktop launch
pnpm --filter @kanborg/desktop release:mac:local
```

## Existing installations

KanBorg preserves the original fork application identifier and `Kanbots Local` data directory so saved connections, encrypted keys, boards and chats remain available. The `kanbots-mcp` launcher remains compatible; new connections use `kanborg-mcp`. Internal legacy IPC, environment variables and repository data paths remain supported. Install KanBorg alongside the upstream Kanbots app; quit the old Kanbots Local fork before opening KanBorg.

## Attribution

Forked from [leodavinci1/kanbots](https://github.com/leodavinci1/kanbots). Original copyright and license notices are retained. Upstream cloud services, where explicitly labeled, are not KanBorg services.

See [coordinator documentation](docs/coordinators.md).
