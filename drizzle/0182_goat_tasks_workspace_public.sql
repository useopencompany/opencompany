ALTER TABLE "goat"."tasks" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'goat_tasks_workspace_id_goat_workspaces_id_fk'
  ) THEN
    ALTER TABLE "goat"."tasks" ADD CONSTRAINT "goat_tasks_workspace_id_goat_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "goat"."workspaces"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
UPDATE "goat"."tasks" AS task
SET "workspace_id" = runtime."workspace_id"
FROM "goat"."codex_chat_sessions" AS runtime
WHERE task."workspace_id" IS NULL
  AND task."session_id" = runtime."chat_session_id"
  AND runtime."workspace_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goat_tasks_workspace_archived_created_at_idx" ON "goat"."tasks" USING btree ("workspace_id","archived_at","created_at");
