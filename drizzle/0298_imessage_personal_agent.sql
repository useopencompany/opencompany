-- iMessage personal assistant, behind the per-user `imessage_enabled` flag (default off).
-- `harness` selects which runner turn runner executes an opencompany-engine runtime; every row
-- that exists today, and every row the main product creates, stays `chat` so no existing session
-- changes behavior. `imessage_bindings` pairs a member's phone to the personal-agent Conversation.
ALTER TABLE "goat"."users" ADD COLUMN "imessage_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "goat"."codex_chat_sessions" ADD COLUMN "harness" text DEFAULT 'chat' NOT NULL;--> statement-breakpoint
ALTER TABLE "goat"."codex_chat_sessions" ADD CONSTRAINT "goat_codex_chat_sessions_harness_check" CHECK ("goat"."codex_chat_sessions"."harness" IN ('chat', 'personal_agent'));--> statement-breakpoint
CREATE TABLE "goat"."imessage_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"user_workos_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"link_code" text,
	"link_code_expires_at" timestamp with time zone,
	"handle" text,
	"conversation_id" text,
	"linked_at" timestamp with time zone,
	"last_inbound_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goat_imessage_bindings_status_check" CHECK ("goat"."imessage_bindings"."status" IN ('pending', 'linked'))
);--> statement-breakpoint
ALTER TABLE "goat"."imessage_bindings" ADD CONSTRAINT "goat_imessage_bindings_user_workos_id_users_workos_user_id_fk" FOREIGN KEY ("user_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."imessage_bindings" ADD CONSTRAINT "goat_imessage_bindings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "goat"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."imessage_bindings" ADD CONSTRAINT "goat_imessage_bindings_conversation_id_chat_sessions_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "goat"."chat_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "goat_imessage_bindings_user_idx" ON "goat"."imessage_bindings" USING btree ("user_workos_id");--> statement-breakpoint
CREATE UNIQUE INDEX "goat_imessage_bindings_handle_idx" ON "goat"."imessage_bindings" USING btree ("handle") WHERE "goat"."imessage_bindings"."handle" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "goat_imessage_bindings_link_code_idx" ON "goat"."imessage_bindings" USING btree ("link_code") WHERE "goat"."imessage_bindings"."link_code" IS NOT NULL;
