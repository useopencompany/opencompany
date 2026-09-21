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

Schema version 3 adds presentation revision and ETag columns after the version 2 migration. It
preserves drafts, commands, attachments,
and checkpoint projections while removing duplicate IDs and content columns. This is a local
migration, with no server database changes. Older app builds cannot open the upgraded database;
there is no automatic downgrade. Do not delete the database to roll back while it contains
unsent work.

Attachment policy comes from the pure `@opencompany/core/attachments` export. Stream parsing,
reconnection, cursor validation, and historical-pause handling belong to
`@opencompany/protocol/run-stream`.

The mobile app uses `react-native-keyboard-controller` 1.22.5, `expo-glass-effect` for the
React Native composer, and `expo-clipboard` for response actions. Validate changes with
`bun --cwd apps/mobile typecheck`, `bun --cwd apps/mobile test`, and a fresh native simulator
build. Fast Refresh does not rebuild keyboard-controller's native code.

## Proposed HEIC support

Do not add HEIC or HEIF to the upload allowlist. A future change should use the SDK-matched
`expo-image-manipulator` to create a JPEG derivative for both Photos and Files before attachment
validation or persistence. Start at JPEG quality 0.9. If the derivative exceeds 5 MB, resize and
recompress it before validation. Update the URI, filename, MIME type, byte size, dimensions, and
orientation as one record. Keep the source photo untouched and persist only the derivative used
for uploads and offline retries.

That change needs real HEIC and HEIF fixtures covering portrait and landscape orientation, HDR,
cloud-backed Photos, multi-select, corrupted files, and oversized derivatives.
