CREATE TABLE IF NOT EXISTS "goat"."browser_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_workos_id" text NOT NULL REFERENCES "goat"."users"("workos_user_id") ON DELETE CASCADE,
	"name" text NOT NULL,
	"site_host" text NOT NULL,
	"allowed_hosts" jsonb NOT NULL DEFAULT '[]'::jsonb,
	"status" text NOT NULL DEFAULT 'pending_login',
	"encrypted_browserbase_context_id" jsonb NOT NULL,
	"encryption_key_version" integer NOT NULL,
	"active_session_id" text,
	"last_login_session_id" text,
	"last_used_at" timestamptz,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"updated_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "goat_browser_profiles_status_check" CHECK ("status" IN ('pending_login', 'connected', 'needs_reauth', 'disconnected'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goat_browser_profiles_user_status_idx" ON "goat"."browser_profiles" ("user_workos_id", "status");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "goat_browser_profiles_user_host_name_idx" ON "goat"."browser_profiles" ("user_workos_id", "site_host", "name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goat_browser_profiles_active_session_idx" ON "goat"."browser_profiles" ("active_session_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "goat"."browser_profile_sessions" (
	"id" serial PRIMARY KEY,
	"profile_id" uuid NOT NULL REFERENCES "goat"."browser_profiles"("id") ON DELETE CASCADE,
	"user_workos_id" text NOT NULL REFERENCES "goat"."users"("workos_user_id") ON DELETE CASCADE,
	"chat_session_id" text REFERENCES "goat"."chat_sessions"("id") ON DELETE SET NULL,
	"user_message_id" text REFERENCES "goat"."chat_messages"("id") ON DELETE SET NULL,
	"browserbase_session_id" text NOT NULL,
	"kind" text NOT NULL,
	"started_at" timestamptz,
	"ended_at" timestamptz,
	"duration_ms" integer NOT NULL DEFAULT 0,
	"raw_metrics" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"cost_basis" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "goat_browser_profile_sessions_kind_check" CHECK ("kind" IN ('login', 'agent'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goat_browser_profile_sessions_profile_created_idx" ON "goat"."browser_profile_sessions" ("profile_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goat_browser_profile_sessions_user_chat_created_idx" ON "goat"."browser_profile_sessions" ("user_workos_id", "chat_session_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goat_browser_profile_sessions_browserbase_session_idx" ON "goat"."browser_profile_sessions" ("browserbase_session_id");
