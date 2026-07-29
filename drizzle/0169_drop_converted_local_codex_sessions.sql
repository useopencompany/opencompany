-- Migration 0168 initially preserved Local Codex chats by converting them to
-- normal Goat chats. Remove those already-converted sessions using the
-- Local Codex debug schema marker that remains on their assistant messages.
DELETE FROM "goat"."chat_sessions" AS "session"
WHERE EXISTS (
  SELECT 1
  FROM "goat"."chat_messages" AS "message"
  WHERE "message"."session_id" = "session"."id"
    AND "message"."debug_trace"->>'schemaVersion' IN (
      'goat.local_codex.debug.v1',
      'goat.local_codex.debug.v2'
    )
);
