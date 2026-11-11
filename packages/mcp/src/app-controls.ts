import type {ToolDef} from './index.js';
const text={type:'string',maxLength:16000}, id={type:'integer',minimum:1}, flag={type:'boolean'};
const nullable=(schema:object)=>({anyOf:[schema,{type:'null'}]});
const strings={type:'array',items:text,maxItems:100};
const workspace={workspaceId:{type:'string'}};
const mutation={...workspace,requestId:{type:'string',minLength:8,maxLength:120},revision:{type:'integer',minimum:0}};
export type AppControl={tool:ToolDef;channel?:string;action?:string;write:boolean;startsWork?:boolean};
const controls:AppControl[]=[];
function add(name:string,description:string,target:string,write:boolean,properties:Record<string,unknown>={},required:string[]=[],startsWork=false){
 controls.push({tool:{name,description,inputSchema:{type:'object',additionalProperties:false,properties:{...(write?mutation:workspace),...properties},required:[...(write?['workspaceId','requestId','revision']:['workspaceId']),...required]}},...(target.startsWith('@')?{action:target.slice(1)}:{channel:target}),write,startsWork});
}
add('listArchivedIssues','Read archived work without changing it.','issues:list-archived',false);
add('archiveIssue','Archive a task through the same app handler. Preserve its retained work.','issues:archive',true,{number:id},['number']);
add('restoreIssue','Restore an archived task.','issues:unarchive',true,{number:id},['number']);
add('getRunStatistics','Read actual run statistics.','agent-runs:stats',false,{runId:id},['runId']);
add('listRunChecks','Read recorded checks and exact evidence.','agent-runs:checks:list',false,{runId:id},['runId']);
add('getCheckCommands','Read configured check commands.','agent-runs:checks:commands',false);
add('getRunPreview','Read preview state.','agent-runs:preview:get',false,{runId:id},['runId']);
add('startRunPreview','Start the configured preview for an existing run.','agent-runs:preview:start',true,{runId:id},['runId'],true);
add('stopRunPreview','Stop a run preview without stopping its worker.','agent-runs:preview:stop',true,{runId:id},['runId']);
add('listCardTemplates','Read reusable task templates.','card-templates:list',false);
const template={name:text,titleTemplate:text,bodyTemplate:nullable(text),labels:strings};
add('createCardTemplate','Save a reusable task template without starting work.','card-templates:create',true,template,['name','titleTemplate']);
add('updateCardTemplate','Update the same task template used in the app.','card-templates:update',true,{id,...template},['id']);
add('removeCardTemplate','Remove a task template; existing tasks remain.','card-templates:delete',true,{id},['id']);
add('reorderCardTemplates','Save task-template display order.','card-templates:reorder',true,{ids:{type:'array',items:id,maxItems:100}},['ids']);
add('createIssueFromTemplate','Create a task from a saved template without dispatching.','card-templates:instantiate',true,{id},['id']);
add('getUsage','Read subscription usage and separately recorded API spend.','cost:usage',false);
add('getUsageBreakdown','Read the app usage breakdown.','cost:breakdown',false);
add('getWorkspaceBudgets','Read worker and session budgets.','workspace:get-budgets',false);
add('setWorkspaceBudgets','Save owner-requested workspace budgets. Does not authorize new spending beyond owner scope.','workspace:set-budgets',true,{runCostBudgetUsd:nullable({type:'number',minimum:0}),sessionCostBudgetUsd:nullable({type:'number',minimum:0})},['runCostBudgetUsd','sessionCostBudgetUsd']);
add('getHouseRules','Read workspace house rules.','workspace:get-house-rules',false);
add('setHouseRules','Save requested workspace guidance. Does not expand tool authority.','workspace:set-house-rules',true,{houseRules:nullable(text)},['houseRules']);
add('getWorkspaceScripts','Read configured workspace scripts.','workspace:get-scripts',false);
add('setWorkspaceScripts','Save requested scripts without executing them.','workspace:set-scripts',true,{devServer:nullable(text),setup:nullable(text),cleanup:nullable(text)});
add('runWorkspaceScript','Execute an existing configured setup or cleanup script only within owner-authorized scope.','workspace:run-script',true,{kind:{type:'string',enum:['setup','cleanup']}},['kind'],true);
add('listWorkspaceRepos','Read repositories already associated with this workspace.','workspace:repos-list',false);
add('getRepoStatus','Read the status of an existing workspace repository.','workspace:repo-status',false,{repoId:id},['repoId']);
add('setRepoDisplayName','Rename an existing workspace repository display label.','workspace:repos-set-display-name',true,{id,displayName:nullable(text)},['id','displayName']);
add('setRepoTargetBranch','Set the branch used for future assignments, preserving running workers.','workspace:repos-set-target-branch',true,{id,targetBranch:nullable(text)},['id','targetBranch']);
add('listPullRequestComments','Read comments for a task’s linked pull request.','pr-comments:list',false,{issueNumber:id},['issueNumber']);
add('replyToPullRequest','Post an explicitly requested response to a task’s linked pull request.','pr-comments:reply',true,{issueNumber:id,body:text},['issueNumber','body']);
add('listReviewComments','Read run review comments.','review-comments:list',false,{runId:id,includeConsumed:flag},['runId']);
add('addReviewComment','Save a review comment against an exact file and line.','review-comments:add',true,{runId:id,filePath:text,lineNumber:id,side:{type:'string',enum:['old','new','context']},body:text},['runId','filePath','lineNumber','side','body']);
add('removeReviewComment','Remove a review comment through the app handler.','review-comments:remove',true,{id},['id']);
add('getProviderConfiguration','Read provider configuration and connection metadata; never credentials.','providers:get',false);
add('testProviderConnection','Test a configured provider using its stored authorization. No credentials accepted through MCP.','providers:test-connection',true,{id:{type:'string'}},['id']);
add('listUserQuestions','Read persistent questions, their originating threads, explanations and delivery state.','@questions-list',false);
add('replyToUserQuestion','Save an owner-provided answer and queue it to the current coordinator, with originating thread/run references. Does not interrupt workers. Do not invent owner consent.','@question-reply',true,{id,reply:text},['id','reply']);
add('explainUserQuestion','Ask the current coordinator to explain a question in the app without answering or interrupting its originating worker.','@question-explain',true,{id},['id']);
add('recordUserQuestionExplanation','Save the coordinator explanation in the persistent Questions inbox. Does not choose an answer.','@question-explanation-record',true,{id,explanation:text},['id','explanation']);
add('closeUserQuestion','Close an obsolete or already-answered question with evidence in the reason. Metadata only: never stops or resumes its worker.','@question-close',true,{id,reason:text},['id','reason']);
add('getCoordinatorChat','Read the built-in coordinator conversation and its queued messages.','@chat-get',false);
add('queueCoordinatorMessage','Queue a message in the built-in coordinator thread. Steer interrupts only that coordinator, preserving workers.','@chat-submit',true,{id:text,body:text,steer:flag},['body'],true);
add('editQueuedCoordinatorMessage','Edit a message that has not started delivery.','@chat-edit-queued',true,{id:text,body:text},['id','body']);
add('cancelQueuedCoordinatorMessage','Cancel a message before delivery starts.','@chat-cancel-queued',true,{id:text},['id']);
add('steerQueuedCoordinatorMessage','Inject an existing queued message by stopping only the built-in coordinator turn.','@chat-steer-queued',true,{id:text},['id'],true);
add('stopCoordinatorChat','Stop the built-in coordinator turn without stopping workers.','@chat-stop',true);
add('requestRepositoryDiscovery','Queue repository discovery for the current coordinator.','@request-discovery',true,{},[],true);
add('requestPerspective','Queue a one-time perspective review through the current coordinator.','@request-perspective',true,{name:text,prompt:text,notes:text},['name','prompt'],true);
add('renameCoordinatorConnection','Rename an existing connection; does not change its authority.','@rename-client',true,{id:text,name:{type:'string',minLength:1,maxLength:80}},['id','name']);

