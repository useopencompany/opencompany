CREATE SCHEMA "goat";
--> statement-breakpoint
CREATE TABLE "goat"."tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"user_workos_id" text NOT NULL,
	"prompt" text NOT NULL,
	"model" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"stage" text DEFAULT 'queued' NOT NULL,
	"result" text,
	"error" text,
	"harness_spec" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sandbox_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_id" text,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goat_tasks_status_check" CHECK ("goat"."tasks"."status" IN ('queued', 'running', 'succeeded', 'failed')),
	CONSTRAINT "goat_tasks_stage_check" CHECK ("goat"."tasks"."stage" IN ('queued', 'planning', 'sandboxing', 'running', 'completed', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "goat"."users" (
	"workos_user_id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"first_name" text,
	"last_name" text,
	"avatar_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "goat"."tasks" ADD CONSTRAINT "tasks_user_workos_id_users_workos_user_id_fk" FOREIGN KEY ("user_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "goat_tasks_user_created_at_idx" ON "goat"."tasks" USING btree ("user_workos_id","created_at");--> statement-breakpoint
CREATE INDEX "goat_tasks_status_next_run_at_idx" ON "goat"."tasks" USING btree ("status","next_run_at");--> statement-breakpoint
CREATE INDEX "goat_tasks_lease_expires_at_idx" ON "goat"."tasks" USING btree ("lease_expires_at");