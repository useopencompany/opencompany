ALTER TABLE "goat"."brain_documents" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'draft' NOT NULL;
--> statement-breakpoint
ALTER TABLE "goat"."brain_timeline_entries" ADD COLUMN IF NOT EXISTS "evidence_id" text;
--> statement-breakpoint
UPDATE "goat"."brain_timeline_entries"
SET "evidence_id" = 'ev-' || substring(md5("document_id" || ':' || "at"::text || ':' || "summary" || ':' || "source_ref"), 1, 24)
WHERE "evidence_id" IS NULL OR "evidence_id" = '';
--> statement-breakpoint
ALTER TABLE "goat"."brain_timeline_entries" ALTER COLUMN "evidence_id" SET NOT NULL;
--> statement-breakpoint
INSERT INTO "goat"."brain_documents" (
  "id",
  "user_workos_id",
  "brain_id",
  "folder_path",
  "title",
  "content",
  "body",
  "timeline",
  "kind",
  "mime_type",
  "relations",
  "sources",
  "entity_type",
  "status",
  "aliases",
  "content_hash",
  "size_bytes",
  "created_at",
  "updated_at"
)
SELECT
  "brain_files"."id",
  "brain_files"."user_workos_id",
  "brain_files"."brain_id",
  CASE
    WHEN "brain_files"."folder_path" = 'ideas' THEN 'concepts'
    WHEN "brain_files"."folder_path" = 'insights' THEN 'concepts'
    WHEN "brain_files"."folder_path" = 'sources' THEN 'references'
    ELSE "brain_files"."folder_path"
  END,
  "brain_files"."title",
  "brain_files"."content",
  "brain_files"."compiled_truth",
  '[]'::jsonb,
  "brain_files"."kind",
  "brain_files"."mime_type",
  COALESCE("brain_files"."frontmatter"->'related', "brain_files"."frontmatter"->'relations', '[]'::jsonb),
  COALESCE("brain_files"."frontmatter"->'sources', '[]'::jsonb),
  CASE
    WHEN "brain_files"."entity_type" = 'source' THEN 'reference'
    WHEN "brain_files"."entity_type" = 'docs' THEN 'document'
    WHEN "brain_files"."folder_path" = 'docs' THEN 'document'
    WHEN "brain_files"."folder_path" IN ('ideas', 'insights', 'concepts') THEN 'concept'
    ELSE "brain_files"."entity_type"
  END,
  "brain_files"."status",
  COALESCE("brain_files"."frontmatter"->'aliases', '[]'::jsonb),
  "brain_files"."content_hash",
  "brain_files"."size_bytes",
  "brain_files"."created_at",
  "brain_files"."updated_at"
FROM "goat"."brain_files" AS "brain_files"
WHERE to_regclass('goat.brain_files') IS NOT NULL
ON CONFLICT ("user_workos_id", "brain_id") DO NOTHING;
--> statement-breakpoint
UPDATE "goat"."brain_documents"
SET
  "folder_path" = CASE
    WHEN "folder_path" = 'ideas' THEN 'concepts'
    WHEN "folder_path" = 'insights' THEN 'concepts'
    WHEN "folder_path" = 'sources' THEN 'references'
    ELSE "folder_path"
  END,
  "entity_type" = CASE
    WHEN "entity_type" = 'source' THEN 'reference'
    WHEN "entity_type" = 'docs' THEN 'document'
    WHEN "folder_path" = 'docs' THEN 'document'
    WHEN "folder_path" IN ('ideas', 'insights', 'concepts') THEN 'concept'
    ELSE "entity_type"
  END;
--> statement-breakpoint
ALTER TABLE "goat"."brain_documents" DROP CONSTRAINT IF EXISTS "goat_brain_documents_entity_type_check";
--> statement-breakpoint
ALTER TABLE "goat"."brain_documents" DROP CONSTRAINT IF EXISTS "goat_brain_documents_status_check";
--> statement-breakpoint
ALTER TABLE "goat"."brain_documents" ADD CONSTRAINT "goat_brain_documents_entity_type_check" CHECK ("entity_type" IN ('person', 'company', 'project', 'decision', 'meeting', 'conversation', 'research', 'document', 'concept', 'reference', 'daily', 'note'));
--> statement-breakpoint
ALTER TABLE "goat"."brain_documents" ADD CONSTRAINT "goat_brain_documents_status_check" CHECK ("status" IN ('draft', 'active', 'archived', 'merged'));
--> statement-breakpoint
DROP INDEX IF EXISTS "goat"."goat_brain_timeline_entries_dedup_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "goat_brain_timeline_entries_dedup_idx" ON "goat"."brain_timeline_entries" USING btree ("document_id", "evidence_id");
--> statement-breakpoint
DROP TABLE IF EXISTS "goat"."brain_files";
