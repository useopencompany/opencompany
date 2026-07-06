ALTER TABLE "goat"."users" ADD COLUMN "timezone" text DEFAULT 'UTC' NOT NULL;--> statement-breakpoint
CREATE TABLE "goat"."task_schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"user_workos_id" text NOT NULL,
	"name" text NOT NULL,
	"source_description" text DEFAULT '' NOT NULL,
	"cron" text NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"prompt" text NOT NULL,
	"planned_harness_spec" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp with time zone,
	"next_run_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "goat"."tasks" ADD COLUMN "schedule_id" text;--> statement-breakpoint
ALTER TABLE "goat"."tasks" ADD COLUMN "scheduled_for" timestamp with time zone;--> statement-breakpoint
CREATE TABLE "goat"."task_schedule_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"schedule_id" text NOT NULL,
	"user_workos_id" text NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"task_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goat_task_schedule_runs_status_check" CHECK ("goat"."task_schedule_runs"."status" IN ('pending', 'created', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "goat"."task_schedules" ADD CONSTRAINT "task_schedules_user_workos_id_users_workos_user_id_fk" FOREIGN KEY ("user_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."tasks" ADD CONSTRAINT "tasks_schedule_id_task_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "goat"."task_schedules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."task_schedule_runs" ADD CONSTRAINT "task_schedule_runs_schedule_id_task_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "goat"."task_schedules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."task_schedule_runs" ADD CONSTRAINT "task_schedule_runs_user_workos_id_users_workos_user_id_fk" FOREIGN KEY ("user_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."task_schedule_runs" ADD CONSTRAINT "task_schedule_runs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "goat"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "goat_task_schedules_user_deleted_created_idx" ON "goat"."task_schedules" USING btree ("user_workos_id","deleted_at","created_at");--> statement-breakpoint
CREATE INDEX "goat_task_schedules_due_idx" ON "goat"."task_schedules" USING btree ("enabled","deleted_at","next_run_at");--> statement-breakpoint
CREATE INDEX "goat_task_schedules_user_next_run_idx" ON "goat"."task_schedules" USING btree ("user_workos_id","next_run_at");--> statement-breakpoint
CREATE INDEX "goat_tasks_schedule_idx" ON "goat"."tasks" USING btree ("schedule_id","scheduled_for");--> statement-breakpoint
CREATE UNIQUE INDEX "goat_task_schedule_runs_schedule_for_idx" ON "goat"."task_schedule_runs" USING btree ("schedule_id","scheduled_for");--> statement-breakpoint
CREATE INDEX "goat_task_schedule_runs_user_created_idx" ON "goat"."task_schedule_runs" USING btree ("user_workos_id","created_at");--> statement-breakpoint
CREATE INDEX "goat_task_schedule_runs_task_idx" ON "goat"."task_schedule_runs" USING btree ("task_id");