add('listCoordinatorConnections','Read scoped connection names and approval status without credentials.','@connections-list',false);
add('getHandoffStatus','Read current handoff, authority epoch and recorded schedule receipts.','@handoff-status',false);
add('listWorkflowTemplates','Read reusable workflow templates.','@templates-list',false);
add('removeWorkflowTemplate','Remove a template without changing projects already using it. Retains audit evidence.','@template-remove',true,{id:text},['id']);
add('restorePersonaVersion','Restore a retained persona definition as a new version; running assignments remain unchanged.','@persona-restore',true,{id:text,version:id,reason:text},['id','version','reason']);
add('getRoutingPolicy','Read current shared automatic routing policy.','@routing-get',false);
add('setRoutingPolicy','Save explicitly requested routing policy through the app service. Does not itself spend or redeem credits.','@routing-save',true,{config:{type:'object',additionalProperties:false,properties:{enabled:flag,maxRunUsd:{type:'number',exclusiveMinimum:0,maximum:1000},autoResets:flag,claudeResetExpiresAt:nullable(text)},required:['enabled','maxRunUsd','autoResets','claudeResetExpiresAt']}},['config']);
add('refreshProviderCapacity','Refresh provider readings using existing authorization. Does not reconnect accounts or redeem reset credits.','@capacity-refresh',true);
add('updateProviderPreferences','Save non-secret provider preferences using the same app-level store.','providers:save',true,{id:text,enabled:flag,defaultModel:nullable(text),priority:{type:'number'}},['id']);
add('refreshApiConnection','Refresh an existing API connection without changing credentials.','providers:save',true,{id:text,refreshConnectionId:text},['id','refreshConnectionId']);
add('refreshProviderReporting','Refresh existing reporting authorization; no new credentials accepted.','providers:save',true,{id:text,reportingAction:{type:'string',enum:['refresh']},reportingOrganizationId:text},['id','reportingAction']);
add('getErrorMonitorConfiguration','Read error-monitor settings without its token.','sentry:get-config',false);
add('saveErrorMonitorConfiguration','Save non-secret error-monitor preferences.','sentry:save-config',true,{enabled:flag,orgSlug:nullable(text),projectSlug:nullable(text),pollIntervalSeconds:{type:'integer',minimum:1},environmentFilter:nullable(text)});
add('syncErrorMonitor','Sync configured error monitoring.','sentry:sync-now',true,{},[],true);
add('listIssueRuns','Read existing runs associated with a task.','issues:list-runs',false,{number:id},['number']);
add('listChildIssues','Read related child tasks.','issue-relations:list-children',false,{parentNumber:id},['parentNumber']);
add('listParentIssues','Read related parent tasks.','issue-relations:list-parents',false,{childNumber:id},['childNumber']);
add('addIssueRelation','Link existing parent and child tasks.','issue-relations:add',true,{parentNumber:id,childNumber:id},['parentNumber','childNumber']);
add('removeIssueRelation','Remove a relation without deleting either task.','issue-relations:remove',true,{id},['id']);
add('listRunHunks','Read run diff hunks.','agent-runs:hunks:list',false,{runId:id},['runId']);
add('getRecentActivity','Read recent app activity.','analytics:recent-activity',false,{limit:{type:'integer',minimum:1,maximum:100}});
add('getAnalyticsRollup','Read aggregate persona/model outcomes.','analytics:rollup',false,{repoOwner:text,repoName:text,sinceTs:text,cardKind:text,cardSizeBucket:text});
add('getAnalyticsTimeSeries','Read usage over time.','analytics:time-series',false,{repoOwner:text,repoName:text,sinceTs:text,personaId:text,model:text},['sinceTs']);
add('getAnalyticsFrontier','Read observed performance and cost comparisons.','analytics:frontier',false,{repoOwner:text,repoName:text,sinceTs:text,minRuns:id});

