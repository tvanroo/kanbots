import { existsSync } from 'node:fs';
import { validateProvider, type ProviderCredentials } from '@kanbots/llm';
import type { ProviderId, Store } from '@kanbots/local-store';
import { z } from 'zod';
import type {
  ProviderSaveInput,
  ProviderSettingsInput,
  ProviderTestConnectionResult,
  ProvidersPayload,
} from '../bridge.js';
import { badRequest, parseArgs } from './errors.js';
import type { ProvidersRuntime } from './types.js';

/**
 * Narrow deps for provider handlers. Provider config is user-level (one
 * Claude Code OAuth, one codex CLI auth per machine), so the handlers don't
 * need a full workspace `HandlerDeps`. The wider `HandlerDeps` shape is
 * assignable to this because of structural typing — existing call sites
 * still compile unchanged.
 */
export interface ProvidersHandlerDeps {
  store: Pick<Store, 'providers' | 'providerSettings'>;
  providers: ProvidersRuntime;
}

const PROVIDER_ID_SCHEMA = z.enum([
  'claude-code',
  'codex-cli',
  'gemini-cli',
  'amp-cli',
  'cursor-cli',
  'copilot-cli',
  'opencode-cli',
  'droid-cli',
  'ccr-cli',
  'qwen-cli',
  'acp',
]);

const connectionSchema = z.object({
  id: z.string().uuid(), provider: z.enum(['openai', 'anthropic']), name: z.string().trim().max(100),
  enabled: z.boolean(), priority: z.number().int().min(0).max(999),
  apiKey: z.string().trim().min(11).max(2000).optional(),
  funding: z.enum(['unknown', 'paid', 'grant', 'subscription-credit']),
  budget: z.number().nonnegative().nullable(), remaining: z.number().nonnegative().nullable(),
  expirationMode: z.enum(['unknown', 'never', 'date']).optional(),
  expiresAt: z.string().datetime().nullable(),
  timeZone: z.string().max(100).refine(zone => { try { new Intl.DateTimeFormat('en', { timeZone: zone }); return true; } catch { return false; } }).optional(),
  keyExpirationMode: z.enum(['unknown', 'never', 'date']).optional(),
  keyExpiresAt: z.string().datetime().nullable().optional(),
  renewal: z.enum(['unknown', 'none', 'weekly', 'monthly', 'yearly']),
  renewsAt: z.string().datetime().nullable(), expired: z.boolean(), pool: z.string().max(120),
  defaultModel: z.string().max(120).nullable(),
}).strict().superRefine((value, context) => {
  if (value.expirationMode === 'date' && !value.expiresAt) context.addIssue({ code: 'custom', path: ['expiresAt'], message: 'Choose an expiration date.' });
  if (value.keyExpirationMode === 'date' && !value.keyExpiresAt) context.addIssue({ code: 'custom', path: ['keyExpiresAt'], message: 'Choose a key expiration date.' });
});

const saveSchema = z
  .object({
    id: PROVIDER_ID_SCHEMA,
    priority: z.number().int().min(0).max(999).optional(),
    reportingAction: z.enum(['connect', 'refresh']).optional(),
    reportingKey: z.string().trim().min(11).max(2000).regex(/^\S+$/).optional(),
    connection: connectionSchema.optional(),
    refreshConnectionId: z.string().uuid().optional(),
    enabled: z.boolean().optional(),
    defaultModel: z.string().min(1).max(120).nullable().optional(),
    apiKey: z.string().min(1).max(2_000).nullable().optional(),
  })
  .strict();

const testSchema = z
  .object({
    id: PROVIDER_ID_SCHEMA,
    apiKey: z.string().min(1).max(2_000).optional(),
  })
  .strict();

const setDefaultsSchema = z
  .object({
    defaultProvider: PROVIDER_ID_SCHEMA.nullable().optional(),
    defaultModel: z.string().min(1).max(120).nullable().optional(),
  })
  .strict();

export async function getConfig(deps: ProvidersHandlerDeps): Promise<ProvidersPayload> {
  return readPayload(deps);
}

