# Coordinator modes and MCP expansion plan

Status: original design baseline, inspected at 0b27f46 on 2026-11-05. The 1.2.0 local implementation covers the core stages below; see [coordinators.md](coordinators.md) for delivered behavior and limits. Items described as proposed here are not a claim that every extension shipped. Hosted service work remains deferred.

## Product contract

Kanbots is the durable project and worker execution system. A coordinator translates the human's intent into work, monitors outcomes, requests decisions, and manages releases. The coordinator can be either an external MCP-aware harness or a chat thread inside Kanbots. Both use the same coordination service, tools, work queue, evidence, permissions, and routing policy.

A persisted coordination session records workspace, objective, task graph, decisions, current controller, revision, policies, spending limits, event cursor, and release state. Mode is internal or external. One controller holds a renewable lease for a session; it does not lock the whole app. Observer clients may read concurrently. UI edits remain possible and produce revision conflicts/events. Explicit handoff checkpoints the summary, revokes the old controller's write authority, and transfers ownership. Losing the controller does not kill already authorized workers or silently activate another coordinator. The app may continue an explicitly approved finite pipeline; new scope or release decisions wait for the controller/human.

The internal chat is a supported coordinator, not a second hidden planning agent under an external harness. Give it coordinator capabilities only when its session owns the lease. Worker runs receive narrower task-bound capabilities. The existing autopilot must obey the same ownership and scheduling rules.

## Original implementation evidence (before 1.2.0)

- packages/mcp/src/index.ts exposes 17 tools: listIssues, getIssue, createIssue, updateIssue, moveIssueStatus, archiveIssue, splitIssue, dispatchAgent, stopAgentRun, listAgentRuns, resolvePendingDecision, listPendingDecisions, listLearnings, pinLearning, deleteLearning, updateLearning, getPerformanceMetrics.
- packages/mcp/src/server.ts implements stdio forwarding to an HTTP localhost bridge. Results are pretty-printed JSON text; only tools capability is advertised, version is 0.0.0, and there are no resources, durable event cursors, or compact result contracts.
- packages/api/src/chat-tools-dispatch.ts maps this subset onto shared app handlers. Current dispatch accepts number/fromStatus/model; it does not expose persona, per-task budget, repo selection, or routing requirements. listAgentRuns requires an issue number. No getRunStatus or answerDecision alias exists despite the public guide.
- packages/api/src/tool-bridge.ts binds 127.0.0.1 on an ephemeral port, creates random bearer tokens, and revokes them in memory. Tokens grant all exposed tools and are not bound to a named client, run, role, or workspace authorization record.
- packages/desktop/src/main.ts starts the bridge for the active workspace and issues tokens in prepareForRun for internal chat. Closing/switching the workspace closes the bridge. Source search found no advertised Settings > MCP server external config/pairing controls.
- Runtime MCP config files can contain a bearer token without an explicit restrictive creation mode; cleanup revokes the token but leaves the file. The legacy Codex configuration builder embeds environment values into command arguments. External setup should not copy these patterns.
- packages/mcp/src/auth.ts inspects the upstream kanbots data directory for an optional cloud sign-in hint. This is not MCP client authentication and can misdiagnose local auth failures in Kanbots Local.
- The app already has handlers for run detail/diff/stats, comments/follow-up, review, checks, previews, relations, ship status/commit/merge/PR, and budget configuration. These are largely absent from MCP, so much work can reuse underlying services.
- Existing approve/requestChanges handlers mostly update card state. They do not constitute evidence-backed acceptance or a complete revise/retest workflow. Ship operations resolve an active/latest run by issue, not an immutable approved run/commit.
- The manifest advertises schemas, but the low-level MCP call handler does not apply those schemas. Dispatch performs partial manual checks and some downstream handlers validate with Zod; validation is not one consistent boundary. The HTTP bridge has no explicit request-size bound and does not handle malformed route decoding inside its error guard.

Public guide reviewed: https://www.kanbots.dev/docs/mcp-server . Treat source as authoritative where its examples differ (issueNumber versus number; children versus subtasks; in-progress versus inProgress; missing tools/setup screen).

## Pairing and authentication

Keep stdio as the initial portable transport for local harnesses. A stable bundled launcher discovers the running Kanbots Local instance and requests a client session. It uses the packaged runtime, so onboarding does not require a global Node installation or assume a CLI is on PATH. App updates must preserve launcher identity/path and pairing; an optional helper can launch the app after user-selected setup.

