-- Who originally put each brain document in the brain. Set once at insert and
-- never on update; user_workos_id keeps its existing last-actor semantics.
ALTER TABLE "goat"."brain_documents" ADD COLUMN IF NOT EXISTS "created_by_workos_id" text;--> statement-breakpoint
ALTER TABLE "goat"."brain_documents" ADD CONSTRAINT "brain_documents_created_by_workos_id_users_workos_user_id_fk" FOREIGN KEY ("created_by_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Backfill only where the creator is unambiguous. user_workos_id is
-- overwritten on every edit, and version rows record the actor of the change
-- that *replaced* their content, so for multi-actor documents the original
-- creator is unrecoverable — leave those null (unknown beats wrong). Also
-- leave Slack-sourced documents null: the integration owner connected the
-- channel but did not author its content.
UPDATE "goat"."brain_documents" d
SET "created_by_workos_id" = d."user_workos_id"
WHERE d."created_by_workos_id" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(d."sources") AS s
    WHERE s->>'ref' LIKE 'slack:%'
  )
  AND NOT EXISTS (
    SELECT 1 FROM "goat"."brain_document_versions" v
    WHERE v."document_id" = d."id"
      AND v."user_workos_id" IS DISTINCT FROM d."user_workos_id"
  );
