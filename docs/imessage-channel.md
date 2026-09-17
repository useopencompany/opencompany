# iMessage personal assistant

A member texts the shared opencompany iMessage line and a personal assistant answers back. It is an
experiment behind the per-user **iMessage assistant** beta switch (Preferences → Beta features),
off by default. With the switch off there is no settings page, no API surface, and no way for an
inbound text to reach that member.

## Isolation from the main harness

The assistant is an opencompany-engine runtime whose `goat.codex_chat_sessions.harness` is
`personal_agent`. Every runtime the main product creates keeps the default `chat`, and the coding
engines never consult the column. The turn dispatcher in `apps/runner/src/coding-engine-registry.ts`
routes `personal_agent` to `apps/runner/src/personal-agent/turn.ts`; everything else keeps calling
the existing `runProductChatTurn` unchanged.

The personal-agent runner reuses, unchanged: the worker, leases and retries; the session, run and
message tables; the projector, so the conversation is readable in the web app; the action gateway
(plugin MCP actions) and the host-tool gateway (wiki, skills); web search and fetch; model
resolution, credit checks and usage recording; and context compaction. It owns its system prompt,
its tool selection, its approval policy and its delivery. Shared code changes are limited to
exported helpers in `opencompany-chat.ts`, the one-line dispatch, and a harness check in the
host-tool bootstrap query that withholds workflow, schedule and subagent tools from a personal agent
even for admins.

## Tools and behavior

The assistant gets web search and fetch, the wiki tool, skill discovery and use, plugin actions, and
one channel tool, `imessage_send`, which sends text and/or a tapback reaction to the paired phone and
can thread a reply under a specific message. At most three sends per turn. Workflows, schedules,
browser, artifacts and subagents are not wired and are also fenced server-side.

A Run that a text started carries `settings.imessage` (delivery id, message id, chat id, sender).
Only such a Run gets the send tool and the texting prompt block; a Run the member typed in the web
view of the conversation answers in the conversation and never reaches the phone. If the model
finishes an iMessage Run without calling the tool, its final text is sent as a fallback so the phone
never goes silent. Out-of-credits and unexpected failures also produce a short text.

Actions whose permission mode is Ask are not paused for approval: a phone has no approval UI. The
action fails with a message the model relays, and the member can run it from the app.

## Pairing

Settings → Channels → iMessage shows the shared line and a six-digit code (ten-minute TTL). The
member texts the code from their phone; the webhook binds that handle to the member's pending row
in `goat.imessage_bindings`, creates the personal-agent Conversation in the member's current
workspace, and texts a confirmation. One binding per member, one member per handle. Unlinking
deletes the binding and keeps the conversation and its history. Linking is inbound-only: opencompany
never texts an unpaired number except to answer a text that looks like a code.

## Transport

[messages.dev](https://www.messages.dev) provides the line. Inbound: `POST
/webhooks/imessage/events` on the API, verified with the line's webhook secret (hex HMAC-SHA256 over
`${timestamp}.${rawBody}`, five-minute tolerance). Only `message.received` is handled; the
provider delivery id is the Message command's idempotency key, so a redelivery never starts a second
Run. Outbound: `POST /v1/messages`, `/v1/reactions` and `/v1/typing`, called inline from the tool
with a thin fetch client in `packages/agent/src/integrations/imessage.ts`. The provider accepts
writes asynchronously and returns an `obx_...` id. This version does not poll that outbox or consume
`message.sent`, so it catches enqueue failures but does not surface a later delivery failure.

Env: `MESSAGES_API_KEY`, `MESSAGES_WEBHOOK_SECRET`, `MESSAGES_LINE_HANDLE` — see
[environment variables](./env-vars.md#imessage-personal-assistant). A sandbox line allows 50
messages a day shared across all members; a dedicated line has no message cap. Apple-side guidance
is roughly one message per second per line and at most five unanswered messages to one contact.

## Data

Migration `0299_imessage_personal_agent` is additive: `goat.users.imessage_enabled`,
`goat.codex_chat_sessions.harness` (default `chat`), and `goat.imessage_bindings`. Application
rollback can leave all three deployed; turning the flag off for everyone disables the channel.

## Deferred

Memory, unprompted sends, attachments and audio, group chats, per-member lines, idle rollover of the
conversation, and web-composer restrictions on the personal-agent conversation.
