# Slack Channels and durable workflow threads

Workspace admins install the workspace bot in **Settings → Channels → Slack**. This is separate
from every member's personal Slack plugin. Invite the bot to a public, unshared channel, then put
the destination in normal workflow instructions: “Post the investigation summary in #product.”
There is no destination picker in the workflow editor.

`post_slack_message` is available to workflow runtimes. It queues a root post with a stable
`messageKey`; each successful root creates a 30-day subscription to the workflow's existing
Conversation. Slack replies become Task follow-up Messages and Runs through the existing Task
repository. The original Task, Conversation, harness, artifacts, and runtime references remain;
a reply never starts another workflow. While idle, the subscription is `waiting` and the runtime
uses its normal durable idle/checkpoint lifecycle. No engine process is kept alive for Slack.

Only plain text replies in the exact subscribed `(workspace, team, channel, root timestamp)`
are eligible. Anyone who can post a plain text reply in the subscribed Slack thread can continue the work,
including guests and people without an opencompany account. The worker rechecks public/unshared
channel access and filters bots and deleted users. Follow-up Runs use the workflow owner’s
existing authority, connected tools, context, and artifacts; the prompt attributes the Slack
sender by ID. The owner must still belong to the opencompany workspace. No sender email match
is required. DMs, mentions outside a subscribed thread, edits, attachments, and untracked threads
are ignored.
A paused Run awaiting approval stays paused; later Slack replies wait. Expired, disconnected,
archived, or closed work cannot silently restart. Human replies to a closed thread receive
an explicit closed-thread response. Disconnecting permanently closes existing subscriptions;
reconnecting enables new workflow posts.

## Persistence and recovery

- `session_subscriptions` stores source identity, target Conversation, policy, and lifecycle.
  It is separate from webhook transport and can represent other event sources later.
- `subscription_events` durably deduplicates provider events and assigns a monotonic sequence
  under a database lock before Slack is acknowledged. Failure to persist returns HTTP 503.
- The worker locks the Task and inbox row, and atomically creates the follow-up Run and records
  its ID. Existing fenced Run leases own execution; later events for the same session wait until
  its response is delivered. Different sessions can progress independently.
- `channel_deliveries` persists root and reply intents before any post. A database lease claims
  each delivery. Slack message metadata carries its stable delivery ID. After a crash or ambiguous
  result, the worker reads the exact channel/thread to reconcile that ID and bot identity. It does
  **not** repost an unconfirmed write. Uncertain deliveries remain visible as installation health
  issues and retry reconciliation every 15 minutes. Missing access/scopes and revoked tokens
  require an admin to restore access or reconnect. No personal Slack credential is used.

This provides durable single-turn execution and prevents blind duplicate replies. If Slack never
exposes an ambiguous post in history, an operator must inspect it; automatic reposting would risk
a duplicate. The conversation and accepted events remain durable during that uncertainty.

## Slack app configuration

Use the existing `OPENCOMPANY_SLACK_BOT_*` credentials. OAuth still uses
`/api/integrations/slack-bot/start` and `/api/integrations/slack-bot/callback`; signed events use
`/webhooks/slack-bot/events` on the API. Subscribe to `message.channels`, `app_uninstalled`, and
`tokens_revoked`. Required bot scopes: `chat:write`, `channels:read`, `channels:history`,
and `users:read`. New installs no longer request DM, private-channel, mention,
or reaction scopes. Old grants may remain until the Slack app is reinstalled; ingress ignores
those event types. Stop configuring the legacy Wiki answer bot's Brain destinations.

Slack contracts: [posting and thread timestamps](https://docs.slack.dev/reference/methods/chat.postmessage/),
[message metadata](https://docs.slack.dev/messaging/message-metadata/),
[channel history](https://docs.slack.dev/reference/methods/conversations.history/), and
[thread history](https://docs.slack.dev/reference/methods/conversations.replies/).

Migration `0282_durable_session_subscriptions` is additive. Deploy it before the new API and
runner. Application rollback can retain these tables and their queued data. Rolling back the
API also restores legacy bot ingress behavior, so disable Slack event delivery during rollback
if that behavior is unwanted. Do not drop the tables while subscriptions or deliveries are active.
