import { startPerformanceDiagnostics } from './performance-diagnostics.js';
import { configureCodexUsageSnapshot } from './codex-catalogue.js';
import { rememberWorkspace, startupWorkspace } from './workspace-resume.js';
import { SelfUpdater, startupSwitch } from './self-update.js';
import { blocksUpdate, CoordinatorService } from './coordinator.js';
import { registerMacCodexCliAdapter } from './register-codex-cli.js';
import { startRoutedRun as startRoutedRunUnchecked } from './automatic-routing.js';
import { configureRoutingProviders, collectCapacity, invalidateCapacity } from './routing-capacity.js';
import { routingState,saveRouting } from './routing-state.js';
import { manageCodexResets, notifyClaudeReset } from './subscription-resets.js';
import { getFundingAccounts, saveFundingAccount } from './account-funding.js';
import { readClaudeSubscriptionUsage, configureClaudeUsageSnapshot } from '@kanborg/api';
import { getOpenAIReporting, updateOpenAIReporting } from './openai-reporting.js';
import { getAnthropicReporting, getAnthropicReportingAccounts, updateAnthropicReporting } from './anthropic-reporting.js';
import { getClaudeDetails } from './claude-auth.js';
import { listApiConnections, saveApiConnection, refreshApiConnection, subscriptionPriorities, saveSubscriptionPriority } from './api-connections.js';
import { getCodexDetails } from './codex-catalogue.js';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, delimiter, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, shell } from 'electron';
import {
  createAutopilotManager,
  createChatHandlers,
  createCurator,
  createHandlers,
  createSupervisor,
  dispatchChatTool,
  reconcileIssueLabels,
  startToolBridge,
  type AgentSupervisor,
  type AutopilotManager,
  type ChatHandlers,
  type ChatToolRuntime,
  type DraftIssueFn,
  type DraftPrDescriptionFn,
  type Handlers,
  type SentryAnalyzerFn,
  type SentryRuntime,
  type SuggestFeatureFn,
  type ToolBridge,
} from '@kanborg/api';
import { GitHubClient, resolveGitHubToken, type IssueSource } from '@kanborg/core';
import {
  createComposer,
  createPrDescriptionDrafter,
  createSentryAnalyzer,
  createSuggester,
} from '@kanborg/dispatcher';
import {
  describeKanBorgDir,
  ensureGitignoreEntry,
  ensureKanBorgDir,
  findGitRoot,
  LocalIssueSource,
  openStore,
  readWorkspaceConfig,
  resolveGitUserName,
  writeWorkspaceConfig,
  type Store,
  type WorkspaceConfig,
} from '@kanborg/local-store';
import {
  cancelClaudeLogin,
  isClaudeAuthenticated,
  startClaudeLogin,
} from './claude-auth.js';
import {
  cancelCodexLogin,
  isCodexAuthenticated,
  startCodexLogin,
} from './codex-auth.js';
import {
  cancelGeminiLogin,
  GEMINI_AUTH_PATH,
  isGeminiAuthenticated,
  startGeminiLogin,
} from './gemini-auth.js';
import {
  AMP_AUTH_PATH,
  AMP_SETTINGS_PATH,
  cancelAmpLogin,
  isAmpAuthenticated,
  startAmpLogin,
} from './amp-auth.js';
import {
  cancelCursorLogin,
  CURSOR_AUTH_PATH,
  CURSOR_CONFIG_DIR,
  isCursorAuthenticated,
  startCursorLogin,
} from './cursor-auth.js';
import {
  cancelCopilotLogin,
  COPILOT_AUTH_PATH,
  COPILOT_CONFIG_DIR,
  COPILOT_GH_HOSTS_PATH,
  isCopilotAuthenticated,
  startCopilotLogin,
} from './copilot-auth.js';
import {
  cancelOpencodeLogin,
  isOpencodeAuthenticated,
  OPENCODE_AUTH_PATH,
  OPENCODE_CONFIG_DIR,
  startOpencodeLogin,
} from './opencode-auth.js';
import {
  cancelDroidLogin,
  DROID_AUTH_PATH,
  DROID_CONFIG_DIR,
  DROID_MCP_PATH,
  isDroidAuthenticated,
  startDroidLogin,
} from './droid-auth.js';
import {
  cancelCcrLogin,
  CCR_CONFIG_DIR,
  CCR_CONFIG_PATH,
  isCcrAuthenticated,
  startCcrLogin,
} from './ccr-auth.js';
import {
  cancelQwenLogin,
  isQwenAuthenticated,
  QWEN_CONFIG_DIR,
  QWEN_INSTALL_PATH,
  QWEN_SETTINGS_PATH,
  startQwenLogin,
} from './qwen-auth.js';
import { watchDbFile, type DbWatcher } from './db-watcher.js';
import {
  createSubscriptionRegistry,
  type OwnedSubscriptionRegistry,
} from './ipc/subscriptions.js';
import { registerHandlers } from './ipc/register.js';
import {
  closeProvidersStoreForShutdown,
  getAppStore,
  registerProvidersIpc,
} from './providers-ipc.js';
import {
  broadcastWorkspaceTouched,
  workspaceTreeControl,
  registerWorkspaceTreeIpc,
} from './workspace-tree-ipc.js';
import { SentryPoller } from './sentry-poller.js';
import {
  decryptToken,
  encryptToken,
  envTokenOverride,
  safeStorageAvailable,
} from './sentry-token.js';
import type {
  ActiveCloudWorkspaceInfo,
  ActiveWorkspaceInfo,
  BootstrapPayload,
  RecentCloudWorkspace,
  RecentWorkspace,
} from './types.js';
import type { AgentRun, AgentRunStatus } from '@kanborg/local-store';

interface ActiveWorkspace {
  repoPath: string;
  config: WorkspaceConfig;
  store: Store;
  source: IssueSource;
  supervisor: AgentSupervisor;
  autopilot: AutopilotManager;
  draftIssue: DraftIssueFn;
  suggestIssue: SuggestFeatureFn;
  draftPrDescription: DraftPrDescriptionFn;
  analyzeSentryError: SentryAnalyzerFn;
  sentryPoller: SentryPoller;
  subscriptions: OwnedSubscriptionRegistry;
  unregisterHandlers: () => void;
  ownerId: number;
  detachOwnerCleanup: () => void;
  cooldownUnsub: () => void;
  dbWatcher: DbWatcher;
  toolBridge: ToolBridge | null;
  toolBridgeRuntimeDir: string | null;
}

process.on('uncaughtException', (err) => {
  console.error('[main] uncaughtException:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandledRejection:', reason);
});

let activeWorkspace: ActiveWorkspace | null = null;
let coordinators: CoordinatorService;
let selfUpdater: SelfUpdater;
let updateRestart=false;
const startRoutedRun:typeof startRoutedRunUnchecked=(opts)=>{if(updateRestart)throw Error('KanBorg is restarting for an update. Work resumes after reopening.');return startRoutedRunUnchecked(opts);};
let mainWindow: BrowserWindow | null = null;
const chatWindows = new Set<BrowserWindow>();

/**
 * Per-device chat store + supervisor. Lives at `userData/device-chats.db`
 * so chat history survives workspace switches and works in cloud-only
 * mode. Lazily initialized on first chat IPC; the cwd resolver below
 * picks whichever workspace is currently active (local repo, cloud-bound
 * local repo, or the userData fallback).
 */
let deviceChatStore: Store | null = null;
let deviceChatSupervisor: AgentSupervisor | null = null;

