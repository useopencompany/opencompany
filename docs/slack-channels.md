# Slack Channels and durable workflow threads

For automatic provisioning of native company-agent identities, see
[the Slack agent provisioning research](./future-concepts/slack-agent-provisioning.md).
Its workspace onboarding is not yet shipped; the contracts below describe the runtime.

Workspace admins install the workspace bot in **Settings → Channels → Slack**. This is separate
from every member's personal Slack plugin. Invite the bot to a public, unshared channel, then put
the destination in normal workflow instructions: “Post the investigation summary in #product with
the opencompany Slack bot.” There is no destination picker in the workflow editor.

## Sessions started from a direct message

A direct message to the bot opens a Task on the sender's own opencompany account and answers in
that message's thread. The sender is matched by the email on their Slack profile: it must belong
to a member of the workspace this Slack team is installed into, or the bot replies once saying it
found no account and does nothing else. A DM conversation with the bot has no other participants,
so the sender and the Task owner are the same person and the session runs on their connected tools
and context.

Ingress persists the message in `slack_direct_messages` before acknowledging Slack, and the runner
resolves the sender and creates the Task. The Task is recorded as sequence `0` of a `slack_thread`
subscription over `(team, DM channel, the sender's message timestamp)`, so its first run owes the
thread exactly one reply and every later message in that thread continues the same session through
the workflow follow-up path below. The Task carries no `workflow_id`, which is what grants it the
Slack send tool in place of a workflow's `slack_channel_enabled` toggle; a workflow Task still
reads only that toggle. Replies to the bot's own DM conversation skip the public-channel check,
because Slack only delivers an `im` event for a conversation the bot is already part of.

## Per-workflow channel configuration

The workflow editor's **Channels** section owns two things, both stored on `goat.workflows`:

- `slack_channel_enabled` decides whether a run is given the Slack send tool at all. Workflows
  written before this section existed default to on, so their behavior is unchanged; turning the
  toggle off withholds the tool from every later run of that workflow.
- `slack_bot_display_name` is a cosmetic identity. One Slack app has one bot user, so the name is
  only a `chat.postMessage` `username` override: the post keeps the APP badge and cannot be
  mentioned by that name. It is snapshotted onto the delivery row when the post is queued, so
  editing the workflow never rewrites an already-queued post.

`opencompany_slack_bot_send_message` is available to workflow runtimes. It is named after the
phrase people write in instructions so the model picks it over a member's personal Slack plugin
action, which can also post messages. It queues a root post with a stable
`messageKey`; each successful root creates a 30-day subscription to the workflow's existing
Conversation.

Its description carries the house writing style, because the tool is the only Slack-facing
instruction a workflow run reliably sees. A channel message is one or two spoken sentences saying
what the run is doing and what it wants back; the real question goes in that message's thread, kept
to what you would ask a busy CTO for advice. Internal identifiers, headings, and numbered option
lists are out in both, because a Slack reader has not read the session and anyone who wants the
full reasoning can open it. Splitting is a real capability, not just advice —
passing `replyToMessageKey` with an earlier message's `messageKey` queues the new message as a
reply in that message's thread, inheriting its channel. A reply is queued before Slack has
timestamped its root, so it stores `thread_parent_id` instead of a `thread_ts` and stays unclaimed
until the root is confirmed `sent`; the worker then resolves the root's `message_ts`, persists it
on the row, and posts. A reply whose root is canceled or failed is canceled rather than dropped
into the channel on its own. Replies to replies resolve back to the root, matching Slack's flat
threads, and only root posts open a subscription. Slack replies become Task follow-up Messages and Runs through the existing Task
repository. The original Task, Conversation, harness, artifacts, and runtime references remain;
a reply never starts another workflow. While idle, the subscription is `waiting` and the runtime
uses its normal durable idle/checkpoint lifecycle. No engine process is kept alive for Slack.

