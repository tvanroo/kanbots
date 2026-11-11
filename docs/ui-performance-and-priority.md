# UI responsiveness and waiting-work priority

## Diagnostics

The desktop app writes local aggregate performance samples every 10 seconds to
`diagnostics/performance.jsonl` under its existing user-data directory. On macOS,
KanBorg → Show performance diagnostics opens that folder. Include the current and
`.previous` files when investigating lag, together with the approximate time and
screen/action affected. Samples contain the app version and process ID.

Recorded measurements:
- Main-process event-loop p99 and maximum delay, memory RSS.
- IPC request count, total/max duration, slow calls (100 ms+) and failures by channel.
- Current and peak outstanding IPC requests, including requests still waiting.
- Maximum visible-renderer long-task, interaction duration and timer delay per sample.

Renderer timing support depends on Chromium; hidden-window samples are suppressed.
Sleep/resume and debugging can affect timing, so correlate symptoms with the timeline.
IPC timings are handler duration, not pure CPU time. Renderer measurements are maxima,
not counts or percentiles. No prompts, replies, DOM text, input text, request arguments,
response bodies, or error messages are recorded. Logging uses asynchronous writes;
files rotate at 2 MiB, retaining one previous file. Collection has bounded label and
message sizes; logging failure does not block app work.

Static investigation found overlapping coordinator polling and unnecessary persistence
on workflow reads. Reads now persist only when they materialize previously unseen cards.
This is a targeted improvement, not proof that the reported production lag is resolved.
A production trace remains necessary to identify the dominant bottleneck.

## Priority

Running cards stay pinned above waiting cards. Drag waiting cards vertically within a
stage; upper/lower halves insert before/after the target. Dropping onto running work
places the card first among waiting work. Dropping onto the stage background places it
last. Successful edits select Manual sort. Other sort modes remain available as views.
To change stages, drop onto the destination stage background.

The order is saved as workflow `stageOrder` and exposed in coordinator session
`stagePriority`. Both the app and MCP `updateWorkflowCard` use the same mutation:
`priorityStage` plus `beforeNumber` (null means last). Standard coordinator authority,
revision checks and request idempotency remain in force. Active workers cannot be
reordered. Stale stage/target references are rejected. Card evidence, entry time,
identity and worker ownership remain intact; priority edits leave a history record.
Queued assignments consume this order within each stage without rearranging other
stages' queue positions. Coordinators are instructed to honor it for eligible work;
priority does not authorize dispatch or override dependencies, gates or wind-down.

Validation: unit and coordinator integration tests cover persistence/reload, shared
app/MCP edits, null validation, running-worker protection and queue ordering. Isolated
browser checks exercise actual upward/downward dragging and pinned running cards with
synthetic data. No production worker or live board was changed during validation.