add('getSubscriptionAuthorization','Check configured subscription sign-in state. No credentials are returned.','@host:auth-status',false,{provider:{type:'string',enum:['claude','codex']}},['provider']);
add('reconnectSubscription','Start the requested provider’s normal sign-in flow on the Mac. The owner completes sign-in; this does not imply success.','@host:auth-start',true,{provider:{type:'string',enum:['claude','codex']}},['provider']);
add('cancelSubscriptionReconnect','Cancel the pending provider sign-in flow.','@host:auth-cancel',true,{provider:{type:'string',enum:['claude','codex']}},['provider']);
add('getNotificationPreferences','Read workspace notification preferences.','@host:notifications-get',false);
add('setNotificationPreferences','Save workspace completion-notification preferences.','@host:notifications-set',true,{enabled:flag},['enabled']);
add('controlAppWindow','Focus, minimize or maximize KanBorg’s own window. Does not control other apps.','@host:window',true,{action:{type:'string',enum:['focus','minimize','maximize','restore']}},['action']);

add('requestCoordinatorHandoff','Request graceful handoff to built-in or an already approved connection. Outgoing controller checkpoints before transfer.','@request-handoff',true,{mode:{type:'string',enum:['internal','external']},clientId:text},['mode']);
add('cancelCoordinatorHandoff','Cancel the pending handoff while preserving current ownership and workers.','@cancel-handoff',true);
add('retryCoordinatorHandoff','Retry failed delivery of the existing wrap-up request without creating a new handoff.','@retry-handoff',true);
add('finishCoordinatorHandoff','Transfer to the approved destination after wrap-up. Explicit useSavedProgress accepts the retained checkpoint; never approves pairing.','@finish-handoff',true,{useSavedProgress:flag});