Only plain text replies in the exact subscribed `(workspace, team, channel, root timestamp)`
are eligible. Anyone who can post a plain text reply in the subscribed Slack thread can continue the work,
including guests and people without an opencompany account. The worker rechecks public/unshared
channel access and filters bots and deleted users. Follow-up Runs use the workflow owner’s
existing authority, connected tools, context, and artifacts; the prompt attributes the Slack
sender by ID. The owner must still belong to the opencompany workspace. No sender email match
is required. Mentions outside a subscribed thread, edits, attachments, and untracked threads
are ignored.
A paused Run awaiting approval stays paused; later Slack replies wait. Expired, disconnected,
archived, or closed work cannot silently restart. Human replies to a closed thread receive
an explicit closed-thread response. Disconnecting permanently closes existing subscriptions;
reconnecting enables new workflow posts.

## Images in posts

A post can carry up to four images under its text, in the same message and under the same
identity. The run publishes each image as a chat artifact first, then passes the artifact IDs as
`images`. Only PNG, JPEG, and WebP artifacts of 5 MB or less from the same session are accepted,
matching chat attachments, so a run cannot post another session's files by guessing an ID. The
delivery row pins each artifact's current version in `image_artifact_version_ids`, so republishing
an image never changes a queued post.

The worker uploads the files to Slack without a channel, which keeps them private to the bot, and
then sends one `chat.postMessage` whose image blocks reference them by `slack_file` ID. Sharing
the files straight into the thread with `files.completeUploadExternal` would post them as a
separate file-share message: that message carries no delivery metadata for reconciliation and
Slack returns no timestamp for thread replies to hang under. The post keeps the workflow's
display name and avatar exactly as a text post does.

Slack rejects a `slack_file` it has not finished processing with `invalid_blocks`, and publishes no
readiness signal. That rejection means nothing was posted, so the worker waits 1, 2, 4, and 8
seconds between attempts; this is the one case where a failed post is sent again. If Slack still
refuses, or an upload fails, or an install lacks `files:write`, the message goes out once with a
link to the task in place of the images. The send tool tells the run when its install cannot
upload yet, so the run does not claim the images are in Slack.

## Thread progress reactions

A reply can wait minutes for its answer, so the worker marks the inbound message itself: 👀 when it
starts a Run for that reply, then ✅ once that Run's reply lands in the thread. Everything else is
⚠️: a failed or interrupted Run, a closed thread, a Run that finished without ever calling the
Slack tool, or a reply Slack never took. The mark lands on the person's own message, so a thread
never gains an extra post just to say "working on it", and the check mark only ever means "this
message got its reply". Slack has no replace, so the swap adds the new mark before clearing 👀 and a
half-failed swap leaves the message over-marked rather than unmarked.

This is deliberately not a tool the Run calls. Progress is worker state, and a tool would need its
own harness instructions, would only fire once the model chose to call it, and would go silent in
exactly the case that most needs a signal: a Run that dies before it answers. Reactions are
best-effort — a failed one is logged and dropped rather than retried, and an install without
`reactions:write` runs its threads unmarked.

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
`/webhooks/slack-bot/events` on the API. Subscribe to `message.channels`, `message.im`,
`app_uninstalled`, and `tokens_revoked`, and turn on the App Home messages tab with
“Allow users to send Slash commands and messages from the messages tab”. Required bot scopes:
`chat:write`, `channels:read`, `channels:history`, and `users:read`. New installs additionally
request `users:read.email`, `chat:write.customize`, `reactions:write`, `im:history`, and
`files:write`; an install that predates any of them keeps delivering, and Channels settings asks an
admin to reconnect. Without `files:write` posts link to the task instead of showing images.
Without `chat:write.customize` a workflow's display name and avatar are dropped and the post uses
the default bot identity rather than failing; without `reactions:write` thread replies get no
progress reaction. Without `im:history` Slack never delivers a direct message at all, so the bot
is simply silent when a member writes to it. Custom avatars must be public HTTPS image URLs
because Slack downloads the image when it posts the message. New installs still do not request
private-channel, mention, or reaction *event* scopes - `reactions:write` only lets the bot mark a
message, not read anyone else's reactions. Old grants may remain until the Slack app is
reinstalled; ingress ignores those event types.

