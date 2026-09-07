CREATE OR REPLACE FUNCTION "goat"."canonical_task_status_v1"(
  physical_status text,
  archived_at timestamptz
)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN archived_at IS NOT NULL THEN 'archived'
    ELSE physical_status
  END
$$;
--> statement-breakpoint
SELECT goat.refresh_task_read_model_v1(task.id)
FROM goat.tasks AS task
WHERE task.status = 'waiting';
