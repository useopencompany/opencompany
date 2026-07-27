CREATE TABLE "goat"."chat_sandbox_usage" (
	"id" serial PRIMARY KEY NOT NULL,
	"chat_session_id" text NOT NULL,
	"user_workos_id" text NOT NULL,
	"user_message_id" text,
	"sandbox_id" text NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"active_ms" integer DEFAULT 0 NOT NULL,
	"provider_cost_usd_micros" bigint DEFAULT 0 NOT NULL,
	"platform_fee_usd_micros" bigint DEFAULT 0 NOT NULL,
	"total_cost_usd_micros" bigint DEFAULT 0 NOT NULL,
	"raw_metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cost_basis" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "goat"."chat_sandbox_usage" ADD CONSTRAINT "goat_chat_sandbox_usage_chat_session_id_chat_sessions_id_fk" FOREIGN KEY ("chat_session_id") REFERENCES "goat"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "goat"."chat_sandbox_usage" ADD CONSTRAINT "goat_chat_sandbox_usage_user_workos_id_users_workos_user_id_fk" FOREIGN KEY ("user_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "goat"."chat_sandbox_usage" ADD CONSTRAINT "goat_chat_sandbox_usage_user_message_id_chat_messages_id_fk" FOREIGN KEY ("user_message_id") REFERENCES "goat"."chat_messages"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "goat_chat_sandbox_usage_user_session_created_at_idx" ON "goat"."chat_sandbox_usage" USING btree ("user_workos_id","chat_session_id","created_at");
--> statement-breakpoint
CREATE INDEX "goat_chat_sandbox_usage_session_created_at_idx" ON "goat"."chat_sandbox_usage" USING btree ("chat_session_id","created_at");
--> statement-breakpoint
CREATE INDEX "goat_chat_sandbox_usage_user_message_idx" ON "goat"."chat_sandbox_usage" USING btree ("user_message_id");
--> statement-breakpoint
CREATE INDEX "goat_chat_sandbox_usage_sandbox_idx" ON "goat"."chat_sandbox_usage" USING btree ("sandbox_id");
