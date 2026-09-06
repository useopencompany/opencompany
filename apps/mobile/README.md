# Mobile chat persistence

Chat drafts, queued commands, and cached conversations live in `opencompany-chat.db` through
Expo SQLite. Records are partitioned by user and workspace. The chat session cancels network
activity on backgrounding or disconnection and restarts it when the app is active and online.
Disposing a session also fences queued local writes before sign-out or workspace cleanup.

`src/widgets/chat/model/chat-storage` separates migrations, draft storage, outbox transitions,
conversation snapshots, run checkpoints, and cache maintenance. All writes use one serialized
connection. Message rows own rendered content; checkpoints store run status and replay cursors.
Snapshots cannot overwrite messages owned by a checkpoint. Pending approval actions are an
outbox-derived display state, so rejecting an action restores its controls without changing the
persisted event projection.

Conversation and message IDs are allocated once and adopted by the server. Once a message request
is frozen, retries reuse its exact body and idempotency key, including expired attachment IDs.
The server checks accepted requests before resolving attachments. A rejected message restores
its text and attachments alongside newer draft work. If recovery exceeds the attachment limit,
the user must remove extra files before sending again.

Schema version 2 migrates version 1 in a transaction, preserving drafts, commands, attachments,
and checkpoint projections while removing duplicate IDs and content columns. This is a local
migration, with no server database changes. Older app builds cannot open the upgraded database;
there is no automatic downgrade. Do not delete the database to roll back while it contains
unsent work.

Attachment policy comes from the pure `@opencompany/core/attachments` export. Stream parsing,
reconnection, cursor validation, and historical-pause handling belong to
`@opencompany/protocol/run-stream`.