Slack contracts: [posting and thread timestamps](https://docs.slack.dev/reference/methods/chat.postmessage/),
[message metadata](https://docs.slack.dev/messaging/message-metadata/),
[channel history](https://docs.slack.dev/reference/methods/conversations.history/), and
[thread history](https://docs.slack.dev/reference/methods/conversations.replies/).

Migration `0282_durable_session_subscriptions` is additive. Deploy it before the new API and
runner. Application rollback can retain these tables and their queued data. Rolling back the
API also restores legacy bot ingress behavior, so disable Slack event delivery during rollback
if that behavior is unwanted. Do not drop the tables while subscriptions or deliveries are active.

Migration `0296_channel_delivery_thread_parent` is additive: it adds a nullable, self-referencing
`thread_parent_id` to `channel_deliveries` and a partial index over it. Existing rows keep
`NULL` and behave exactly as before, so an application rollback can leave the column deployed.

Migrations `0291_workflow_slack_channel` and `0292_channel_delivery_bot_identity` are additive and
`0294_workflow_slack_avatar` adds the avatar URL to both the workflow and delivery snapshot. They
default every existing row to today's behavior: the Slack channel on, and the default bot identity.
An application rollback can leave both columns deployed.

Migration `0284_slack_thread_participants` updates the subscription policy default and existing
Slack thread policy labels. It preserves subscriptions and queued events. Rollback can restore
`workspace_member` policy labels alongside the previous worker. Previously ignored replies stay
ignored; a new reply is needed to resume those threads.

Migration `0312_channel_delivery_images` adds `image_artifact_version_ids` to
`channel_deliveries`, defaulting to an empty array so existing rows deliver as before, and an
application rollback can leave the column deployed. It also moves managed company-agent
provisioning jobs back to `created` when their installation lacks `files:write`, so those apps
reinstall themselves with the new manifest scope. Unlike `0309`, it leaves the installation
connected: until the reinstall lands, that agent's posts link to the task for images. Agents
connected through the legacy manual credential endpoint keep the link until an owner reinstalls
the app with the current manifest.

Migration `0297_slack_direct_message_sessions` is additive: it adds the `slack_direct_messages`
inbox. An application rollback can leave the table deployed; queued rows stop being claimed and no
session is opened for them. Do not drop it while direct messages are pending.

## Company agents with their own Slack identity (beta)

A company agent can connect a dedicated Slack app from **Agents → agent → Enable Slack**. A separate app supplies the real bot user that Slack can mention and DM.
The existing workflow display-name override remains cosmetic; it does not create another user.
The workspace bot in Settings continues to serve existing workflows and personal DM tasks.

The beta uses Slack's standard app manifests and installed bot tokens. It does not require a
new server environment variable or access to Slack's manager-app program. Slack now documents
[manager-app enrollment](https://docs.slack.dev/reference/methods/apps.manifest.create/) as a
prerequisite for managed provisioning; that enrollment is not assumed here. Dedicated app
provisioning now uses the customer-authorized developer tooling route described below, while
retaining the same installation and event routing.

### Try an agent

1. Apply migrations `0305_company_agent_slack` and `0306_slack_agent_provisioning`, then deploy
   API, runner, and web together. The runner's existing Slack Channel worker starts a separate
   provisioning poller. `OPENCOMPANY_API_ORIGIN` must be public HTTPS; the existing public web
   origin must serve agent images. No new environment secret or CLI binary is required.
2. An opencompany admin opens **Settings → Channels → Slack → Set up identities**. They review
   the developer-access grant, paste the generated command into Slack, authorize it there, and
   paste the returned verification code into opencompany. A final screen shows the actual Slack
   workspace before **Connect workspace** stores the grant. Attempts expire after ten minutes,
   are single-use, and are bound to the admin user and opencompany workspace.
3. Create or open an agent. Slack is **off by default**, for both new and existing agents.
   The owner turns on **Enable Slack**. The saved toggle triggers app creation and installation
   in the authorized Slack workspace; there is no per-agent token form or install prompt.
   Workspace app-approval policy can still block installation and surfaces as a retryable error.
4. The worker verifies the bot identity/scopes, encrypts credentials, and configures signed
   events plus the name/avatar. Uploaded agent photos are normalized to 512px PNG. A neutral
   agent icon is used when no photo is supplied; removing a photo restores that icon. Renaming
   an enabled agent updates the same app. Slack-off agents sync changes when re-enabled.
5. **Ready to test in Slack** means configuration succeeded. **Available in Slack** means a
   valid signed event or URL verification was received. Invite the agent to a public, unshared
   channel and mention it, or open a DM. Activate a paused agent before expecting replies.

The opencompany bot retains its own OAuth connection, app, and credentials. Agent posts require
that agent's dedicated installation and never fall back to the workspace bot. The legacy manual
credential endpoint remains available for installations created during the earlier beta.

Migration `0306` adds separate encrypted authorization, setup-attempt, and provisioning-job tables.
It turns off the legacy Slack default on agents without a connected native installation; it does
not disable already-connected identities. This backfill is not automatically reversible: do not
restore every old flag to true on rollback. Existing workflows retain their previous defaults.

Disconnecting **identity setup** removes the stored developer credential and blocks future
provisioning/profile updates. Existing bot installations are kept. Turning Slack off or pausing
an agent blocks its responses. Disconnecting an individual installation through the API erases
its bot credentials; uninstalling/revoking in Slack is separate. Interrupted or ambiguous app
creation stops for operator investigation rather than risking another app. Do not reset such a
job to queued until reconciling the app in Slack and its saved installation state.

For an end-to-end smoke test, install two agents in the same Slack workspace. Mention each in
the same channel thread and confirm different Slack profiles and different agent-owned tasks;
then reply in the thread and confirm each existing task continues. Also test a DM, duplicate
Slack event delivery, an unmatched sender, pausing the agent, and disconnecting its installation.
Automated tests substitute Slack responses; they do not replace this live installation test.

### Boundaries and lifecycle

- The sender must be an active human Slack user in the installed team with an email matching
  an opencompany workspace member. The task runs as the agent's active owner using that
  owner's tools. Connecting is restricted to that owner. Private/shared channels, group DMs,
  files, edited messages, and bot-to-bot conversations are outside this beta.
- Ingress verifies the per-app signing secret, team, and app. A durable inbox deduplicates the
  same Slack message across `app_mention` and `message.channels`. Subscriptions include the
  installation ID, so two agents in one Slack thread retain independent tasks and credentials.
- Dedicated agents fetch at most one 15-message page of thread context per incoming turn and
  label omitted context. This avoids immediate pagination failures under Slack's stricter
  [commercial app history limits](https://docs.slack.dev/reference/methods/conversations.replies/).
  Rate-limited starts retry after one minute; repeated failures surface as connection health.
- Pausing the agent, disabling Slack, or removing its owner prevents new starts. Disconnecting
  deletes stored credentials, closes subscriptions, and cancels pending messages/deliveries.
  A send already in flight may finish. Remove the app itself in Slack to revoke the installation.
  A disconnected dedicated identity never silently switches to the shared workspace bot.

Migration `0305` adds columns and an inbox, and replaces two shared-bot unique indexes with
partial indexes excluding dedicated installations. Existing rows retain their identity. Deploy
API and runner together after migration: old shared-bot reconnect code cannot use the new
conflict target. An application rollback requires first disabling dedicated ingress/workers and
removing dedicated installations (including their dependent data), then restoring the old index
predicates. Do not restore those unique indexes while multiple agents share a Slack workspace.
Prefer a forward fix to this destructive rollback. No production migration is part of local tests.