function appIconOption(): { icon: string } | Record<string, never> {
  const candidate = join(__dirname, 'icon.png');
  return existsSync(candidate) ? { icon: candidate } : {};
}

function findWebContentsForOwner(ownerId: number | undefined): Electron.WebContents | null {
  if (ownerId === undefined) {
    return mainWindow?.webContents ?? null;
  }
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.webContents.id === ownerId) return win.webContents;
  }
  return mainWindow?.webContents ?? null;
}

const RECENTS_LIMIT = 20;

function recentsPath(): string {
  return join(app.getPath('userData'), 'workspaces.json');
}

async function readRecents(): Promise<RecentWorkspace[]> {
  try {
    const raw = await readFile(recentsPath(), 'utf-8');
    const parsed = JSON.parse(raw) as { recents?: RecentWorkspace[] };
    return Array.isArray(parsed.recents) ? parsed.recents : [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    return [];
  }
}

async function writeRecents(list: RecentWorkspace[]): Promise<void> {
  const path = recentsPath();
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify({ recents: list }, null, 2), 'utf-8');
}

async function recordRecent(repoPath: string, displayName: string): Promise<void> {
  const list = await readRecents();
  const filtered = list.filter((r) => r.repoPath !== repoPath);
  filtered.unshift({
    repoPath,
    displayName,
    lastOpenedAt: new Date().toISOString(),
  });
  await writeRecents(filtered.slice(0, RECENTS_LIMIT));
  rememberWorkspace(app.getPath('userData'),repoPath);
}

async function pruneMissingRecents(): Promise<RecentWorkspace[]> {
  const list = await readRecents();
  const present = list.filter((r) => existsSync(r.repoPath));
  if (present.length !== list.length) await writeRecents(present);
  return present;
}

function stripHouseRules(config: WorkspaceConfig): WorkspaceConfig {
  const { houseRules: _omit, ...rest } = config;
  return rest as WorkspaceConfig;
}

function stripAcpCommand(config: WorkspaceConfig): WorkspaceConfig {
  const { acpCommand: _omit, ...rest } = config;
  return rest as WorkspaceConfig;
}

async function ensureLocalWorkspace(repoPath: string): Promise<WorkspaceConfig> {
  const existing = await readWorkspaceConfig(repoPath);
  if (existing) return existing;
  const authorLogin = await resolveGitUserName(repoPath);
  const config: WorkspaceConfig = {
    mode: 'local',
    name: basename(repoPath),
    authorLogin,
  };
  await writeWorkspaceConfig(repoPath, config);
  return config;
}

function broadcastIssueChange(): void {
  const sender = mainWindow?.webContents;
  if (!sender || sender.isDestroyed()) return;
  sender.send('issues:changed', {});
}

function wrapNotifyingSource(source: IssueSource): IssueSource {
  const wrapped: IssueSource = {
    listIssues: (opts) => source.listIssues(opts),
    getIssue: (n) => source.getIssue(n),
    listComments: (n) => source.listComments(n),
    addComment: (n, body) => source.addComment(n, body),
    createIssue: async (input) => {
      const r = await source.createIssue(input);
      broadcastIssueChange();
      return r;
    },
    updateIssue: async (n, patch) => {
      const r = await source.updateIssue(n, patch);
      broadcastIssueChange();
      return r;
    },
  };
  if (source.openDraftPR) {
    wrapped.openDraftPR = source.openDraftPR.bind(source);
  }
  return wrapped;
}

function wrapNotifyingSupervisor(supervisor: AgentSupervisor): AgentSupervisor {
  return {
    ...supervisor,
    start: async (input) => {
      const r = await supervisor.start(input);
      broadcastIssueChange();
      return r;
    },
    resume: async (input) => {
      const r = await supervisor.resume(input);
      broadcastIssueChange();
      return r;
    },
    stop: async (id) => {
      const r = await supervisor.stop(id);
      broadcastIssueChange();
      return r;
    },
  };
}

async function buildSource(config: WorkspaceConfig, store: Store): Promise<IssueSource> {
  if (config.mode === 'github') {
    const token = await resolveGitHubToken();
    return new GitHubClient({
      owner: config.owner,
      repo: config.repo,
      token,
      cache: store.httpCache,
    });
  }
  return new LocalIssueSource({
    repo: store.localIssues,
    authorLogin: config.authorLogin,
  });
}

async function closeActiveWorkspace(): Promise<void> {
  await coordinators?.beforeClose();
  // Free-floating cloud workspace has no local resources, so closing
  // is just clearing the state. Done first so renderer never sees
  // both kinds set at once.
  // Chat windows are bound to the workspace's SQLite db; close them before
  // ripping the workspace down so the renderer stops sending IPC into
  // handlers that are about to disappear.
  if (chatWindows.size > 0) {
    closeAllChatWindows();
  }
  if (!activeWorkspace) return;
  try {
    activeWorkspace.cooldownUnsub();
  } catch {
    // ignore
  }
  try {
    activeWorkspace.detachOwnerCleanup();
  } catch {
    // ignore
  }
  try {
    activeWorkspace.sentryPoller.stop();
  } catch {
    // ignore
  }
  try {
    await activeWorkspace.autopilot.stopAllForShutdown();
  } catch {
    // ignore
  }
  try {
    activeWorkspace.subscriptions.closeAllForOwner(activeWorkspace.ownerId);
  } catch {
    // ignore
  }
  try {
    activeWorkspace.unregisterHandlers();
  } catch {
    // ignore
  }
  try {
    activeWorkspace.dbWatcher.stop();
  } catch {
    // ignore
  }
  if (activeWorkspace.toolBridge) {
    try {
      await activeWorkspace.toolBridge.close();
    } catch {
      // ignore
    }
  }
  try {
    activeWorkspace.store.close();
  } catch {
    // ignore
  }
  activeWorkspace = null;
  coordinators?.attach(null);
}