const boardView={type:'object',additionalProperties:false,properties:{id:text,name:text,createdAt:text,sortMode:{type:'string',enum:['manual','priority','createdAt','updatedAt']},includeBacklog:flag,filters:{type:'object',additionalProperties:false,properties:{hasAgent:flag,priorities:strings,areas:strings},required:['hasAgent','priorities','areas']}},required:['id','name','createdAt','sortMode','includeBacklog','filters']};
const preferences={type:'object',additionalProperties:false,properties:{
 savedViews:{type:'object',additionalProperties:false,properties:{views:{type:'array',items:boardView,maxItems:100},activeViewId:nullable(text),seeded:flag},required:['views','activeViewId','seeded']},
 tweaks:{type:'object',additionalProperties:false,properties:{theme:{type:'string',enum:['paper','dark']},accentHue:{type:'number',minimum:0,maximum:360},showRail:flag,showTray:flag}},
 diff:{type:'object',additionalProperties:false,properties:{mode:{type:'string',enum:['unified','split']},ignoreWhitespace:flag}},
 board:{type:'object',additionalProperties:false,properties:{sortMode:{type:'string',enum:['manual','priority','createdAt','updatedAt']},includeBacklog:flag}}
}};
add('getUiPreferences','Read shared workspace appearance, diff and board preferences.','@preferences-get',false);
add('setUiPreferences','Save a partial preference change; the app observes it without reload.','@preferences-save',true,{preferences},['preferences']);
add('setIssueLabels','Save task labels and assignees without dispatching work. Workflow stages remain governed by updateWorkflowCard.','@issue-labels',true,{number:id,labels:strings,assignees:strings},['number']);
add('getWorkerQueue','Read queued assignments and their saved instructions.','@queue-get',false);
add('cancelQueuedAssignment','Cancel an assignment that has not started. Existing workers remain untouched.','@queue-cancel',true,{id:text},['id']);
add('updateQueuedAssignment','Edit execution limits for an assignment before it starts.','@queue-update',true,{id:text,budgetUsd:{type:'number',minimum:0.01,maximum:1000},qa:flag,readOnly:flag,maxReworks:{type:'integer',minimum:0,maximum:2}},['id']);

