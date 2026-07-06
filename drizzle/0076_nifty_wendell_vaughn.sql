CREATE TABLE "goat"."task_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"user_workos_id" text NOT NULL,
	"message_id" text,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "goat"."task_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"user_workos_id" text NOT NULL,
	"role" text NOT NULL,
	"status" text DEFAULT 'created' NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"model_message" jsonb,
	"tool_name" text,
	"tool_call_id" text,
	"response_to_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "goat_task_messages_role_check" CHECK ("goat"."task_messages"."role" IN ('user', 'assistant', 'tool')),
	CONSTRAINT "goat_task_messages_status_check" CHECK ("goat"."task_messages"."status" IN ('created', 'running', 'completed', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "goat"."task_events" ADD CONSTRAINT "task_events_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "goat"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."task_events" ADD CONSTRAINT "task_events_user_workos_id_users_workos_user_id_fk" FOREIGN KEY ("user_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."task_events" ADD CONSTRAINT "task_events_message_id_task_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "goat"."task_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."task_messages" ADD CONSTRAINT "task_messages_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "goat"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."task_messages" ADD CONSTRAINT "task_messages_user_workos_id_users_workos_user_id_fk" FOREIGN KEY ("user_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "goat_task_events_user_task_id_idx" ON "goat"."task_events" USING btree ("user_workos_id","task_id","id");--> statement-breakpoint
CREATE INDEX "goat_task_events_task_id_idx" ON "goat"."task_events" USING btree ("task_id","id");--> statement-breakpoint
CREATE INDEX "goat_task_messages_user_task_created_at_idx" ON "goat"."task_messages" USING btree ("user_workos_id","task_id","created_at");--> statement-breakpoint
CREATE INDEX "goat_task_messages_task_created_at_idx" ON "goat"."task_messages" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "goat_task_messages_task_response_to_message_idx" ON "goat"."task_messages" USING btree ("task_id","response_to_message_id");