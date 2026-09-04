-- Keep a single rolling opencompany-engine checkpoint separate from the canonical transcript.
CREATE TABLE "goat"."chat_context_compactions" (
	"chat_session_id" text PRIMARY KEY NOT NULL,
	"summary" text NOT NULL,
	"model" text NOT NULL,
	"generation" integer NOT NULL,
	"compacted_from_message_id" text NOT NULL,
	"compacted_through_message_id" text NOT NULL,
	"first_retained_message_id" text NOT NULL,
	"estimated_tokens_before" integer NOT NULL,
	"estimated_tokens_after" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "opencompany_chat_context_compactions_generation_check" CHECK ("goat"."chat_context_compactions"."generation" > 0),
	CONSTRAINT "opencompany_chat_context_compactions_token_counts_check" CHECK ("goat"."chat_context_compactions"."estimated_tokens_before" >= 0 AND "goat"."chat_context_compactions"."estimated_tokens_after" >= 0)
);--> statement-breakpoint
ALTER TABLE "goat"."chat_context_compactions" ADD CONSTRAINT "chat_context_compactions_chat_session_id_chat_sessions_id_fk" FOREIGN KEY ("chat_session_id") REFERENCES "goat"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;
