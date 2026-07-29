-- Claude Code chat engine: chat sessions can run on Claude Code (`claude -p`) inside
-- the same sandboxed coding-CLI queue as codex (goat.codex_chat_* tables gain an
-- engine discriminator). Auth is a per-user long-lived `claude setup-token` pasted in
-- settings and stored encrypted; there is no device flow and tokens do not rotate.
ALTER TABLE "goat"."chat_sessions" DROP CONSTRAINT IF EXISTS "goat_chat_sessions_engine_check";--> statement-breakpoint
ALTER TABLE "goat"."chat_sessions" ADD CONSTRAINT "goat_chat_sessions_engine_check" CHECK ("goat"."chat_sessions"."engine" IN ('opencompany', 'local_codex', 'codex', 'claude_code'));--> statement-breakpoint
ALTER TABLE "goat"."codex_chat_sessions" ADD COLUMN IF NOT EXISTS "engine" text DEFAULT 'codex' NOT NULL;--> statement-breakpoint
ALTER TABLE "goat"."codex_chat_sessions" DROP CONSTRAINT IF EXISTS "goat_codex_chat_sessions_engine_check";--> statement-breakpoint
ALTER TABLE "goat"."codex_chat_sessions" ADD CONSTRAINT "goat_codex_chat_sessions_engine_check" CHECK ("goat"."codex_chat_sessions"."engine" IN ('codex', 'claude_code'));--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "goat"."claude_code_credentials" (
	"user_workos_id" text PRIMARY KEY NOT NULL,
	"encrypted_auth_json" jsonb NOT NULL,
	"encryption_key_version" integer NOT NULL,
	"status" text DEFAULT 'connected' NOT NULL,
	"status_reason" text,
	"last_validated_at" timestamp with time zone,
	"last_rotated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goat_claude_code_credentials_status_check" CHECK ("goat"."claude_code_credentials"."status" IN ('connected', 'needs_reauth'))
);--> statement-breakpoint
ALTER TABLE "goat"."claude_code_credentials"
	ADD CONSTRAINT "goat_claude_code_credentials_user_workos_id_users_workos_user_id_fk"
	FOREIGN KEY ("user_workos_id") REFERENCES "goat"."users"("workos_user_id")
	ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goat_claude_code_credentials_status_idx" ON "goat"."claude_code_credentials" ("status");