async function openWorkspaceInternal(repoPath: string): Promise<ActiveWorkspaceInfo> {
  const gitRoot = await findGitRoot(repoPath);
  if (!gitRoot) {
    throw new Error(
      `${repoPath} is not inside a git repository. Run \`git init\` there and try again.`,
    );
  }

  await ensureKanBorgDir(gitRoot);
  let config = await ensureLocalWorkspace(gitRoot);

  await closeActiveWorkspace();

  const kdir = describeKanBorgDir(gitRoot);
  const store = openStore({ path: kdir.dbPath });

  // Catch external db writes (other process, direct sqlite3 edits) — the
  // notify-wrappers below only cover writes that go through our handlers.
  const dbWatcher = watchDbFile(kdir.dbPath, broadcastIssueChange);

  let source: IssueSource;
  try {
    source = wrapNotifyingSource(await buildSource(config, store));
  } catch (err) {
    dbWatcher.stop();
    store.close();
    throw err;
  }

  const sentryPoller = new SentryPoller({
    store,
    source: source,
    broadcast: broadcastIssueChange,
  });
  const sentryRuntime: SentryRuntime = {
    encryptToken,
    decryptToken,
    envTokenOverride,
    safeStorageAvailable,
    syncNow: () => sentryPoller.runOnce(),
    restartPoller: () => sentryPoller.restart(),
  };

  const providersRuntime = {
    safeStorageAvailable,
    hasClaudeCodeCredentials: isClaudeAuthenticated,
    hasCodexCredentials: isCodexAuthenticated,
    getCodexDetails, getClaudeDetails,
    getAnthropicReporting, getAnthropicReportingAccounts, updateAnthropicReporting,
    getFundingAccounts, saveFundingAccount,
    getOpenAIReporting, updateOpenAIReporting,
    listApiConnections, saveApiConnection, refreshApiConnection, subscriptionPriorities, saveSubscriptionPriority,
  };

  const containmentEnv = process.env.KANBOTS_CONTAINMENT_MODE;
  const containmentMode: 'off' | 'warn' | 'pause' =
    containmentEnv === 'off' || containmentEnv === 'pause' ? containmentEnv : 'warn';

  const budgetsState = {
    runCostBudgetUsd: config.defaults?.runCostBudgetUsd ?? null,
    sessionCostBudgetUsd: config.defaults?.sessionCostBudgetUsd ?? null,
  };

  const houseRulesState = {
    houseRules: config.houseRules ?? null,
  };

  const acpCommandState = {
    acpCommand: config.acpCommand ?? null,
  };

  // Curator runs after every successful agent run on this workspace, distilling
  // events into durable learnings. Cheap by default (Haiku, per-day budget cap)
  // and gracefully no-ops when the run signal isn't `completed_clean`/`promoted`.
  const curator = createCurator({ store, cwd: gitRoot });

  const rawSupervisor = await createSupervisor({
    startAgentRun: startRoutedRun,
    store,
    providerConfig: getAppStore,
    repoPath: gitRoot,
    containmentMode,
    defaultRunCostBudgetUsd: () => budgetsState.runCostBudgetUsd,
    houseRules: () => houseRulesState.houseRules,
    acpCommand: () => acpCommandState.acpCommand,
    onRunStatusChange: async (run) => {
      try {
        await maybeNotifyRunStatus(run, store, source);
      } catch {
        // best-effort: never let notification failures break the supervisor
      }
    },
    onRunComplete: async (run) => {
      // Two best-effort tasks fan out from a successful run:
      //   1. Mirror the run's outcome onto the issue's labels (status:review,
      //      agent:idle).
      //   2. Dispatch the memory-ledger curator so this run feeds future ones.
      // Both run in parallel; failures of either are logged-and-swallowed.
      const labelTask = (async () => {
        const thread = store.threads.findById(run.threadId);
        if (!thread) return;
        const issue = await source.getIssue(thread.issueNumber);
        if (issue.labels.includes('archived')) return;
        const labels = issue.labels.filter(
          (l) => !l.startsWith('status:') && !l.startsWith('agent:'),
        );
        labels.push('status:review', 'agent:idle');
        await source.updateIssue(thread.issueNumber, { labels });
      })().catch(() => {
        // label errors must not crash the supervisor hook
      });
      const curatorTask = curator(run).catch(() => {
        // curator failures must not crash the supervisor hook
      });
      await Promise.allSettled([labelTask, curatorTask]);
    },
  });
  const supervisor = wrapNotifyingSupervisor(rawSupervisor);
  const draftIssue = createComposer({ cwd: gitRoot });
  const suggestIssue = createSuggester({ cwd: gitRoot });
  const draftPrDescription = createPrDescriptionDrafter({ cwd: gitRoot });
  const analyzeSentryError = createSentryAnalyzer({ cwd: gitRoot });

  // Demote any in-progress / agent-running labels left over from a previous
  // session. The supervisor sweep above marked stale runs failed; this
  // mirrors that on the issue side so the board doesn't show ghost work.
  const reconcileOwner = config.mode === 'github' ? config.owner : 'local';
  const reconcileRepo = config.mode === 'github' ? config.repo : config.name;
  await reconcileIssueLabels(source, store, reconcileOwner, reconcileRepo).catch(() => {
    // best-effort
  });

  // Preview-proxy injection assets are copied next to the compiled main.cjs
  // at build time (see desktop/tsup.config.ts onSuccess). Hand the absolute
  // path to the api layer so the dispatcher can serve them at runtime even
  // though it's bundled into this process.
  const previewAssetsDir = join(__dirname, 'assets');

  const apiConfig =
    config.mode === 'github'
      ? {
          mode: 'github' as const,
          owner: config.owner,
          repo: config.repo,
          repoPath: gitRoot,
          containmentMode,
          previewAssetsDir,
        }
      : {
          mode: 'local' as const,
          owner: 'local',
          repo: config.name,
          repoPath: gitRoot,
          authorLogin: config.authorLogin,
          containmentMode,
          previewAssetsDir,
        };

  const cooldownUnsub = supervisor.subscribeCooldown((state) => {
    const sender = mainWindow?.webContents;
    if (!sender || sender.isDestroyed()) return;
    sender.send('cooldown:changed', state);
  });

  const subscriptions = createSubscriptionRegistry({
    supervisor,
    forward: (payload, ownerId) => {
      // Send to the window that opened the subscription. Falls back to the
      // main window when ownerId is missing (legacy callers) or the original
      // window has gone away.
      const target = findWebContentsForOwner(ownerId);
      if (target && !target.isDestroyed()) {
        target.send('agent-runs:events:data', payload);
      }
      if (payload.kind === 'status') broadcastIssueChange();
    },
  });
  const autopilot = createAutopilotManager({
    store,
    source,
    supervisor,
    suggestIssue,
    repoPath: gitRoot,
    repoConfig: { owner: apiConfig.owner, repo: apiConfig.repo },
    defaultSessionCostBudgetUsd: () => budgetsState.sessionCostBudgetUsd,
    onSessionChange: () => broadcastIssueChange(),
  });
  // The tool-bridge dispatches MCP calls into the same handlers map the
  // IPC bridge serves. Handlers don't exist yet (they reference the bridge
  // via chatTools), so we capture a late-bound slot the bridge consults at
  // request time.
  const handlersHolder: { handlers: Handlers | null } = { handlers: null };
  let toolBridge: ToolBridge | null = null;
  let toolBridgeRuntimeDir: string | null = null;
  let chatTools: ChatToolRuntime | undefined;
  try {
    toolBridge = await startToolBridge({
      handlers: {} as Handlers,
      dispatch: (name, args) => {
        const h = handlersHolder.handlers;
        if (!h) throw new Error('handlers not yet ready');
        if(coordinators?.hasController()&&!['listIssues','getIssue','listAgentRuns','listPendingDecisions','listLearnings','getPerformanceMetrics'].includes(name))throw Error('This project is managed by its selected coordinator. Use the Coordinators panel.');
        return dispatchChatTool(name, args, h);
      },
    });
    toolBridgeRuntimeDir = join(kdir.root, 'mcp-runtime');
    await mkdir(toolBridgeRuntimeDir, { recursive: true });
    const mcpServerEntry = resolveMcpServerEntry();
    if (mcpServerEntry) {
      chatTools = buildChatToolRuntime({
        toolBridge,
        runtimeDir: toolBridgeRuntimeDir,
        mcpServerEntry,
      });
    }
  } catch (err) {
    console.error('[main] tool-bridge bootstrap failed:', err);
    toolBridge = null;
    chatTools = undefined;
  }

  const handlers = createHandlers({
    deps: {
      source,
      store,
      config: apiConfig,
      supervisor,
      draftIssue,
      suggestIssue,
      draftPrDescription,
      autopilot,
      analyzeSentryError,
      sentry: sentryRuntime,
      providers: providersRuntime,
      ...(chatTools ? { chatTools } : {}),
      budgets: {
        get: () => ({
          runCostBudgetUsd: budgetsState.runCostBudgetUsd,
          sessionCostBudgetUsd: budgetsState.sessionCostBudgetUsd,
        }),
        set: async (input) => {
          budgetsState.runCostBudgetUsd = input.runCostBudgetUsd;
          budgetsState.sessionCostBudgetUsd = input.sessionCostBudgetUsd;
          const defaults = {
            runCostBudgetUsd: input.runCostBudgetUsd,
            sessionCostBudgetUsd: input.sessionCostBudgetUsd,
          };
          const next: WorkspaceConfig =
            config.mode === 'github'
              ? { ...config, defaults }
              : { ...config, defaults };
          await writeWorkspaceConfig(gitRoot, next);
          config = next;
          if (activeWorkspace && activeWorkspace.repoPath === gitRoot) {
            activeWorkspace.config = next;
          }
        },
      },
      houseRules: {
        get: () => ({ houseRules: houseRulesState.houseRules }),
        set: async (input) => {
          houseRulesState.houseRules = input.houseRules;
          const next: WorkspaceConfig =
            input.houseRules === null
              ? stripHouseRules(config)
              : { ...config, houseRules: input.houseRules };
          await writeWorkspaceConfig(gitRoot, next);
          config = next;
          if (activeWorkspace && activeWorkspace.repoPath === gitRoot) {
            activeWorkspace.config = next;
          }
        },
      },
      acpCommand: {
        get: () => ({ acpCommand: acpCommandState.acpCommand }),
        set: async (input) => {
          acpCommandState.acpCommand = input.acpCommand;
          const next: WorkspaceConfig =
            input.acpCommand === null
              ? stripAcpCommand(config)
              : { ...config, acpCommand: input.acpCommand };
          await writeWorkspaceConfig(gitRoot, next);
          config = next;
          if (activeWorkspace && activeWorkspace.repoPath === gitRoot) {
            activeWorkspace.config = next;
          }
        },
      },
      revealPath: async (path) => {
        const error = await shell.openPath(path);
        if (error) throw new Error(error);
      },
      onSuggestEvent: (event) => {
        const sender = mainWindow?.webContents;
        if (!sender || sender.isDestroyed()) return;
        sender.send('composer:suggest:event', event);
      },
    },
    subscriptions,
  });
  const unregisterHandlers = registerHandlers(handlers, subscriptions);
  handlersHolder.handlers = handlers;

  // Tie subscriptions to the renderer that opened them. When the webContents
  // is destroyed (window closed, render process gone) we drop everything to
  // avoid pinning supervisor listeners forever.
  const ownerId = mainWindow?.webContents.id ?? -1;
  const detachOwnerCleanup = (() => {
    const sender = mainWindow?.webContents;
    if (!sender) return () => {};
    const handler = (): void => {
      subscriptions.closeAllForOwner(ownerId);
    };
    sender.on('destroyed', handler);
    return () => {
      try {
        sender.removeListener('destroyed', handler);
      } catch {
        // sender already gone
      }
    };
  })();

  activeWorkspace = {
    repoPath: gitRoot,
    config,
    store,
    source,
    supervisor,
    autopilot,
    draftIssue,
    suggestIssue,
    draftPrDescription,
    analyzeSentryError,
    sentryPoller,
    subscriptions,
    unregisterHandlers,
    ownerId,
    detachOwnerCleanup,
    cooldownUnsub,
    dbWatcher,
    toolBridge,
    toolBridgeRuntimeDir,
  };

  const startAutopilot=handlers['autopilot:start'];
  handlers['autopilot:start']=(args)=>{if(coordinators.hasController())return Promise.reject(new Error('Pause coordination before starting independent autopilot.'));return startAutopilot(args);};
  coordinators.attach({repoPath:gitRoot,handlers,store,supervisor,source});
  coordinators.resumeAutopilotAfterLaunch();
  sentryPoller.start();

  await ensureGitignoreEntry(gitRoot, '.kanbots/').catch(() => {
    // best-effort
  });

  const displayName = config.mode === 'local' ? config.name : `${config.owner}/${config.repo}`;
  await recordRecent(gitRoot, displayName);

  return { repoPath: gitRoot, config };
}