export async function save(
  deps: ProvidersHandlerDeps,
  args: ProviderSaveInput,
): Promise<ProvidersPayload> {
  const parsed = parseArgs(saveSchema, args);
  const id = parsed.id as ProviderId;
  if (parsed.reportingAction) {
    if (id === 'codex-cli' && deps.providers.updateOpenAIReporting) await deps.providers.updateOpenAIReporting(parsed.reportingAction, parsed.reportingKey);
    else if (id === 'claude-code' && deps.providers.updateAnthropicReporting) await deps.providers.updateAnthropicReporting(parsed.reportingAction);
    else throw badRequest('Organization reporting requires a supported desktop provider.');
    return readPayload(deps);
  }
  if (parsed.connection || parsed.refreshConnectionId) {
    if (!deps.providers.saveApiConnection || !deps.providers.refreshApiConnection) throw badRequest('API connections require the desktop app.');
    if (parsed.connection) await deps.providers.saveApiConnection(parsed.connection);
    if (parsed.refreshConnectionId) await deps.providers.refreshApiConnection(parsed.refreshConnectionId);
    return readPayload(deps);
  }

  // All supported providers manage their own credentials externally.
  // The app never stores API keys — each CLI either drives its own OAuth
  // (`claude-code`, `codex-cli`, etc.) or reads a well-known env var.
  if (parsed.apiKey !== undefined && parsed.apiKey !== null && parsed.apiKey !== '') {
    throw badRequest(
      `${id} does not accept an API key here. ${apiKeyHintFor(id)}`,
    );
  }

  if (parsed.priority !== undefined) deps.providers.saveSubscriptionPriority?.(id, parsed.priority);
  const patch: Parameters<typeof deps.store.providers.update>[1] = {};
  if (parsed.enabled !== undefined) patch.enabled = parsed.enabled;
  if (parsed.defaultModel !== undefined) patch.defaultModel = parsed.defaultModel;
  deps.store.providers.update(id, patch);
  return readPayload(deps);
}

export async function testConnection(
  deps: ProvidersHandlerDeps,
  args: { id: ProviderId; apiKey?: string },
): Promise<ProviderTestConnectionResult> {
  const parsed = parseArgs(testSchema, args);
  const id = parsed.id as ProviderId;

  let creds: ProviderCredentials;
  if (id === 'claude-code') {
    creds = {
      kind: 'claude-code-oauth',
      credentialsPath: claudeCodeCredentialsPath(),
    };
  } else {
    // codex-cli, gemini-cli, amp-cli: validate is a no-op; their adapters
    // don't read creds — they rely on the CLI finding its own auth.
    creds = { kind: 'api-key', apiKey: '' };
  }

  const authCheck = id === 'claude-code'
    ? deps.providers.hasClaudeCodeCredentials
    : id === 'codex-cli' ? deps.providers.hasCodexCredentials : undefined;
  const result = authCheck
    ? (await authCheck()
        ? { ok: true, models: undefined }
        : { ok: false, error: 'CLI unavailable or signed out. Install the CLI and sign in, then retry.', models: undefined })
    : await validateProvider(id, creds);
  deps.store.providers.update(id, {
    lastValidatedAt: new Date().toISOString(),
    lastError: result.ok ? null : (result.error ?? 'unknown error'),
  });
  return {
    ok: result.ok,
    ...(result.error !== undefined ? { error: result.error } : {}),
    ...(result.models !== undefined ? { models: result.models } : {}),
  };
}

export async function setDefaults(
  deps: ProvidersHandlerDeps,
  args: ProviderSettingsInput,
): Promise<ProvidersPayload> {
  const parsed = parseArgs(setDefaultsSchema, args);
  const patch: Parameters<typeof deps.store.providerSettings.update>[0] = {};
  if (parsed.defaultProvider !== undefined) {
    patch.defaultProvider = (parsed.defaultProvider as ProviderId | null) ?? null;
  }
  if (parsed.defaultModel !== undefined) patch.defaultModel = parsed.defaultModel;
  deps.store.providerSettings.update(patch);
  return readPayload(deps);
}

