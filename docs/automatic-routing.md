# Automatic routing — local release 1.1.13

New OpenAI/Anthropic task turns use available API grants, subscription quota, then explicitly permitted pay-as-you-go connections. Other providers retain manual execution. Existing native sessions stay on their original provider; newly routed sessions can move between sources and retain a local transcript of completed work.

## Controls

Providers settings contains Automatic routing, a maximum API spend per task turn (default $5), automatic ChatGPT reset redemption, and an optional Claude reset expiry. Saved API connections retain their funding, grant amount, billing day, and stop/pay-go choice. Unknown grant balances are not treated as free capacity. API keys remain encrypted in the existing local store.

Monthly Anthropic estimates use the connected organization's eligible cost reports and subscription billing day. The use-by target is six hours before estimated expiry; this is a conservative scheduling assumption, not a provider-confirmed expiration time. After the target, a stop connection is excluded and a pay-go connection is considered paid. A predicted renewal never creates a new balance without usable evidence.

API requests reserve estimated cost against a shared organization pool before being sent. Actual token usage settles the reservation; ambiguous requests retain it. Concurrent local tasks share reservations, and the app uses a single-instance lock. Pricing comes from a daily cached models.dev catalogue intersected with the connection's discovered models. Missing prices exclude an automatic API route. This first router selects current tool-capable models; benchmark-driven tiers and historical demand forecasting are not implemented.

These are local spending controls and conservative estimates, not provider-side hard limits. Organization reports can lag and include external activity. Subscription CLIs can have provider-controlled extra usage enabled; the app avoids known near-exhausted quota and polls during work, but cannot guarantee prevention of every provider-side spillover charge. Configure provider-side spending limits when a strict external cap is required.

## Reset credits

Supported Codex app-server reset offers are redeemed with a persisted idempotency key. An offer expiring within 30 minutes is attempted even without work. Otherwise, redemption requires work, depleted quota, and more than six hours until its natural reset. An offer expiring within 48 hours boosts subscription routing so useful work can consume existing quota first.

Claude reset redemption remains manual: Claude's documented reset interface is Settings > Usage, not a supported CLI redemption API. A user-entered offer expiry boosts routing and triggers a local reminder near expiry. It never claims to have redeemed an offer. All background work requires Kanbots Local to be running and the Mac awake.

## Capacity display

The compact capacity control combines distinct sources as segments instead of adding incomparable dollars and quota percentages. Hover, focus, or click to see each provider, quota remaining, grant/credit balance, and pay-go spending. Bars consistently fill left to right as usage increases. Pay-go percentages require a configured budget; unknown limits are not presented as zero usage. Shared organization pools appear once. Unsupported reporting is shown explicitly.

## Verification

- API package build; desktop and web type checks.
- 13 focused grant/routing tests: billing boundaries, report pagination, stale data, six-hour cutoff, model eligibility, reservations, unknown outcomes, route fallback, reset timing, and stop/pay-go transitions.
- Browser check of the capacity popup using synthetic subscriptions, grants, and pay-go data.
- No real inference requests or reset-credit redemptions were used for these checks. Authenticated end-to-end task execution remains user acceptance testing.
