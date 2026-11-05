# Local provider connections (1.1.3)

OpenAI and Anthropic each have a subscription section and separate API connection cards. The subscription labels are based on the official installed CLI's reported authentication method. Codex model selectors read `model/list` from its app server, including pagination. They do not fall back to the old GPT-5 list.

API keys are pasted into the desktop UI and encrypted with Electron safeStorage in `Kanbots Local/api-connections.json` under Application Support. This is the owner's explicit app-local storage exception. No plaintext fallback is permitted. Payloads sent back to the renderer contain only the first five and last five characters of a saved key. Editing metadata retains the encrypted key unless a replacement is supplied. Reinstalling the same app identity preserves this file and the existing app store.

Each API connection saves an enabled flag, priority, preferred model, funding type, amount, remaining balance, expiry, expired flag, renewal cadence/date, and shared-pool label. Unknown values remain empty. These are user-entered metadata, not live capacity estimates. Renewal dates do not automatically mint or reset credits.

Refresh uses the provider's models API and attempts its organization cost report with the supplied key. Missing billing permissions do not prevent model discovery. Reported spend is organization-wide calendar-month USD spend and is never treated as remaining credit or subtracted from manually entered balances. Anthropic's legacy report excludes Priority Tier costs. A previous successful cost reading retains its timestamp if refresh fails. Grant expiration and credit balances currently require manual entry.

This increment is connection setup and discovery. API connections are not yet execution routes; enabling them does not change task execution. Priorities are saved preferences and determine card order only. Automatic switching, budget enforcement, renewal scheduling, direct API agent execution, and grant optimization remain follow-up work. Subscription-granted API credits exclude Codex/Claude Code according to current provider documentation, so direct API execution must be implemented before claiming those credits are used by tasks.

Validation: desktop/web TypeScript checks and production build; focused temporary-profile Electron test with synthetic keys and mocked provider responses covers encrypted storage, masked readback, metadata edits retaining keys, model discovery, billing permission denial, and separation of spend from balance. Codex discovery was checked against the local logged-in account without inference. Real API-key and billing acceptance is pending user configuration.


## Feedback revision (1.1.4)

Saved API connections collapse to compact, themed cards; Save is neutral/disabled without changes. New keys need no custom name and automatically trigger discovery. Invalid fields get inline messages, highlighting and focus. Manual priority controls are removed; automatic execution routing remains future work.

Manual funding starts Unknown. Key expiry and credit expiry are separate, each supporting Unknown / Does not expire / Date. A stored IANA time zone defaults to UTC for new API entries; changing it converts display without moving an existing instant. Dates offer a visible midnight default and local-time preview; exact provider cutoffs still need confirmation. Subscription-credit selection suggests monthly renewal, with an annual OpenAI Business caveat. No balance or grant date is fabricated.

Anthropic organization reporting now uses the documented beta usage/cost analytics endpoints. The optional Connect usage & costs action launches the official ant CLI OAuth flow in a separate ANTHROPIC_CONFIG_DIR under this app's data directory. The user sees that org:admin is broad organization authority even though Kanbots only issues GET requests. CLI-managed OAuth tokens never go to the renderer or reporting snapshot. This is distinct from Claude Code subscription authentication. Individual Console accounts may not have Admin API access; Enterprise requires its separate scoped analytics credentials.

Reports preserve provider freshness timestamps, treat absent snapshots as unknown, and mark prior readings stale on failure. Organization reports are not attributed to individual inference keys without a verified organization mapping. Reported costs are before credits and are not a credit balance. OpenAI API reporting continues to attempt the documented organization cost endpoint with the supplied key; ChatGPT OAuth does not imply organization billing permissions. Do not claim OAuth billing parity for providers without a verified authorization flow.

Official sources checked 2026-11-05:
- https://platform.claude.com/docs/en/manage-claude/usage-cost-analytics-api
- https://platform.claude.com/docs/en/manage-claude/admin-api
- https://platform.claude.com/docs/en/cli-sdks-libraries/cli/authentication
- https://platform.claude.com/docs/en/api/beta/organization/api_keys/retrieve
- https://developers.openai.com/api/docs/guides/chatgpt-api-credits

Validation: TypeScript and production build; browser preview with synthetic data for invalid-key focus, name-free save, automatic collapse, unchanged disabled Save; UTC/Pacific/half-hour offset/DST-gap conversion checks; mocked Electron reporting checks for GET-only requests, cents-to-USD conversion, unknown freshness, permission failures, and no token in persisted snapshots. Real Anthropic organization OAuth consent and report acceptance remain owner setup steps.


## OpenAI reporting revision (1.1.5)

OpenAI now has a dedicated organization reporting connection using a locally encrypted Admin API key, distinct from inference keys and ChatGPT subscription authentication. Its key preview is the first five and last five characters only. Read-only GET requests use the documented `/v1/organization/usage/completions` and `/v1/organization/costs` endpoints with pagination and a UTC calendar-month range. Input/output totals do not add cached tokens again. Reports expose their retrieval times and independent usage/cost availability. Failed refreshes retain prior readings with timestamps; replacing a key clears previous-account readings. Cost reports can cover services outside the token-usage report, and neither report establishes remaining credit or grant expiry.

Codex subscription usage is read automatically through `account/rateLimits/read` during discovery with the existing ChatGPT login. Only quota windows, reset times, explicit ordinary-usage permission and credit summaries are returned to the renderer; account identifiers and other protocol payloads are excluded. Missing permission is unknown. Windows and credits are displayed separately and never summed. Credits have no assumed expiry. A quota-read failure does not discard the model catalogue.

Verified on the local account: ChatGPT authentication, eight models, one reported quota window and one credit pool. No inference request was made. OpenAI organization reporting passed a temporary-profile mocked check for encryption, masking, pagination, token accounting, USD costs and independent failure handling; live Admin-key acceptance remains the owner's setup step.

Source: https://developers.openai.com/cookbook/examples/completions_usage_api and the installed Codex app-server generated protocol. No ChatGPT OAuth path for OpenAI organization reporting was verified, so the UI does not imply that subscription sign-in grants it.