const NOTIFY_STATUSES = new Set<AgentRunStatus>([
  'awaiting_input',
  'failed',
  'complete',
  'stopped',
]);

function notificationBody(status: AgentRunStatus): string {
  switch (status) {
    case 'awaiting_input':
      return 'Decision needed';
    case 'failed':
      return 'Run failed';
    case 'complete':
      return 'Run complete';
    case 'stopped':
      return 'Run stopped';
    default:
      return status;
  }
}

async function maybeNotifyRunStatus(
  run: AgentRun,
  store: Store,
  source: IssueSource,
): Promise<void> {
  if (!NOTIFY_STATUSES.has(run.status)) return;
  if (!Notification.isSupported()) return;
  if (activeWorkspace?.config.notifyOnRunComplete === false) return;
  // Suppress when the user is already looking at the app — they don't need
  // an OS-level pop-up to tell them what's already on screen.
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused()) return;

  const thread = store.threads.findById(run.threadId);
  if (!thread) return;
  let title = `Issue #${thread.issueNumber}`;
  try {
    const issue = await source.getIssue(thread.issueNumber);
    title = `#${thread.issueNumber} ${issue.title}`;
  } catch {
    // fall back to the issue number
  }

  const silent = run.status === 'complete' || run.status === 'stopped';
  const notif = new Notification({
    title,
    body: notificationBody(run.status),
    silent,
  });
  notif.on('click', () => {
    const win = mainWindow;
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    if (!win.webContents.isDestroyed()) {
      win.webContents.send('kanbots:navigate-task', {
        issueNumber: thread.issueNumber,
        runId: run.id,
      });
    }
  });
  notif.show();
}

function activeWorkspaceInfo(): ActiveWorkspaceInfo | null {
  if (!activeWorkspace) return null;
  return { repoPath: activeWorkspace.repoPath, config: activeWorkspace.config };
}

function deviceChatDbPath(): string {
  return join(app.getPath('userData'), 'device-chats.db');
}

/**
 * Working directory used for chat agent runs, resolved at dispatch time
 * so a chat started in cloud-only mode picks up the bound local repo as
 * soon as the user opens one. Falls back to userData when nothing's
 * bound — the agent CLI still launches; only filesystem tools have a
 * meaningful scope to act on.
 */
function resolveChatCwd(): string {
  if (activeWorkspace !== null) return activeWorkspace.repoPath;
  return app.getPath('userData');
}

async function ensureDeviceChat(): Promise<{
  store: Store;
  supervisor: AgentSupervisor;
}> {
  if (deviceChatStore !== null && deviceChatSupervisor !== null) {
    return { store: deviceChatStore, supervisor: deviceChatSupervisor };
  }
  const store = openStore({ path: deviceChatDbPath() });
  const supervisor = await createSupervisor({
    startAgentRun: startRoutedRun,
    store,
    providerConfig: getAppStore,
    repoPath: resolveChatCwd,
  });
  deviceChatStore = store;
  deviceChatSupervisor = supervisor;
  return { store, supervisor };
}

