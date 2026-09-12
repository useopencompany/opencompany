# Claude Code subscription usage

The personal Claude Code card in **Settings → Inference → Coding subscriptions** shows
remaining allowance and reset times for the connected user's Claude subscription, alongside
the equivalent Codex card described in [Codex subscription routing](./codex-subscription-routing.md).
These are account-wide readings, including usage outside opencompany; they are not workspace
billing or local cost estimates.

Usage is fetched on opening the card, every minute while the tab is visible, and on manual
refresh. A failed refresh retains the last successful reading with an error; missing windows
are unavailable, never interpreted as unused allowance. Passed reset times require a fresh
reading before showing restored allowance.

## Why a probe request instead of a usage endpoint

opencompany stores the long-lived token printed by `claude setup-token`. That token carries
only the `user:inference` scope, so Anthropic's account usage endpoint
(`GET /api/oauth/usage`, which [CodexBar](https://github.com/steipete/CodexBar/blob/main/docs/claude.md)
uses for browser-authorized Claude accounts) answers `403 user:profile required`.

Anthropic returns the same unified subscription windows as `anthropic-ratelimit-unified-*`
response headers on any inference request, so the authenticated
`GET /v1/engine-auth/claude-code/usage` route sends the cheapest possible completion — Haiku,
`max_tokens: 1`, a one-character prompt — and reads the windows off the response. Every
`anthropic-ratelimit-unified-<window>-utilization` header paired with a `-reset` timestamp
becomes a window, so model-scoped limits appear without a code change when Anthropic adds
them. The probe's own cost against the subscription is negligible, but it is a real request:
the route is limited to six refreshes per minute per actor and times out.

A rate-limited (`429`) response still carries the windows, and that reading is exactly what
the user opened the card for, so headers are read before the response status is considered.
Only a response with no readable windows is turned into an error. Like the Codex card, a
failed read must not disconnect an otherwise valid subscription.

Responses carry private, non-cacheable headers and contain only normalized windows and a
timestamp — never credentials.

## Operational verification

1. Connect Claude Code under **Settings → Inference → Coding subscriptions**.
2. Confirm the card lists a Session window and a Weekly window with reset times.
3. Confirm the values match `/usage` in a local Claude Code session on the same account.
4. Disconnect the subscription and confirm the card disappears rather than showing a full
   allowance.
