# Major overhaul completion contract

Owner requested full implementation and deployed acceptance, November 12, 2026.

## Required work

- Optional local encrypted secrets: write-only entry, scoped consumers, external root key, versioned staged rotation/rollback, revocation, metadata/audit, verified backup/recovery and optional BSM adapter. Never automatically migrate existing credentials.
- Durable task checkpoints and compact evidence receipts; explicit worker capability/authority transitions.
- Dependency-aware concurrency with reservations and duplicate prevention.
- PR/release lifecycle from independent review and checks through exact runtime and functional acceptance; serialize deployments and preserve existing owners.
- Stable request IDs for side effects and recovery after uncertain responses.
- Explicit provider/GitHub access states, bounded retries, delta events and actionable blockers.
- Metrics for utilization, duplicates, recovery, PR age, stage latency and verified delivery.
- Failure injection: lost responses, duplicates, stale review head, rate limits, restart, event ordering and wrong runtime SHA.
- Build, sign, notarize, publish, install, restore workflows and verify app interactions.
- CardBox workflow 43259186068 passed for intended main 143eb8c3461e18ee4fccade379c86ff3887006b3. Deployment workflow 43275539475 was observed in progress on that exact revision; runtime and functional acceptance remain unverified. GitHub access has recovered. Preserve question 98, Autopilot off and paused schedule.

## In-progress implementation

Local vault core uses SQLite with AES-256-GCM per-version data keys wrapped by an external root key. Owner initialization may store an OS-encrypted root-key envelope separately from the database; deployments can inject the root key. Metadata reads do not reveal values. Scoped trusted main-process callback leases zero buffers on completion/timeout; these are not a sandbox for an untrusted consumer and cannot revoke a copy already taken by a trusted consumer. No arbitrary shell-command or MCP value delivery is provided.

Tests currently cover staged rotation, retained rollback, wrong project/consumer, lease expiry, buffer clearing, revocation, wrong root-key rejection, ciphertext-at-rest and restoring a SQLite backup with the original key. App entry, verified recovery packages with retained rollback, read-only MCP status and owner-mediated MCP activation/revocation/recovery requests are wired. Cancelled native recovery stays pending. External-key restore requires the original injected key. Remaining: optional BSM adapter, remote entry handoff, rendered provider-vault UI verification and further failure-injection tests. Provider binding is implemented below. Coordinator regression suite: 92 passing; synthetic vault tests: 4 passing; routing suite: 15 passing. The alternate GitHub connector returned 404 for workflow 43259186068; this is not evidence that the run completed or disappeared. No production secret has been created or migrated; this development version is not released.

## Dispatch and publication recovery

Dispatch reserves worker capacity before asynchronous preparation. Reservations survive restart and block duplicate task starts. `reconcileDispatch` adopts a single newly recorded worker or clears a reservation only when no worker was recorded. Concurrent dispatch and lost-response/restart tests pass.

Release validation now reserves the workspace release slot before revision reads. Interrupted read-only validation restores its prior state; uncertain side effects block subsequent publication. `reconcileRelease` reads exact merge parents or matching PR plus remote branch SHA without repeating publication. A completed release plan means its merge or draft PR completed, never deployment or functional acceptance. Concurrent release and mismatched/exact merge-parent tests pass. Lost PR response coverage verifies restart reconciliation, rejection of mismatched remote revisions and no repeated push or PR creation. Rendered recovery controls remain to be verified.

Provider preflight failures release unused charge reservations; ambiguous network outcomes retain them. Repeated/missing pagination cursors stop refresh while retaining prior verified model/cost readings.

## Answered question continuity

Owner reported answered cards disappearing on text submission. The UI now requests answered history and retains the submitted card. Durable history includes the answer, coordinator delivery state, originating-chat link and a saved response supplied through `recordUserQuestionResponse`. Default pending-only queries still keep sidebar counts accurate. Regression coverage verifies retained answers and responses across restart and rendered history after refresh.

## Latest verification

All 204 desktop tests passed under the packaged Electron runtime (synthetic fixtures). The Questions component was rendered with application styles in isolated headless Chrome at 1280x900 and 390x844: text submission, answer/response visibility after reload, originating chat and return navigation passed without console errors or framework overlays. This uses a mock desktop bridge; it does not prove installed-app IPC or live coordinator response delivery. Screenshots and fixture scripts are outside the repository in /private/tmp. Full dependency and desktop build passed before the latest metrics addition; rebuild before packaging.

## Provider vault binding

Provider settings now offer explicit selection of an active project vault entry scoped to `api:openai` or `api:anthropic`. Existing OS-encrypted keys remain the default and are not migrated. Saving a vault selection validates its active state and consumer, invalidates the old account/model observations, and persists only a reference. Model discovery and inference resolve that reference in the main process; values never return through metadata/MCP. Main-process HTTP consumers necessarily create in-memory header strings, so buffer clearing is not a guarantee of immediate erasure of every string copy. Disabling/revoking the selected version prevents subsequent reads. Changing away from the vault requires a replacement key. Metadata-only edits from older clients preserve the reference. Concurrent saves are checked after asynchronous validation. Sixteen routing tests, desktop/web typechecks and a full build passed; no live credential was migrated or used in these tests.

## Owner entry and final regression pass

`requestSecretEntry` accepts only name, consumer and reason. The app embeds a write-only vault form in the owner request; verification requires a new matching staged or active version and returns metadata only. Existing entries cannot satisfy a new request accidentally. Recovery re-verifies the staged copy after owner confirmation before swapping directories, preventing a changed backup from replacing the working vault. All 204 desktop tests pass under the packaged Electron runtime; desktop and web typechecking pass. No real credential or running workspace was mutated by this pass.

