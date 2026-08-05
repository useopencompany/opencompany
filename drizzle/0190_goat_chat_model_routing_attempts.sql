-- Durable, prompt-free diagnostics for every Auto model-routing attempt.
CREATE TABLE "goat"."chat_model_routing_attempts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_workos_id" text NOT NULL,
	"chat_session_id" text,
	"user_message_id" text,
	"classifier_model" text NOT NULL,
	"selected_model" text NOT NULL,
	"tier" text NOT NULL,
	"reason" text NOT NULL,
	"outcome" text NOT NULL,
	"duration_ms" integer NOT NULL,
	"error_category" text,
	"finish_reason" text,
	"provider_status_code" integer,
	"provider_retryable" boolean,
	"prompt_length" integer NOT NULL,
	"attachment_count" integer NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"total_tokens" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goat_chat_model_routing_tier_check" CHECK ("tier" IN ('standard', 'frontier')),
	CONSTRAINT "goat_chat_model_routing_reason_check" CHECK ("reason" IN ('pdf_attachment', 'attachment', 'simple_answer', 'summarization', 'drafting', 'single_action', 'multi_step', 'analysis', 'coding', 'high_stakes', 'ambiguous', 'router_fallback')),
	CONSTRAINT "goat_chat_model_routing_outcome_check" CHECK ("outcome" IN ('success', 'skipped', 'timeout', 'error', 'invalid')),
	CONSTRAINT "goat_chat_model_routing_error_category_check" CHECK ("error_category" IS NULL OR "error_category" IN ('output_length', 'invalid_output', 'timeout', 'rate_limit', 'provider', 'unknown')),
	CONSTRAINT "goat_chat_model_routing_non_negative_metrics_check" CHECK ("duration_ms" >= 0 AND "prompt_length" >= 0 AND "attachment_count" >= 0 AND "input_tokens" >= 0 AND "output_tokens" >= 0 AND "total_tokens" >= 0),
	CONSTRAINT "goat_chat_model_routing_provider_status_code_check" CHECK ("provider_status_code" IS NULL OR "provider_status_code" BETWEEN 100 AND 599)
);
--> statement-breakpoint
ALTER TABLE "goat"."chat_model_routing_attempts" ADD CONSTRAINT "goat_chat_model_routing_attempts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "goat"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "goat"."chat_model_routing_attempts" ADD CONSTRAINT "goat_chat_model_routing_attempts_user_workos_id_users_workos_user_id_fk" FOREIGN KEY ("user_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "goat"."chat_model_routing_attempts" ADD CONSTRAINT "goat_chat_model_routing_attempts_chat_session_id_chat_sessions_id_fk" FOREIGN KEY ("chat_session_id") REFERENCES "goat"."chat_sessions"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "goat"."chat_model_routing_attempts" ADD CONSTRAINT "goat_chat_model_routing_attempts_user_message_id_chat_messages_id_fk" FOREIGN KEY ("user_message_id") REFERENCES "goat"."chat_messages"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "goat_chat_model_routing_workspace_created_idx" ON "goat"."chat_model_routing_attempts" USING btree ("workspace_id", "created_at");
--> statement-breakpoint
CREATE INDEX "goat_chat_model_routing_session_created_idx" ON "goat"."chat_model_routing_attempts" USING btree ("chat_session_id", "created_at");
--> statement-breakpoint
CREATE INDEX "goat_chat_model_routing_outcome_created_idx" ON "goat"."chat_model_routing_attempts" USING btree ("outcome", "created_at");
--> statement-breakpoint
CREATE INDEX "goat_chat_model_routing_user_message_idx" ON "goat"."chat_model_routing_attempts" USING btree ("user_message_id");
