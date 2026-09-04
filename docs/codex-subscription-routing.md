# Codex subscription-backed model routing

Workspace admins can route the opencompany engine's `openai/gpt-5.6-sol` and
`openai/gpt-5.6-terra` models through a connected ChatGPT/Codex subscription.
The setting is available under **Settings → Inference → Workspace model
access**. The admin enabling the setting becomes the
workspace's credential provider. Removing that admin from the workspace or
disconnecting their Codex account clears the designation.

The designation applies to opencompany chat, task, and Slack bot turns. All
other models and engine features continue through Vercel AI Gateway. When the
designation is enabled for an eligible model, backend authentication, usage
limits, or service errors are returned to the user; they never trigger a
metered gateway fallback.

Subscription-backed turns use the ChatGPT Codex Responses endpoint with
streaming, tool calls, and encrypted reasoning continuity. OAuth access tokens
are refreshed under a short database lease and persisted with optimistic
rotation so concurrent runners do not race a rotating refresh token.

These turns record token telemetry and appear in Billing activity as covered
by the ChatGPT subscription. Provider cost, platform fee, and charged credits
are all zero. No additional environment variables are required; credentials
remain encrypted in `goat.codex_credentials`.

## Operational verification

After applying migration `0238_codex_subscription_routing`:

1. Connect Codex under **Settings → Inference → Coding subscriptions**.
2. Enable **Shared model access** under **Settings → Inference**.
3. Run one Sol or Terra turn in chat, a task, and the Slack bot.
4. Confirm the request provider is `codex-backend`, token usage is present,
   Billing shows **Covered**, and no credit debit was created.
5. Confirm a non-eligible model still reports `vercel-ai-gateway` and debits
   credits normally.
6. Temporarily exercise a 401 and 429 response in a non-production workspace;
   verify the reconnect/usage-limit message is shown and no gateway request is
   made.