let deviceChatHandlers: ChatHandlers | null = null;
async function getDeviceChatHandlers(): Promise<ChatHandlers> {
  if (deviceChatHandlers !== null) return deviceChatHandlers;
  const { store, supervisor } = await ensureDeviceChat();
  deviceChatHandlers = createChatHandlers({ store: { ...store, providerSettings: getAppStore().providerSettings }, supervisor });
  return deviceChatHandlers;
}
function registerDeviceChatIpc(): void {
  const channels: Array<keyof ChatHandlers> = [
    'chat:list',
    'chat:create',
    'chat:get',
    'chat:rename',
    'chat:delete',
    'chat:post-message',
    'chat:stop-run',
    'chat:sessions:list',
    'chat:sessions:create',
    'chat:sessions:rename',
    'chat:sessions:delete',
    'chat:sessions:set-active',
  ];
  for (const channel of channels) {
    ipcMain.handle(
      `kanbots:invoke:${channel}`,
      async (_event, args: unknown) => {
        try {
          const map = await getDeviceChatHandlers();
          // The Handlers map types args per-channel; the IPC bridge passes them
          // through opaquely so the runtime cast is safe.
          const fn = map[channel] as (a: unknown) => Promise<unknown>;
          return await fn(args);
        } catch (err) {
          throw new Error(
            JSON.stringify({
              code: err instanceof Error && err.name ? err.name : 'Error',
              message: err instanceof Error ? err.message : String(err),
            }),
          );
        }
      },
    );
  }
}

