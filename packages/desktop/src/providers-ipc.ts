import { getFundingAccounts, saveFundingAccount } from './account-funding.js';
import { getOpenAIReporting, updateOpenAIReporting } from './openai-reporting.js';
import { getAnthropicReporting, getAnthropicReportingAccounts, updateAnthropicReporting } from './anthropic-reporting.js';
import { getClaudeDetails } from './claude-auth.js';
import { listApiConnections, saveApiConnection, refreshApiConnection, subscriptionPriorities, saveSubscriptionPriority } from './api-connections.js';
import { getCodexDetails } from './codex-catalogue.js';
import { join } from 'node:path';
import { app, ipcMain } from 'electron';
import {
  createProvidersHandlers,
  type ProvidersHandlerDeps,
  type ProvidersHandlers,
  type ProvidersRuntime,
} from '@kanborg/api';
import { openStore, type Store } from '@kanborg/local-store';
import { CHANNEL_PREFIX } from './ipc/register.js';
import { toIpcError } from './ipc/errors.js';
import { safeStorageAvailable } from './providers-key.js';
import { isClaudeAuthenticated } from './claude-auth.js';
import { isCodexAuthenticated } from './codex-auth.js';

/**
 * Provider config (Claude Code / Codex CLI defaults + last-validated state)
 * is per-user, not per-workspace — the underlying credentials live in
 * ~/.claude/ and ~/.codex/ regardless of which project is open. We therefore
 * register the four `providers:*` IPC handlers once at app startup against an
 * app-level SQLite at `userData/app-store.sqlite`. They stay registered for
 * the app lifetime so the Providers modal works in both cloud-only mode
 * (no active local workspace) and legacy local mode.
 */

let appStore: Store | null = null;

export function getAppStore(): Store {
  if (appStore !== null) return appStore;
  const path = join(app.getPath('userData'), 'app-store.sqlite');
  appStore = openStore({ path });
  return appStore;
}

export function getProviderHandlers(): ProvidersHandlers {
  const runtime: ProvidersRuntime = {
    safeStorageAvailable,
    hasClaudeCodeCredentials: isClaudeAuthenticated,
    hasCodexCredentials: isCodexAuthenticated,
    getCodexDetails, getClaudeDetails,
    getAnthropicReporting, getAnthropicReportingAccounts, updateAnthropicReporting,
    getFundingAccounts, saveFundingAccount,
    getOpenAIReporting, updateOpenAIReporting,
    listApiConnections, saveApiConnection, refreshApiConnection, subscriptionPriorities, saveSubscriptionPriority,
  };
  const deps: ProvidersHandlerDeps = {
    get store() {
      return getAppStore();
    },
    providers: runtime,
  };
  return createProvidersHandlers(deps);
}

export function registerProvidersIpc(): void {
  const handlers=getProviderHandlers();

  const channels = Object.keys(handlers) as ReadonlyArray<
    keyof ProvidersHandlers & string
  >;
  for (const channel of channels) {
    const handler = handlers[channel] as (args: unknown) => Promise<unknown>;
    ipcMain.handle(`${CHANNEL_PREFIX}${channel}`, async (_event, args) => {
      try {
        return await handler(args);
      } catch (err) {
        // Mirror ipc/register.ts: ipcMain only ships `message` across the
        // boundary, so encode structured error info into it.
        throw new Error(JSON.stringify(toIpcError(err)));
      }
    });
  }
}

export function closeProvidersStoreForShutdown(): void {
  if (appStore === null) return;
  try {
    appStore.close();
  } catch {
    // best-effort
  }
  appStore = null;
}
