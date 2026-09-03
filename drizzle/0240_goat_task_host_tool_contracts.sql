-- Task Conversations run through the same engine adapters as interactive Chat. Older
-- opencompany Task runtimes were created without a host-tool contract, which made the
-- action gateway reject them and silently removed integrations (including Plugin MCP actions).
UPDATE "goat"."codex_chat_sessions" AS "runtime"
SET "host_tool_contract_version" = 'goat-chat-host-tools.v3',
    "updated_at" = now()
FROM "goat"."chat_sessions" AS "conversation"
WHERE "conversation"."id" = "runtime"."chat_session_id"
  AND "conversation"."kind" = 'task'
  AND "runtime"."engine" = 'opencompany'
  AND "runtime"."host_tool_contract_version" IS NULL;
