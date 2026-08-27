CREATE TABLE "goat"."task_activities" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"author" text NOT NULL,
	"author_workos_id" text,
	"kind" text NOT NULL,
	"body" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "opencompany_task_activities_author_check" CHECK ("goat"."task_activities"."author" IN ('user', 'orchestrator', 'system')),
	CONSTRAINT "opencompany_task_activities_kind_check" CHECK ("goat"."task_activities"."kind" IN ('created', 'run_started', 'run_finished', 'status_changed', 'comment', 'retry'))
);
--> statement-breakpoint
ALTER TABLE "goat"."task_activities" ADD CONSTRAINT "task_activities_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "goat"."tasks"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "goat"."task_activities" ADD CONSTRAINT "task_activities_author_workos_id_users_workos_user_id_fk" FOREIGN KEY ("author_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "opencompany_task_activities_task_created_at_idx" ON "goat"."task_activities" USING btree ("task_id", "created_at");
