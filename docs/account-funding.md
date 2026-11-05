# Account funding and provider reporting

Reviewed 2026-11-05. Scope: the existing OpenAI and Anthropic connections.

## Default onboarding

Owner correction: default new API keys to pay-as-you-go. The normal surface shows usage, cost, and the calendar-month UTC tracking rollover. It does not request a remaining credit balance or grant expiry. Budgets entered in this version are comparison targets, not enforcement settings. Credit grants are an opt-in exception. The calendar tracking boundary is not evidence of an account-specific provider hard-limit reset.

The reviewed OpenAI spend-limit documentation describes organization/project settings but does not document a budget-cap read endpoint. Anthropic's reviewed Spend Limits API applies to Enterprise member limits, not ordinary Console API budgets. Request-rate/token limits must not be mislabeled as spending limits. Further work is needed for actual API task dispatch, per-request usage/cost recording, concurrent budget reservations, and app-only enforcement; no unused enforcement code is presented as a working feature.

## What is automatic

- Organization identity comes from authenticated provider response headers.
- Keys sharing a verified provider/organization ID share one funding record.
- Usage and organization costs use the existing reporting credentials and retain their own timestamps.
- Claude subscription quota and ChatGPT/Codex quota are separate from API funding.

The documented integrations reviewed do not expose a credit ledger with individual grants, current paid credit balance, grant expiration, and next grant renewal. Neither a successful model-list request nor organization reporting access establishes the remaining credit balance. The app does not probe guessed or retired dashboard endpoints or ask for more admin access on the assumption that it unlocks a missing credit API.

## Missing data

Account-level entries represent purchased credit, promotional grants, subscription-included API credit, and spending budgets separately. Amounts and dates are optional and explicitly user-entered. Unknown, zero, negative balance, and no expiration are distinct. Negative balances are retained, not clamped to zero. A budget is not prepaid credit.

Expiration and renewal suggestions are based on published policy only after the user identifies the credit type. They do not prove enrollment, grant amount, a purchase date, or a billing-cycle anchor:

- OpenAI subscription API benefits generally expire/renew at the billing-cycle boundary; annually billed Business benefits use the annual boundary.
- Anthropic subscription API benefits renew and expire monthly, including annual plans.
- Standard purchased API credits expire one year after purchase at both providers. The suggested date must be checked against the account's grant record.

No new credit is created on a scheduled renewal. Past renewal dates require confirmation. Usage costs are not subtracted from a manually entered balance: credit application order, account-wide consumption, timing, and taxes prevent an exact inference from monthly spend alone.

Existing per-key funding notes remain intact. The account UI offers explicit review/import; identical legacy notes are offered together and their source connection IDs prevent repeat imports. No amounts are summed across keys.

## Sources

- [OpenAI API benefits](https://developers.openai.com/api/docs/guides/chatgpt-api-credits)
- [OpenAI prepaid billing](https://help.openai.com/en/articles/8264644-setting-up-and-managing-prepaid-api-billing)
- [Anthropic API benefits](https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers)
- [Anthropic prepaid billing](https://support.claude.com/en/articles/8977456-how-do-i-pay-for-my-claude-api-usage)
- [Anthropic usage and costs](https://platform.claude.com/docs/en/manage-claude/usage-cost-analytics-api)

Future provider-ledger adapters must retain grant IDs, currencies, provider organization IDs, retrieval times and per-field provenance. They should replace only the matching provider-reported fields and leave manually confirmed missing details intact. Browser-assisted billing imports would be a separate integration, not a capability of today's API credentials.

## Per-key setup (1.1.11)

The primary entry point is now each API key's Payment control: pay-as-you-go, monthly grant, or other credit. Monthly grants store amount, next reset instant and display zone, rollover policy, and stop/pay-go after exhaustion. Unknown remaining balance stays unknown; entering an amount does not establish the remaining balance. Reset dates do not create credits automatically. Existing account-level pools remain accessible in a collapsed legacy section, without migration or duplicate balance creation. Verified organization IDs remain on keys for later shared-pool reconciliation.

OpenAI and Anthropic key cards show reporting coverage separately from model access. These settings are persisted configuration, not an active API dispatch or spending enforcement path. A future router must classify an exhausted grant with pay-go fallback as paid capacity and re-rank against available subscription/grant capacity; stop must exclude it. Shared organization reports must not be subtracted independently from each key.

## Anthropic monthly grant estimates (1.1.12)

Per-key monthly grant setup accepts a monthly USD amount and subscription billing day (1–31). No billing day is guessed. The estimator clamps short months to their last day and uses 00:00 UTC as an explicitly disclosed convention. An optional first-grant timestamp excludes pre-enrollment spend; rollover grants are not estimated from one cycle. Existing organization OAuth reporting is reused, and organization identity must match the key. Refresh occurs after saving, via key Refresh, and every 15 minutes while settings are visible. Keys with the same cycle share one cost query per organization refresh.

The cost query uses the cycle start and fixed current ending_at, all pages, and products messages_api, message_batches_api, claude_console and managed_agents_api. cost.amount is after discounts and before credits, in cents. The organization total includes other keys and workspaces, not just this app. Estimated remaining is max(0, monthly amount - eligible spend), assuming this grant was issued and no other overlapping grant changes allocation. It never overwrites a manual remaining balance. Null freshness, failed queries, wrong organizations, configuration changes, and past cycles cannot appear as a newly full grant. Old estimates are marked stale; data older than 24 hours is visibly stale. This does not implement routing or budget enforcement.

Official research checked 2026-11-05:
- https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-ultra-and-team-plans says credits expire at the end of the billing cycle and new credits arrive shortly after payment. It does not specify a universal cutoff time or guarantee midnight UTC.
- https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers confirms no rollover, eligible products, and organization sharing.
- https://platform.claude.com/docs/en/api/beta/organization/analytics/cost/list documents product filters, cents, pagination and date-range parameters.
- https://platform.claude.com/docs/en/manage-claude/usage-cost-analytics-api documents data_refreshed_at and reporting delays up to 24 hours.

No provider-confirmed exact time or grant issuance is claimed. Subscription billing-day input and the UTC convention are sufficient for an estimate, not a verified ledger or exact cutoff enforcement.
