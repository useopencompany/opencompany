ALTER TABLE "goat"."brain_members" DROP CONSTRAINT IF EXISTS "brain_members_brain_id_brains_id_fk";--> statement-breakpoint
ALTER TABLE "goat"."brain_members" ADD CONSTRAINT "brain_members_brain_id_brains_id_fk" FOREIGN KEY ("brain_id") REFERENCES "goat"."brains"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "goat"."brain_folders" DROP CONSTRAINT IF EXISTS "brain_folders_brain_ref_brains_id_fk";--> statement-breakpoint
ALTER TABLE "goat"."brain_folders" ADD CONSTRAINT "brain_folders_brain_ref_brains_id_fk" FOREIGN KEY ("brain_ref") REFERENCES "goat"."brains"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "goat"."brain_documents" DROP CONSTRAINT IF EXISTS "brain_documents_brain_ref_brains_id_fk";--> statement-breakpoint
ALTER TABLE "goat"."brain_documents" ADD CONSTRAINT "brain_documents_brain_ref_brains_id_fk" FOREIGN KEY ("brain_ref") REFERENCES "goat"."brains"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "goat"."brain_timeline_entries" DROP CONSTRAINT IF EXISTS "brain_timeline_entries_brain_ref_brains_id_fk";--> statement-breakpoint
ALTER TABLE "goat"."brain_timeline_entries" ADD CONSTRAINT "brain_timeline_entries_brain_ref_brains_id_fk" FOREIGN KEY ("brain_ref") REFERENCES "goat"."brains"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "goat"."brain_edges" DROP CONSTRAINT IF EXISTS "brain_edges_brain_ref_brains_id_fk";--> statement-breakpoint
ALTER TABLE "goat"."brain_edges" ADD CONSTRAINT "brain_edges_brain_ref_brains_id_fk" FOREIGN KEY ("brain_ref") REFERENCES "goat"."brains"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "goat"."brain_document_embeddings" DROP CONSTRAINT IF EXISTS "brain_document_embeddings_brain_ref_brains_id_fk";--> statement-breakpoint
ALTER TABLE "goat"."brain_document_embeddings" DROP CONSTRAINT IF EXISTS "brain_document_embeddings_brain_ref_fkey";--> statement-breakpoint
ALTER TABLE "goat"."brain_document_embeddings" ADD CONSTRAINT "brain_document_embeddings_brain_ref_brains_id_fk" FOREIGN KEY ("brain_ref") REFERENCES "goat"."brains"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "goat"."brain_document_versions" DROP CONSTRAINT IF EXISTS "brain_document_versions_brain_ref_brains_id_fk";--> statement-breakpoint
ALTER TABLE "goat"."brain_document_versions" ADD CONSTRAINT "brain_document_versions_brain_ref_brains_id_fk" FOREIGN KEY ("brain_ref") REFERENCES "goat"."brains"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "goat"."brain_sources" DROP CONSTRAINT IF EXISTS "goat_brain_sources_brain_id_brains_id_fk";--> statement-breakpoint
ALTER TABLE "goat"."brain_sources" ADD CONSTRAINT "goat_brain_sources_brain_id_brains_id_fk" FOREIGN KEY ("brain_id") REFERENCES "goat"."brains"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "goat"."brain_ingest_jobs" DROP CONSTRAINT IF EXISTS "goat_brain_ingest_jobs_brain_ref_brains_id_fk";--> statement-breakpoint
ALTER TABLE "goat"."brain_ingest_jobs" ADD CONSTRAINT "goat_brain_ingest_jobs_brain_ref_brains_id_fk" FOREIGN KEY ("brain_ref") REFERENCES "goat"."brains"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
WITH candidates AS (
  SELECT
    "id" AS "old_id",
    CASE
      WHEN "slug" = 'general' AND "id" = 'goat_brain_' || "created_by_workos_id"
        THEN 'general-' || substr(md5("created_by_workos_id"), 1, 12)
      ELSE
        left(coalesce(nullif("slug", ''), 'brain'), 67) || '-' || substr(md5("id"), 1, 12)
    END AS "candidate_id"
  FROM "goat"."brains"
  WHERE "id" LIKE 'goat\_brain\_%' ESCAPE '\'
),
renames AS (
  SELECT
    "old_id",
    CASE
      WHEN EXISTS (
        SELECT 1
        FROM "goat"."brains" existing
        WHERE existing."id" = candidates."candidate_id"
          AND existing."id" <> candidates."old_id"
      )
        THEN left(candidates."candidate_id", 67) || '-' || substr(md5(candidates."old_id" || ':collision'), 1, 12)
      ELSE candidates."candidate_id"
    END AS "new_id"
  FROM candidates
)
UPDATE "goat"."brains" brain
SET "id" = renames."new_id",
    "updated_at" = now()
FROM renames
WHERE brain."id" = renames."old_id"
  AND renames."new_id" <> renames."old_id";
