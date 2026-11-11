# Questions with actionable context

Questions link to the originating local thread and selected run. The conversation view includes original messages and paginated events, supports other runs in the same thread, and leaves the reply draft intact when closed. It is read-only and cannot execute a command.

Workers can include `commands` in `kanbots-decision` JSON; Claude and Codex parsers retain them in the durable question card. Each command contains `title`, exact `code`, `language`, `where`, and `expected`. The Questions UI shows the destination, snippet, Copy confirmation and expected output. Never put secrets into a question or command artifact.

Coordinators use `getUserQuestionContext` to inspect the same scoped history and `recordUserQuestionExplanation` to save an explanation plus optional commands. Explanations should briefly explain the requested action, its reason and each option's consequences. Internal sibling briefings and routing output are not explanations. Legacy raw-event explanation fallback is removed. Fenced snippets in saved question/explanation text are supported; a path alone is not treated as code. Questions requesting missing commands visibly offer to retrieve the instructions through the current coordinator, without executing them or answering the question.

Board stage buttons independently toggle visible columns; All stages restores all columns. Empty selection is explicit.

The parallel worker target accepts a positive safe integer instead of inconsistent four/eight-worker ceilings. App and MCP update the same saved workspace and Autopilot target. Lowering it does not kill active workers; queue refill waits until occupancy is below target. Update drain, ownership, quota and scope restrictions are unchanged.

## Performance evidence and persistence

Initial 1.2.43 diagnostics showed 16 of 43 samples with main-process stalls over one second, worst 6.3 seconds. Registry measured 213 MB, including about 193 MB of serialized completed request receipts. Synchronous full registry writes are a concrete source of avoidable work, not proof of every stall's cause.

1.2.44 moves completed results over 16 KB into private immutable receipt files and retains their digest/state/reference in the registry. Files are committed before the registry reference; restart retries return the original result. Missing or invalid references fail closed rather than rerunning mutations. Original outcomes are retained, not discarded. New numeric `coordinator-state-save` timings support post-install comparison.

Validation: 188 desktop tests, 76 dispatcher tests, typechecks and builds. Browser verified multiselect, none/all stage states, exact clipboard text, source history/run navigation and draft preservation. Existing requested concurrency is not raised automatically.