add('getShippingStatus','Read task commit, branch and release state without releasing.','ship:status',false,{issueNumber:id},['issueNumber']);
add('commitTaskWork','Commit the task work locally; does not push, merge or deploy.','ship:commit',true,{issueNumber:id,message:text},['issueNumber'],true);
add('getRunDetails','Read a workspace run record.','agent-runs:get',false,{runId:id},['runId']);
add('revealRunWorktree','Reveal the existing run worktree in Finder.','agent-runs:reveal-worktree',true,{runId:id},['runId']);
add('listAgentCommands','Read installed agent command metadata.','agent-cli:slash-commands',false,{agent:text},['agent']);
add('forkRun','Fork an existing run through the app handler. Does not bypass current update wind-down.','agent-runs:fork',true,{runId:id},['runId'],true);
add('draftPullRequestDescription','Generate a PR description from run evidence. Does not publish it.','agent-runs:draft-pr-description',true,{runId:id},['runId'],true);
add('dismissDecisionCard','Dismiss a pending card through the same handler; the original thread receives the result.','cards:dismiss',true,{cardId:id},['cardId'],true);
add('getTodayUsage','Read today’s recorded usage.','cost:today',false);
add('getProviderCooldown','Read provider cooldown state.','cooldown:get',false);
add('getWorkspaceDetails','Read active workspace metadata.','workspace:get',false);
add('getAcpCommand','Read the configured ACP command.','workspace:get-acp-command',false);
add('setAcpCommand','Save an owner-requested ACP command without running it.','workspace:set-acp-command',true,{acpCommand:nullable(text)},['acpCommand']);
add('setPrimaryRepo','Select an existing workspace repo for future work.','workspace:repos-set-primary',true,{id},['id']);
add('openRepoInEditor','Open an already-associated repository in its configured editor.','workspace:open-repo-in-ide',true,{repoId:id,ide:{type:'string',enum:['vscode','cursor','system']}},['repoId']);
add('listFileReviewComments','Read review comments for one run file.','review-comments:list-for-file',false,{runId:id,filePath:text},['runId','filePath']);
add('consumeReviewComments','Mark pending review comments consumed through the shared app handler.','review-comments:consume-pending',true,{runId:id},['runId']);
add('listWorkspaceFolders','Read existing workspace folders.','folders:list',false);
add('draftIssue','Draft a task from a description using the app’s routing. Does not create or dispatch it.','composer:draft',true,{description:text},['description'],true);
add('getLegacyAutopilotSession','Read a retained legacy Autopilot session; use manageAutopilot for new work.','autopilot:get-by-issue',false,{issueNumber:id},['issueNumber']);
add('testErrorMonitor','Test the existing error-monitor connection without accepting credentials.','sentry:test-connection',true,{orgSlug:text,projectSlug:text});
add('analyzeErrorIssue','Analyze an error-linked task through the app service.','sentry:analyze',true,{issueNumber:id},['issueNumber'],true);
add('applyErrorSuggestion','Apply a stored error-analysis suggestion.','sentry:apply-suggestion',true,{issueNumber:id},['issueNumber']);
add('listWorkspaceLearnings','Read retained workspace learning entries.','learnings:list',false,{repoOwner:text,repoName:text,includeDeleted:flag,tag:{type:'string',enum:['convention','gotcha','fragile','decision-rationale']},limit:{type:'integer',minimum:1,maximum:100}},['repoOwner','repoName']);
add('updateLearning','Update a saved learning entry.','learnings:update',true,{id,content:text},['id','content']);
add('removeLearning','Remove a learning entry through the app’s retained-history handler.','learnings:delete',true,{id},['id']);
add('pinLearning','Set a saved learning’s pinned state.','learnings:pin',true,{id,pinned:flag},['id','pinned']);

add('listOwnerActionRequests','Read exact pending owner approvals and completed action receipts.','@owner-actions',false);
add('requestOwnerAction','Request an owner-reserved pairing, binding, revocation or release approval in the app. The coordinator cannot approve this request itself.','@owner-action-request',true,{action:{type:'string',enum:['approve-client','revoke-client','approve-binding','revoke-binding','approve-release','share-chat','add-repo','add-folder','remove-worktree','configure-provider','remove-provider-credential','open-project']},target:text,reason:{type:'string',minLength:1,maxLength:2000}},['action','target','reason']);
// Funding metadata is editable; credentials stay in the protected owner flow.
add('setProviderDefaults','Save explicit fallback provider/model preferences; automatic routing remains separately configured.','providers:set-defaults',true,{defaultProvider:nullable(text),defaultModel:nullable(text)});
const fundingPool={type:'object',additionalProperties:false,properties:{id:text,name:text,kind:{type:'string',enum:['unknown','paid-credit','grant','subscription-credit','budget']},enabled:flag,amount:nullable({type:'number',minimum:0}),remaining:nullable({type:'number',minimum:0}),acquiredAt:nullable(text),expirationMode:{type:'string',enum:['unknown','never','date']},expiresAt:nullable(text),renewal:{type:'string',enum:['unknown','none','monthly','yearly','weekly']},renewsAt:nullable(text)},required:['id','name','kind','enabled','amount','remaining','acquiredAt','expirationMode','expiresAt','renewal','renewsAt']};
add('setFundingAccount','Save owner-provided funding balances and expiry metadata. Does not redeem credits or authorize spending.','providers:save',true,{id:text,fundingAccount:{type:'object',additionalProperties:false,properties:{provider:{type:'string',enum:['openai','anthropic']},organizationId:text,pools:{type:'array',items:fundingPool,maxItems:100}},required:['provider','organizationId','pools']}},['id','fundingAccount']);

