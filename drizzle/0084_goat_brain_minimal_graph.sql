ALTER TABLE "goat"."brain_documents" RENAME COLUMN "related" TO "relations";--> statement-breakpoint
ALTER TABLE "goat"."brain_documents" RENAME COLUMN "schema_type" TO "entity_type";--> statement-breakpoint
UPDATE "goat"."brain_documents"
SET "entity_type" = CASE "entity_type"
  WHEN 'reference' THEN 'source'
  WHEN 'insight' THEN 'note'
  ELSE "entity_type"
END;--> statement-breakpoint
ALTER TABLE "goat"."brain_documents" DROP COLUMN "metadata";--> statement-breakpoint
ALTER TABLE "goat"."brain_documents" ADD CONSTRAINT "goat_brain_documents_entity_type_check" CHECK ("entity_type" IN ('person', 'company', 'project', 'meeting', 'decision', 'research', 'source', 'note'));