async function readPayload(deps: ProvidersHandlerDeps): Promise<ProvidersPayload> {
  const rows = deps.store.providers.list();
  const settings = deps.store.providerSettings.get();

  const [codex, claude] = await Promise.all([deps.providers.getCodexDetails?.(), deps.providers.getClaudeDetails?.()]);
  const priorities = deps.providers.subscriptionPriorities?.() ?? {};
  const providers = await Promise.all(rows.map(async (row) => ({
    id: row.id,
    priority: priorities[row.id] ?? 1,
    enabled: row.enabled,
    hasKey: row.id === 'codex-cli' && codex ? codex.hasKey : await detectProviderCredentials(row.id, deps),
    ...(row.id === 'codex-cli' && codex ? codex : {}),
    ...(row.id === 'claude-code' && claude ? claude : {}),
    defaultModel: row.defaultModel,
    keyEncryption: row.keyEncryption,
    lastValidatedAt: row.lastValidatedAt,
    lastError: row.lastError,
  })));

  // `hasKey` reflects detected CLI credentials (~/.claude/.credentials.json,
  // ~/.codex/auth.json, or OPENAI_API_KEY). If either CLI is signed in we
  // treat the app as configured even when the provider row hasn't been
  // explicitly toggled on — the supervisor falls back to claude-code and the
  // overlay is just there to nudge first-time users.
  const anyConfigured = providers.some((p) => p.hasKey);

  return {
    providers,
    apiConnections: deps.providers.listApiConnections?.() ?? [],
    ...(deps.providers.getOpenAIReporting ? { openaiReporting: deps.providers.getOpenAIReporting() } : {}),
    ...(deps.providers.getAnthropicReporting ? { anthropicReporting: deps.providers.getAnthropicReporting() } : {}),
    settings: {
      defaultProvider: settings.defaultProvider,
      defaultModel: settings.defaultModel,
    },
    safeStorageAvailable: deps.providers.safeStorageAvailable(),
    anyConfigured,
  };
}

function hasCodexCliCredentials(): boolean {
  // codex finds its own auth — `codex login` writes ~/.codex/auth.json,
  // or OPENAI_API_KEY can be set in the ambient environment.
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  if (home && existsSync(`${home}/.codex/auth.json`)) return true;
  if (process.env.OPENAI_API_KEY) return true;
  return false;
}

function hasGeminiCliCredentials(): boolean {
  // gemini finds its own auth — `gemini /login` writes
  // ~/.gemini/oauth_creds.json; GEMINI_API_KEY in the ambient environment
  // is the alternate path.
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  if (home && existsSync(`${home}/.gemini/oauth_creds.json`)) return true;
  if (process.env.GEMINI_API_KEY) return true;
  return false;
}

function hasAmpCliCredentials(): boolean {
  // amp finds its own auth — `amp /login` writes under ~/.config/amp/;
  // AMP_API_KEY in the ambient environment is the alternate path.
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  if (home && existsSync(`${home}/.config/amp/settings.json`)) return true;
  if (home && existsSync(`${home}/.config/amp/auth.json`)) return true;
  if (process.env.AMP_API_KEY) return true;
  return false;
}

function hasCursorCliCredentials(): boolean {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  if (home && existsSync(`${home}/.cursor/config.json`)) return true;
  if (home && existsSync(`${home}/.cursor`)) return true;
  if (process.env.CURSOR_API_KEY) return true;
  return false;
}

function hasCopilotCliCredentials(): boolean {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  if (home && existsSync(`${home}/.copilot/config.json`)) return true;
  if (home && existsSync(`${home}/.copilot`)) return true;
  if (home && existsSync(`${home}/.config/gh/hosts.yml`)) return true;
  if (process.env.GITHUB_TOKEN) return true;
  return false;
}

function hasOpencodeCliCredentials(): boolean {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  if (home && existsSync(`${home}/.local/share/opencode/auth.json`)) return true;
  if (home && existsSync(`${home}/.config/opencode`)) return true;
  if (process.env.OPENCODE_AUTH_TOKEN) return true;
  if (process.env.ANTHROPIC_API_KEY) return true;
  if (process.env.OPENAI_API_KEY) return true;
  return false;
}