add('listSavedChats','List device chats explicitly shared with this workspace or created through this connection.','@saved-chat:list',false);
add('createSavedChat','Create a saved app chat shared with this workspace. Reuse existing chats for continuations.','@saved-chat:create',true,{title:text});
add('getSavedChat','Read a saved chat shared with this workspace.','@saved-chat:get',false,{conversationId:id},['conversationId']);
add('renameSavedChat','Rename a shared saved chat.','@saved-chat:rename',true,{conversationId:id,title:text},['conversationId','title']);
add('deleteSavedChat','Delete a shared saved chat through the app handler.','@saved-chat:delete',true,{conversationId:id},['conversationId']);
add('sendSavedChatMessage','Send an explicitly requested message to an existing shared chat with automatic routing.','@saved-chat:post-message',true,{conversationId:id,body:text,sessionId:id},['conversationId','body'],true);
add('stopSavedChatRun','Stop a run belonging to a shared saved chat.','@saved-chat:stop-run',true,{conversationId:id,runId:id},['conversationId','runId']);
add('listSavedChatSessions','Read sessions in a shared saved chat.','@saved-chat:sessions:list',false,{conversationId:id},['conversationId']);
add('createSavedChatSession','Create a named session in a shared chat. Normal execution still uses routing.','@saved-chat:sessions:create',true,{conversationId:id,agentProvider:text,agentModel:text,title:text},['conversationId','agentProvider']);
add('renameSavedChatSession','Rename a session within a shared chat.','@saved-chat:sessions:rename',true,{conversationId:id,id,title:nullable(text)},['conversationId','id','title']);
add('deleteSavedChatSession','Delete a session within a shared chat.','@saved-chat:sessions:delete',true,{conversationId:id,id},['conversationId','id']);
add('selectSavedChatSession','Select the app’s active session in a shared chat.','@saved-chat:sessions:set-active',true,{conversationId:id,sessionId:id},['conversationId','sessionId']);

