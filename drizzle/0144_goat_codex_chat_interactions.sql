-- Codex app-server sends request_user_input as a server-initiated JSON-RPC
-- request. Persist the request and its eventual response so a cloud runner can
-- wait durably while the Goat UI collects the user's answer.
CREATE TABLE "goat"."codex_chat_interactions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_workos_id" text NOT NULL,
	"codex_chat_session_id" text NOT NULL,
	"codex_chat_turn_id" text NOT NULL,
	"lease_id" text NOT NULL,
	"request_id" text NOT NULL,
	"item_id" text,
	"method" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"request" jsonb NOT NULL,
	"response" jsonb,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goat_codex_chat_interactions_status_check" CHECK ("codex_chat_interactions"."status" IN ('pending', 'resolved', 'canceled')),
	CONSTRAINT "goat_codex_chat_interactions_method_check" CHECK ("codex_chat_interactions"."method" = 'item/tool/requestUserInput')
);
--> statement-breakpoint
ALTER TABLE "goat"."codex_chat_interactions" ADD CONSTRAINT "goat_codex_chat_interactions_user_workos_id_users_workos_user_id_fk" FOREIGN KEY ("user_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."codex_chat_interactions" ADD CONSTRAINT "goat_codex_chat_interactions_codex_chat_session_id_codex_chat_sessions_id_fk" FOREIGN KEY ("codex_chat_session_id") REFERENCES "goat"."codex_chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."codex_chat_interactions" ADD CONSTRAINT "goat_codex_chat_interactions_codex_chat_turn_id_codex_chat_turns_id_fk" FOREIGN KEY ("codex_chat_turn_id") REFERENCES "goat"."codex_chat_turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "goat_codex_chat_interactions_session_status_idx" ON "goat"."codex_chat_interactions" USING btree ("codex_chat_session_id","status","created_at");--> statement-breakpoint
CREATE INDEX "goat_codex_chat_interactions_turn_created_idx" ON "goat"."codex_chat_interactions" USING btree ("codex_chat_turn_id","created_at");
