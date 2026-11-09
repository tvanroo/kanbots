# Coordinator app controls

KanBorg 1.2.37 extends the paired local MCP connection with typed app controls. `getControlCoverage` lists direct operations, legacy UI equivalents and owner-mediated actions. The bridge inventory regression test rejects new app API channels without a coordinator route or an explicit equivalent.

## Shared state

Task templates, archives, relationships, reviews, scripts, budgets, provider metadata and funding balances use the same handlers as the app. Provider operations use the device-level provider store. Appearance, diff preferences and saved board views are durable per-project configuration; app changes and MCP changes synchronize with version checks. Persona edits preserve current selections and running assignments.

Execution, QA, Autopilot and releases continue through the coordinator contract. Legacy dispatch and release buttons are mapped to those operations instead of introducing a second execution path. Update wind-down blocks new execution through the added controls too.

## Authority and receipts

Reads require the paired workspace. Writes require its current controller, a current revision and a stable request ID. Duplicate requests return the original receipt, including after restart. Interrupted approval execution becomes uncertain and is not automatically replayed.

`requestOwnerAction` creates an exact pending request visible in Project coordinator. Pairing, revocation, host binding approval, owner-reserved release approval, sharing an existing device chat, adding a repository/folder, removing a worktree, configuring/removing provider credentials and opening a different project require the owner action. Requests do not approve themselves. Provider setup opens the existing settings UI and verifies the resulting connection; secret values are never accepted by these MCP schemas.

## Saved chats and project lifecycle

Saved chats use the device-chat service used by the app. A project connection can access only chats created through it or explicitly shared by the owner. Session and run operations verify their conversation before acting. Deleting a session, stopping a run and sending a continuation never create a replacement conversation.

`openScopedWorkspace` can reopen only the already-paired project. Opening a different project requires an owner request and does not expand the original pairing. Closing/switching waits for active workers to finish; returned accepted delivery is distinguished from actual open state. Verify with `listWorkspaces`.

Native file selectors have typed path equivalents. Source inspection is bounded, rejects paths and symlinks outside the paired project and excludes known credential/internal-state paths. Worktree removal requires owner confirmation, rejects active ownership, locked/main worktrees and dirty work.

## Verification scope

Tests cover schema/handler alignment, API channel inventory, current authority, stale revisions, durable duplicate receipts, handoff, update wind-down, uncertain approvals, chat sharing, preference persistence, project reopening and source-path containment. This does not imply every third-party provider, editor or remote service was exercised live. Provider sign-in remains successful only after its own verification succeeds.