function hasDroidCliCredentials(): boolean {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  if (home && existsSync(`${home}/.factory/config.json`)) return true;
  if (home && existsSync(`${home}/.factory/mcp.json`)) return true;
  if (home && existsSync(`${home}/.factory`)) return true;
  if (process.env.FACTORY_API_KEY) return true;
  return false;
}

function hasCcrCliCredentials(): boolean {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  if (home && existsSync(`${home}/.claude-code-router/config.json`)) return true;
  if (home && existsSync(`${home}/.claude-code-router`)) return true;
  if (process.env.ANTHROPIC_API_KEY) return true;
  if (process.env.OPENAI_API_KEY) return true;
  return false;
}

function hasQwenCliCredentials(): boolean {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  if (home && existsSync(`${home}/.qwen/settings.json`)) return true;
  if (home && existsSync(`${home}/.qwen/installation_id`)) return true;
  if (home && existsSync(`${home}/.qwen`)) return true;
  if (process.env.DASHSCOPE_API_KEY) return true;
  if (process.env.QWEN_API_KEY) return true;
  return false;
}

function hasAcpCredentials(): boolean {
  // The ACP meta-provider delegates to whichever binary is configured.
  // Treat the presence of an override env var as a positive signal; if
  // none is set, fall through to the default gemini path so the row
  // surfaces as "configured" whenever Gemini is signed in.
  if (process.env.KANBOTS_ACP_COMMAND && process.env.KANBOTS_ACP_COMMAND.trim().length > 0) {
    return true;
  }
  return hasGeminiCliCredentials();
}

function apiKeyHintFor(id: ProviderId): string {
  switch (id) {
    case 'claude-code':
      return 'Sign in via the desktop app.';
    case 'codex-cli':
      return 'Use `codex login` or set OPENAI_API_KEY in your environment.';
    case 'gemini-cli':
      return 'Run `gemini /login` or set GEMINI_API_KEY in your environment.';
    case 'amp-cli':
      return 'Run `amp /login` or set AMP_API_KEY in your environment.';
    case 'cursor-cli':
      return 'Run `cursor-agent login` or set CURSOR_API_KEY in your environment.';
    case 'copilot-cli':
      return 'Run `gh auth login` or sign in via the Copilot CLI.';
    case 'opencode-cli':
      return 'Run `opencode auth` to configure providers.';
    case 'droid-cli':
      return 'Run `droid login` to sign in to Factory.';
    case 'ccr-cli':
      return 'Configure `~/.claude-code-router/config.json` with your provider key.';
    case 'qwen-cli':
      return 'Run `qwen-code login` or set DASHSCOPE_API_KEY in your environment.';
    case 'acp':
      return 'ACP delegates to a configured agent — set `KANBOTS_ACP_COMMAND` or use the default.';
    default: {
      const exhaustive: never = id;
      throw new Error(`unknown provider id: ${String(exhaustive)}`);
    }
  }
}

function detectProviderCredentials(
  id: ProviderId,
  deps: ProvidersHandlerDeps,
): boolean | Promise<boolean> {
  switch (id) {
    case 'claude-code':
      return deps.providers.hasClaudeCodeCredentials();
    case 'codex-cli':
      return deps.providers.hasCodexCredentials?.() ?? hasCodexCliCredentials();
    case 'gemini-cli':
      return hasGeminiCliCredentials();
    case 'amp-cli':
      return hasAmpCliCredentials();
    case 'cursor-cli':
      return hasCursorCliCredentials();
    case 'copilot-cli':
      return hasCopilotCliCredentials();
    case 'opencode-cli':
      return hasOpencodeCliCredentials();
    case 'droid-cli':
      return hasDroidCliCredentials();
    case 'ccr-cli':
      return hasCcrCliCredentials();
    case 'qwen-cli':
      return hasQwenCliCredentials();
    case 'acp':
      return hasAcpCredentials();
    default: {
      const exhaustive: never = id;
      throw new Error(`unknown provider id: ${String(exhaustive)}`);
    }
  }
}

function claudeCodeCredentialsPath(): string {
  // Mirror packages/desktop/src/claude-auth.ts (CLAUDE_CREDENTIALS_PATH).
  // We can't import from desktop here, but the path is stable.
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  return `${home}/.claude/.credentials.json`;
}