add('splitIssue','Create linked subtasks without starting workers. Dispatch them separately through coordinator controls.','issues:split',true,{number:id,subtasks:{type:'array',minItems:1,maxItems:30,items:{type:'object',additionalProperties:false,properties:{title:text,body:text},required:['title']}}},['number','subtasks']);
add('removeWorkspaceRepo','Remove an associated repository from workspace configuration without deleting files.','workspace:repos-remove',true,{id},['id']);
add('listTaskSessions','Read sessions belonging to a workspace task thread.','chat:thread-sessions:list',false,{threadId:id},['threadId']);
add('createTaskSession','Create a session in a workspace task thread without dispatching work.','chat:thread-sessions:create',true,{threadId:id,agentProvider:text,agentModel:text,title:text},['threadId','agentProvider']);
add('renameTaskSession','Rename a workspace task session.','chat:thread-sessions:rename',true,{id,title:nullable(text)},['id','title']);
add('deleteTaskSession','Delete a workspace task session through the same handler.','chat:thread-sessions:delete',true,{id},['id']);
add('openScopedWorkspace','Reopen this connection’s already-paired project. Returns accepted delivery; verify open state with listWorkspaces. Never grants access to another project.','@host:workspace-open',true);
add('closeScopedWorkspace','Close this project only after its workers stop. Saved coordination and Autopilot preferences remain.','@host:workspace-close',true);
add('uploadAttachment','Upload owner-provided attachment bytes through the configured app attachment service. May publish externally; use only within requested scope.','@attachment-upload',true,{contentType:{type:'string',maxLength:120},base64:{type:'string',minLength:4,maxLength:1400000}},['contentType','base64']);
add('listWorkspaceFiles','List one directory in the paired project.','@host:tree-list',false,{path:{type:'string',maxLength:2048}});
add('listWorkspaceWorktrees','Read existing project worktrees and dirty-file counts.','@host:tree-worktrees',false);
add('getWorkspaceFileStatus','Read changed files across the project’s worktrees.','@host:tree-status',false);
add('readWorkspaceFile','Read a bounded source file in the paired project. Credential files and paths outside it are excluded.','@host:tree-read',false,{path:{type:'string',minLength:1,maxLength:2048}},['path']);
add('revealWorkspaceWorktree','Reveal an existing project worktree in Finder.','@host:tree-reveal',true,{path:{type:'string',minLength:1,maxLength:2048}},['path']);
add('copyWorkspaceWorktreePath','Copy an existing project worktree path to the Mac clipboard.','@host:tree-copy',true,{path:{type:'string',minLength:1,maxLength:2048}},['path']);
add('connectProviderReporting','Start explicitly requested provider reporting sign-in using the app flow. The owner completes authorization; returned status is not proof of success.','providers:save',true,{id:text,reportingAction:{type:'string',enum:['connect']},approveReportingInstall:flag,reportingOrganizationId:text,reportingSwitchAccount:flag},['id','reportingAction']);
add('updateApiConnectionMetadata','Update an existing API connection’s non-secret routing, budget and expiry metadata. Omitted fields are preserved. Does not replace or reveal its key.','@api-metadata',true,{id:text,connectionId:text,changes:{type:'object',additionalProperties:false,properties:{name:text,enabled:flag,priority:{type:'number'},funding:{type:'string',enum:['unknown','paid','grant','subscription-credit']},budget:nullable({type:'number',minimum:0}),remaining:nullable({type:'number',minimum:0}),expirationMode:{type:'string',enum:['unknown','never','date']},expiresAt:nullable(text),renewal:{type:'string',enum:['unknown','none','weekly','monthly','yearly']},renewsAt:nullable(text),rollover:flag,afterGrant:{type:'string',enum:['stop','paygo']},pool:text,defaultModel:nullable(text),confirmBalance:flag,grantBillingDay:{type:'integer',minimum:1,maximum:31},grantFirstStart:nullable(text),timeZone:text,keyExpirationMode:{type:'string',enum:['unknown','never','date']},keyExpiresAt:nullable(text)}}},['id','connectionId','changes']);
export const APP_CONTROLS:readonly AppControl[]=controls;
export const APP_CONTROL_TOOLS=APP_CONTROLS.map(c=>c.tool);

// Legacy UI routes use the coordinator contract instead of bypassing it.
export const APP_CONTROL_EQUIVALENTS:Record<string,string[]>={
 'issues:post-message':['followUpRun'],'issues:dispatch':['dispatchTask'],'issues:start-agent':['dispatchTask'],
 'issues:approve':['updateWorkflowCard'],'issues:request-changes':['updateWorkflowCard','followUpRun'],'issues:reviewer':['runQA'],
 'ship:merge':['prepareRelease','executeRelease'],'ship:create-pr':['prepareRelease','executeRelease'],
 'agent-runs:promote-commit':['prepareRelease','executeRelease'],'agent-runs:promote-pr':['prepareRelease','executeRelease'],
 'agent-runs:events:subscribe':['readRunLog','waitForChanges'],'agent-runs:events:unsubscribe':['readRunLog'],
 'composer:suggest':['requestPerspective'],'autopilot:start':['manageAutopilot'],
 'chat:list':['listSavedChats'],'chat:create':['createSavedChat'],'chat:get':['getSavedChat'],
 'chat:rename':['renameSavedChat'],'chat:delete':['deleteSavedChat'],'chat:post-message':['sendSavedChatMessage'],
 'chat:stop-run':['stopSavedChatRun'],'chat:sessions:list':['listSavedChatSessions'],
 'chat:sessions:create':['createSavedChatSession'],'chat:sessions:rename':['renameSavedChatSession'],
 'chat:sessions:delete':['deleteSavedChatSession'],'chat:sessions:set-active':['selectSavedChatSession'],
 'workspace:repos-add':['requestOwnerAction'],'folders:add':['requestOwnerAction'],'attachments:upload':['uploadAttachment']
};
