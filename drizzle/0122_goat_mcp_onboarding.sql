-- Persist the user's preferred MCP client and the first successful Brain query
-- completed through an authenticated MCP transport. Existing successful users
-- are backfilled so the rollout does not show them an obsolete setup prompt.
ALTER TABLE "goat"."users" ADD COLUMN IF NOT EXISTS "preferred_mcp_client" text;--> statement-breakpoint
ALTER TABLE "goat"."users" ADD COLUMN IF NOT EXISTS "mcp_setup_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "goat"."users" ADD CONSTRAINT "goat_users_preferred_mcp_client_check" CHECK ("preferred_mcp_client" IS NULL OR "preferred_mcp_client" IN ('claude', 'chatgpt', 'cursor'));--> statement-breakpoint
UPDATE "goat"."users" AS "user"
SET "mcp_setup_completed_at" = "first_mcp_query"."completed_at"
FROM (
	SELECT "user_workos_id", min("created_at") AS "completed_at"
	FROM "goat"."brain_tool_runs"
	WHERE "ok" = true
		AND "action" = 'query'
		AND "source_ref" LIKE 'mcp:%'
	GROUP BY "user_workos_id"
) AS "first_mcp_query"
WHERE "user"."workos_user_id" = "first_mcp_query"."user_workos_id"
	AND "user"."mcp_setup_completed_at" IS NULL;