// Local-first launch: cloud sign-in is OPTIONAL. By default every IPC
// channel works without a cloud session. Only operations that actually
// hit the Kanbots Cloud (upstream) backend (or open a cloud-only workspace) need a
// valid session — those opt in via CLOUD_REQUIRED_CHANNELS below.
//
// The sign-in flow itself, status probes, and prompt-dismiss must stay
// reachable without auth (a not-signed-in user has to be able to sign
// in), so they are intentionally NOT listed here.
function registerIpc(): void {
  registerProvidersIpc();

  // Workspace file tree + git-status IPC. Read source of truth lazily
  // at call time so the same handlers serve both cloud-mode (bound
  // local repo) and local-mode (current git workspace).
  registerWorkspaceTreeIpc({
    getCurrentRepoRoot: () => {
      if (activeWorkspace !== null) return activeWorkspace.repoPath;
      return null;
    },
  });

  // Chat IPCs are per-device (live at userData/device-chats.db) so chat
  // history persists across workspace switches and works in cloud-only
  // mode. Registered at app scope; the workspace-scoped registerHandlers
  // skips `chat:*` (see ipc/register.ts).
  registerDeviceChatIpc();

  ipcMain.handle('kanbots:bootstrap', async (): Promise<BootstrapPayload> => {
    const [recents, claudeAuthed, codexAuthed] = await Promise.all([
      pruneMissingRecents(),
      isClaudeAuthenticated(),
      isCodexAuthenticated(),
    ]);
    // Cheap file/env probes — running each CLI's full status command would
    // shell out and can take seconds. The deeper checks still run via the
    // dedicated `kanbots:<agent>-auth-status` channels and via the providers
    // handler once the renderer queries it.
    const geminiAuthed =
      existsSync(GEMINI_AUTH_PATH) || Boolean(process.env.GEMINI_API_KEY);
    const ampAuthed =
      existsSync(AMP_SETTINGS_PATH) ||
      existsSync(AMP_AUTH_PATH) ||
      Boolean(process.env.AMP_API_KEY);
    const cursorAuthed =
      existsSync(CURSOR_AUTH_PATH) ||
      existsSync(CURSOR_CONFIG_DIR) ||
      Boolean(process.env.CURSOR_API_KEY);
    const copilotAuthed =
      existsSync(COPILOT_AUTH_PATH) ||
      existsSync(COPILOT_CONFIG_DIR) ||
      existsSync(COPILOT_GH_HOSTS_PATH) ||
      Boolean(process.env.GITHUB_TOKEN);
    const opencodeAuthed =
      existsSync(OPENCODE_AUTH_PATH) ||
      existsSync(OPENCODE_CONFIG_DIR) ||
      Boolean(process.env.OPENCODE_AUTH_TOKEN) ||
      Boolean(process.env.ANTHROPIC_API_KEY) ||
      Boolean(process.env.OPENAI_API_KEY);
    const droidAuthed =
      existsSync(DROID_AUTH_PATH) ||
      existsSync(DROID_MCP_PATH) ||
      existsSync(DROID_CONFIG_DIR) ||
      Boolean(process.env.FACTORY_API_KEY);
    const ccrAuthed =
      existsSync(CCR_CONFIG_PATH) ||
      existsSync(CCR_CONFIG_DIR) ||
      Boolean(process.env.ANTHROPIC_API_KEY) ||
      Boolean(process.env.OPENAI_API_KEY);
    const qwenAuthed =
      existsSync(QWEN_SETTINGS_PATH) ||
      existsSync(QWEN_INSTALL_PATH) ||
      existsSync(QWEN_CONFIG_DIR) ||
      Boolean(process.env.DASHSCOPE_API_KEY) ||
      Boolean(process.env.QWEN_API_KEY);
    return {
      workspace: activeWorkspaceInfo(),
      cloudWorkspace: null,
      recents,
      cloudRecents: [],
      claudeAuthed,
      codexAuthed,
      geminiAuthed,
      ampAuthed,
      cursorAuthed,
      copilotAuthed,
      opencodeAuthed,
      droidAuthed,
      ccrAuthed,
      qwenAuthed,
      cloudAuthed: false,
      cloudPromptDismissed: true,
    };
  });

  configureRoutingProviders(() => getAppStore().providers.list());
  ipcMain.handle('kanbots:coordinator-state', () => coordinators.ui());
  ipcMain.handle('kanbots:coordinator-action', (_event, action, args) => coordinators.uiAction(action,args));
  ipcMain.handle('kanbots:routing-state', () => routingState());
  ipcMain.handle('kanbots:routing-save', (_event, config) => { const state=saveRouting(config); invalidateCapacity(); return state; });
  ipcMain.handle('kanbots:capacity', async (_event, refresh?: boolean) => (await collectCapacity(false, refresh === true)).snapshot);
  setInterval(() => { notifyClaudeReset(); void collectCapacity().catch(()=>{}); if(getAppStore().providers.get('codex-cli')?.enabled) void manageCodexResets(false).catch(()=>{}); }, 60000).unref();
  ipcMain.handle('kanbots:claude-subscription-usage', () => readClaudeSubscriptionUsage());
  ipcMain.handle('kanbots:claude-auth-status', async (): Promise<{ authed: boolean }> => {
    return { authed: await isClaudeAuthenticated(true) };
  });

  ipcMain.handle(
    'kanbots:claude-login-start',
    async (_event, installIfMissing?: boolean): Promise<{ ok: true } | { ok: false; error: string }> => {
      return startClaudeLogin(true);
    },
  );

  ipcMain.handle('kanbots:claude-login-cancel', async (): Promise<void> => {
    cancelClaudeLogin();
  });

  ipcMain.handle('kanbots:codex-auth-status', async (): Promise<{ authed: boolean }> => {
    return { authed: await isCodexAuthenticated() };
  });

  ipcMain.handle(
    'kanbots:codex-login-start',
    async (): Promise<{ ok: true } | { ok: false; error: string }> => {
      return startCodexLogin();
    },
  );

  ipcMain.handle('kanbots:codex-login-cancel', async (): Promise<void> => {
    cancelCodexLogin();
  });

  ipcMain.handle('kanbots:gemini-auth-status', async (): Promise<{ authed: boolean }> => {
    return { authed: await isGeminiAuthenticated() };
  });

  ipcMain.handle(
    'kanbots:gemini-login-start',
    async (): Promise<{ ok: true } | { ok: false; error: string }> => {
      return startGeminiLogin();
    },
  );

  ipcMain.handle('kanbots:gemini-login-cancel', async (): Promise<void> => {
    cancelGeminiLogin();
  });

  ipcMain.handle('kanbots:amp-auth-status', async (): Promise<{ authed: boolean }> => {
    return { authed: await isAmpAuthenticated() };
  });

  ipcMain.handle(
    'kanbots:amp-login-start',
    async (): Promise<{ ok: true } | { ok: false; error: string }> => {
      return startAmpLogin();
    },
  );

  ipcMain.handle('kanbots:amp-login-cancel', async (): Promise<void> => {
    cancelAmpLogin();
  });

  ipcMain.handle('kanbots:cursor-auth-status', async (): Promise<{ authed: boolean }> => {
    return { authed: await isCursorAuthenticated() };
  });

  ipcMain.handle(
    'kanbots:cursor-login-start',
    async (): Promise<{ ok: true } | { ok: false; error: string }> => {
      return startCursorLogin();
    },
  );

  ipcMain.handle('kanbots:cursor-login-cancel', async (): Promise<void> => {
    cancelCursorLogin();
  });

  ipcMain.handle('kanbots:copilot-auth-status', async (): Promise<{ authed: boolean }> => {
    return { authed: await isCopilotAuthenticated() };
  });

  ipcMain.handle(
    'kanbots:copilot-login-start',
    async (): Promise<{ ok: true } | { ok: false; error: string }> => {
      return startCopilotLogin();
    },
  );

  ipcMain.handle('kanbots:copilot-login-cancel', async (): Promise<void> => {
    cancelCopilotLogin();
  });

  ipcMain.handle('kanbots:opencode-auth-status', async (): Promise<{ authed: boolean }> => {
    return { authed: await isOpencodeAuthenticated() };
  });

  ipcMain.handle(
    'kanbots:opencode-login-start',
    async (): Promise<{ ok: true } | { ok: false; error: string }> => {
      return startOpencodeLogin();
    },
  );

  ipcMain.handle('kanbots:opencode-login-cancel', async (): Promise<void> => {
    cancelOpencodeLogin();
  });

  ipcMain.handle('kanbots:droid-auth-status', async (): Promise<{ authed: boolean }> => {
    return { authed: await isDroidAuthenticated() };
  });

  ipcMain.handle(
    'kanbots:droid-login-start',
    async (): Promise<{ ok: true } | { ok: false; error: string }> => {
      return startDroidLogin();
    },
  );

  ipcMain.handle('kanbots:droid-login-cancel', async (): Promise<void> => {
    cancelDroidLogin();
  });

  ipcMain.handle('kanbots:ccr-auth-status', async (): Promise<{ authed: boolean }> => {
    return { authed: await isCcrAuthenticated() };
  });

  ipcMain.handle(
    'kanbots:ccr-login-start',
    async (): Promise<{ ok: true } | { ok: false; error: string }> => {
      return startCcrLogin();
    },
  );

  ipcMain.handle('kanbots:ccr-login-cancel', async (): Promise<void> => {
    cancelCcrLogin();
  });

  ipcMain.handle('kanbots:qwen-auth-status', async (): Promise<{ authed: boolean }> => {
    return { authed: await isQwenAuthenticated() };
  });

  ipcMain.handle(
    'kanbots:qwen-login-start',
    async (): Promise<{ ok: true } | { ok: false; error: string }> => {
      return startQwenLogin();
    },
  );

  ipcMain.handle('kanbots:qwen-login-cancel', async (): Promise<void> => {
    cancelQwenLogin();
  });

  ipcMain.handle('kanbots:pick-folder', async (): Promise<string | null> => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Open KanBorg workspace',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled) return null;
    return result.filePaths[0] ?? null;
  });

  ipcMain.handle(
    'kanbots:open-workspace',
    async (_event, repoPath: string): Promise<{ ok: true } | { ok: false; error: string }> => {
      try {
        await openWorkspaceInternal(repoPath);
        if (mainWindow) mainWindow.webContents.reloadIgnoringCache();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  ipcMain.handle('kanbots:close-workspace', async (): Promise<void> => {
    rememberWorkspace(app.getPath('userData'),null);
    await closeActiveWorkspace();
    if (mainWindow) mainWindow.webContents.reloadIgnoringCache();
  });

  ipcMain.handle('kanbots:recent-workspaces', async (): Promise<RecentWorkspace[]> => {
    return pruneMissingRecents();
  });

  ipcMain.handle('kanbots:window-minimize', () => {
    mainWindow?.minimize();
  });

  ipcMain.handle('kanbots:window-toggle-maximize', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  });

  ipcMain.handle('kanbots:window-close', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      win.close();
      return;
    }
    mainWindow?.close();
  });

  ipcMain.handle(
    'kanbots:open-chat',
    async (
      _event,
      conversationId: number | null,
    ): Promise<{ ok: true } | { ok: false; error: string }> => {
      try {
        await createChatWindow(conversationId ?? null);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  ipcMain.handle(
    'kanbots:set-notify-on-run-complete',
    async (_event, enabled: boolean): Promise<{ ok: true } | { ok: false; error: string }> => {
      if (!activeWorkspace) {
        return { ok: false, error: 'no active workspace' };
      }
      try {
        const next: WorkspaceConfig = {
          ...activeWorkspace.config,
          notifyOnRunComplete: enabled,
        };
        await writeWorkspaceConfig(activeWorkspace.repoPath, next);
        activeWorkspace.config = next;
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );
}

/**
 * In dev mode, mirror the renderer's console output to the main process
 * stdout/stderr so `pnpm desktop:dev` shows React errors (including the
 * ErrorBoundary's `console.error(...)`) without the user having to open
 * DevTools. Off in packaged builds — the renderer's console is private
 * to DevTools there.
 *
 * Levels: Electron uses 0=verbose, 1=info, 2=warning, 3=error.
 */
function forwardRendererConsole(win: BrowserWindow, tag: 'main' | 'chat'): void {
  const isDev = Boolean(process.env.KANBOTS_RENDERER_URL) || process.env.NODE_ENV === 'development';
  if (!isDev) return;
  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    const prefix = `[renderer:${tag}]`;
    const where = sourceId ? ` (${sourceId.split('/').pop()}:${line})` : '';
    const text = `${prefix} ${message}${where}`;
    if (level === 3) process.stderr.write(text + '\n');
    else process.stdout.write(text + '\n');
  });
  // Renderer crashes (whole process exits) and unresponsive states are not
  // covered by `console-message` — surface them too so dev knows when the
  // renderer falls over silently.
  win.webContents.on('render-process-gone', (_event, details) => {
    process.stderr.write(
      `[renderer:${tag}] render-process-gone reason=${details.reason} exitCode=${details.exitCode}\n`,
    );
  });
  win.webContents.on('preload-error', (_event, preloadPath, error) => {
    process.stderr.write(
      `[renderer:${tag}] preload-error path=${preloadPath} message=${error.message}\n`,
    );
  });
}

async function createWindow(): Promise<void> {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'KanBorg',
    ...appIconOption(),
    frame: false,
    titleBarStyle: 'hidden',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow = win;
  win.on('closed', () => {
    mainWindow = null;
  });

  forwardRendererConsole(win, 'main');

  if (process.env.KANBOTS_OPEN_DEVTOOLS) {
    win.webContents.openDevTools({ mode: 'detach' });
  }

  const devUrl = process.env.KANBOTS_RENDERER_URL;
  if (devUrl) {
    await win.loadURL(devUrl);
  } else {
    // Renderer is copied into dist/web/ during build; layout: dist/main.cjs → dist/web/index.html.
    await win.loadFile(join(__dirname, 'web', 'index.html'));
  }
}

async function createChatWindow(conversationId: number | null): Promise<BrowserWindow> {
  // Chat windows use the OS-native frame/title bar so they behave like
  // a normal application window (move, resize, minimize, maximize from
  // the OS). The main board window keeps its custom chrome.
  const win = new BrowserWindow({
    width: 880,
    height: 760,
    title: 'KanBorg chat',
    ...appIconOption(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  chatWindows.add(win);
  // Cache the webContents id at creation time — by the time `closed`
  // fires the webContents is already destroyed, so `win.webContents.id`
  // throws "Object has been destroyed" (Electron quirk).
  const ownerWebContentsId = win.webContents.id;
  win.on('closed', () => {
    chatWindows.delete(win);
    // Workspace-scoped subscription registry only exists when a local
    // workspace is open. In cloud-only mode the chat window's
    // agent-run streams (if any) come from the device chat path and
    // there's nothing to release here.
    if (activeWorkspace) {
      activeWorkspace.subscriptions.closeAllForOwner(ownerWebContentsId);
    }
  });

  forwardRendererConsole(win, 'chat');

  if (process.env.KANBOTS_OPEN_DEVTOOLS) {
    win.webContents.openDevTools({ mode: 'detach' });
  }

  // The chat UI lives in the same renderer bundle but mounts a different
  // root view when the URL hash starts with #/chat. Pass the optional
  // conversation id so the window opens straight to it.
  const hash = `#/chat${conversationId !== null ? `/${conversationId}` : ''}`;
  const devUrl = process.env.KANBOTS_RENDERER_URL;
  if (devUrl) {
    await win.loadURL(`${devUrl}${hash}`);
  } else {
    await win.loadFile(join(__dirname, 'web', 'index.html'), { hash });
  }
  return win;
}

function closeAllChatWindows(): void {
  for (const win of [...chatWindows]) {
    try {
      win.close();
    } catch {
      // ignore — closed handler will sweep
    }
  }
  chatWindows.clear();
}

function resolveMcpServerEntry(): string | null {
  const bundled=join(__dirname,'mcp','server.js');
  if (existsSync(bundled)) return bundled;
  // The MCP server ships from `@kanborg/mcp/server`. We resolve the entry
  // through the standard module loader so it works in both dev (pnpm
  // symlinks → packages/mcp/dist/server.js) and a packaged Electron app
  // where node_modules sits beside the desktop bundle.
  try {
    const req = createRequire(__filename);
    const entry = req.resolve('@kanborg/mcp/server');
    return entry;
  } catch {
    return null;
  }
}

function buildChatToolRuntime(args: {
  toolBridge: ToolBridge;
  runtimeDir: string;
  mcpServerEntry: string;
}): ChatToolRuntime {
  const { toolBridge, runtimeDir, mcpServerEntry } = args;
  return {
    prepareForRun: async ({ provider, conversationId }) => {
      if(conversationId!==undefined){const prepared=await coordinators.prepareInternal(conversationId,provider);if(prepared)return prepared;}
      const token = toolBridge.issueToken();
      const env = {
        KANBOTS_MCP_ENTRY: mcpServerEntry,
        KANBOTS_TOOL_BRIDGE_URL: toolBridge.baseUrl(),
        KANBOTS_TOOL_BRIDGE_TOKEN: token,
      };
      const mcpServer = {
        command: process.execPath,
        args: [mcpServerEntry],
      };
      let extraArgs: string[];
      if (provider === 'codex-cli') {
        extraArgs = buildCodexMcpArgs('kanbots', {...mcpServer,env:{}});
        extraArgs.push('-c','mcp_servers.kanbots.env_vars=["KANBOTS_TOOL_BRIDGE_URL","KANBOTS_TOOL_BRIDGE_TOKEN","ELECTRON_RUN_AS_NODE"]');
      } else {
        const configPath = join(
          runtimeDir,
          `mcp-${randomUUID().slice(0, 8)}.json`,
        );
        const config = { mcpServers: { kanbots: mcpServer } };
        await writeFile(configPath, JSON.stringify(config, null, 2), {encoding:'utf8',mode:0o600});
        extraArgs = ['--mcp-config', configPath];
      }
      return {
        extraArgs,
        env,
        cleanup: () => {
          toolBridge.revokeToken(token);
          // The MCP config file is small; don't bother unlinking — it's
          // inside .kanbots/mcp-runtime which is gitignored and gets
          // garbage-collected on workspace close (the dir is deleted by
          // the workspace bootstrap on next open if you wire it).
        },
      };
    },
  };
}

// codex's `-c key=value` parses the value as TOML, falling back to a raw
// literal if TOML parsing fails. We always emit quoted basic strings + TOML
// arrays so the parser doesn't have to guess.
function buildCodexMcpArgs(
  serverName: string,
  spec: { command: string; args: string[]; env: Record<string, string> },
): string[] {
  const out: string[] = [];
  const base = `mcp_servers.${serverName}`;
  out.push('-c', `${base}.command=${tomlString(spec.command)}`);
  out.push('-c', `${base}.args=[${spec.args.map(tomlString).join(', ')}]`);
  for (const [key, value] of Object.entries(spec.env)) {
    out.push('-c', `${base}.env.${key}=${tomlString(value)}`);
  }
  return out;
}

function tomlString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// Retain the original fork identity for macOS encrypted storage, settings and single-instance locking.
// Product, window and installer names are KanBorg; this is deliberately not a data migration.
app.setName('Kanbots Local');
app.setPath(
  'userData',
  startupSwitch('user-data-dir') || join(app.getPath('appData'), 'Kanbots Local'),
);

// Finder launches with a short PATH. Keep the user's existing entries first.
if (process.platform === 'darwin') {
  process.env.PATH = [
    process.env.PATH,
    join(homedir(), '.local/bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin',
  ].filter(Boolean).join(delimiter);
}

const ownsLocalInstance = app.requestSingleInstanceLock();
if (!ownsLocalInstance) app.quit();
if (ownsLocalInstance) void app.whenReady().then(async () => {
  const diagnosticsDirectory = startPerformanceDiagnostics();
  configureClaudeUsageSnapshot(join(app.getPath('userData'), 'claude-usage-snapshot.json'));
  configureCodexUsageSnapshot(join(app.getPath('userData'), 'codex-usage-snapshot.json'));
  selfUpdater=new SelfUpdater();
  coordinators=new CoordinatorService();
  coordinators.setAppRuntime(async(action,args,path)=>{
    if(action==='workspace-open'){
      if(activeWorkspace&&activeWorkspace.repoPath!==path)throw Error('Another project is open; close it through its own scoped connection first');
      if(activeWorkspace)return {accepted:true,open:true};
      setImmediate(()=>void openWorkspaceInternal(path).then(()=>mainWindow?.webContents.reloadIgnoringCache()).catch(e=>console.error('Scoped workspace reopen failed:',e instanceof Error?e.message:'unknown error')));
      return {accepted:true,open:false,verifyWith:'listWorkspaces'};
    }
    if(activeWorkspace?.repoPath!==path)throw Error('Workspace is not active');
    if(action==='owner-open-project'){
      if(activeWorkspace.store.agentRuns.listActive().some(blocksUpdate)||activeWorkspace.autopilot.listActive().length)throw Error('Workers are active. Wind down before switching projects.');
      await openWorkspaceInternal(args.path);mainWindow?.webContents.reloadIgnoringCache();return {open:true};
    }
    if(action==='workspace-close'){
      if(activeWorkspace.store.agentRuns.listActive().some(blocksUpdate)||activeWorkspace.autopilot.listActive().length)throw Error('Workers are active. Wind down before closing the workspace.');
      setImmediate(()=>void closeActiveWorkspace().then(()=>mainWindow?.webContents.reloadIgnoringCache()).catch(()=>{}));
      return {accepted:true,verifyWith:'listWorkspaces'};
    }

    if(action==='tree-remove'&&activeWorkspace.store.agentRuns.listActive().some(r=>r.worktreePath===args.path))throw Error('A worker still owns this worktree');
    if(action.startsWith('tree-'))return workspaceTreeControl(path,action,args);
    if(action.startsWith('saved-chat:')){
      const handlers=await getDeviceChatHandlers();
      if(action==='saved-chat:list')return (await handlers['chat:list']()).filter(c=>(args.ids as number[]).includes(c.id));
      const allowed=['create','get','rename','delete','post-message','stop-run','sessions:list','sessions:create','sessions:rename','sessions:delete','sessions:set-active','verify'];
      const operation=action.slice('saved-chat:'.length);if(!allowed.includes(operation))throw Error('Unknown saved chat control');
      if(operation==='verify'){await handlers['chat:get']({conversationId:args.conversationId});return {exists:true};}
      if(operation!=='create'){
        const payload=await handlers['chat:get']({conversationId:args.conversationId});
        if(args.runId!==undefined){const run=deviceChatStore!.agentRuns.findById(args.runId);if(!run||run.threadId!==payload.conversation.threadId)throw Error('Run belongs to another chat');}
        if(args.id!==undefined||args.sessionId!==undefined){const sessions=await handlers['chat:sessions:list']({conversationId:args.conversationId});if(!sessions.some(s=>s.id===(args.id??args.sessionId)))throw Error('Session belongs to another chat');}
      }
      const channel=`chat:${operation}` as keyof ChatHandlers;
      const input={...args};if(['sessions:rename','sessions:delete','stop-run'].includes(operation))delete input.conversationId;
      return (handlers[channel] as (a:any)=>Promise<any>)(input);
    }
    if(action==='auth-status')return {authed:args.provider==='claude'?await isClaudeAuthenticated(true):await isCodexAuthenticated()};
    if(action==='auth-start')return args.provider==='claude'?startClaudeLogin(true):startCodexLogin();
    if(action==='auth-cancel'){if(args.provider==='claude')cancelClaudeLogin();else cancelCodexLogin();return {cancelled:true};}
    if(action==='notifications-get')return {enabled:activeWorkspace.config.notifyOnRunComplete??false};
    if(action==='notifications-set'){const next={...activeWorkspace.config,notifyOnRunComplete:args.enabled};await writeWorkspaceConfig(path,next);activeWorkspace.config=next;return {enabled:next.notifyOnRunComplete};}
    if(action==='window'){if(!mainWindow)throw Error('App window unavailable');if(args.action==='focus'){mainWindow.show();mainWindow.focus();}else if(args.action==='minimize')mainWindow.minimize();else if(args.action==='maximize')mainWindow.maximize();else mainWindow.unmaximize();return {minimized:mainWindow.isMinimized(),maximized:mainWindow.isMaximized()};}
    throw Error('Unknown desktop control');
  });
  await registerMacCodexCliAdapter(adapter => coordinators.registerHostAdapter(adapter));
  coordinators.setWorkflowNotifier(()=>{for(const window of BrowserWindow.getAllWindows())window.webContents.send('workflow:changed',{});});
  coordinators.setUpdater({status:()=>selfUpdater.status(),check:()=>selfUpdater.check(),request:async(a,p)=>{try{const result=await selfUpdater.enqueue(a,p);if(a.action!=='cancel')coordinators.beginUpdateWindDown();return result;}finally{if(!selfUpdater.pending()&&['cancelled','failed','completed'].includes(selfUpdater.status().update?.phase??''))coordinators.endUpdateWindDown();}},pending:()=>selfUpdater.pending()});
  const coordinatorEntry=resolveMcpServerEntry();
  if(coordinatorEntry) await coordinators.start(coordinatorEntry);
  if (process.platform === 'darwin') {
    app.setAboutPanelOptions({ applicationName: 'KanBorg' });
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'KanBorg', submenu: [
        { role: 'about', label: 'About KanBorg' },
        { label: 'Show performance diagnostics', click: () => { void shell.openPath(diagnosticsDirectory); } }, { type: 'separator' },
        { role: 'services' }, { type: 'separator' },
        { role: 'hide', label: 'Hide KanBorg' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' }, { role: 'quit', label: 'Quit KanBorg' },
      ] }, { role: 'fileMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
    ]));
  } else Menu.setApplicationMenu(null);
  registerIpc();
  const recovery=selfUpdater.recovery();
  const restorePath=recovery?.repoPath??selfUpdater.workflowRecovery()?.repoPath??startupWorkspace(app.getPath('userData'));
  let restored=false;
  if(restorePath){
    try{await openWorkspaceInternal(restorePath);restored=true;}
    catch(e){if(recovery)selfUpdater.failRecovery(e instanceof Error?e.message:'Workspace recovery failed');console.error('[startup] Could not restore project:',e instanceof Error?e.message:String(e));}
  }
  // Load the board only after restoration, avoiding a flash of the project picker.
  await createWindow();
  if(recovery&&restored)selfUpdater.complete();
  const workflowRecovery=selfUpdater.workflowRecovery();
  if(workflowRecovery&&restored){
    try{await coordinators.resumeAfterUpdate(app.getVersion(),workflowRecovery.id);selfUpdater.workflowResumeQueued();}
    catch(e){console.error('[update] Workflow resume remains pending:',e instanceof Error?e.message:String(e));}
  }
  const updateTimer=setInterval(()=>void selfUpdater.installWhenIdle(async()=>{
    if(selfUpdater.pending())coordinators.beginUpdateWindDown();
    if(!activeWorkspace||!coordinators.updateIdle()||activeWorkspace.repoPath!==selfUpdater.status().update?.repoPath)return false;
    return await coordinators.updateWorkersReady()&&!activeWorkspace.store.agentRuns.listActive().some(blocksUpdate)&&!deviceChatStore?.agentRuns.listActive().some(blocksUpdate)&&!activeWorkspace.autopilot.listActive().length;
  },async()=>{
    updateRestart=true;
    await coordinators.beforeClose();
    if(activeWorkspace?.store.agentRuns.listActive().some(blocksUpdate)||deviceChatStore?.agentRuns.listActive().some(blocksUpdate))throw Error('A new run started before restart. Let it finish and request the update again.');
    await closeActiveWorkspace();
    deviceChatStore?.close();deviceChatStore=null;
    closeProvidersStoreForShutdown();
  },()=>coordinators.expediteUpdate()).catch(async error=>{console.error('[update] Could not finish update:',error.message);updateRestart=false;coordinators.allowRequests();const record=selfUpdater.status().update;if(!activeWorkspace&&record?.repoPath)await openWorkspaceInternal(record.repoPath).catch(()=>{});}),3000);updateTimer.unref();

  app.on('activate' , async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });
});

app.on('window-all-closed', async () => {
  if(updateRestart)return;
  // The chat windows have their own lifecycle and may still be running;
  // BrowserWindow.getAllWindows() is empty here only when the user has
  // explicitly closed every window. Drop the workspace so processes don't
  // outlive the UI.
  await closeActiveWorkspace();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', async () => {
  if(updateRestart)return;
  closeAllChatWindows();
  await closeActiveWorkspace();
  closeProvidersStoreForShutdown();
});
