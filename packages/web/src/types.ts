// Web-side type aliases. The canonical types live in `@kanborg/api`
// (re-exported from `@kanborg/local-store` and `@kanborg/core`); this
// module re-exports them under the names the renderer was already
// using and adds a few view-only types.

import type {
  Comment,
  DecoratedIssue,
  IssueActiveRunPayload,
  IssueDetail as ApiIssueDetail,
  PreviewState,
  PreviewStatePayload as ApiPreviewStatePayload,
  ThreadPayload,
} from '@kanborg/api';

export type { IssueRelationPayload } from '@kanborg/api';

export type {
  AgentCheck,
  AgentEvent,
  AgentEventType,
  AgentKey,
  AgentRun,
  AgentRunStatus,
  AutopilotCheckCommand,
  AutopilotChildEntry,
  AutopilotChildKind,
  AutopilotChildStatus,
  AutopilotConfig,
  AutopilotKind,
  AutopilotPersonaSnapshot,
  AutopilotPlanningEvent,
  AutopilotPlanningSlot,
  AutopilotSession,
  AutopilotStatus,
  Card,
  CardStatus,
  CardTemplatePayload,
  CardType,
  ChatConversation,
  ChatPayload,
  ChatPostMessageResult,
  ChatSessionPayload,
  ChatSessionStatus,
  CheckKind,
  Comment,
  Config,
  CostBreakdownItem,
  CreateIssueInput,
  DecisionPayload,
  DiffFile,
  DiffFileStatus,
  DiffPayload,
  DraftedIssue,
  DraftedPrDescription,
  Message,
  PendingDecisionPayload,
  PrCommentPayload,
  PrCommentsListResult,
  ProviderConfigPayload,
  ProviderId,
  OpenAIReporting,
  CodexSubscriptionUsage,
  AnthropicReporting,
  ApiConnection,
  ApiConnectionInput,
  ProviderSaveInput,
  ProviderSettingsInput,
  ProviderSettingsPayload,
  ProviderTestConnectionResult,
  ProvidersPayload,
  ReviewCommentPayload,
  Role,
  SentryConfigInput,
  SentryConfigPayload,
  SentryImportStatus,
  SentryMetaPayload,
  SentrySuggestion,
  SentrySuggestionCategory,
  SentrySuggestionConfidence,
  SentrySuggestionVerdict,
  SentrySyncResult,
  SentryTestConnectionResult,
  ShipCommitResult,
  ShipMergeResult,
  ShipPRResult,
  ShipStatus,
  SlashCommandPayload,
  StatusKey,
  UpdateIssuePatch,
  Workspace,
  WorkspaceAcpCommandBridgePayload,
  WorkspaceBudgets,
  WorkspaceFolderPayload,
  WorkspaceHouseRules,
  WorkspaceRepoPayload,
  WorkspaceRepoStatus,
  WorkspaceScriptsBridgePayload,
  WorkspaceRunScriptResult,
} from '@kanborg/api';

// User shape isn't in @kanborg/api directly — it's the inline type on
// `Comment.user` and `Issue.user`. Pull it off Comment for convenience.
export type User = Comment['user'];

export type IssueState = 'open' | 'closed';

// In the UI, `Issue` always means the decorated issue (with status,
// agent, activeRun) — the renderer never sees the bare GitHub Issue.
export type Issue = DecoratedIssue;

// Same convention: the renderer-facing active-run shape is the payload
// shape from the bridge, not the wider supervisor `AgentRun`.
export type IssueActiveRun = IssueActiveRunPayload;

export type Thread = ThreadPayload;
export type IssueDetail = ApiIssueDetail;

// Web's preview UI strictly types `state` to the live state union; the
// bridge keeps it as `PreviewState | string` for forward-compat. Narrow
// here for renderer code.
export interface PreviewStatePayload extends Omit<ApiPreviewStatePayload, 'state'> {
  state: PreviewState;
}
