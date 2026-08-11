-- New recurring Task schedules are workspace-owned. Existing user-scoped schedules remain NULL
-- during the bounded compatibility window and are resolved only through an observable fallback.
ALTER TABLE "goat"."task_schedules" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "goat"."task_schedules" ADD CONSTRAINT "task_schedules_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "goat"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "goat_task_schedules_workspace_next_run_idx" ON "goat"."task_schedules" USING btree ("workspace_id","next_run_at");