## Published 1.2.45 acceptance status

Source dd404c82706c023e3755f741a456475f3f81ec7e was published as v1.2.45 with the DMG and update manifest. DMG SHA-256: 4c56bfe9e2003a40c2255cbbbf6af67a6c6a1973f37ca669312e4715c13947ac. Apple notarization, staple validation and Gatekeeper acceptance passed. Packaged launch, renderer bridge and synthetic update workspace restoration passed. The installed app accepted update request 60925b19-71f5-40c4-b4b2-482a45458d29; installation is waiting for safe worker checkpoints. Do not infer installed acceptance from publication. Current live ownership and paused schedules are retained; question 98 has a queued owner answer and must not be discarded.

## Persona stage assignments and visual release gate (in progress)

Owner added explicit workspace persona assignment for Review (Code Reviewer) and Release / Verification (Release Steward), with separate automatically handed-off agent runs and existing release authority retained. Settings now opens the shared persona editor in management-only mode. Workflow stages store persona IDs; app and MCP deletion reject assigned personas, and rename continuity is regression-tested. Automatic stage dispatch is implemented with saved persona prompt/version, durable entry identities, shared capacity reservations, exact prior revision and evidence references, update/handoff pauses, and lost-start reconciliation. The two-stage synthetic test verifies separate reviewer/steward runs and no duplicate on restart. Real CardBox two-stage acceptance remains incomplete.

Every changed UI surface must undergo rendered visual inspection using the actual app styles at desktop and narrow widths before release, in addition to interaction checks. The local vault has been restyled with shared buttons, theme tokens, spaced labels and responsive inputs. Synthetic vault initialization, entry clearing, activation and revocation passed; desktop and narrow screenshots were inspected. These changes are not yet packaged.

Installed 1.2.45 was verified by getApplicationUpdate as completed at 2026-11-12T18:11:46.150Z. CardBox controller remained fb6a8e0e-bdce-4f9c-8530-38c5fa3810e0; Autopilot and the confirmed schedule remained paused, and question-answer:98 remained queued. CardBox deployment 43275539475 completed successfully for 143eb8c3461e18ee4fccade379c86ff3887006b3; runtime and functional acceptance are still separate open gates.

## 1.2.46 candidate verification

Candidate source df5581f91f4e89fac0fb41b64e292f7d386fe296 includes editable stage personas, protected deletion and the branded vault surface. All 208 desktop tests passed (including 99 coordinator tests). Type checks and dependency/desktop build passed. Signing/notarization is running under the existing bounded helper; no published or installed 1.2.46 claim yet.

CardBox deployment workflow success was inspected at log level: 43275539475 retained status `held`, blocker `catalog-api:scoped_gate_open_pre_activation`, compatibility `release_manager_digest_review_required`, and `catalog_maintenance_held` / `108_requires_catalog_maintenance`. Thus workflow success does NOT prove activation of 143eb8c3461e18ee4fccade379c86ff3887006b3. Existing owner-designated release authority must resolve the maintenance and digest gate; no duplicate deployment was started.

## 1.2.47 release verification

1.2.46 was published (df5581f91f4e89fac0fb41b64e292f7d386fe296), with Apple notarization and packaged persona edit/restart checks. The installed application remained 1.2.45 before the next update request.

1.2.47 source 682f1485e2b5138013cbf015b31f1990f92ef565 separates unanswered questions from retained answer/response history. Component interaction/reload/history and regression checks passed. Actual packaged Questions count/empty state passed at desktop and narrow widths; narrow rendering was inspected. Packaged update recovery restored its synthetic workspace and healthy receipt. Apple notarization and Gatekeeper passed. Installer SHA-256 3078955c48a1afb6c19c57596f04a04bf41d5bc0571f544bd272e0ac591228c8. Live update request install-kanborg-147-questions-history-20261112 was accepted; installed acceptance remains pending. Autopilot/schedule remain paused and question-answer:98 retained.

Packaged testing also exposed an unrelated saved-view delta serialization issue (Missing activeViewId). The Questions mismatch itself was a test selector reading hidden Board state and passed after scoping it to Question views. Investigate the preference delta contract separately; do not treat its repeated retries as harmless completion.

Installed 1.2.47 acceptance: getApplicationUpdate returned currentVersion 1.2.47 and completed update 53aa64a3-bad4-421d-b310-ee5ada591a85 at 2026-11-12T18:33:48.937Z. Re-read confirmed the same controller, Autopilot paused, confirmed schedule paused, and question-answer:98 queued. Post-update resume request reconciled with the explicit owner holds, recorded in coordination summary; no worker redispatch. Published release: https://github.com/tvanroo/kanbots/releases/tag/v1.2.47 . Full overhaul acceptance remains open.

## Live persona setup acceptance (2026-11-12)

Through installed 1.2.47 Settings → Personas, created Code Reviewer with an independent exact-revision review prompt and saved Release Steward v2 with direct routine handoff guidance and preserved release authority. Through Settings → Workflow, previewed seven affected cards and saved version 8 assigning Review to custom:d8aedff2-e1a3-4e79-986a-5caa83ed2608 and Release / Verification to cardbox:release-steward. MCP getWorkflow/listPersonas confirmed both saved IDs and prompts. Existing worker identities were not changed or dispatched. This proves live editor/save and shared MCP readback, NOT two-run handoff acceptance.

Remaining persona acceptance risk: current CardBox Review → Release transition is manual, while stage dispatcher starts on a recorded stage transition. Confirm that the assigned worker has a scoped way to record its review disposition and initiate that allowed handoff without coordinator relay; a generic successful run must not be treated as approval. No transition gates were relaxed to manufacture acceptance.
