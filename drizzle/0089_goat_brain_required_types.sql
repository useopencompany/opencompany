ALTER TABLE "goat"."brain_documents" ALTER COLUMN "entity_type" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "goat"."brain_documents" DROP CONSTRAINT IF EXISTS "goat_brain_documents_folder_entity_type_check";
--> statement-breakpoint
ALTER TABLE "goat"."brain_documents" ADD CONSTRAINT "goat_brain_documents_folder_entity_type_check" CHECK (
  ("entity_type" = 'person' AND ("folder_path" = 'people' OR "folder_path" LIKE 'people/%')) OR
  ("entity_type" = 'company' AND ("folder_path" = 'companies' OR "folder_path" LIKE 'companies/%')) OR
  ("entity_type" = 'project' AND ("folder_path" = 'projects' OR "folder_path" LIKE 'projects/%')) OR
  ("entity_type" = 'decision' AND ("folder_path" = 'decisions' OR "folder_path" LIKE 'decisions/%')) OR
  ("entity_type" = 'meeting' AND ("folder_path" = 'meetings' OR "folder_path" LIKE 'meetings/%')) OR
  ("entity_type" = 'conversation' AND ("folder_path" = 'conversations' OR "folder_path" LIKE 'conversations/%')) OR
  ("entity_type" = 'research' AND ("folder_path" = 'research' OR "folder_path" LIKE 'research/%')) OR
  ("entity_type" = 'document' AND ("folder_path" = 'docs' OR "folder_path" LIKE 'docs/%')) OR
  ("entity_type" = 'concept' AND ("folder_path" = 'concepts' OR "folder_path" LIKE 'concepts/%')) OR
  ("entity_type" = 'reference' AND ("folder_path" = 'references' OR "folder_path" LIKE 'references/%')) OR
  ("entity_type" = 'daily' AND ("folder_path" = 'daily' OR "folder_path" LIKE 'daily/%')) OR
  ("entity_type" = 'note' AND ("folder_path" = 'inbox' OR "folder_path" LIKE 'inbox/%'))
) NOT VALID;
