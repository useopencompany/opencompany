CREATE TABLE "goat"."task_model_usage" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"user_workos_id" text NOT NULL,
	"message_id" text,
	"run_lease_id" text,
	"phase" text NOT NULL,
	"step_index" integer DEFAULT 0 NOT NULL,
	"model_provider" text NOT NULL,
	"model_name" text NOT NULL,
	"response_id" text,
	"response_model_id" text,
	"finish_reason" text,
	"raw_finish_reason" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"input_no_cache_tokens" integer DEFAULT 0 NOT NULL,
	"input_cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"input_cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"output_text_tokens" integer DEFAULT 0 NOT NULL,
	"output_reasoning_tokens" integer DEFAULT 0 NOT NULL,
	"total_tokens" integer DEFAULT 0 NOT NULL,
	"raw_usage" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"provider_created_at" timestamp with time zone,
	"provider_cost_usd_micros" bigint DEFAULT 0 NOT NULL,
	"platform_fee_usd_micros" bigint DEFAULT 0 NOT NULL,
	"total_cost_usd_micros" bigint DEFAULT 0 NOT NULL,
	"cost_basis" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goat_task_model_usage_phase_check" CHECK ("goat"."task_model_usage"."phase" IN ('planner', 'execution'))
);
--> statement-breakpoint
CREATE TABLE "goat"."task_sandbox_usage" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"user_workos_id" text NOT NULL,
	"message_id" text,
	"run_lease_id" text,
	"sandbox_id" text NOT NULL,
	"template" text,
	"vcpu" integer,
	"ram_mib" integer,
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
CREATE TABLE "goat"."task_tool_usage" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"user_workos_id" text NOT NULL,
	"message_id" text,
	"run_lease_id" text,
	"tool_call_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"provider" text NOT NULL,
	"operation" text NOT NULL,
	"provider_request_id" text,
	"provider_cost_usd_micros" bigint DEFAULT 0 NOT NULL,
	"platform_fee_usd_micros" bigint DEFAULT 0 NOT NULL,
	"total_cost_usd_micros" bigint DEFAULT 0 NOT NULL,
	"raw_usage" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cost_basis" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "goat"."task_model_usage" ADD CONSTRAINT "task_model_usage_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "goat"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."task_model_usage" ADD CONSTRAINT "task_model_usage_user_workos_id_users_workos_user_id_fk" FOREIGN KEY ("user_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."task_model_usage" ADD CONSTRAINT "task_model_usage_message_id_task_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "goat"."task_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."task_sandbox_usage" ADD CONSTRAINT "task_sandbox_usage_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "goat"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."task_sandbox_usage" ADD CONSTRAINT "task_sandbox_usage_user_workos_id_users_workos_user_id_fk" FOREIGN KEY ("user_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."task_sandbox_usage" ADD CONSTRAINT "task_sandbox_usage_message_id_task_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "goat"."task_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."task_tool_usage" ADD CONSTRAINT "task_tool_usage_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "goat"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."task_tool_usage" ADD CONSTRAINT "task_tool_usage_user_workos_id_users_workos_user_id_fk" FOREIGN KEY ("user_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."task_tool_usage" ADD CONSTRAINT "task_tool_usage_message_id_task_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "goat"."task_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "goat_task_model_usage_user_task_created_at_idx" ON "goat"."task_model_usage" USING btree ("user_workos_id","task_id","created_at");--> statement-breakpoint
CREATE INDEX "goat_task_model_usage_task_created_at_idx" ON "goat"."task_model_usage" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "goat_task_model_usage_message_idx" ON "goat"."task_model_usage" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "goat_task_sandbox_usage_user_task_created_at_idx" ON "goat"."task_sandbox_usage" USING btree ("user_workos_id","task_id","created_at");--> statement-breakpoint
CREATE INDEX "goat_task_sandbox_usage_task_created_at_idx" ON "goat"."task_sandbox_usage" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "goat_task_sandbox_usage_message_idx" ON "goat"."task_sandbox_usage" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "goat_task_sandbox_usage_sandbox_idx" ON "goat"."task_sandbox_usage" USING btree ("sandbox_id");--> statement-breakpoint
CREATE INDEX "goat_task_tool_usage_user_task_created_at_idx" ON "goat"."task_tool_usage" USING btree ("user_workos_id","task_id","created_at");--> statement-breakpoint
CREATE INDEX "goat_task_tool_usage_task_created_at_idx" ON "goat"."task_tool_usage" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "goat_task_tool_usage_message_idx" ON "goat"."task_tool_usage" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "goat_task_tool_usage_tool_call_idx" ON "goat"."task_tool_usage" USING btree ("tool_call_id");