Add Settings > Coordinators: Add harness, select allowed workspaces and role, copy a non-secret config snippet, test connection, show last connection, revoke. First launch presents a pairing request in Kanbots with a short verification code matching the launcher, requested access, and the target workspace. Pairing credentials stay in protected local storage and are loaded by the launcher, never copied into model context, command arguments, or a repository. A client label is descriptive, not cryptographic proof of the calling app; local stdio authorization is possession-based, not an OAuth login to the user's LLM account. Do not promise isolation from a malicious process running as the same OS user without a stronger OS-backed mechanism.

Issue short-lived bridge sessions tied to the paired client, app instance, workspace scope, and role. Automatically reconnect after app restarts, without replaying uncertain mutations. Distinguish app closed, workspace unavailable, revoked pairing, expired session, incompatible protocol, and permission denied. Read-only health discovery exposes no credentials or project data. Keep provider credentials solely in Kanbots.

Roles: observer; coordinator (plan/edit/dispatch/inspect/answer ordinary questions); worker (own task progress/artifacts only); release authority (separately enabled). Human-required approvals cannot be resolved merely by supplying an arbitrary text answer or a claimed approved=true field. The app records a genuine human approval for an exact action/target/SHA; the harness can present the request and relay an app-authorized decision. Support optional MCP elicitation where verified, with an app approval page fallback.

No browser OAuth is necessary for the local stdio connection. If Streamable HTTP or hosted clients are added later, implement the MCP HTTP authorization model with audience-bound tokens and proper discovery; do not expose the current bearer bridge to a LAN.

## Tool surface

Use versioned typed services underneath both chat and MCP, with compact default output. Keep old tool names as compatibility adapters. Do not expose every renderer IPC operation blindly.

| Area | Proposed surface | Key requirements |
| --- | --- | --- |
| Discovery | getCapabilities, listWorkspaces, getWorkspaceSummary | Explicit workspace IDs, supported providers/features, version, permissions, no secrets |
| Coordination | createCoordinationSession, getCoordinationSession, claim/renew/releaseCoordinator, handoffCoordinator | Internal/external mode, lease, revision, persisted handoff summary |
| Planning | existing issue tools plus addComment, setDependencies, upsertPlan | Acceptance criteria, task kind, prerequisites; idempotent batch creation with per-item results |
| Execution | dispatchTask, followUpRun, stopRun, listRuns, getRun | Async run handle; budget, time limit, role (implementation/review/QA), routing=auto, capability requirements, concurrency policy |
| Observation | getChanges, waitForChanges, getRunResult | Bounded long-poll, cursor and pagination, compact changes and next actions, no full log by default |
| Evidence | getArtifact, getDiffSummary, readLogExcerpt | Paged artifacts/links, source commit, file changes, actual checks, failures, reproducible commands |
| QA | startReview, runChecks, getChecks, requestChanges | Bind review/checks to implementation SHA; verified worker capabilities; rerun when code changes |
| Decisions | listDecisions, answerDecision, requestApproval | Separate ordinary questions from privileged human approvals; expected revision and decision identity |
| Capacity | getCapacity, explainRouting | Safe quota/cost snapshot with source/freshness/confidence; never provider keys or token-bearing configs |
| Release | prepareRelease, getReleaseStatus, executeRelease | Plan exact commits/target/actions first; enforce approval and current SHA before mutation |

The coordinator chooses quality/capability needs and authorized spending, not individual provider priorities. Kanbots chooses the subscription/key/model underneath. Initial capability categories are requirements, not promises of benchmark-ranked intelligence. Unsupported browser/device QA must be reported before dispatch or as a blocker, not marked passed.

## Token efficiency and continuity

Return a receipt immediately for dispatch. A completion capsule contains outcome, task/run IDs, commit, changed files summary, checks/evidence, unresolved risks/questions, actual/estimated spending with provenance, and recommended next action. Generate mechanical portions deterministically. If a narrative summary is needed, use Kanbots workers and their routed capacity.

getChanges(sinceCursor) reports only meaningful deltas: completed, blocked, decision required, capacity exhausted, release ready. waitForChanges has a bounded timeout below client limits and respects cancellation. Large logs/diffs are opt-in resources or paginated tools, with stable references and access checks. Tool output has schemas and structured content, with a small compatibility text representation. A coordinator prompt/resource teaches delegation, evidence review, and no unnecessary polling or transcript ingestion.

Use optional protocol notifications/tasks only after capability negotiation. Baseline clients work with ordinary async dispatch plus polling tools. An MCP server cannot guarantee waking an idle model or creating a new conversational turn in every desktop harness. Clients without background wake support can reconnect and retrieve deltas; explicitly authorized finite worker/QA pipelines continue locally while the coordinator is absent.

Persist event cursors and immutable run/artifact IDs. On restart reconcile running work; expose interrupted/unknown states rather than silently repeating a command. All mutating requests need an idempotency key scoped to client/workspace/action, with atomic dispatch reservation and a durable receipt. A retried request returns the original outcome. Conditional revisions prevent stale board updates; expected commit IDs prevent stale QA/release approvals. Multiple external harnesses may observe; only the session controller can change its execution plan.

## Hardening before trusting external coordination

- Validate one shared input/output schema at the server boundary; enforce tool and workspace scopes even if callers bypass tools/list.
- Bound body size, nesting, result size, request time, queue length, parallel runs, and spend. Add origin/host checks for loopback HTTP and strict route decoding; prohibit redirects or arbitrary bridge targets in the launcher.
- Use protected storage, restrictive runtime file permissions, token expiry and revocation; remove token-bearing files and command arguments. Redact secrets from all error/result/log paths.
- Log client/session/task/action/outcome and durable request IDs, without credentials. A local stop-all switch halts new dispatch and stops running workers under normal cleanup rules.
- Never give workers coordinator or release authority by default. Limit recursive dispatch and enforce task lineage if authorized child jobs are introduced. Repository instructions and tool output cannot grant permissions.
- MCP scopes alone do not sandbox shell workers. Inspect/enforce worker filesystem, process, network, and credential boundaries separately; test stop behavior for descendants. Do not claim a restricted MCP role prevents an unrestricted shell from accessing the same resources.
- Keep code completion, QA pass, human acceptance, merge, package, deployment, and live acceptance as distinct states. Build success is not release acceptance.
- Fix fork identity, real server version, documented schemas, packaging/launcher paths, and local error recovery before external onboarding.

## Delivery sequence and acceptance gates

1. **Reliable local connection and common coordinator identity.** Ship stable launcher, named pairing/scopes/revocation, explicit workspace IDs, shared session/mode/lease storage, discovery/health, schema/error fixes. Gate: two unrelated stdio clients connect; restart app without reconfiguration; denied clients cannot read or mutate; mode handoff prevents duplicate controllers.
2. **Complete delegate-and-observe loop.** Expose plan/comment/dispatch/follow-up/stop/result/evidence and capacity tools; add idempotency, compact capsules and cursor-based wait. Wire internal chat to the same service. Gate: either mode creates a task, routes work, handles a question, resumes, and receives a compact result; reconnect/retry does not create another run or spend twice.
3. **Development and QA pipeline.** Add dependency queue, configured parallelism, independently dispatched reviewer/QA runs, exact-SHA checks/artifacts and bounded rework. Gate: failing QA returns work to implementation; changed code invalidates old evidence; unsupported testing is explicit; the coordinator need not inspect verbose worker logs.
4. **Release-manager workflow.** Add prepare/approve/execute contracts over existing ship services; pin run/commit/target, stale-approval detection, draft PR/build outputs and durable receipts. Deployment is a separately configured action. Gate: approved exact revision ships once, stale or absent approvals cannot execute, and failure leaves a clear recoverable state.

First useful milestone is steps 1–2 with one implementation worker and a compact result. Do not start with hosted services, full MCP Apps UI, mandatory new protocol extensions, or a second automatic coordinator. Compatibility checks must use real packaged app builds, not just imports from the source tree.

## References

- Existing implementation: packages/mcp/src/{index,server,auth}.ts; packages/api/src/{tool-bridge,chat-tools-dispatch}.ts; packages/api/src/handlers/{index,issues,agent-actions,agent-runs,agent-checks,ship}.ts; packages/desktop/src/main.ts.
- MCP stdio versus HTTP auth: https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization
- Structured tools: https://modelcontextprotocol.io/specification/2025-06-18/server/tools
- SDK schema validation patterns (verify against pinned version during implementation): https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/servers/tools.md
- Optional durable tasks extension: https://tasks.extensions.modelcontextprotocol.io/

Assessment only: no external harness was paired, no secrets were accessed, no runtime configuration changed, and no new app was built for this planning task.
